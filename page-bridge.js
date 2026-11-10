/* Page-context worker.
All YouTube player-API access happens here: Firefox Xray isolation hides page-defined methods (e.g. #movie_player.setDrcUserPreference) from the content script, so the content script must never call them directly — only via postMessage.
Uses long-standing public element methods only; never minified fields. */
(() => {
  "use strict";
  if (window.__ytPreferencesBridgeInstalled) return;
  window.__ytPreferencesBridgeInstalled = true;

  const RESULT = {
    GET_AUDIO_TRACKS: "AUDIO_TRACKS_RESULT",
    SET_AUDIO_TRACK: "SET_AUDIO_TRACK_RESULT",
    GET_DRC: "DRC_RESULT",
    SET_DRC: "DRC_RESULT",
    SET_ANNOTATIONS: "ANNOTATIONS_RESULT",
    PROBE: "PROBE_RESULT"
  };

  // Flatten a live track object via the public getLanguageInfo() accessor.
  function flatten(track) {
    const info = (track && typeof track.getLanguageInfo === "function" ?
      track.getLanguageInfo() : {}) || {};
    return {
      id: info.id ?? (track && track.id) ?? null,
      name: info.name ?? null,
      languageCode: info.languageCode ?? null,
      isOriginal: info.isOriginal === true || info.isOriginal === 1,
      isDefault: info.isDefault === true || info.isDefault === 1
    };
  }

  function annotationsState(player) {
    // The player lists "annotations_module" only on videos that have annotations (not every video does — skip quietly when absent).
    const names = typeof player.getOptions === "function" ? player.getOptions() : null;
    const available = Array.isArray(names) && names.includes("annotations_module");
    return {
      available,
      canUnload: typeof player.unloadModule === "function"
    };
  }

  window.addEventListener("message", event => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.source !== "yt-prefs-content") return;
    const player = document.querySelector("#movie_player");
    if (!player) return respond(data, {
      error: "Player not found"
    });

    try {
      switch (data.type) {
        case "PROBE":
          return respond(data, {
            methods: {
              getAvailableAudioTracks: typeof player.getAvailableAudioTracks,
              getAudioTrack: typeof player.getAudioTrack,
              setAudioTrack: typeof player.setAudioTrack,
              getDrcUserPreference: typeof player.getDrcUserPreference,
              setDrcUserPreference: typeof player.setDrcUserPreference,
              hasDrcAudioTrack: typeof player.hasDrcAudioTrack,
              getOptions: typeof player.getOptions,
              unloadModule: typeof player.unloadModule
            }
          });

        case "GET_AUDIO_TRACKS": {
          const tracks = (player.getAvailableAudioTracks?.() ?? []).map(flatten);
          const current = player.getAudioTrack?.();
          return respond(data, {
            tracks,
            currentId: current ? flatten(current).id : null
          });
        }

        case "SET_AUDIO_TRACK": {
          const all = player.getAvailableAudioTracks?.() ?? [];
          const track = all.find(t => flatten(t).id === data.trackId);
          if (!track) return respond(data, {
            error: "Track not found"
          });
          if (typeof player.setAudioTrack !== "function")
            return respond(data, {
              error: "setAudioTrack unavailable"
            });
          player.setAudioTrack(track);
          return respond(data, {
            success: true
          });
        }

        case "GET_DRC": {
          if (typeof player.getDrcUserPreference !== "function")
            return respond(data, {
              error: "getDrcUserPreference unavailable"
            });
          const raw = player.getDrcUserPreference();
          return respond(data, {
            value: raw === null || raw === undefined ? null : Number(raw),
            available: typeof player.hasDrcAudioTrack === "function" ?
              !!player.hasDrcAudioTrack() : null
          });
        }

        case "SET_DRC": {
          // The exact function the "Stable Volume" checkbox is bound to; bypasses the menu's "only editable with original audio" UI rule and YouTube persists it in localStorage yt-player-drc-pref (1y).
          if (typeof player.setDrcUserPreference !== "function")
            return respond(data, {
              error: "setDrcUserPreference unavailable"
            });
          player.setDrcUserPreference(data.enabled ? 1 : 0);
          return respond(data, {
            value: Number(player.getDrcUserPreference())
          });
        }

        case "SET_ANNOTATIONS": {
          const st = annotationsState(player);
          if (!st.available) return respond(data, {
            available: false
          });
          if (!st.canUnload) return respond(data, {
            available: true,
            error: "unloadModule unavailable"
          });
          if (data.enabled) {
            if (typeof player.loadModule === "function")
              player.loadModule("annotations_module");
          } else {
            // Idempotent, guarded internally: what YouTube's own "Annotations" checkbox calls.
            player.unloadModule("annotations_module");
          }
          return respond(data, {
            available: true,
            success: true
          });
        }

        // unknown type: ignore
        default:
          return;
      }
    } catch (error) {
      respond(data, {
        error: String(error)
      });
    }
  });

  function respond(request, result) {
    window.postMessage({
      source: "yt-prefs-bridge",
      type: RESULT[request.type],
      requestId: request.requestId,
      ...result
    }, "*");
  }

  console.info("[YT Prefs Bridge] Installed.");
  // Handshake: content script gates player-API features on this signal, because a postMessage sent before this listener exists is simply lost.
  window.postMessage({
    source: "yt-prefs-bridge",
    type: "BRIDGE_READY"
  }, "*");
})();
