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
    GET_CAPTIONS: "CAPTIONS_RESULT",
    SET_CAPTION_TRACK: "SET_CAPTION_RESULT",
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

  // Caption tracks from getOption("captions","tracklist"): plain-JSON shape for logic.js.
  // Field spellings defensive (vssId vs vss_id; name object vs string) — ImprovedTube proves both spellings occur across builds;
  // matching words ("Animated") are not localized.
  function flattenCaption(track) {
    if (!track) return null;
    const name = typeof track.name === "string" ?
      track.name :
      track.name?.simpleText ?? null;
    return {
      name,
      languageCode: track.languageCode ?? null,
      kind: track.kind ?? null,
      vssId: track.vssId ?? track.vss_id ?? null,
      trackName: track.trackName ?? null
    };
  }

  /* Original audio language, live sources only — window.ytInitialPlayerResponse is STALE after SPA navigation
  (it keeps describing the previous video), so it is never read.
  1) the track you are hearing right now: getAudioTrack().getLanguageInfo().id ("ru.4" -> ru);
  the sibling feature keeps the original audio selected, so current == original.
  2) an audio track flagged isOriginal (creator-dubbed videos).
  3) player.getPlayerResponse() — the live per-video response; only when it offers a single audio track (no ambiguity).
  auto-dubbed videos list both languages with no original marker, so multi-entry lists are not guessed from.
  Parse audioTrackId-shaped values: "ru.4" -> ru, "en-US.10" -> en.
  Live probe: getAudioTrack().getLanguageInfo().id carries exactly this form
  (the raw .id property is a prefixed protobuf blob like "251;ChE..." — rejected here).
  Its base64 payload provably contains the language:
  lang:"ru" on the original track,
  lang:"en-US" plus "dubbed-aut" on the auto-dub. */
  function parseAudioTrackLang(id) {
    const lang = String(id ?? "").split(".")[0].split("-")[0];
    return /^[a-z]{2,3}$/i.test(lang) ? lang.toLowerCase() : null;
  }

  function originalAudioLanguage(player) {
    try {
      const current = player.getAudioTrack?.();
      const fromCurrent = parseAudioTrackLang(current?.getLanguageInfo?.()?.id ?? current?.id);
      if (fromCurrent) return fromCurrent;
      for (const t of player.getAvailableAudioTracks?.() ?? []) {
        const li = t.getLanguageInfo?.();
        if (!li || (li.isOriginal !== true && li.isOriginal !== 1)) continue;
        const code = li.languageCode ?? parseAudioTrackLang(li.id ?? t.id);
        if (code) return String(code).split("-")[0].toLowerCase();
      }
      const at = player.getPlayerResponse?.()?.captions?.
        playerCaptionsTracklistRenderer?.audioTracks ?? [];
      if (at.length === 1) return parseAudioTrackLang(at[0].audioTrackId);
    } catch { /* degrade to null — selection falls back to the current subtitle language */ }
    return null;
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

        case "GET_CAPTIONS": {
          if (typeof player.getOption !== "function")
            return respond(data, {
              error: "getOption unavailable"
            });
          const list = (player.getOption("captions", "tracklist", {
            includeAsr: true
          }) ?? []).map(flattenCaption);
          return respond(data, {
            list,
            current: flattenCaption(player.getOption("captions", "track") ?? null),
            on: typeof player.isSubtitlesOn === "function" ? !!player.isSubtitlesOn() : null,
            audioLanguage: originalAudioLanguage(player)
          });
        }

        case "SET_CAPTION_TRACK": {
          // setOption forces captions ON; restore the previous on/off state (ImprovedTube-proven).
          const all = player.getOption?.("captions", "tracklist", {
            includeAsr: true
          }) ?? [];
          const track = all.find(t => {
            const f = flattenCaption(t);
            return f.vssId && f.vssId === data.vssId;
          });
          if (!track) return respond(data, {
            error: "Track not found"
          });
          if (typeof player.setOption !== "function")
            return respond(data, {
              error: "setOption unavailable"
            });
          const wasOn = typeof player.isSubtitlesOn === "function" ? !!player.isSubtitlesOn() : null;
          player.setOption("captions", "track", track);
          if (wasOn === false && typeof player.toggleSubtitles === "function")
            player.toggleSubtitles();
          return respond(data, {
            success: true,
            current: flattenCaption(player.getOption("captions", "track") ?? null)
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
