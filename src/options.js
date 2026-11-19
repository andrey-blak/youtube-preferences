"use strict";
const LABELS = {
  disableAutoplay: "Disable autoplay",
  preventFullscreenAutoplay: "Never auto-resume on fullscreen enter/exit",
  selectOriginalAudio: "Prefer original audio track",
  disableStableVolume: "Disable stable volume",
  disableAmbientMode: "Disable ambient mode",
  disableAnnotations: "Disable annotations",
  collapseSidebar: "Collapse the left sidebar (all non-watch pages)",
  preferOriginalCaptions: "Prefer original subtitles (never animated)",
  debug: "Verbose debug logging in the console"
};

// Group order matters (user decision): Subtitles then Languages then Advanced last.
// Every boolean key of DEFAULT_CONFIG must appear in exactly one keys array — a source-level test enforces this.
const GROUPS = [
  { title: "Playback", keys: ["disableAutoplay", "preventFullscreenAutoplay"] },
  { title: "Audio", keys: ["selectOriginalAudio", "disableStableVolume"] },
  { title: "Appearance", keys: ["disableAmbientMode", "disableAnnotations"] },
  { title: "Interface", keys: ["collapseSidebar"] },
  { title: "Subtitles", keys: ["preferOriginalCaptions"], policy: true },
  { title: "Languages", overrides: true },
  { title: "Advanced", keys: ["debug"], reset: true }
];

// English language names from codes; engines without full ICU or weird codes fall back to the code.
let displayNames = null;
try {
  displayNames = new Intl.DisplayNames(["en"], {
    type: "language"
  });
} catch (e) {}
function langName(code) {
  let n = null;
  try {
    n = displayNames && displayNames.of(code);
  } catch (e) {}
  return n && n !== code ? n + " (" + code + ")" : code;
}

const POLICY_VALUES = ["keep", "on", "off"];
const POLICY_VALUE_LABELS = {
  keep: "Keep YouTube's setting",
  on: "Show",
  off: "Hide"
};
function makeChoice(value, values, labels) {
  const sel = document.createElement("select");
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = labels ? labels[v] : v;
    if (v === value) o.selected = true;
    sel.append(o);
  }
  return sel;
}

function controlRow(text, control) {
  const row = document.createElement("div");
  row.className = "control-row";
  const lab = document.createElement("label");
  lab.textContent = text;
  row.append(lab, control);
  return row;
}

browser.storage.sync.get(YTLogic.DEFAULT_CONFIG).then(stored => {
  policy = normalizePolicy(stored.captionsPolicy);
  renderAll(stored);
});

function normalizePolicy(p) {
  return {
    default: POLICY_VALUES.includes(p && p.default) ? p.default : "keep",
    unlisted: POLICY_VALUES.includes(p && p.unlisted) ? p.unlisted : "keep",
    overrides: Object.fromEntries(Object.entries((p && p.overrides) || {})
      .filter(([, v]) => v === "on" || v === "off"))
  };
}

function renderAll(stored) {
  const box = document.getElementById("prefs");
  box.textContent = "";
  for (const g of GROUPS) {
    const h = document.createElement("h3");
    h.textContent = g.title;
    h.className = "group-title" + (g.title === "Advanced" ? " advanced-title" : "");
    box.append(h);
    for (const key of g.keys || []) box.append(makeCheckRow(stored, key));
    if (g.policy) box.append(makePolicySelects());
    if (g.overrides) box.append(makeOverridesBlock());
    if (g.reset) box.append(makeResetRow());
  }
  renderOverrideRows();
}

function makeCheckRow(stored, key) {
  const label = document.createElement("label");
  label.className = "check-row";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!stored[key];
  input.addEventListener("change", async () => {
    await browser.storage.sync.set({
      [key]: input.checked
    });
    console.info("[YT Prefs] saved", key, input.checked);
  });
  label.append(input, " " + (LABELS[key] ?? key));
  return label;
}

// ---- captions visibility policy ----
let policy = null;
const rowsBox = () => document.getElementById("policy-overrides");

async function savePolicy() {
  await browser.storage.sync.set({
    captionsPolicy: policy
  });
  console.info("[YT Prefs] saved captionsPolicy", JSON.stringify(policy));
}

function makePolicySelects() {
  const frag = document.createDocumentFragment();
  const def = makeChoice(policy.default, POLICY_VALUES, POLICY_VALUE_LABELS);
  def.addEventListener("change", async () => {
    policy.default = def.value;
    await savePolicy();
  });
  frag.append(controlRow("Known languages without a rule:", def));
  const unl = makeChoice(policy.unlisted, POLICY_VALUES, POLICY_VALUE_LABELS);
  unl.addEventListener("change", async () => {
    policy.unlisted = unl.value;
    await savePolicy();
  });
  frag.append(controlRow("Unlisted / unknown languages:", unl));
  return frag;
}

