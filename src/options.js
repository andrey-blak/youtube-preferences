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

// ---- segmented radio control ----
/* One click per change, from native radio inputs: arrow-key navigation, tab order, and group semantics are platform behavior, not ARIA theater.
Native radio groups treat all four arrows as intra-group — overridden here: left/right stay intra-group, up/down walk to the adjacent segment control in DOM order.
State = pill background + bold (uniform, so widths never shift) + focus outline; never weight/color changes on toggle.
The native radio is invisible-but-focusable (opacity:0), the text span is the painted segment. */
function makeSegment(groupName, current, options, onPick) {
  const seg = document.createElement("span");
  seg.className = "segment";
  options.forEach((o, idx) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === current;
    const text = document.createElement("span");
    text.textContent = o.label;
    input.addEventListener("change", () => {
      if (input.checked) onPick(o.value);
    });
    input.addEventListener("keydown", e => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const groups = [...document.querySelectorAll(".segment")];
      const next = groups[groups.indexOf(seg) + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      const inputs = next.querySelectorAll("input");
      const target = inputs[idx] || next.querySelector("input:checked") || inputs[0];
      target.focus();
      target.closest("label").scrollIntoView({
        block: "nearest"
      });
    });
    label.append(input, text);
    seg.append(label);
  });
  return seg;
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

const POLICY_VALUES = ["keep", "on", "off"];

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

// Options order fixed by user: Show before Hide everywhere.
const RULE_OPTIONS = [
  { value: "keep", label: "Use YouTube defaults" },
  { value: "on", label: "Show" },
  { value: "off", label: "Hide" }
];
const TOGGLE_OPTIONS = [
  { value: "on", label: "Show" },
  { value: "off", label: "Hide" }
];

function makePolicySelects() {
  const frag = document.createDocumentFragment();
  frag.append(controlRow("Known languages without a rule:",
    makeSegment("pol-default", policy.default, RULE_OPTIONS, async v => {
      policy.default = v;
      await savePolicy();
    })));
  frag.append(controlRow("Unlisted / unknown languages:",
    makeSegment("pol-unlisted", policy.unlisted, RULE_OPTIONS, async v => {
      policy.unlisted = v;
      await savePolicy();
    })));
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
    const seg = makeSegment("ovr-" + code, policy.overrides[code], TOGGLE_OPTIONS, async v => {
      policy.overrides[code] = v;
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
    row.append(name, seg, rm);
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
  dlg.setAttribute("aria-label", "Add languages");

  // Keyboard model (listbox conventions): the checkbox list is not a native radio group,
  // so arrows move focus between VISIBLE options explicitly; Space toggles natively once an option is focused.
  const visibleBoxes = () => (dlg._boxes || []).filter(b => !b.lab.hidden);
  const focusBox = b => {
    if (!b) return;
    b.cb.focus();
    b.lab.scrollIntoView({
      block: "nearest"
    });
  };
  f.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusBox(visibleBoxes()[0]);
    }
  });
  list.addEventListener("keydown", e => {
    const v = visibleBoxes();
    if (!v.length) return;
    const idx = v.findIndex(b => b.cb === e.target);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusBox(idx < 0 ? v[0] : v[Math.min(idx + 1, v.length - 1)]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (idx <= 0) f.focus();
      else focusBox(v[idx - 1]);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusBox(v[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      focusBox(v[v.length - 1]);
    }
  });

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
