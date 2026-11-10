/* Orchestrator (content-script world). Rules:
   - No player JS method calls from here (Xray): all go through page-bridge.js.
   - Feature-unavailable is a quiet skip, never a retry loop.
   Pure helpers live in logic.js (unit-tested). */
(() => {
  "use strict";
  const {
    YTLogic
  } = globalThis;
  const {
    DEFAULT_CONFIG,
    waitUntil,
    findOriginalTrack,
    shouldEnforceFullscreenPause,
    applyAmbientPref,
    isAmbientPrefOff
  } = YTLogic;

  // ---- config (browser.storage.local, live-reloaded) ----
  let config = {
    ...DEFAULT_CONFIG
  };
  const log = (...a) => {
    if (config.debug) console.info("[YT Prefs]", ...a);
  };

  // Ambient Mode is page-side (not in the html5 player); its checkbox exists only in fullscreen. Proven layer: hide the glow canvas (see docs/findings.md). Removed live when the Options checkbox is turned off.
  const AMBIENT_CSS = "#cinematics{display:none!important}";

  // ---- page bridge injection ----
  // The script loads asynchronously into the PAGE world; requests sent before it installs are lost (nothing listens yet). All bridge-gated features wait for BRIDGE_READY; DOM-only features (autoplay, ambient) don't need it.
  let bridgeReady = false;

  function injectBridge() {
    if (bridgeReady || document.getElementById("yt-prefs-bridge")) return;
    const s = document.createElement("script");
    s.id = "yt-prefs-bridge";
    s.src = browser.runtime.getURL("page-bridge.js");
    s.onload = () => s.remove();
    // transient resource load failure: retry
    s.onerror = () => {
      s.remove();
      setTimeout(injectBridge, 1000);
    };
    (document.head || document.documentElement).appendChild(s);
  }

  // ---- bridge client: requestId reply-map + timeout ----
  const bridge = (() => {
    const pending = new Map();
    let seq = 0;
    window.addEventListener("message", event => {
      if (event.source !== window) return;
      const data = event.data;
      if (data?.source !== "yt-prefs-bridge") return;
      if (data.type === "BRIDGE_READY") {
        bridgeReady = true;
        return;
      }
      const settle = pending.get(data.requestId);
      if (!settle) return;
      pending.delete(data.requestId);
      settle.resolve(data);
    });

    function call(type, payload = {}, timeoutMs = 5000) {
      return new Promise(resolve => {
        const requestId = `ytp-${Date.now()}-${seq++}`;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve({
            error: `Bridge timeout: ${type}`
          });
        }, timeoutMs);
        pending.set(requestId, {
          resolve: r => {
            clearTimeout(timer);
            resolve(r);
          }
        });
        window.postMessage({
          source: "yt-prefs-content",
          type,
          requestId,
          ...payload
        }, "*");
      });
    }
    return {
      call
    };
  })();

  // ---- helpers ----
  const getPlayer = () => document.querySelector("#movie_player");
  const getVideo = () => document.querySelector("video.html5-main-video");

  // Single-flight serialized apply chain (no sleeps, no polling intervals).
  let chain = Promise.resolve();

  function requestApply(reason) {
    chain = chain.then(() => applyAll(reason).catch(e => log("apply error", e)));
  }

  async function applyAll(reason) {
    // Non-watch pages (home, search) have no player: bail fast
    if (!getPlayer() &&
      !(await waitUntil(() => !!getPlayer(), {
        interval: 100,
        timeout: 3000
      }))) return;
    log("applyAll:", reason);
    // DOM-only: instant, no bridge needed
    await enforceAutoplayOff();
    applyAmbientStyle();
    applyAmbientPreference();
    // Player-API features wait for the bridge instead of burning a call timeout.
    if (!(await waitUntil(() => bridgeReady, {
        interval: 100,
        timeout: 6000
      })))
      return log("bridge never became ready; API features skipped");
    if (config.selectOriginalAudio) await applyOriginalAudio();
    if (config.disableStableVolume) await applyStableVolume();
    if (config.disableAnnotations) await applyAnnotations();
  }

  // ---- autoplay: DOM attribute + click; locale-free, works today ----
  async function enforceAutoplayOff() {
    if (!config.disableAutoplay) return;
    let b = document.querySelector(".ytp-autonav-toggle-button");
    if (!b) {
      // The control renders shortly after the player on watch pages.
      await waitUntil(() => !!document.querySelector(".ytp-autonav-toggle-button"), {
        interval: 100,
        timeout: 2000
      });
      b = document.querySelector(".ytp-autonav-toggle-button");
    }
    if (!b) return log("autoplay button not found (skip)");
    if (b.getAttribute("aria-checked") === "true") {
      b.click();
      log("autoplay disabled");
    } else {
      log("autoplay already off");
    }
  }

  // ---- original audio ----
  async function applyOriginalAudio() {
    const listed = await bridge.call("GET_AUDIO_TRACKS");
    if (listed.error) return log("audio list failed:", listed.error);
    const tracks = listed.tracks ?? [];
    if (tracks.length < 2) return log("single audio track; nothing to switch");
    const original = findOriginalTrack(tracks);
    if (!original) return log("original track unavailable on this video");
    if (listed.currentId === original.id) return log("original audio already active");
    const set = await bridge.call("SET_AUDIO_TRACK", {
      trackId: original.id
    });
    if (set.error || !set.success) return log("setAudioTrack failed:", set.error);
    const ok = await waitUntil(
      () => bridge.call("GET_AUDIO_TRACKS")
      .then(r => r.currentId === original.id), {
        interval: 150,
        timeout: 5000
      });
    log("original audio verified:", ok);
    return ok;
  }

  // ---- Stable Volume: direct API (menu greying-out is UI-only, oddity #2) ----
  async function applyStableVolume() {
    const st = await bridge.call("GET_DRC");
    if (st.error) return log("drc probe failed:", st.error);
    if (st.value === 0) return log("stable volume already off");
    if (st.value !== 1) return log("stable volume not applicable here");
    const off = await bridge.call("SET_DRC", {
      enabled: false
    });
    if (off.error) return log("setDrc failed:", off.error);
    const ok = await waitUntil(
      () => bridge.call("GET_DRC").then(r => r.value === 0), {
        interval: 150,
        timeout: 3000
      });
    log("stable volume off verified:", ok);
  }

  // ---- Annotations: same call as YouTube's own checkbox ----
  async function applyAnnotations() {
    // The module registers shortly after video data arrives; give it a short window, then treat absence as the normal "video has no annotations".
    let r;
    const decided = await waitUntil(async () => {
      r = await bridge.call("SET_ANNOTATIONS", {
        enabled: false
      });
      return r.available === true || !!r.error;
    }, {
      interval: 250,
      timeout: 2000
    });
    if (!decided) return log("annotations not available on this video (skip)");
    if (r.error) return log("annotations unload failed:", r.error);
    log("annotations unloaded");
  }

  // ---- ambient: CSS layer + real PREF-cookie preference ----
  let ambientStyle = null;

  function applyAmbientStyle() {
    if (!config.disableAmbientMode) {
      ambientStyle?.remove();
      ambientStyle = null;
      return;
    }
    if (!ambientStyle || !ambientStyle.isConnected) {
      ambientStyle = document.createElement("style");
      ambientStyle.id = "yt-prefs-ambient-off";
      ambientStyle.textContent = AMBIENT_CSS;
      document.documentElement.appendChild(ambientStyle);
    }
  }

  /* YouTube's html5-player (base.js) checkbox persists the Ambient setting as bits in the PREF cookie (f7: 0x10=on, 0x40=user-changed; verified: the first manual toggle on this machine wrote 100->140).
  The NEWER Polymer settings menu variant reads/writes server-side instead (InnerTube modifySetting keyed to the logged-out CONSISTENCY cookie; local stores provably unchanged across an on/off/reload cycle — docs/findings.md).
  This write is therefore INSURANCE: it unchecks the menu on builds/contexts that use the PREF-backed checkbox, and never hurts the others. The #cinematics CSS layer above is what guarantees the glow stays off.
  Cookie semantics copied from YouTube's own code (cma.save -> g.nq -> hl): domain=youtube.com, path=/, TTL 2y, SECURE (non-secure document.cookie writes do not replace the Secure cookie — they phantom-duplicate it).
  Read mirrors hl.get: the LAST PREF occurrence wins. */
  function readPrefCookie() {
    let value = "";
    for (const part of document.cookie.split(";")) {
      const kv = part.trim();
      if (kv.startsWith("PREF=")) value = kv.slice(5);
    }
    return value;
  }

  function applyAmbientPreference() {
    if (!config.disableAmbientMode) return;
    const current = readPrefCookie();
    if (isAmbientPrefOff(current)) return log("ambient PREF bits already off");
    const {
      value,
      changed
    } = applyAmbientPref(current, false);
    if (!changed) return;
    // Remove any phantom PREF entries created by earlier non-secure writes.
    document.cookie = "PREF=;path=/;domain=youtube.com;max-age=0";
    document.cookie = "PREF=;path=/;max-age=0";
    document.cookie =
      `PREF=${value};path=/;domain=youtube.com;secure;max-age=63072000`;
    log("ambient PREF bits (old-menu insurance) off:",
      isAmbientPrefOff(readPrefCookie()) ? "verified" : "write failed");
  }

  // ---- fullscreen autoplay guard (BOTH directions, ANY exit method) ----
  /* Intent tracking (button click / f key) is best-effort only: exits via Esc or browser chrome never fire it.
  The authoritative signal is the video's paused state sampled in the CAPTURE phase of fullscreenchange — the page player resumes only after that event — plus a bounded play-listener that re-pauses a resume arriving within the guard window. */
  const RESUME_GUARD_MS = 1200;
  let pausedBeforeToggle = null;
  let resumeGuardTimer = null;

  function noteIntent(event) {
    if (!config.preventFullscreenAutoplay) return;
    const viaButton = event.target instanceof Element &&
      !!event.target.closest(".ytp-fullscreen-button");
    const viaKey = event.type === "keydown" &&
      event.key.toLowerCase() === "f" && !event.repeat &&
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      // pressing f while typing in the search box must not arm the guard
      !(event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable]"));
    if (!viaButton && !viaKey) return;
    const v = getVideo();
    if (v) pausedBeforeToggle = v.paused;
  }
  document.addEventListener("click", noteIntent, true);
  document.addEventListener("keydown", noteIntent, true);

  function disarmResumeGuard(video) {
    if (!resumeGuardTimer) return;
    clearTimeout(resumeGuardTimer.stop);
    video?.removeEventListener("play", resumeGuardTimer.onPlay);
    resumeGuardTimer = null;
  }

  function armResumeGuard(video) {
    disarmResumeGuard(video);
    const onPlay = () => {
      if (!video.paused) {
        video.pause();
        log("fullscreen autoplay prevented");
      }
    };
    video.addEventListener("play", onPlay);
    const stop = setTimeout(() => {
      video.removeEventListener("play", onPlay);
      resumeGuardTimer = null;
    }, RESUME_GUARD_MS);
    resumeGuardTimer = {
      onPlay,
      stop
    };
  }

  document.addEventListener("fullscreenchange", () => {
    if (config.preventFullscreenAutoplay) {
      const v = getVideo();
      // Fall back to the transition-time state when intent tracking missed
      // the trigger (Esc exit, browser fullscreen button, programmatic).
      const wasPaused = pausedBeforeToggle ?? (v ? v.paused : null);
      pausedBeforeToggle = null;
      if (wasPaused === true && v) {
        if (shouldEnforceFullscreenPause(true, !v.paused)) {
          v.pause();
          log("fullscreen autoplay prevented");
        } else {
          armResumeGuard(v);
        }
      } else {
        // user wanted playback (or state unknown): no guard
        disarmResumeGuard(v);
      }
    }
    requestApply("fullscreen-change");
  }, true);

  // ---- triggers: navigation + actual player replacement only ----
  document.addEventListener("yt-navigate-finish", () => requestApply("navigate"));
  window.addEventListener("popstate", () => requestApply("popstate"));
  let lastPlayerRef = null;
  new MutationObserver(() => {
    const p = getPlayer();
    if (p && p !== lastPlayerRef) {
      lastPlayerRef = p;
      requestApply("player-replaced");
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // ---- init ----
  async function init() {
    injectBridge();
    const stored = await browser.storage.local.get(DEFAULT_CONFIG);
    config = {
      ...DEFAULT_CONFIG,
      ...stored
    };
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      for (const [k, v] of Object.entries(changes))
        if (k in DEFAULT_CONFIG) config[k] = v.newValue ?? DEFAULT_CONFIG[k];
      requestApply("config-change");
    });
    requestApply("init");
  }
  init();
})();
