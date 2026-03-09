(() => {
  "use strict";

  // ==========================================
  // CONFIGURACIÓN – Ajustar según tu entorno
  // ==========================================
  const CONFIG = {
    storageAccount: "stsp500prodeastus",
    container: "logs",
    get baseUrl() {
      return `https://${this.storageAccount}.blob.core.windows.net/${this.container}`;
    },
    get listUrl() {
      return `${this.baseUrl}?restype=container&comp=list`;
    },
    blobUrl(name) {
      return `${this.baseUrl}/${encodeURIComponent(name)}`;
    },
  };

  // ==========================================
  // DEFAULTS
  // ==========================================
  const DEFAULTS = {
    refreshMinutes: 5,
    refreshInitialDelay: 2,
    refreshRetryDelay: 30,
    followTail: true,
    onlyMatches: false,
    filterText: "",
    searchHistory: [],
    selectedFile: "",
    highlightRules: [
      { pattern: "Ejecución de estrategia", textColor: "#111", bgColor: "#fff1a8" },
      { pattern: "Stop Loss",               textColor: "#111", bgColor: "#d95f73" },
      { pattern: "Opening",                 textColor: "#111", bgColor: "#5f7bce" },
      { pattern: "Take Profit",             textColor: "#111", bgColor: "#7dbf78" },
    ],
  };

  // ==========================================
  // localStorage helpers (reemplaza chrome.storage)
  // ==========================================
  const STORAGE_KEY = "blt-settings";

  function getSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULTS };
  }

  function saveSettings(patch) {
    try {
      const current = getSettings();
      const merged = { ...current, ...patch };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch { /* ignore */ }
  }

  // ==========================================
  // State
  // ==========================================
  const state = {
    settings: { ...DEFAULTS },
    timerId: null,
    retryTimerId: null,
    initialDelayTimerId: null,
    buffer: "",
    paused: false,

    // Search
    hitNodes: [],
    activeHitIdx: 0,
    sizeBytes: 0,

    // Conditional fetch
    lastEtag: null,
    lastModified: null,

    // Concurrency
    inFlight: false,
    abort: null,

    // Blob files list
    files: [],
    filesLoading: false,
  };

  // ==========================================
  // Helpers
  // ==========================================
  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    s = (s ?? "").toString();
    return s.replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function toRegex(input) {
    if (!input) return null;
    const m = input.match(/^\/(.*)\/([gimsuy]*)$/);
    if (m) {
      try { return new RegExp(m[1], m[2]); } catch { return null; }
    }
    return null;
  }

  function testFilter(line, re, raw) {
    if (re) {
      if (re.global) re.lastIndex = 0;
      return re.test(line);
    }
    return line.toLowerCase().includes(raw.toLowerCase());
  }

  function textSizeBytes(str) {
    try { return new TextEncoder().encode(str).length; } catch { return (str ?? "").length; }
  }

  function compileRules(rules) {
    const out = [];
    for (const r of (rules || [])) {
      const pattern = (r.pattern || "").trim();
      if (!pattern) continue;
      const regexMatch = pattern.match(/^\/(.*)\/([gimsuy]*)$/);
      try {
        if (regexMatch) {
          out.push({ re: new RegExp(regexMatch[1], regexMatch[2] || ""), className: `hl-rule-${out.length}` });
        } else {
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          out.push({ re: new RegExp(escaped, "i"), className: `hl-rule-${out.length}` });
        }
      } catch { /* ignore invalid */ }
    }
    return out;
  }

  function msUntilNextTick(intervalMinutes) {
    const now = Date.now();
    const intervalMs = intervalMinutes * 60 * 1000;
    const next = Math.ceil(now / intervalMs) * intervalMs;
    const delay = next - now;
    return delay < 500 ? intervalMs : delay;
  }

  // ==========================================
  // Azure Blob Storage – List blobs
  // ==========================================
  async function listBlobs() {
    state.filesLoading = true;
    const sel = $("blt-file-select");
    if (sel) {
      sel.innerHTML = '<option value="">Cargando archivos…</option>';
      sel.disabled = true;
    }

    try {
      let allBlobs = [];
      let marker = "";

      // Paginated listing
      do {
        let url = CONFIG.listUrl;
        if (marker) url += `&marker=${encodeURIComponent(marker)}`;

        const resp = await fetch(url, {
          headers: { "x-ms-version": "2020-10-02" },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

        const xml = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, "application/xml");

        // Parse blob names
        const blobs = doc.querySelectorAll("Blob > Name");
        blobs.forEach(b => {
          const name = b.textContent.trim();
          if (name.endsWith(".log") || name.endsWith(".log.txt")) {
            allBlobs.push(name);
          }
        });

        // Check for next marker
        const nextMarker = doc.querySelector("NextMarker");
        marker = nextMarker ? nextMarker.textContent.trim() : "";
      } while (marker);

      // Sort: most recent files first (by name, which includes date)
      allBlobs.sort((a, b) => b.localeCompare(a));

      state.files = allBlobs;
      populateFileSelector();
    } catch (err) {
      console.error("Error listing blobs:", err);
      if (sel) {
        sel.innerHTML = '<option value="">Error al cargar archivos</option>';
        sel.disabled = false;
      }
      $("blt-note").textContent = `⚠️ Error listando blobs: ${err.message}`;
    } finally {
      state.filesLoading = false;
    }
  }

  function populateFileSelector() {
    const sel = $("blt-file-select");
    if (!sel || !state.files.length) {
      if (sel) sel.innerHTML = '<option value="">No se encontraron archivos</option>';
      return;
    }

    sel.innerHTML = state.files
      .map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`)
      .join("");
    sel.disabled = false;

    // Restore previously selected file or select first
    const saved = state.settings.selectedFile;
    if (saved && state.files.includes(saved)) {
      sel.value = saved;
    } else {
      sel.value = state.files[0];
    }

    // Trigger load
    onFileChanged();
  }

  function onFileChanged() {
    const sel = $("blt-file-select");
    const file = sel ? sel.value : "";
    if (!file) return;

    state.settings.selectedFile = file;
    saveSettings({ selectedFile: file });

    // Reset state for new file
    state.buffer = "";
    state.sizeBytes = 0;
    state.lastEtag = null;
    state.lastModified = null;
    state.hitNodes = [];
    state.activeHitIdx = 0;

    const logEl = $("blt-log");
    if (logEl) {
      logEl.innerHTML = '<div class="blt-loading"><div class="blt-spinner"></div>Cargando log…</div>';
    }

    // Fetch the file
    refresh(true).catch(console.error);

    // Restart timer for new file
    startTimerLoop();
  }

  function getCurrentFileUrl() {
    const sel = $("blt-file-select");
    const file = sel ? sel.value : "";
    if (!file) return null;
    return CONFIG.blobUrl(file);
  }

  // ==========================================
  // Init
  // ==========================================
  async function init() {
    state.settings = getSettings();
    wireEvents();
    applySettingsToUI();
    compileHighlightCSS(state.settings.highlightRules);
    loadRulesIntoOptions();

    // List blobs and load the first/selected file
    await listBlobs();
  }

  function wireEvents() {
    // File selector
    $("blt-file-select").addEventListener("change", onFileChanged);
    $("blt-reload-files").addEventListener("click", () => listBlobs());

    // Viewer controls
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

    // Options
    $("blt-addRule").addEventListener("click", () => addRuleRow());
    $("blt-saveRules").addEventListener("click", saveRulesFromOptions);

    // Scroll tracking
    const logEl = $("blt-log");
    logEl.addEventListener("scroll", () => {
      const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 20;
      if (!nearBottom && $("blt-follow").checked) {
        $("blt-follow").checked = false;
        state.settings.followTail = false;
        saveSettings({ followTail: false });
      }
    });

    // Search history
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

  function applySettingsToUI() {
    $("blt-refresh").value = state.settings.refreshMinutes;
    $("blt-follow").checked = state.settings.followTail;
    $("blt-only").checked = state.settings.onlyMatches;
    $("blt-filter").value = state.settings.filterText;
  }

  // ==========================================
  // Timer / Auto-refresh
  // ==========================================
  function startTimerLoop() {
    if (state.timerId) clearTimeout(state.timerId);
    if (state.retryTimerId) clearTimeout(state.retryTimerId);
    if (state.initialDelayTimerId) clearTimeout(state.initialDelayTimerId);

    const tick = () => {
      if (state.paused) {
        const mins = Math.max(1, Number(state.settings.refreshMinutes));
        const delay = msUntilNextTick(mins);
        state.timerId = setTimeout(tick, delay);
        updateNextRefreshLabel(delay);
        return;
      }

      const initialDelay = Math.max(0, Number(state.settings.refreshInitialDelay)) * 1000;

      state.initialDelayTimerId = setTimeout(async () => {
        await refresh(false).catch(console.error);
        if (!state.paused) $("blt-note").textContent = "Esperando registros...";
        scheduleRetry();
      }, initialDelay);

      const mins = Math.max(1, Number(state.settings.refreshMinutes));
      const delay = msUntilNextTick(mins);
      state.timerId = setTimeout(tick, delay);
      updateNextRefreshLabel(delay);
    };

    const mins = Math.max(1, Number(state.settings.refreshMinutes));
    const firstDelay = msUntilNextTick(mins);
    updateNextRefreshLabel(firstDelay);
    state.timerId = setTimeout(tick, firstDelay);
  }

  function scheduleRetry() {
    if (state.retryTimerId) clearTimeout(state.retryTimerId);
    if (state.paused) return;
    const retryDelay = Math.max(10, Number(state.settings.refreshRetryDelay)) * 1000;
    state.retryTimerId = setTimeout(async () => {
      if (!state.paused) await refresh(false).catch(console.error);
    }, retryDelay);
  }

  function updateNextRefreshLabel(delayMs) {
    const el = $("blt-next-refresh");
    if (!el) return;
    if (state.paused) { el.textContent = ""; return; }
    const nextTime = new Date(Date.now() + delayMs);
    el.textContent = `Próxima: ${nextTime.toLocaleTimeString()}`;
  }

  // ==========================================
  // Event handlers
  // ==========================================
  function onRefreshChanged(e) {
    const allowed = [1, 5, 15, 30, 60];
    const v = allowed.includes(Number(e.target.value)) ? Number(e.target.value) : 5;
    state.settings.refreshMinutes = v;
    saveSettings({ refreshMinutes: v });
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
    const nextEl = $("blt-next-refresh");
    if (nextEl) nextEl.textContent = state.paused ? "" : "";
    if (state.paused) {
      if (state.retryTimerId) clearTimeout(state.retryTimerId);
      if (state.initialDelayTimerId) clearTimeout(state.initialDelayTimerId);
    } else {
      startTimerLoop();
    }
  }

  // ==========================================
  // Refresh (conditional fetch)
  // ==========================================
  async function refresh(initial) {
    if (state.inFlight) return;
    state.inFlight = true;

    state.abort?.abort();
    const ac = new AbortController();
    state.abort = ac;

    const url = getCurrentFileUrl();
    if (!url) {
      state.inFlight = false;
      return;
    }

    try {
      $("blt-note").textContent = state.paused ? "⏸️ Pausado" : "Actualizando…";

      const headers = {};
      if (state.lastEtag) {
        headers["If-None-Match"] = state.lastEtag;
      } else if (state.lastModified) {
        headers["If-Modified-Since"] = state.lastModified;
      }

      const resp = await fetch(url, {
        method: "GET",
        cache: "no-cache",
        headers,
        signal: ac.signal,
      });

      if (resp.status === 304) {
        updateStatus(state.sizeBytes, true);
        return;
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

      const text = await resp.text();

      const newEtag = resp.headers.get("etag");
      const newModified = resp.headers.get("last-modified");
      if (newEtag) state.lastEtag = newEtag;
      if (newModified) state.lastModified = newModified;

      const sizeHeader = resp.headers.get("content-length");
      const size = sizeHeader ? parseInt(sizeHeader, 10) : textSizeBytes(text);

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

  // ==========================================
  // Render
  // ==========================================
  function render(scrollToActive = false) {
    const logEl = $("blt-log");
    const filter = state.settings.filterText.trim();
    const re = toRegex(filter);
    const rules = compileRules(state.settings.highlightRules);

    const lines = (state.buffer || "").split(/\r?\n/);
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

    // Hit navigation
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

  function scrollToBottom() {
    const el = $("blt-log");
    el.scrollTop = el.scrollHeight + 1000;
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

  // ==========================================
  // Tabs
  // ==========================================
  function switchTab(which) {
    const isView = which === "view";
    $("blt-tab-view").classList.toggle("is-active", isView);
    $("blt-tab-options").classList.toggle("is-active", !isView);
    $("blt-view").classList.toggle("is-active", isView);
    $("blt-options").classList.toggle("is-active", !isView);
  }

  // ==========================================
  // Options – Highlight rules
  // ==========================================
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

  function saveRulesFromOptions() {
    const rows = Array.from(document.querySelectorAll("#blt-rules .rule"));
    const rules = rows
      .map(row => ({
        pattern:   row.querySelector(".r-pattern").value.trim(),
        bgColor:   row.querySelector(".r-bg").value,
        textColor: row.querySelector(".r-fg").value,
      }))
      .filter(r => r.pattern);

    const payload = { highlightRules: rules.length ? rules : DEFAULTS.highlightRules };
    saveSettings(payload);
    state.settings.highlightRules = payload.highlightRules;
    removeDynamicCSS();
    compileHighlightCSS(state.settings.highlightRules);
    render();

    const st = $("blt-opt-status");
    st.textContent = "Guardado ✓";
    setTimeout(() => (st.textContent = ""), 1500);
  }

  // ==========================================
  // Dynamic highlight CSS
  // ==========================================
  function compileHighlightCSS(rules) {
    const style = document.createElement("style");
    style.id = "blt-dynamic-rules";
    let css = "";
    rules?.forEach((r, index) => {
      const cls = `hl-rule-${index}`;
      const bg = r.bgColor || "#fff1a8";
      const fg = r.textColor || "#111";
      css += `.${cls}{background:${bg};color:${fg};border-left:4px solid rgba(0,0,0,.2)}\n`;
    });
    style.textContent = css;
    document.head.appendChild(style);
  }

  function removeDynamicCSS() {
    const el = document.getElementById("blt-dynamic-rules");
    if (el) el.remove();
  }

  // ==========================================
  // Search history
  // ==========================================
  function getHistory() {
    return Array.isArray(state.settings.searchHistory) ? state.settings.searchHistory : [];
  }

  function setHistory(arr) {
    state.settings.searchHistory = arr;
    saveSettings({ searchHistory: arr });
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
    const html =
      arr
        .map(item => `<button type="button" class="blt-history-item" title="Usar búsqueda">${escapeHtml(item)}</button>`)
        .join("") +
      `<button type="button" class="blt-history-clear" title="Borrar historial">Limpiar historial</button>`;
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

    hist.querySelector(".blt-history-clear")?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      setHistory([]);
      hideHistoryDropdown();
    });
  }

  // ==========================================
  // Boot
  // ==========================================
  init().catch(console.error);
})();
