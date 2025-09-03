(() => {
  const isLog = () => /\.log(\?.*)?$/.test(location.pathname + location.search);
  if (!isLog()) return; // Solo actuar en ficheros .log

  // ======= Config por defecto =======
  const DEFAULTS = {
    refreshSeconds: 5,       // auto-refresh (segundos)
    tailKB: 512,             // tamaño de cola inicial (KB)
    followTail: true,        // seguir al final
    onlyMatches: false,      // mostrar solo coincidencias
    filterText: "",          // filtro de búsqueda (persiste)
    highlightRules: [        // reglas de resaltado
      {
        name: "Ejecución de estrategia",
        pattern: "ig_strategy: Ejecución de estrategia",
        flags: "i",
        className: "hl-ejecucion",
        textColor: "#111",
        bgColor: "#fff1a8"
      }
    ]
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
    etag: null,
    lastLength: null,   // Content-Length previo
    rangeStart: 0,      // Siguiente byte a pedir (append)
    buffer: "",         // Texto acumulado
    paused: false,
    // Búsqueda
    hitNodes: [],
    activeHitIdx: 0
  };

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
            <label>Cola (KB)
              <input id="blt-tailkb" type="number" min="1" step="1" />
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
          <ol>
            <li><strong>Nombre</strong>: texto descriptivo (no afecta la lógica).</li>
            <li><strong>Patrón</strong>: texto literal o <em>regex</em> <strong>sin</strong> las barras <code>/.../</code>.</li>
            <li><strong>Flags</strong> (si regex): ej. <code>i</code> para ignorar mayúsculas/minúsculas.</li>
            <li><strong>CSS class</strong> (opcional): pon nombres distintos si quieres colores distintos por regla (p. ej. <code>hl-ejecucion</code>, <code>hl-error</code>).</li>
            <li>Elige <strong>Color de fondo</strong> y <strong>Color de texto</strong>.</li>
            <li>Pulsa <strong>Guardar</strong>.</li>
          </ol>
          <p class="note"><strong>Tip:</strong> si dejas <em>CSS class</em> vacío en varias reglas, compartirán el mismo estilo y la última guardada puede sobrescribir colores de las anteriores.</p>
        </div>

        <div class="blt-opt-rules">
          <div id="blt-rules"></div>
          <button id="blt-addRule" class="blt-btn">Añadir regla</button>
        </div>

        <div class="blt-opt-actions">
          <button id="blt-saveRules" class="blt-btn">Guardar</button>
          <span id="blt-opt-status" class="blt-opt-status"></span>
        </div>
      </section>

      <template id="blt-ruleRow">
        <div class="rule" title="Define una regla de resaltado">
          <input class="r-name" placeholder="Nombre (ej.: Ejecución de estrategia)" />
          <input class="r-pattern" placeholder="Patrón (texto o \\[(ERROR|WARN)\\])" />
          <input class="r-flags" placeholder="Flags (ej.: i)" />
          <input class="r-class" placeholder="CSS class (ej.: hl-ejecucion)" />
          <input class="r-bg" type="color" value="#fff1a8" title="Color de fondo" />
          <input class="r-fg" type="color" value="#111111" title="Color de texto" />
          <button class="r-del" title="Eliminar">🗑</button>
        </div>
      </template>
    `;

    document.body.appendChild(root);

    // Inicializa valores UI (VISOR)
    $("blt-refresh").value = state.settings.refreshSeconds;
    $("blt-tailkb").value = state.settings.tailKB;
    $("blt-follow").checked = state.settings.followTail;
    $("blt-only").checked = state.settings.onlyMatches;
    $("blt-filter").value = state.settings.filterText;

    // Eventos VISOR
    $("blt-refresh").addEventListener("change", onRefreshChanged);
    $("blt-tailkb").addEventListener("change", onTailChanged);
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
  }

  // ======= Lógica general =======
  async function init() {
    state.settings = await getSettings();
    buildUI();
    compileHighlightCSS(state.settings.highlightRules);
    startTimer();
    // Carga inicial inmediata
    refresh(true).catch(console.error);
  }

  function startTimer() {
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = setInterval(() => {
      if (!state.paused) refresh(false).catch(console.error);
    }, Math.max(1, Number(state.settings.refreshSeconds)) * 1000);
  }

  function onRefreshChanged(e) {
    const v = Math.max(1, Number(e.target.value || 5));
    state.settings.refreshSeconds = v;
    saveSettings({ refreshSeconds: v });
    startTimer();
  }
  function onTailChanged(e) {
    const v = Math.max(1, Number(e.target.value || 512));
    state.settings.tailKB = v;
    saveSettings({ tailKB: v });
    // Forzar recarga desde la cola
    state.lastLength = null;
    state.rangeStart = 0;
    state.buffer = "";
    refresh(true).catch(console.error);
  }
  function onFollowChanged(e) {
    state.settings.followTail = !!e.target.checked;
    saveSettings({ followTail: state.settings.followTail });
    if (state.settings.followTail) scrollToBottom();
  }
  function onOnlyChanged(e) {
    state.settings.onlyMatches = !!e.target.checked;
    saveSettings({ onlyMatches: state.settings.onlyMatches });
    // Al cambiar esta opción, recalculamos hits
    render();
  }
  function onFilterChanged(e) {
    state.settings.filterText = e.target.value || "";
    saveSettings({ filterText: state.settings.filterText });
    state.activeHitIdx = 0; // reinicia navegación
    render(/*scrollToActive*/true); // sitúa en la primera coincidencia si existe
  }
  function onTogglePause() {
    state.paused = !state.paused;
    $("blt-pause").textContent = state.paused ? "Reanudar" : "Pausar";
    $("blt-note").textContent = state.paused ? "⏸️ Pausado" : "";
  }

  async function refresh(initial) {
    const url = location.href;

    // Intenta HEAD para Content-Length y ETag
    let contentLength = null;
    let etag = null;
    try {
      const head = await fetch(url, { method: "HEAD", cache: "no-store" });
      etag = head.headers.get("etag");
      const cl = head.headers.get("content-length");
      contentLength = cl ? parseInt(cl, 10) : null;
    } catch (e) {
      // HEAD puede no estar permitido; seguimos sin él
    }

    // Decide qué pedir
    let rangeHeader = null;
    let cutFirstLine = false;

    if (state.lastLength == null || initial) {
      if (contentLength != null) {
        const tailBytes = Math.max(1, state.settings.tailKB | 0) * 1024;
        if (contentLength > tailBytes) {
          state.rangeStart = contentLength - tailBytes;
          rangeHeader = `bytes=${state.rangeStart}-`;
          cutFirstLine = true; // puede empezar en mitad de línea
        } else {
          state.rangeStart = 0;
        }
      }
    } else {
      if (contentLength != null && contentLength > state.lastLength) {
        state.rangeStart = state.lastLength;
        rangeHeader = `bytes=${state.rangeStart}-`;
      } else if (contentLength != null && contentLength < state.lastLength) {
        // Archivo truncado/rotado -> volver a cargar desde cola
        const tailBytes = Math.max(1, state.settings.tailKB | 0) * 1024;
        if (contentLength > tailBytes) {
          state.rangeStart = contentLength - tailBytes;
          rangeHeader = `bytes=${state.rangeStart}-`;
          cutFirstLine = true;
        } else {
          state.rangeStart = 0;
        }
      } else if (etag && state.etag && etag === state.etag) {
        updateStatus(contentLength, true);
        return; // sin cambios
      }
    }

    // Realiza GET (con Range si aplica)
    const headers = { "cache-control": "no-store" };
    if (rangeHeader) headers["Range"] = rangeHeader;

    const resp = await fetch(url, { method: "GET", headers });

    let text = await resp.text();
    if (rangeHeader && cutFirstLine) {
      const i = text.indexOf("\n");
      if (i !== -1) text = text.slice(i + 1);
    }

    if (rangeHeader && state.rangeStart > 0 && state.buffer) {
      state.buffer += (state.buffer.endsWith("\n") || text.startsWith("\n")) ? text : ("\n" + text);
    } else {
      state.buffer = text;
    }

    // Actualiza métricas
    state.etag = resp.headers.get("etag") || etag || null;
    const cl2 = resp.headers.get("content-length");
    if (contentLength != null) state.lastLength = contentLength;
    else if (cl2 != null) state.lastLength = parseInt(cl2, 10);

    render();
    updateStatus(state.lastLength, false);
  }

  function render(scrollToActive = false) {
    const logEl = $("blt-log");
    const filter = state.settings.filterText.trim();
    const re = toRegex(filter);
    const rules = (state.settings.highlightRules || []).map(r => ({
      re: new RegExp(r.pattern, r.flags || ""),
      className: r.className || "hl-custom"
    }));

    const lines = state.buffer.split(/\r?\n/);
    let html = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "" && !state.settings.onlyMatches) {
        html += "\n";
        continue;
      }

      const match = filter ? testFilter(line, re, filter) : true;
      if (state.settings.onlyMatches && !match) continue;

      let cls = "blt-line";
      for (const rr of rules) if (rr.re.test(line)) cls += ` ${rr.className}`;
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

    // Ajusta índice actual si quedó fuera de rango
    if (state.activeHitIdx >= state.hitNodes.length) state.activeHitIdx = state.hitNodes.length - 1;

    $("blt-count").textContent = `${state.activeHitIdx + 1} / ${state.hitNodes.length}`;
    setNavEnabled(true);

    // Marca la coincidencia activa
    state.hitNodes.forEach(n => n.classList.remove("blt-hit-current"));
    const activeNode = state.hitNodes[state.activeHitIdx];
    if (activeNode) {
      activeNode.classList.add("blt-hit-current");
      if (scrollToActive) scrollToNode(activeNode);
    } else if (state.settings.followTail) {
      scrollToBottom();
    }

    // Si followTail está activo y no estamos navegando por hits, baja al final
    if (!scrollToActive && state.settings.followTail) scrollToBottom();
  }

  function gotoHit(delta, scroll = true) {
    if (!state.hitNodes.length) return;
    // Navegar cancela el followTail para que no se nos vaya al fondo
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
    $("blt-bytes").textContent = bytes != null ? `Tamaño: ${bytes.toLocaleString()} bytes` : "";
    $("blt-last").textContent = `Última actualización: ${now.toLocaleTimeString()}`;
    if (skipped) $("blt-note").textContent = "Sin cambios"; else if (!state.paused) $("blt-note").textContent = "";
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
    row.querySelector(".r-name").value = r.name || "";
    row.querySelector(".r-pattern").value = r.pattern || "";
    row.querySelector(".r-flags").value = r.flags || "";
    row.querySelector(".r-class").value = r.className || "";
    row.querySelector(".r-bg").value = r.bgColor || "#fff1a8";
    row.querySelector(".r-fg").value = r.textColor || "#111111";
    row.querySelector(".r-del").addEventListener("click", () => row.remove());
    $("blt-rules").appendChild(row);
  }

  async function saveRulesFromOptions() {
    const rows = Array.from(document.querySelectorAll("#blt-rules .rule"));
    const rules = rows.map(row => ({
      name: row.querySelector(".r-name").value.trim(),
      pattern: row.querySelector(".r-pattern").value.trim(),
      flags: row.querySelector(".r-flags").value.trim(),
      className: row.querySelector(".r-class").value.trim(),
      bgColor: row.querySelector(".r-bg").value,
      textColor: row.querySelector(".r-fg").value
    })).filter(r => r.pattern);

    const payload = { highlightRules: rules.length ? rules : DEFAULTS.highlightRules };
    await saveSettings(payload);
    state.settings.highlightRules = payload.highlightRules;
    // Reinyecta CSS y vuelve a pintar
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

  // ======= Utils =======
  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
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
    if (re) return re.test(line);
    return line.toLowerCase().includes(raw.toLowerCase());
  }

  function compileHighlightCSS(rules) {
    const style = document.createElement("style");
    style.id = "blt-dynamic-rules";
    let css = "";
    for (const r of rules) {
      const cls = r.className || "hl-custom";
      const bg = r.bgColor || "#fff1a8";
      const fg = r.textColor || "#111";
      css += `.${cls}{background:${bg};color:${fg};border-left:4px solid rgba(0,0,0,.2)}`;
    }
    style.textContent = css;
    document.head.appendChild(style);
  }

  function removeDynamicCSS() {
    const el = document.getElementById("blt-dynamic-rules");
    if (el) el.remove();
  }

  // Go!
  init().catch(console.error);
})();
