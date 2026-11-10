# Live/build recon findings — YouTube player internals

Method: static analysis of the exact player bundle served to us on 2026-11-10 (`https://www.youtube.com/s/player/a5c2aafe/player_es6.vflset/uk_UA/base.js`, 2 691 371 bytes) plus the served watch page, cross-checked against ImprovedTube (github.com/code-charity/youtube, master). Firefox/Xray caveats per README.

## Decisions (implemented in the addon)

| Feature | Mechanism (all via page-bridge.js, page context) | Evidence in base.js a5c2aafe |
| --- | --- | --- |
| Autoplay OFF | click `.ytp-autonav-toggle-button` when `aria-checked="true"` (content DOM, locale-free) | player itself persists `yt-player-autonavstate` (`g.gr("yt-player-autonavstate")`) |
| Original audio | `getAvailableAudioTracks()` / `setAudioTrack()`; flatten with **`track.getLanguageInfo()`** → `{id,name,languageCode,isOriginal?,isDefault?}` | `OL(this.api,...)` export list; `c.getLanguageInfo().getId()===b` lookups |
| Stable Volume OFF | **`player.setDrcUserPreference(0)`** — the exact function the menu checkbox is bound to. Works regardless of menu editability (oddity #2 is UI-only) and YouTube persists it itself in `yt-player-drc-pref` (1-year TTL, default `1`) | `new Plb(this.api,this.setDrcUserPreference.bind(this),this.getDrcUserPreference.bind(this),…)`; `setDrcUserPreference(a){…g.fr("yt-player-drc-pref",a,31536E3)…}`; exported: `OL(this.api,"setDrcUserPreference",…)` |
| Annotations OFF | **`player.unloadModule("annotations_module")`** — this is literally what the "Annotations" checkbox does (`onSelect: unloadModule/loadModule("annotations_module")`), and the checkbox state is _derived_ from module-loaded state, so the menu reflects our change. Availability = `player.getOptions()` array contains `"annotations_module"` (oddity #1: absent on videos without annotations → skip quietly) | `PL(a,"loadModule",a.K);PL(a,"unloadModule",a.L)`; `unloadModule(a){if(a==="annotations_module"){let b=g.ET(this.app.Mb());b&&b.loaded&&b.unload()}}`; `getOptions()` pushes `"annotations_module"` only when registered; experiment `web_fix_annotations` (settingItemId 294) only changes server-sync, same call shape |
| Ambient Mode OFF | **CSS layer `#cinematics{display:none!important}`** injected as `<style id="yt-prefs-ambient-off">`; trivially removable via Options checkbox (live). Ambient is NOT in the html5 player at all (zero `ambient` API matches in base.js) — page-side, and its checkbox only exists in fullscreen (oddity #3), so no API path. | ImprovedTube ships the same selector (`appearance/player/player.css:15`); canvas `#cinematics` is the page-side glow layer |
| Fullscreen enter/exit auto-resume | record `video.paused` on the fullscreen trigger (`.ytp-fullscreen-button` click / `f` key), enforce `video.pause()` on `fullscreenchange` in BOTH directions | plain DOM, no player API |

Note for the future: settings menu items carry no stable DOM id (only build-random `ytp-id-NN`); their DOM order is by the priority enum `g.F1` = {19 LOOP, 18 STABLE_VOLUME, 17 VOICE_BOOST, 16 REMOTE_SELECT, 15 SIZE, 14 MINIPLAYER, 13 THREED, 12 AUTONAV, 11 CINEMATIC, 10 ANNOTATIONS, 9 AUDIO, 8 SUBTITLES, 7 SLEEP_TIMER, 6 ASPECT_RATIO, 5 SPEED, 4 AUDIO_SETTINGS, 3 QUALITY, 2 LINKEDACCOUNT, 1 REMOTE, 0 CONTEXTMENU}. `yt-player-user-settings` (30-day TTL) persists checkbox settings as `{settingItemId: {boolValue|stringValue}}` with numeric string ids (e.g. "294" annotations under `web_fix_annotations`); format is wrapper-JSON — do NOT hand-write it, let YouTube's own calls write it.

## Live spot-check (user, English UI, a dubbed video, DevTools page-context console)

Builds differ per rollout/experiment; re-run after any YouTube update if a feature starts logging skips:

```js
const p = document.querySelector("#movie_player");
console.table({
  getAvailableAudioTracks: typeof p.getAvailableAudioTracks,   // expect "function"
  getAudioTrack: typeof p.getAudioTrack,                       // expect "function"
  setAudioTrack: typeof p.setAudioTrack,                       // expect "function"
  getDrcUserPreference: typeof p.getDrcUserPreference,         // expect "function"
  setDrcUserPreference: typeof p.setDrcUserPreference,         // expect "function"
  hasDrcAudioTrack: typeof p.hasDrcAudioTrack,                 // expect "function"
  getOptions: typeof p.getOptions,                             // expect "function"
  unloadModule: typeof p.unloadModule                          // expect "function"
});
p.getOptions();                      // array; should include "annotations_module" on annotated videos
p.getDrcUserPreference();            // 1 (on) before, 0 after the addon applies
localStorage.getItem("yt-player-drc-pref");   // non-null after apply
```

## Fallbacks if a future build drops an API

- **setDrcUserPreference gone** → menu-click on the Stable Volume toggle located by `aria-label` equality is NOT acceptable (locale). Use order-based matcher: toggle items are `.ytp-menuitem[role=menuitemcheckbox]` sorted by `g.F1` priority; STABLE_VOLUME=18 is first among checkboxes. Runtime-verify state still via DOM `aria-checked` (readable from content script).
- **unloadModule gone** → same order-based matcher, ANNOTATIONS=10.
- **#cinematics renamed** → check page console `document.querySelector ('[id*=cinematic], canvas')` in fullscreen; update `AMBIENT_CSS`.

## Ambient Mode preference — FINAL picture (two menu variants, proven by state diff)

Experiment on a live build (2026-11-10): captured every local store (cookie names, PREF value, all `yt-*` localStorage keys, full IndexedDB dump) with the checkbox ON vs OFF vs after-reload.

- **html5-player (base.js) checkbox** — persists in the plain `PREF` cookie, field `f7`, hex bitfield; `0x10`=on (id 190), `0x40`=user-changed (id 192). Golden transition: first menu toggle rewrote `f7=100 -> 140`, survived reload. Reader: `Sua()` = `Ba(192) ? Ba(190) : default-on`. Writer chain: checkbox `C(a) -> pr(190,a); pr(192,!0); cma.save() -> g.nq(name, dump, 63072000, "youtube.com", secure=!0)`. **Cookie replacement gotcha:** a `document.cookie` write without `secure` does NOT replace YouTube's Secure PREF — it creates a phantom duplicate while the re-read "verifies" your own value; and `hl.get` takes the LAST `PREF=` occurrence, so a naive first-match regex disagrees with YouTube's own reader. The addon mirrors both semantics (`applyAmbientPref`/`isAmbientPrefOff` in logic.js, unit-tested against the captured strings).
- **Newer Polymer "elevated" settings menu variant** — toggling it OFF changes NOTHING local (identical PREF/LS/IDB with checkbox on vs off vs reloaded). It persists server-side via InnerTube `modifySetting`, keyed for logged-out users to the `CONSISTENCY` cookie; on load the checkbox initializes from the player context config `settingOnByDefault` (polymer `QIF`: local flags first, server default fallback). Not writable by the addon without impersonating the signed-out settings RPC — deliberately NOT attempted.

**Shipped behavior:** glow is killed by the `#cinematics` CSS layer on every build (the actual feature), PREF bits are written as compatibility insurance for PREF-driven menu variants, and on the current menu the checkbox simply reflects YouTube's own server state — which a single manual click pins for the lifetime of the CONSISTENCY cookie. A fresh private session may show the checkbox checked while the glow stays off.
