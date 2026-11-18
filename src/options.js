"use strict";
const LABELS = {
  disableAutoplay: "Keep autoplay OFF",
  selectOriginalAudio: "Always select the original Audio track",
  disableStableVolume: "Keep Stable Volume OFF",
  disableAnnotations: "Keep Annotations OFF",
  disableAmbientMode: "Ambient Mode OFF",
  preventFullscreenAutoplay: "Never auto-resume on fullscreen enter/exit",
  collapseSidebar: "Collapse the left sidebar (all non-watch pages)",
  preferOriginalCaptions: "Prefer original subtitles (never Animated)",
  debug: "Verbose debug logging in the console"
};

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

browser.storage.local.get(YTLogic.DEFAULT_CONFIG).then(stored => {
  // ---- boolean feature checkboxes ----
  const box = document.getElementById("prefs");
  for (const key of Object.keys(YTLogic.DEFAULT_CONFIG)) {
    if (typeof YTLogic.DEFAULT_CONFIG[key] !== "boolean") continue;
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!stored[key];
    input.addEventListener("change", async () => {
      await browser.storage.local.set({
        [key]: input.checked
      });
      console.info("[YT Prefs] saved", key, input.checked);
    });
    label.append(input, " " + (LABELS[key] ?? key));
    box.append(label);
  }
  buildCaptionsPolicy(normalizePolicy(stored.captionsPolicy));
});

function normalizePolicy(p) {
  return {
    default: POLICY_VALUES.includes(p && p.default) ? p.default : "keep",
    unlisted: POLICY_VALUES.includes(p && p.unlisted) ? p.unlisted : "keep",
    overrides: Object.fromEntries(Object.entries((p && p.overrides) || {})
      .filter(([, v]) => v === "on" || v === "off"))
  };
}

// ---- "Show subtitles" policy section ----
let policy = null;
const rowsBox = () => document.getElementById("policy-overrides");

async function savePolicy() {
  await browser.storage.local.set({
    captionsPolicy: policy
  });
  console.info("[YT Prefs] saved captionsPolicy", JSON.stringify(policy));
}

function buildCaptionsPolicy(initial) {
  policy = initial;
  const fs = document.createElement("fieldset");
  const leg = document.createElement("legend");
  leg.textContent = "Show subtitles";
  fs.append(leg);

  for (const [id, text] of [
      ["pol-default", "Default for languages on the list:"],
      ["pol-unlisted", "Other / unlisted languages:"]
    ]) {
    const row = document.createElement("div");
    row.className = "policy-row";
    const lab = document.createElement("label");
    lab.textContent = text;
    const sel = makeChoice(policy[id === "pol-default" ? "default" : "unlisted"],
      POLICY_VALUES, {
        keep: "Keep (leave YouTube alone)",
        on: "Show",
        off: "Hide"
      });
    sel.id = id;
    sel.addEventListener("change", async () => {
      policy[id === "pol-default" ? "default" : "unlisted"] = sel.value;
      await savePolicy();
    });
    row.append(lab, sel);
    fs.append(row);
  }

  const head = document.createElement("div");
  head.className = "policy-subhead";
  head.textContent = "Language overrides:";
  fs.append(head);
  const rows = document.createElement("div");
  rows.id = "policy-overrides";
  fs.append(rows);

  const addBtn = document.createElement("button");
  addBtn.textContent = "+ Add languages";
  addBtn.addEventListener("click", () => openAddDialog());
  fs.append(addBtn);

  document.getElementById("prefs").append(fs);
  renderOverrideRows();
}

function renderOverrideRows() {
  const rows = rowsBox();
  rows.textContent = "";
  const codes = Object.keys(policy.overrides).sort((a, b) =>
    langName(a).localeCompare(langName(b)));
  if (codes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "None — added languages override the default above.";
    rows.append(empty);
    return;
  }
  for (const code of codes) {
    const row = document.createElement("div");
    row.className = "policy-row";
    const name = document.createElement("span");
    name.className = "lang-name";
    name.textContent = langName(code);
    const sel = makeChoice(policy.overrides[code], ["on", "off"], {
      on: "On",
      off: "Off"
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

// ---- Add-languages dialog ----
function openAddDialog() {
  const dlg = document.getElementById("add-lang-dialog") || createDialogShell();
  const list = dlg.querySelector("#add-lang-list");
  const filter = dlg.querySelector("#add-lang-filter");
  const counter = dlg.querySelector("#add-lang-count");
  const codes = Object.keys(YTLogic.LANGUAGE_CATALOG).sort((a, b) =>
    langName(a).localeCompare(langName(b)));
  const boxes = [];
  list.textContent = "";
  for (const code of codes) {
    const lab = document.createElement("label");
    lab.className = "lang-option";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = code;
    cb.disabled = Object.prototype.hasOwnProperty.call(policy.overrides, code);
    if (cb.disabled) lab.classList.add("existing");
    lab.append(cb, " " + langName(code) + (cb.disabled ? " — already added" : ""));
    list.append(lab);
    boxes.push({
      cb,
      lab,
      text: langName(code).toLowerCase() + " " + code
    });
  }
  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    let n = 0;
    for (const b of boxes) {
      const hit = !q || b.text.includes(q);
      b.lab.hidden = !hit;
      if (hit && b.cb.checked && !b.cb.disabled) n++;
    }
    counter.textContent = String(n);
  };
  filter.oninput = applyFilter;
  list.onchange = applyFilter;
  applyFilter();
  dlg.returnValue = "";
  dlg.showModal();
  dlg.querySelector("#add-lang-confirm").onclick = async () => {
    const chosen = boxes.filter(b => b.cb.checked && !b.cb.disabled).map(b => b.cb.value);
    if (chosen.length) {
      for (const code of chosen) policy.overrides[code] = "on";
      await savePolicy();
      renderOverrideRows();
    }
    dlg.close();
  };
  dlg.querySelector("#add-lang-cancel").onclick = () => dlg.close();
}

function createDialogShell() {
  const dlg = document.createElement("dialog");
  dlg.id = "add-lang-dialog";
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
  const ok = document.createElement("button");
  ok.id = "add-lang-confirm";
  const cancel = document.createElement("button");
  cancel.id = "add-lang-cancel";
  cancel.textContent = "Cancel";
  btns.append(cancel, ok);
  const counter = document.createElement("span");
  counter.id = "add-lang-count";
  counter.textContent = "0";
  ok.append("Add (", counter, ")");
  dlg.append(h, f, list, btns);
  document.body.append(dlg);
  return dlg;
}
