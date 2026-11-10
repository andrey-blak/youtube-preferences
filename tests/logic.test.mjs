import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const code = await readFile(new URL("../logic.js", import.meta.url), "utf8");
// vm contexts get built-ins but no host timers/console; provide them here.
// In the browser these are real globals, so logic.js stays environment-agnostic.
const sandbox = vm.createContext({
  console, setInterval, clearInterval, setTimeout, clearTimeout
});
vm.runInContext(code, sandbox);
const { YTLogic } = sandbox;

// The bridge flattens live tracks via getLanguageInfo(); logic works on the
// flat shape, so the test helper produces it directly.
const track = ({ id, name, isOriginal, isDefault }) =>
  ({ id, name, isOriginal, isDefault });

test("DEFAULT_CONFIG exists", () => {
  assert.equal(typeof YTLogic.DEFAULT_CONFIG, "object");
  for (const k of ["disableAutoplay", "selectOriginalAudio", "disableStableVolume",
    "disableAnnotations", "disableAmbientMode", "preventFullscreenAutoplay"])
    assert.equal(YTLogic.DEFAULT_CONFIG[k], true);
  assert.equal(YTLogic.DEFAULT_CONFIG.debug, false);   // logging off by default
});

test("findOriginalTrack: isOriginal flag wins", () => {
  const o = track({ id: "x", name: "Spanish", isOriginal: true });
  assert.equal(YTLogic.findOriginalTrack([track({ id: "a", name: "English" }), o]), o);
});

test("findOriginalTrack: id marker fallback", () => {
  const o = track({ id: "EghvcmlnaW5hb190cmFjaw", name: "Original" });
  assert.equal(YTLogic.findOriginalTrack([o]), o);
});

test("findOriginalTrack: localized-name fallback", () => {
  const o = track({ id: "zz", name: "Оригінальна" });   // uk
  assert.equal(YTLogic.findOriginalTrack([o]), o);
});

test("findOriginalTrack: none → null (never guess another track)", () => {
  assert.equal(YTLogic.findOriginalTrack([track({ id: "d", name: "Deutsch" })]), null);
  assert.equal(YTLogic.findOriginalTrack([]), null);
  assert.equal(YTLogic.findOriginalTrack(undefined), null);
});

test("shouldEnforceFullscreenPause", () => {
  assert.equal(YTLogic.shouldEnforceFullscreenPause(true, true), true);  // was paused, now playing
  assert.equal(YTLogic.shouldEnforceFullscreenPause(true, false), false);
  assert.equal(YTLogic.shouldEnforceFullscreenPause(null, true), false);
});

test("waitUntil resolves true when predicate turns truthy", async () => {
  let n = 0;
  assert.equal(await YTLogic.waitUntil(() => ++n >= 3, { interval: 10, timeout: 1000 }), true);
});

test("waitUntil resolves false on timeout", async () => {
  assert.equal(await YTLogic.waitUntil(() => false, { interval: 10, timeout: 60 }), false);
});

test("waitUntil async predicate supported", async () => {
  assert.equal(await YTLogic.waitUntil(async () => true, { interval: 10, timeout: 500 }), true);
});

// ---- ambient preference (PREF cookie f7 bits) — golden vectors captured from
// the user's live YouTube 2026-11-10: checked f7=100 -> unchecked f7=140. ----
test("applyAmbientPref: matches YouTube's own off-transition bit-for-bit", () => {
  const r = YTLogic.applyAmbientPref("tz=Europe.Kyiv&f5=30000&f7=100", false);
  assert.equal(r.value, "tz=Europe.Kyiv&f5=30000&f7=140");
  assert.equal(r.changed, true);
});

test("applyAmbientPref: idempotent when already off", () => {
  const r = YTLogic.applyAmbientPref("tz=Europe.Kyiv&f5=30000&f7=140", false);
  assert.equal(r.changed, false);
  assert.equal(r.value, "tz=Europe.Kyiv&f5=30000&f7=140");
});

test("applyAmbientPref: creates f7 field when missing", () => {
  const r = YTLogic.applyAmbientPref("tz=Europe.Kyiv", false);
  assert.equal(r.value, "tz=Europe.Kyiv&f7=40");
  assert.equal(r.changed, true);
});

test("applyAmbientPref: on restores bit 190 and keeps 192 + foreign bits", () => {
  assert.equal(YTLogic.applyAmbientPref("f7=140", true).value, "f7=150");
});

test("isAmbientPrefOff", () => {
  assert.equal(YTLogic.isAmbientPrefOff("f7=140"), true);
  assert.equal(YTLogic.isAmbientPrefOff("f7=150"), false); // changed + ON
  assert.equal(YTLogic.isAmbientPrefOff("f7=100"), false); // untouched default (on)
  assert.equal(YTLogic.isAmbientPrefOff(""), false);       // no PREF yet
  assert.equal(YTLogic.isAmbientPrefOff("f7=zz!"), false); // malformed hex → don't claim
});

// Regression guard: content.js runs in the content-script world where the only
// global logic.js contributes is YTLogic. A `const {X} = globalThis` for
// anything else silently yields undefined and disables a feature with no error
// (this exact bug killed stable-volume/ambient/fullscreen in v1.2.0).
test("content.js only destructures globals that actually exist", async () => {
  const src = await readFile(new URL("../content.js", import.meta.url), "utf8");
  const exposed = new Set(["YTLogic"]); // set by logic.js; browser.* is an extension API
  const stmts = src.match(/const \{[^}]*\} = globalThis;/g) ?? [];
  assert.ok(stmts.length > 0, "expected at least one globalThis destructure");
  for (const stmt of stmts) {
    const names = stmt.slice(stmt.indexOf("{") + 1, stmt.indexOf("}"))
      .split(",").map(s => s.trim()).filter(Boolean);
    for (const n of names)
      assert.ok(exposed.has(n), `globalThis.${n} is never exposed — must come from YTLogic`);
  }
});