function makeOverridesBlock() {
  const frag = document.createDocumentFragment();
  const head = document.createElement("div");
  head.className = "override-row override-head sr-only";
  for (const t of ["Language", "Visibility", "Remove"]) {
    const s = document.createElement("span");
    s.textContent = t;
    head.append(s);
  }
  frag.append(head);
  const rows = document.createElement("div");
  rows.id = "policy-overrides";
  frag.append(rows);
  const addBtn = document.createElement("button");
  addBtn.textContent = "+ Add languages";
  addBtn.addEventListener("click", () => openAddDialog());
  frag.append(addBtn);
  return frag;
}

function renderOverrideRows() {
  const rows = rowsBox();
  rows.textContent = "";
  const codes = Object.keys(policy.overrides).sort((a, b) =>
    langName(a).localeCompare(langName(b)));
  if (codes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "None — added languages override the defaults above.";
    rows.append(empty);
    return;
  }
  for (const code of codes) {
    const row = document.createElement("div");
    row.className = "override-row";
    const name = document.createElement("span");
    name.className = "lang-name";
    name.textContent = langName(code);
    const sel = makeChoice(policy.overrides[code], ["on", "off"], {
      on: "Show",
      off: "Hide"
    });
    sel.addEventListener("change", async () => {
      policy.overrides[code] = sel.value;
      await savePolicy();
    });
    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.title = "Remove (back to default)";
    rm.addEventListener("click", async () => {
      delete policy.overrides[code];
      await savePolicy();
      renderOverrideRows();
    });
    row.append(name, sel, rm);
    rows.append(row);
  }
}

// ---- reset ----
function makeResetRow() {
  const btn = document.createElement("button");
  btn.textContent = "Reset to defaults";
  btn.addEventListener("click", async () => {
    if (!confirm("Reset all settings to defaults? This cannot be undone.")) return;
    await browser.storage.sync.clear();
    console.info("[YT Prefs] reset: storage.sync cleared");
    location.reload();
  });
  return btn;
}

// ---- Add-languages dialog ----
// The dialog is a form[method=dialog]: Enter in the filter implicitly submits the first submit button (Add), Esc cancels natively.
// Already-added languages are not listed at all — they cannot be edited here.
function openAddDialog() {
  const dlg = document.getElementById("add-lang-dialog") || createDialogShell();
  const list = dlg.querySelector("#add-lang-list");
  const filter = dlg.querySelector("#add-lang-filter");
  const codes = Object.keys(YTLogic.LANGUAGE_CATALOG)
    .filter(c => !Object.prototype.hasOwnProperty.call(policy.overrides, c))
    .sort((a, b) => langName(a).localeCompare(langName(b)));
  const boxes = [];
  list.textContent = "";
  for (const code of codes) {
    const lab = document.createElement("label");
    lab.className = "lang-option";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = code;
    lab.append(cb, " " + langName(code));
    list.append(lab);
    boxes.push({
      cb,
      lab,
      text: langName(code).toLowerCase() + " " + code
    });
  }
  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    for (const b of boxes) b.lab.hidden = !!q && !b.text.includes(q);
    // The count reflects everything selected, even rows the current filter hides — those still get added.
    dlg.querySelector("#add-lang-count").textContent = String(boxes.filter(b => b.cb.checked).length);
  };
  filter.oninput = applyFilter;
  list.onchange = applyFilter;
  dlg._boxes = boxes;
  filter.value = ""; // never remembered between opens
  applyFilter();
  dlg.showModal();
}

function createDialogShell() {
  const dlg = document.createElement("dialog");
  dlg.id = "add-lang-dialog";
  const form = document.createElement("form");
  form.method = "dialog";
  const h = document.createElement("h3");
  h.textContent = "Add languages";
  const f = document.createElement("input");
  f.id = "add-lang-filter";
  f.type = "search";
  f.placeholder = "Filter (name or code)…";
  const list = document.createElement("div");
  list.id = "add-lang-list";
  const btns = document.createElement("div");
  btns.className = "dialog-buttons";
  // Add FIRST in the DOM = the form's default button (implicit submit on Enter); row-reverse keeps it visually on the right.
  const ok = document.createElement("button");
  ok.type = "submit";
  ok.value = "add";
  const counter = document.createElement("span");
  counter.id = "add-lang-count";
  counter.textContent = "0";
  ok.append("Add (", counter, ")");
  const cancel = document.createElement("button");
  cancel.type = "submit";
  cancel.value = "cancel";
  cancel.textContent = "Cancel";
  btns.append(ok, cancel);
  form.append(h, f, list, btns);
  dlg.append(form);
  document.body.append(dlg);
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "add") return;
    const chosen = (dlg._boxes || []).filter(b => b.cb.checked).map(b => b.cb.value);
    if (!chosen.length) return;
    for (const code of chosen) policy.overrides[code] = "on";
    await savePolicy();
    renderOverrideRows();
  });
  return dlg;
}
