(() => {
  const isLog = () => /\.log(\?.*)?$/.test(location.pathname + location.search);
  if (!isLog()) return; // Solo actuar en ficheros .log

  // ======= Config por defecto =======
  const DEFAULTS = {
    refreshSeconds: 5,       // auto-refresh (segundos)
    tailKB: 512,             // tamaño de cola a cargar (KB)
    followTail: true,        // seguir al final por defecto
    onlyMatches: false,      // mostrar solo coincidencias del filtro
    filterText: "",          // filtro de búsqueda (persiste)
    highlightRules: [        // reglas de resaltado (se pueden editar en Options)
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

  // Storage helpers (MV3 permite Promises)
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
    lastLength: null,  // Content-Length previo
    rangeStart: 0,     // Siguiente byte a pedir (append)
    buffer: "",        // Texto acumulado (lo que mostramos)
    initialTailUsed: false,
    paused: false,
  };

  // ======= UI =======
  function buildUI() {
    document.documentElement.style.height = "100%";
    document.body.style.margin = 0;
    document.body.style.height = "100%";

    // Limpia el body y crea el contenedor del visor
    document.body.innerHTML = "";

    const root = document.createElement("div");
    root.id = "blt-root";

    root.innerHTML = `
      <div class="blt-toolbar">
        <div class="blt-left">
          <strong class="blt-title">Blob Log Tailer</strong>
          <span class="blt-url" title="URL del log">${escapeHtml(location.href)}</span>
        </div>
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
          <input id="blt-filter" type="text" placeholder="Filtro: texto o /regex/i" />
          <button id="blt-pause" class="blt-btn" title="Pausar/Reanudar auto-refresh">Pausar</button>
          <a id="blt-open" class="blt-btn" href="${location.href}" target="_blank" rel="noopener">Abrir</a>
          <button id="blt-options" class="blt-btn">Opciones</button>
        </div>
      </div>
      <div id="blt-log" class="blt-log" role="log" aria-live="polite" aria-label="Contenido del log"></div>
      <div class="blt-status">
        <span id="blt-bytes"></span>
        <span id="blt-last"></span>
        <span id="blt-note"></span>
      </div>
    `;

    document.body.appendChild(root);

    // Inicializa valores UI
    $("blt-refresh").value = state.settings.refreshSeconds;
    $("blt-tailkb").value = state.settings.tailKB;
    $("blt-follow").checked = state.settings.followTail;
    $("blt-only").checked = state.settings.onlyMatches;
    $("blt-filter").value = state.settings.filterText;

    // Eventos
    $("blt-refresh").addEventListener("change", onRefreshChanged);
    $("blt-tailkb").addEventListener("change", onTailChanged);
    $("blt-follow").addEventListener("change", onFollowChanged);
    $("blt-only").addEventListener("change", onOnlyChanged);
    $("blt-filter").addEventListener("input", onFilterChanged);
    $("blt-pause").addEventListener("click", onTogglePause);
    $("blt-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

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

  // ======= Lógica =======
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
    state.initialTailUsed = false;
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
    render();
  }
  function onFilterChanged(e) {
    state.settings.filterText = e.target.value || "";
    saveSettings({ filterText: state.settings.filterText });
    render();
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
      // Carga inicial desde la cola (tail)
      if (contentLength != null) {
        const tailBytes = Math.max(1, state.settings.tailKB | 0) * 1024;
        if (contentLength > tailBytes) {
          state.rangeStart = contentLength - tailBytes;
          rangeHeader = `bytes=${state.rangeStart}-`;
          cutFirstLine = true; // puede empezar en mitad de línea
          state.initialTailUsed = true;
        } else {
          state.rangeStart = 0;
        }
      }
    } else {
      // Intento de append incremental
      if (contentLength != null && state.lastLength != null && contentLength > state.lastLength) {
        state.rangeStart = state.lastLength;
        rangeHeader = `bytes=${state.rangeStart}-`;
      } else if (contentLength != null && state.lastLength != null && contentLength < state.lastLength) {
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
        // Sin cambios: solo actualizar status
        updateStatus(contentLength, true);
        return;
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

  function render() {
    const logEl = $("blt-log");
    const filter = state.settings.filterText.trim();
    const re = toRegex(filter);
    const rules = (state.settings.highlightRules || []).map(r => ({
      re: new RegExp(r.pattern, r.flags || ""),
      className: r.className || "hl-custom"
    }));

    const lines = state.buffer.split(/\r?\n/);

    // Construye HTML de forma eficiente
    let html = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) { html += "\n"; continue; }

      const match = filter ? testFilter(line, re, filter) : true;
      if (state.settings.onlyMatches && !match) continue;

      let cls = "blt-line";
      for (const rr of rules) {
        if (rr.re.test(line)) { cls += ` ${rr.className}`; }
      }

      if (filter && match) cls += " blt-hit";

      html += `<div class="${cls}">${escapeHtml(line)}</div>`;
    }

    logEl.innerHTML = html;

    if (state.settings.followTail) scrollToBottom();
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
    return null; // texto simple -> se usa includes()
  }

  function testFilter(line, re, raw) {
    if (re) return re.test(line);
    return line.toLowerCase().includes(raw.toLowerCase());
  }

  function compileHighlightCSS(rules) {
    // Inserta reglas CSS personalizadas según settings
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

  // Go!
  init().catch(console.error);
})();
