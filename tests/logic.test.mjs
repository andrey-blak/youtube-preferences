import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const code = await readFile(new URL("../src/logic.js", import.meta.url), "utf8");
// vm contexts get built-ins but no host timers/console/URL; provide them here.
// In the browser these are real globals, so logic.js stays environment-agnostic.
const sandbox = vm.createContext({
  console, setInterval, clearInterval, setTimeout, clearTimeout, URL
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
    "disableAnnotations", "disableAmbientMode", "preventFullscreenAutoplay",
    "collapseSidebar", "preferOriginalCaptions"])
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

// ---- sidebar collapse (feature B): pure watch-page predicate ----
test("isWatchPage: /watch and /live only", () => {
  assert.equal(YTLogic.isWatchPage("https://www.youtube.com/watch?v=x&list=y"), true);
  assert.equal(YTLogic.isWatchPage("https://www.youtube.com/live/abc123"), true);
  assert.equal(YTLogic.isWatchPage("https://www.youtube.com/results?search_query=asd"), false);
  assert.equal(YTLogic.isWatchPage("https://www.youtube.com/"), false);
  assert.equal(YTLogic.isWatchPage("https://www.youtube.com/feed/subscriptions"), false);
  assert.equal(YTLogic.isWatchPage("https://www.youtube.com/shorts/xyz"), false);
  assert.equal(YTLogic.isWatchPage("not a url"), false);
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

// ---- captions style (feature C): Animated vs Standard vs auto-generated ----
// Vectors mirror the live video pi3hXvj2A4g.
// The words "Animated"/"Standard" survive localization in trackName and in names.
// The legacy auto-generated track has kind:"asr" and vssId "a.<lang>".
test("captionTrackIsAnimated: by trackName or localized name suffix", () => {
  assert.equal(YTLogic.captionTrackIsAnimated({ trackName: "Animated" }), true);
  assert.equal(YTLogic.captionTrackIsAnimated({ name: "Английский - Animated" }), true);
  assert.equal(YTLogic.captionTrackIsAnimated({ trackName: "Standard" }), false);
  assert.equal(YTLogic.captionTrackIsAnimated({ name: "Английский (создано автоматически)" }), false);
  assert.equal(YTLogic.captionTrackIsAnimated(null), false);
});

test("pickPreferredCaptionTrack: Standard wins over auto-generated, both over nothing", () => {
  const E = t => ({ languageCode: "en", ...t });
  const tracks = [
    E({ kind: "asr", vssId: "a.en", name: "Английский (создано автоматически)" }),
    E({ vssId: ".en.x1", trackName: "Animated", name: "Английский - Animated" }),
    E({ vssId: ".en.x2", trackName: "Standard", name: "Английский - Standard" })
  ];
  assert.equal(YTLogic.pickPreferredCaptionTrack(tracks, "en", null).trackName, "Standard");
  const noStd = tracks.filter(t => t.trackName !== "Standard");
  assert.equal(YTLogic.pickPreferredCaptionTrack(noStd, "en", null).kind, "asr");
  // Animated only -> null (feature skips silently)
  assert.equal(YTLogic.pickPreferredCaptionTrack(
    [E({ trackName: "Animated", vssId: ".en.x1" })], "en", null), null);
  // other language has tracks, wanted language does not -> null
  assert.equal(YTLogic.pickPreferredCaptionTrack(tracks, "fr", "de"), null);
});

// ---- preferred-language caption selection (feature D):
// subtitles in the ORIGINAL AUDIO language win; within a language:
// manual (non-generated) > Standard > auto-generated; Animated is never the answer.
// Live case: Russian-audio video offering ru + en auto-generated captions —
// YouTube picks English, we must pick Russian. ----
test("pickPreferredCaptionTrack: original-audio language first", () => {
  const T = (languageCode, extra) => ({ languageCode, ...extra });
  const tracks = [
    T("en", { kind: "asr", vssId: "a.en" }),
    T("ru", { kind: "asr", vssId: "a.ru" }),
    T("ru", { trackName: "Animated", vssId: ".ru.an" }),
    T("ru", { trackName: "Standard", vssId: ".ru.st" })
  ];
  const pick = YTLogic.pickPreferredCaptionTrack(tracks, "ru", "en");
  assert.equal(pick.vssId, ".ru.st");        // ru beats en, Standard beats asr
  assert.equal(YTLogic.pickPreferredCaptionTrack(tracks, null, "en").vssId, "a.en");
  // no ru tracks at all -> fallback language used
  assert.equal(YTLogic.pickPreferredCaptionTrack(
    tracks.filter(t => t.languageCode !== "ru"), "ru", "en").vssId, "a.en");
  // nothing in either language -> null
  assert.equal(YTLogic.pickPreferredCaptionTrack(tracks, "fr", "de"), null);
});

test("pickPreferredCaptionTrack: manual captions beat Standard", () => {
  const tracks = [
    { languageCode: "ru", trackName: "Standard", vssId: ".ru.st" },
    { languageCode: "ru", vssId: ".ru", name: "Русские" }            // uploaded by creator
  ];
  assert.equal(YTLogic.pickPreferredCaptionTrack(tracks, "ru", "en").vssId, ".ru");
});

test("pickPreferredCaptionTrack: Animated never wins even if only option", () => {
  assert.equal(YTLogic.pickPreferredCaptionTrack(
    [{ languageCode: "ru", trackName: "Animated", vssId: ".ru.an" }], "ru", null), null);
});

test("pickPreferredCaptionTrack: region subtags normalize (en audio matches en-US track)", () => {
  const tracks = [
    { languageCode: "en-US", kind: "asr", vssId: "a.en-US" },
    { languageCode: "ru", kind: "asr", vssId: "a.ru" }
  ];
  assert.equal(YTLogic.pickPreferredCaptionTrack(tracks, "en", null).languageCode, "en-US");
  assert.equal(YTLogic.pickPreferredCaptionTrack(tracks, "ru", null).vssId, "a.ru");
  // audio "en-US" must still match the "en-US" track
  assert.equal(YTLogic.pickPreferredCaptionTrack(tracks, "en-US", null).languageCode, "en-US");
});

// Regression guard: content.js runs in the content-script world where the only
// global logic.js contributes is YTLogic. A `const {X} = globalThis` for
// anything else silently yields undefined and disables a feature with no error
// (this exact bug killed stable-volume/ambient/fullscreen in v1.2.0).
test("content.js only destructures globals that actually exist", async () => {
  const src = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
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
