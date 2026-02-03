(() => {
  const isLog = () => /\.log(\?.*)?$/.test(location.pathname + location.search);
  if (!isLog()) return; // Solo actuar en ficheros .log

  // ======= Config por defecto =======
  const DEFAULTS = {
    refreshSeconds: 5,       // auto-refresh (segundos)
    followTail: true,        // seguir al final
    onlyMatches: false,      // mostrar solo coincidencias
    filterText: "",          // filtro de búsqueda (persiste)
    searchHistory: [],       // últimas 10 búsquedas
    highlightRules: [        // reglas de resaltado
      {
        pattern: "Ejecución de estrategia",
        textColor: "#111",
        bgColor: "#fff1a8"
      },
      {
        pattern: "Stop Loss",
        textColor: "#111",
        bgColor: "#d95f73"
      },
      {
        pattern: "Opening LONG",
        textColor: "#111",
        bgColor: "#6abe64"
      }
    ],
  };

  // Storage helpers
  const getSettings = () => new Promise(res => {
    chrome.storage.sync.get(DEFAULTS, (data) => res({ ...DEFAULTS, ...data }));
  });
  const saveSettings = (patch) => new Promise(res => {
    chrome.storage.sync.set(patch, () => res());
  });

  // ======= Estado =======
  const state = {
    settings: { ...DEFAULTS },
    timerId: null,
    buffer: "",
    paused: false,

    // Búsqueda
    hitNodes: [],
    activeHitIdx: 0,
    sizeBytes: 0,

    // Cache/condicional
    lastEtag: null,
    lastModified: null,

    // Concurrencia
    inFlight: false,
    abort: null,
  };

  // ======= Utils =======
  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    s = (s ?? "").toString();
    return s.replace(/[&<>\"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  function toRegex(input) {
    if (!input) return null;
    const m = input.match(/^\/(.*)\/([gimsuy]*)$/);
    if (m) {
      try { return new RegExp(m[1], m[2]); } catch { return null; }
    }
    return null; // texto simple -> includes()
  }

  function testFilter(line, re, raw) {
    if (re) {
      // Si tiene flag g, test() mueve lastIndex y rompe en loops
      if (re.global) re.lastIndex = 0;
      return re.test(line);
    }
    return line.toLowerCase().includes(raw.toLowerCase());
  }

  function textSizeBytes(str) {
    try { return new TextEncoder().encode(str).length; } catch { return (str ?? "").length; }
  }

  // Compila reglas de highlight con seguridad (regex inválida no rompe render)
  function compileRules(rules) {
    const out = [];
    for (const r of (rules || [])) {
      const pattern = (r.pattern || "").trim();
      if (!pattern) continue;
      
      // Detectar si es regex o texto plano
      const regexMatch = pattern.match(/^\/(.*)\/([gimsuy]*)$/);
      
      try {
        if (regexMatch) {
          // Es una regex
          const re = new RegExp(regexMatch[1], regexMatch[2] || "");
          out.push({ re, className: `hl-rule-${out.length}` });
        } else {
          // Es texto plano - crear regex que busque el texto literal
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(escaped, "i");
          out.push({ re, className: `hl-rule-${out.length}` });
        }
      } catch {
        // Regla inválida -> se ignora
      }
    }
    return out;
  }

  // ======= UI =======
  function buildUI() {
    document.documentElement.style.height = "100%";
    document.body.style.margin = 0;
    document.body.style.height = "100%";
    document.body.innerHTML = "";

    const root = document.createElement("div");
    root.id = "blt-root";

    root.innerHTML = `
      <div class="blt-header">
        <div class="blt-left">
          <strong class="blt-title">Blob Log Tailer</strong>
          <span class="blt-url" title="URL del log">${escapeHtml(location.href)}</span>
        </div>
        <div class="blt-tabs">
          <button id="blt-tab-view" class="blt-tab is-active" type="button">Visor</button>
          <button id="blt-tab-options" class="blt-tab" type="button">Opciones</button>
        </div>
      </div>

      <!-- Panel VISOR -->
      <section id="blt-view" class="blt-panel is-active">
        <div class="blt-toolbar">
          <div class="blt-controls">
            <label>Actualización (s)
              <input id="blt-refresh" type="number" min="1" step="1" />
            </label>
            <label class="blt-checkbox">
              <input id="blt-follow" type="checkbox" /> Seguir al final
            </label>
            <label class="blt-checkbox">
              <input id="blt-only" type="checkbox" /> Solo coincidencias
            </label>
          </div>
          <div class="blt-search">
            <input id="blt-filter" type="text" placeholder="Filtro: texto o /regex/i" />
            <div id="blt-history" class="blt-history" hidden></div>
            <div class="blt-search-nav">
              <button id="blt-prev" class="blt-btn" title="Coincidencia anterior (Arriba)">↑</button>
              <button id="blt-next" class="blt-btn" title="Siguiente coincidencia (Abajo)">↓</button>
              <span id="blt-count" class="blt-count">0 / 0</span>
            </div>
            <button id="blt-pause" class="blt-btn" title="Pausar/Reanudar auto-refresh">Pausar</button>
          </div>
        </div>

        <div id="blt-log" class="blt-log" role="log" aria-live="polite" aria-label="Contenido del log"></div>

        <div class="blt-status">
          <span id="blt-bytes"></span>
          <span id="blt-last"></span>
          <span id="blt-note"></span>
        </div>
      </section>

      <!-- Panel OPCIONES (integrado) -->
      <section id="blt-options" class="blt-panel">
        <div class="blt-opt-doc">
          <h2>Resaltado por contenido</h2>
          <p>Define patrones de texto o <code>/regex/i</code> para resaltar líneas del log.</p>
        </div>

        <div class="blt-opt-rules">
          <div class="blt-rules-header">
            <span>Patrón</span>
            <span>Fondo</span>
            <span>Texto</span>
            <span></span>
          </div>
          <div id="blt-rules"></div>
          <button id="blt-addRule" class="blt-btn">+ Añadir regla</button>
        </div>

        <div class="blt-opt-actions">
          <button id="blt-saveRules" class="blt-btn blt-btn-primary">Guardar cambios</button>
          <span id="blt-opt-status" class="blt-opt-status"></span>
        </div>
      </section>

      <template id="blt-ruleRow">
        <div class="rule">
          <input class="r-pattern" placeholder="texto o /regex/i" />
          <input class="r-bg" type="color" value="#fff1a8" title="Color de fondo" />
          <input class="r-fg" type="color" value="#111111" title="Color de texto" />
          <button class="r-del" title="Eliminar regla">✕</button>
        </div>
      </template>
    `;

    document.body.appendChild(root);

    // Inicializa valores UI (VISOR)
    $("blt-refresh").value = state.settings.refreshSeconds;
    $("blt-follow").checked = state.settings.followTail;
    $("blt-only").checked = state.settings.onlyMatches;
    $("blt-filter").value = state.settings.filterText;

    // Eventos VISOR
    $("blt-refresh").addEventListener("change", onRefreshChanged);
    $("blt-follow").addEventListener("change", onFollowChanged);
    $("blt-only").addEventListener("change", onOnlyChanged);
    $("blt-filter").addEventListener("input", onFilterChanged);
    $("blt-pause").addEventListener("click", onTogglePause);
    $("blt-prev").addEventListener("click", () => gotoHit(-1, true));
    $("blt-next").addEventListener("click", () => gotoHit(+1, true));

    // Tabs
    $("blt-tab-view").addEventListener("click", () => switchTab("view"));
    $("blt-tab-options").addEventListener("click", () => switchTab("options"));

    // Construye UI de opciones (reglas)
    loadRulesIntoOptions();
    $("blt-addRule").addEventListener("click", () => addRuleRow());
    $("blt-saveRules").addEventListener("click", saveRulesFromOptions);

    // Scroll behavior: si el usuario hace scroll hacia arriba, desactiva seguir al final
    const logEl = $("blt-log");
    logEl.addEventListener("scroll", () => {
      const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 20;
      if (!nearBottom && $("blt-follow").checked) {
        $("blt-follow").checked = false;
        state.settings.followTail = false;
        saveSettings({ followTail: false });
      }
    });

    // === Historial de búsquedas ===
    const filterEl = $("blt-filter");

    filterEl.addEventListener("focus", () => showHistoryDropdown());
    filterEl.addEventListener("click", () => showHistoryDropdown());

    filterEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const v = (filterEl.value || "").trim();
        addToHistory(v);
        filterEl.dispatchEvent(new Event("input", { bubbles: true }));
        hideHistoryDropdown();
      } else if (e.key === "Escape") {
        hideHistoryDropdown();
      }
    });

    filterEl.addEventListener("blur", () => {
      setTimeout(() => hideHistoryDropdown(), 120);
      const v = (filterEl.value || "").trim();
      addToHistory(v);
    });

    document.addEventListener("click", (e) => {
      const wrap = document.querySelector(".blt-search");
      if (wrap && !wrap.contains(e.target)) hideHistoryDropdown();
    });
  }

  // ======= Lógica general =======
  async function init() {
    state.settings = await getSettings();

    // 1) Aprovecha lo que ya cargó el navegador (evita segunda descarga inicial en muchos casos)
    try {
      const preloaded = (document.body && document.body.innerText) ? document.body.innerText : "";
      if (preloaded && preloaded.trim()) {
        state.buffer = preloaded;
        state.sizeBytes = textSizeBytes(preloaded);
        // Si el server te envió ETag/Last-Modified en navegación normal, no los tenemos aquí.
        // Igual el próximo refresh hará condicional si luego los obtenemos.
      }
    } catch {}

    buildUI();
    compileHighlightCSS(state.settings.highlightRules);

    render();
    startTimerLoop();

    // Sembrar lastModified usando el documento ya cargado (para que el 1er refresh sea condicional)
    try {
      const lm = document.lastModified;
      const d = new Date(lm);
      if (!isNaN(d.getTime())) state.lastModified = d.toUTCString();
    } catch {}

    // Opcional: revalidar rápido en 1s (debería ser 304)
    setTimeout(() => refresh(false).catch(console.error), 1000);
  }

  // Loop con setTimeout + await: jamás se encolan refresh
  function startTimerLoop() {
    if (state.timerId) clearTimeout(state.timerId);

    const tick = async () => {
      if (!state.paused) await refresh(false).catch(console.error);
      const ms = Math.max(1, Number(state.settings.refreshSeconds)) * 1000;
      state.timerId = setTimeout(tick, ms);
    };

    const firstMs = Math.max(1, Number(state.settings.refreshSeconds)) * 1000;
    state.timerId = setTimeout(tick, firstMs);
  }

  function onRefreshChanged(e) {
    const v = Math.max(1, Number(e.target.value || 5));
    state.settings.refreshSeconds = v;
    saveSettings({ refreshSeconds: v });
    startTimerLoop();
  }
  function onFollowChanged(e) {
    state.settings.followTail = !!e.target.checked;
    saveSettings({ followTail: state.settings.followTail });
    if (state.settings.followTail) scrollToBottom();
  }
  function onOnlyChanged(e) {
    state.settings.onlyMatches = !!e.target.checked;
    saveSettings({ onlyMatches: state.settings.onlyMatches });
    render();
  }
  function onFilterChanged(e) {
    state.settings.filterText = e.target.value || "";
    saveSettings({ filterText: state.settings.filterText });
    state.activeHitIdx = 0;
    render(true);
  }
  function onTogglePause() {
    state.paused = !state.paused;
    $("blt-pause").textContent = state.paused ? "Reanudar" : "Pausar";
    $("blt-note").textContent = state.paused ? "⏸️ Pausado" : "";
  }

  // ===== Refresh: GET condicional (ETag/Last-Modified) + sin solapes =====
  async function refresh(initial) {
    // Evita concurrencia
    if (state.inFlight) {
      // No encolamos: simplemente ignoramos (el loop ya volverá a intentar)
      return;
    }
    state.inFlight = true;

    // Cancela cualquier request anterior (por si se llama manualmente en el futuro)
    state.abort?.abort();
    const ac = new AbortController();
    state.abort = ac;

    try {
      $("blt-note").textContent = state.paused ? "⏸️ Pausado" : "Actualizando…";

      const headers = {};
      if (state.lastEtag) {
        headers["If-None-Match"] = state.lastEtag;
      } else if (state.lastModified) {
        headers["If-Modified-Since"] = state.lastModified;
      }

      const resp = await fetch(location.href, {
        method: "GET",
        cache: "no-cache",          // permite revalidación; mejor que no-store
        headers,
        signal: ac.signal,
      });

      // Si el servidor soporta condicional, esto es la gloria:
      if (resp.status === 304) {
        updateStatus(state.sizeBytes, true);
        return;
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }

      const text = await resp.text();

      // Guarda ETag/Last-Modified si existen
      const newEtag = resp.headers.get("etag");
      const newModified = resp.headers.get("last-modified");
      if (newEtag) state.lastEtag = newEtag;
      if (newModified) state.lastModified = newModified;

      const sizeHeader = resp.headers.get("content-length");
      const size = sizeHeader ? parseInt(sizeHeader, 10) : textSizeBytes(text);

      // Si no cambió, no re-render
      if (!initial && text === state.buffer) {
        state.sizeBytes = size;
        updateStatus(size, true);
        return;
      }

      state.buffer = text;
      state.sizeBytes = size;

      render();
      updateStatus(size, false);
    } catch (err) {
      if (err?.name === "AbortError") return;
      console.error("Failed to fetch log:", err);
      $("blt-note").textContent = `⚠️ Error: ${err.message}`;
    } finally {
      state.inFlight = false;
    }
  }

  function render(scrollToActive = false) {
    const logEl = $("blt-log");
    const filter = state.settings.filterText.trim();
    const re = toRegex(filter);
    const rules = compileRules(state.settings.highlightRules);

    let lines = (state.buffer || "").split(/\r?\n/);
    let html = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "" && !state.settings.onlyMatches) { html += "\n"; continue; }

      const match = filter ? testFilter(line, re, filter) : true;
      if (state.settings.onlyMatches && !match) continue;

      let cls = "blt-line";

      for (const rr of rules) {
        if (rr.re.global) rr.re.lastIndex = 0;
        if (rr.re.test(line)) cls += ` ${rr.className}`;
      }

      if (filter && match) cls += " blt-hit";

      html += `<div id="blt-line-${i}" class="${cls}">${escapeHtml(line)}</div>`;
    }

    logEl.innerHTML = html;

    // Recolecta coincidencias para navegación
    state.hitNodes = Array.from(logEl.querySelectorAll(".blt-hit"));
    if (state.hitNodes.length === 0) {
      state.activeHitIdx = 0;
      $("blt-count").textContent = "0 / 0";
      setNavEnabled(false);
      if (state.settings.followTail) scrollToBottom();
      return;
    }

    if (state.activeHitIdx >= state.hitNodes.length) state.activeHitIdx = state.hitNodes.length - 1;

    $("blt-count").textContent = `${state.activeHitIdx + 1} / ${state.hitNodes.length}`;
    setNavEnabled(true);

    state.hitNodes.forEach(n => n.classList.remove("blt-hit-current"));
    const activeNode = state.hitNodes[state.activeHitIdx];
    if (activeNode) {
      activeNode.classList.add("blt-hit-current");
      if (scrollToActive) scrollToNode(activeNode);
    } else if (state.settings.followTail) {
      scrollToBottom();
    }

    if (!scrollToActive && state.settings.followTail) scrollToBottom();
  }

  function gotoHit(delta, scroll = true) {
    if (!state.hitNodes.length) return;
    if ($("blt-follow").checked) {
      $("blt-follow").checked = false;
      state.settings.followTail = false;
      saveSettings({ followTail: false });
    }
    state.activeHitIdx = (state.activeHitIdx + delta + state.hitNodes.length) % state.hitNodes.length;
    $("blt-count").textContent = `${state.activeHitIdx + 1} / ${state.hitNodes.length}`;
    state.hitNodes.forEach(n => n.classList.remove("blt-hit-current"));
    const node = state.hitNodes[state.activeHitIdx];
    node.classList.add("blt-hit-current");
    if (scroll) scrollToNode(node);
  }

  function setNavEnabled(enabled) {
    $("blt-prev").disabled = !enabled;
    $("blt-next").disabled = !enabled;
  }

  function scrollToNode(node) {
    const container = $("blt-log");
    const top = node.offsetTop - container.clientHeight / 2;
    container.scrollTop = Math.max(0, top);
  }

  function updateStatus(bytes, skipped) {
    const now = new Date();
    $("blt-bytes").textContent = `Tamaño: ${Number(bytes || 0).toLocaleString()} bytes`;
    $("blt-last").textContent = `Última actualización: ${now.toLocaleTimeString()}`;
    if (state.paused) {
      $("blt-note").textContent = "⏸️ Pausado";
    } else if (skipped) {
      $("blt-note").textContent = "Sin cambios";
    } else {
      $("blt-note").textContent = "";
    }
  }

  function scrollToBottom() {
    const el = $("blt-log");
    el.scrollTop = el.scrollHeight + 1000;
  }

  // ======= Opciones (integradas) =======
  function loadRulesIntoOptions() {
    const wrap = $("blt-rules");
    wrap.innerHTML = "";
    for (const r of state.settings.highlightRules || []) addRuleRow(r);
  }

  function addRuleRow(r = {}) {
    const tpl = $("blt-ruleRow").content.cloneNode(true);
    const row = tpl.querySelector(".rule");
    row.querySelector(".r-pattern").value = r.pattern || "";
    row.querySelector(".r-bg").value = r.bgColor || "#fff1a8";
    row.querySelector(".r-fg").value = r.textColor || "#111111";
    row.querySelector(".r-del").addEventListener("click", () => row.remove());
    $("blt-rules").appendChild(row);
  }

  async function saveRulesFromOptions() {
    const rows = Array.from(document.querySelectorAll("#blt-rules .rule"));
    const rules = rows.map((row, index) => ({
      pattern: row.querySelector(".r-pattern").value.trim(),
      bgColor: row.querySelector(".r-bg").value,
      textColor: row.querySelector(".r-fg").value
    })).filter(r => r.pattern);

    const payload = { highlightRules: rules.length ? rules : DEFAULTS.highlightRules };
    await saveSettings(payload);
    state.settings.highlightRules = payload.highlightRules;
    removeDynamicCSS();
    compileHighlightCSS(state.settings.highlightRules);
    render();

    const st = $("blt-opt-status");
    st.textContent = "Guardado ✓";
    setTimeout(() => st.textContent = "", 1500);
  }

  function switchTab(which) {
    const isView = which === "view";
    $("blt-tab-view").classList.toggle("is-active", isView);
    $("blt-tab-options").classList.toggle("is-active", !isView);
    $("blt-view").classList.toggle("is-active", isView);
    $("blt-options").classList.toggle("is-active", !isView);
  }

  function compileHighlightCSS(rules) {
    const style = document.createElement("style");
    style.id = "blt-dynamic-rules";
    let css = "";
    rules?.forEach((r, index) => {
      const cls = `hl-rule-${index}`;
      const bg = r.bgColor || "#fff1a8";
      const fg = r.textColor || "#111";
      css += `.${cls}{background:${bg};color:${fg};border-left:4px solid rgba(0,0,0,.2)}`;
    });
    style.textContent = css;
    document.head.appendChild(style);
  }

  function removeDynamicCSS() {
    const el = document.getElementById("blt-dynamic-rules");
    if (el) el.remove();
  }

  // ===== Historial: helpers =====
  function getHistory() {
    return Array.isArray(state.settings.searchHistory) ? state.settings.searchHistory : [];
  }

  async function setHistory(arr) {
    state.settings.searchHistory = arr;
    await saveSettings({ searchHistory: arr });
  }

  function addToHistory(term) {
    const v = (term || "").trim();
    if (!v) return;
    let arr = getHistory();
    arr = [v, ...arr.filter(x => x !== v)].slice(0, 10);
    setHistory(arr);
    renderHistoryDropdown(arr);
  }

  function showHistoryDropdown() {
    const arr = getHistory();
    if (!arr.length) return hideHistoryDropdown();
    renderHistoryDropdown(arr);
    $("blt-history").hidden = false;
  }

  function hideHistoryDropdown() {
    const el = $("blt-history");
    if (el) el.hidden = true;
  }

  function renderHistoryDropdown(arr) {
    const hist = $("blt-history");
    if (!hist) return;
    const html = arr.map((item, idx) =>
      `<button type="button" class="blt-history-item" data-idx="${idx}" title="Usar búsqueda">${escapeHtml(item)}</button>`
    ).join("") + `<button type="button" class="blt-history-clear" title="Borrar historial">Limpiar historial</button>`;
    hist.innerHTML = html;

    hist.querySelectorAll(".blt-history-item").forEach(btn => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const value = btn.textContent;
        const filter = $("blt-filter");
        filter.value = value;
        addToHistory(value);
        filter.dispatchEvent(new Event("input", { bubbles: true }));
        hideHistoryDropdown();
      });
    });

    hist.querySelector(".blt-history-clear")?.addEventListener("mousedown", async (e) => {
      e.preventDefault();
      await setHistory([]);
      hideHistoryDropdown();
    });
  }

  // Go!
  init().catch(console.error);
})();
