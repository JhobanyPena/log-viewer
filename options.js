const DEFAULTS = {
  refreshSeconds: 5,
  tailKB: 512,
  followTail: true,
  onlyMatches: false,
  highlightRules: [
    {
      name: "Ejecución de estrategia",
      pattern: "ig_strategy: Ejecución de estrategia",
      flags: "i",
      className: "hl-ejecucion",
      textColor: "#111111",
      bgColor: "#fff1a8"
    }
  ]
};

const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

async function load() {
  const data = await new Promise(res => chrome.storage.sync.get(DEFAULTS, v => res({ ...DEFAULTS, ...v })));
  $("#refreshSeconds").value = data.refreshSeconds;
  $("#tailKB").value = data.tailKB;
  $("#followTail").checked = data.followTail;
  $("#onlyMatches").checked = data.onlyMatches;

  const rulesWrap = $("#rules");
  rulesWrap.innerHTML = "";
  for (const r of data.highlightRules) addRuleRow(r);
}

function addRuleRow(r={}) {
  const tpl = $("#ruleRow").content.cloneNode(true);
  const row = tpl.querySelector(".rule");
  row.querySelector(".r-name").value = r.name || "";
  row.querySelector(".r-pattern").value = r.pattern || "";
  row.querySelector(".r-flags").value = r.flags || "";
  row.querySelector(".r-class").value = r.className || "";
  row.querySelector(".r-bg").value = r.bgColor || "#fff1a8";
  row.querySelector(".r-fg").value = r.textColor || "#111111";
  row.querySelector(".r-del").addEventListener("click", () => row.remove());
  $("#rules").appendChild(row);
}

async function save() {
  const rules = $$(".rule").map(row => ({
    name: row.querySelector(".r-name").value.trim(),
    pattern: row.querySelector(".r-pattern").value.trim(),
    flags: row.querySelector(".r-flags").value.trim(),
    className: row.querySelector(".r-class").value.trim(),
    bgColor: row.querySelector(".r-bg").value,
    textColor: row.querySelector(".r-fg").value
  })).filter(r => r.pattern);

  const payload = {
    refreshSeconds: Math.max(1, Number($("#refreshSeconds").value || 5)),
    tailKB: Math.max(1, Number($("#tailKB").value || 512)),
    followTail: $("#followTail").checked,
    onlyMatches: $("#onlyMatches").checked,
    highlightRules: rules.length ? rules : DEFAULTS.highlightRules
  };

  await new Promise(res => chrome.storage.sync.set(payload, res));
  const st = $("#status");
  st.textContent = "Guardado ✓";
  setTimeout(() => st.textContent = "", 1500);
}

$("#addRule").addEventListener("click", () => addRuleRow());
$("#save").addEventListener("click", save);

document.addEventListener("DOMContentLoaded", load);
