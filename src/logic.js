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
    captionsPolicy: { default: "keep", unlisted: "keep", overrides: {} },
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

  /* Per-language captions policy.
  YouTube's subtitle-translation catalog, captured from a live playerResponse — bare primary subtags only, membership decides default-vs-unlisted routing.
  Keys on TWO candidate languages in priority order:
  1) explicit override for the AUDIO language — "russian audio = off" must hide subtitles even when only English captions exist;
  2) explicit override for the SUBTITLE-track language — catches subtitle-only languages like Klingon (audio is never Klingon);
  3) default when either language is a catalogued code;
  4) unlisted when neither is; keep when nothing is known. */
  const LANGUAGE_CATALOG = Object.freeze({
    aa: 1, ab: 1, af: 1, ak: 1, am: 1, ar: 1, as: 1, ay: 1, az: 1, ba: 1, be: 1, bg: 1, bho: 1,
    bn: 1, bo: 1, br: 1, bs: 1, ca: 1, ceb: 1, co: 1, crs: 1, cs: 1, cy: 1, da: 1, de: 1, dv: 1,
    dz: 1, ee: 1, el: 1, en: 1, eo: 1, es: 1, et: 1, eu: 1, fa: 1, fi: 1, fil: 1, fj: 1, fo: 1,
    fr: 1, fy: 1, ga: 1, gaa: 1, gd: 1, gl: 1, gn: 1, gu: 1, gv: 1, ha: 1, haw: 1, hi: 1, hmn: 1,
    hr: 1, ht: 1, hu: 1, hy: 1, id: 1, ig: 1, is: 1, it: 1, iu: 1, iw: 1, ja: 1, jv: 1, ka: 1,
    kha: 1, kk: 1, kl: 1, km: 1, kn: 1, ko: 1, kri: 1, ku: 1, ky: 1, la: 1, lb: 1, lg: 1, ln: 1,
    lo: 1, lt: 1, lua: 1, luo: 1, lv: 1, mfe: 1, mg: 1, mi: 1, mk: 1, ml: 1, mn: 1, mr: 1, ms: 1,
    mt: 1, my: 1, ne: 1, new: 1, nl: 1, no: 1, nso: 1, ny: 1, oc: 1, om: 1, or: 1, os: 1, pa: 1,
    pam: 1, pl: 1, ps: 1, pt: 1, qu: 1, rn: 1, ro: 1, ru: 1, rw: 1, sa: 1, sd: 1, sg: 1, si: 1,
    sk: 1, sl: 1, sm: 1, sn: 1, so: 1, sq: 1, sr: 1, ss: 1, st: 1, su: 1, sv: 1, sw: 1, ta: 1,
    te: 1, tg: 1, th: 1, ti: 1, tk: 1, tlh: 1, tn: 1, to: 1, tr: 1, ts: 1, tt: 1, tum: 1, ug: 1,
    uk: 1, ur: 1, uz: 1, ve: 1, vi: 1, war: 1, wo: 1, xh: 1, yi: 1, yo: 1, zh: 1, zu: 1
  });

  function decideCaptions(policy, audioLanguageCode, trackLanguageCode, catalog) {
    const audio = audioLanguageCode ? primaryLanguage(audioLanguageCode) : null;
    const track = trackLanguageCode ? primaryLanguage(trackLanguageCode) : null;
    const ovr = (policy && policy.overrides) || {};
    if (audio && (ovr[audio] === "on" || ovr[audio] === "off")) return ovr[audio];
    if (track && (ovr[track] === "on" || ovr[track] === "off")) return ovr[track];
    const known = (c) => c && Object.prototype.hasOwnProperty.call(catalog, c);
    if (known(audio) || known(track)) return policy.default ?? "keep";
    if (audio || track) return policy.unlisted ?? "keep";
    return "keep";
  }

  root.YTLogic = {
    DEFAULT_CONFIG,
    findOriginalTrack,
    waitUntil,
    shouldEnforceFullscreenPause,
    isWatchPage,
    normalizeText,
    primaryLanguage,
    applyAmbientPref,
    isAmbientPrefOff,
    captionTrackIsAnimated,
    pickPreferredCaptionTrack,
    LANGUAGE_CATALOG,
    decideCaptions
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
