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
    collapseSidebar: true,
    preferOriginalCaptions: true,
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

  // Video-first pages (player fills the page, guide is a drawer): the sidebar
  // feature must leave these alone. /live is the live equivalent of /watch.
  function isWatchPage(href) {
    try {
      const p = new URL(href).pathname;
      return p === "/watch" || p.startsWith("/live/");
    } catch {
      return false;
    }
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

  // ---- captions style: Animated vs Standard vs auto-generated (feature C) ----
  /* Track list from player.getOption("captions","tracklist",{includeAsr:true}).
  The literal words "Animated"/"Standard" are NOT localized — verified on a live video served in a non-English UI:
  the language part of the name was translated, the "Animated" suffix stayed English.
  trackName is the clean field, name is fallback.
  Legacy auto-generated: kind === "asr" / vssId "a.<lang>".
  Manual uploads match neither and are still a valid non-animated answer. */
  function captionTrackIsAnimated(track) {
    if (!track) return false;
    return normalizeText(track.trackName).includes("animated") ||
      normalizeText(track.name).includes("animated");
  }

  // Preference tiers inside one language (lower wins). Animated never wins at all:
  // manual upload beats "Standard", which beats the legacy auto-generated track.
  function captionTrackScore(track) {
    if (captionTrackIsAnimated(track)) return -1; // excluded
    const name = normalizeText(`${track.trackName ?? ""} ${track.name ?? ""}`);
    if (name.includes("standard")) return 1;
    const generated = track.kind === "asr" ||
      String(track.vssId ?? track.vss_id ?? "").startsWith("a.");
    if (generated) return 2;
    return 0;
  }

  // Language matching ignores region subtags: audio "en-US" matches track "en" and vice versa.
  function primaryLanguage(code) {
    return String(code ?? "").split("-")[0].toLowerCase();
  }

  // Best track of one language, or null. Only explicit languages are consulted.
  function pickCaptionTrackForLanguage(tracks, languageCode) {
    if (!Array.isArray(tracks) || !languageCode) return null;
    const wanted = primaryLanguage(languageCode);
    let best = null;
    for (const t of tracks) {
      if (!t || primaryLanguage(t.languageCode) !== wanted) continue;
      const score = captionTrackScore(t);
      if (score >= 0 && (best === null || score < captionTrackScore(best))) best = t;
    }
    return best;
  }

  /* Feature C+D in one selection:
  subtitles matching the ORIGINAL AUDIO language are preferred first,
  otherwise the current/YouTube-selected language is the fallback.
  Within the language: manual > Standard > auto-generated, Animated never wins.
  Null result means "skip silently" (nothing suitable exists). */
  function pickPreferredCaptionTrack(tracks, preferredLanguageCode, fallbackLanguageCode) {
    return pickCaptionTrackForLanguage(tracks, preferredLanguageCode) ||
      pickCaptionTrackForLanguage(tracks, fallbackLanguageCode);
  }

  root.YTLogic = {
    DEFAULT_CONFIG,
    findOriginalTrack,
    waitUntil,
    shouldEnforceFullscreenPause,
    isWatchPage,
    normalizeText,
    applyAmbientPref,
    isAmbientPrefOff,
    captionTrackIsAnimated,
    pickPreferredCaptionTrack
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
