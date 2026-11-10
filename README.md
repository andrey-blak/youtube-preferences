# YouTube Preferences

Firefox WebExtension (MV3) that keeps these YouTube preferences enforced on every watch page, without signing in:

- Autoplay OFF
- Audio track switched to the original language (when the video has dubs)
- Stable Volume OFF (direct player API, works even when the menu greys it out)
- Annotations OFF (when the video has them)
- Ambient Mode OFF (CSS layer that hides the `#cinematics` glow; easily disabled via Options if it ever misbehaves)
- Fullscreen enter/exit does not auto-resume a video that was paused

All preferences are checkboxes on the addon's Options page (default: all on, debug logging off). They take effect live via `browser.storage.onChanged`.

## Install

Temporary Add-on:
1. `about:debugging#/runtime/this-firefox` → Load Temporary Add-on… → select `manifest.json` in this folder.
2. Required for private windows: `about:addons` → YouTube Preferences → Enable in private windows → Always. 

Temporary Add-on is lost on browser restart. 

For a permanent install:
1. Open the [Mozilla Add-on Developer Hub](https://addons.mozilla.org/en-US/developers/).
2. Create or sign in to your Mozilla account.
3. Submit your extension.
4. Select On your own (unlisted) as the distribution method.
5. Upload your extension ZIP file.
6. Wait for Mozilla's automated validation and signing.
7. Download the signed .xpi file.
8. In Firefox, open `about:addons`.
9. Click the gear icon → Install Add-on From File.
10. Select the downloaded .xpi.

## Debugging

Turn on "Verbose debug logging" on the Options page (or, from the addon's console on `about:debugging`, run `browser.storage.local.set({debug:true})`). Every action logs with the `[YT Prefs]` prefix in the tab console; missing-feature cases log a single skip line and never retry in a loop.

## Troubleshooting

- **Nothing happens in private windows** → See step 2 of Install.
- **A feature logs `unavailable`/`skip` permanently** → that video/build genuinely lacks it (not every video has annotations, dubs, or DRC); test a dubbed mainstream video before filing it as broken.
- **Ambient CSS layer hides something it shouldn't** → uncheck "Ambient Mode" on the Options page; the style tag is removed live (`#yt-prefs-ambient-off`).
- **Stable Volume logs `setDrc unavailable`** → YouTube build dropped the method; see docs/findings.md "Fallbacks" for the menu-click fallback.

## Layout

```
manifest.json
logic.js (pure, unit-tested)
content.js (orchestrator)
page-bridge.js (all player-API access, page context)
options.{html,js}
tests/
docs/findings.md
```

## Tests

`node --test tests/` (Node ≥ 18) must end with `# pass X` `# fail 0`.
