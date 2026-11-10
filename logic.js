/* Pure helpers, no DOM.
Loaded as classic script before content.js AND on the options page.
tested in Node via node:vm (tests/logic.test.mjs). */
(function(root) {
  "use strict";

  const DEFAULT_CONFIG = {
    disableAutoplay: true,
    selectOriginalAudio: true,
    disableStableVolume: true,
    disableAnnotations: true,
    disableAmbientMode: true,
    preventFullscreenAutoplay: true,
    debug: false
  };

  // base64("original") inside the protobuf audio-track id. Fallback only.
  const ORIGINAL_ID_MARKER = "EghvcmlnaW5hb";
  // Multilingual "original" words (ImprovedTube-proven set + uk).
  const ORIGINAL_NAME_WORDS = ["original", "originale", "originalny", "originalaudio",
    "origineel", "orijinal", "оригинал", "оригинальная", "оригінальна"
  ];

  function normalizeText(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  // tracks = flattened [{id, name, isOriginal, isDefault}] produced by the bridge. Never returns a non-original track when no original exists.
  function findOriginalTrack(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const byFlag = tracks.find(t => t.isOriginal === true);
    if (byFlag) return byFlag;
    const byMarker = tracks.find(t => String(t.id ?? "").includes(ORIGINAL_ID_MARKER));
    if (byMarker) return byMarker;
    const byName = tracks.find(t =>
      ORIGINAL_NAME_WORDS.some(w => normalizeText(t.name).includes(normalizeText(w))));
    if (byName) return byName;
    return tracks.find(t => t.isDefault === true) ?? null;
  }

  // Poll instead of arbitrary sleeps. predicate may be sync or async.
  function waitUntil(predicate, options = {}) {
    const interval = options.interval ?? 100;
    const timeout = options.timeout ?? 5000;
    return new Promise(resolve => {
      const start = Date.now();
      let busy = false;
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        Promise.resolve().then(predicate).then(ok => {
          busy = false;
          if (ok) {
            clearInterval(timer);
            resolve(true);
          } else if (Date.now() - start >= timeout) {
            clearInterval(timer);
            resolve(false);
          }
        }, () => {
          busy = false;
        });
      }, interval);
      if (options.signal) options.signal.addEventListener("abort",
        () => {
          clearInterval(timer);
          resolve(false);
        }, {
          once: true
        });
    });
  }

  function shouldEnforceFullscreenPause(wasPausedBeforeToggle, isPlayingNow) {
    return wasPausedBeforeToggle === true && isPlayingNow === true;
  }

  // ---- ambient mode preference: PREF cookie, field f7, hex bitfield ----
  /* Governs the html5-player (base.js.
  Ambient checkbox: Sua()=Ba(192)?Ba(190) :default, checkbox handler pr(190,a);pr(192,!0) -> field f7 (id=186+bit).
  Golden transition captured live: f7=100 -> menu toggle OFF -> f7=140.
  NOTE: the newer Polymer menu variant does NOT use these bits (server-side setting; see docs/findings.md) — this is the compatibility layer. */
  const PREF_AMBIENT_FIELD = "f7";
  // setting id 190 (bit 4 of field f7)
  const PREF_AMBIENT_ON = 0x10;
  // setting id 192 (bit 6)
  const PREF_AMBIENT_CHANGED = 0x40;

  function ambientBits(prefValue) {
    for (const kv of String(prefValue ?? "").split("&")) {
      const eq = kv.indexOf("=");
      if (eq < 0) continue;
      if (kv.slice(0, eq) !== PREF_AMBIENT_FIELD) continue;
      const hex = kv.slice(eq + 1);
      if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
      return parseInt(hex, 16);
    }
    // field absent
    return null;
  }

  // Returns {value, changed}: new full PREF value + whether bits differ.
  function applyAmbientPref(prefValue, enabled) {
    const pairs = String(prefValue ?? "").split("&").filter(Boolean);
    let found = false,
      changed = false;
    const out = pairs.map(kv => {
      const eq = kv.indexOf("=");
      if (eq < 0 || kv.slice(0, eq) !== PREF_AMBIENT_FIELD) return kv;
      found = true;
      const hex = kv.slice(eq + 1);
      // malformed: leave untouched
      if (!/^[0-9a-fA-F]+$/.test(hex)) return kv;
      const bits = parseInt(hex, 16);
      const next = enabled ? (bits | PREF_AMBIENT_ON | PREF_AMBIENT_CHANGED) :
        (bits & ~PREF_AMBIENT_ON) | PREF_AMBIENT_CHANGED;
      if (next === bits) return kv;
      changed = true;
      return `${PREF_AMBIENT_FIELD}=${next.toString(16)}`;
    });
    if (!found) {
      out.push(`${PREF_AMBIENT_FIELD}=` +
        ((enabled ? PREF_AMBIENT_ON : 0) | PREF_AMBIENT_CHANGED).toString(16));
      changed = true;
    }
    return {
      value: out.join("&"),
      changed
    };
  }

  function isAmbientPrefOff(prefValue) {
    const bits = ambientBits(prefValue);
    return bits !== null && (bits & PREF_AMBIENT_CHANGED) !== 0 &&
      (bits & PREF_AMBIENT_ON) === 0;
  }

  root.YTLogic = {
    DEFAULT_CONFIG,
    findOriginalTrack,
    waitUntil,
    shouldEnforceFullscreenPause,
    normalizeText,
    applyAmbientPref,
    isAmbientPrefOff
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
