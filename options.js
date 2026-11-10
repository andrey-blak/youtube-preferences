"use strict";
const LABELS = {
  disableAutoplay: "Keep autoplay OFF",
  selectOriginalAudio: "Always select the original Audio track",
  disableStableVolume: "Keep Stable Volume OFF",
  disableAnnotations: "Keep Annotations OFF",
  disableAmbientMode: "Ambient Mode OFF",
  preventFullscreenAutoplay: "Never auto-resume on fullscreen enter/exit",
  debug: "Verbose debug logging in the console"
};
const box = document.getElementById("prefs");
browser.storage.local.get(YTLogic.DEFAULT_CONFIG).then(stored => {
  for (const key of Object.keys(YTLogic.DEFAULT_CONFIG)) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!stored[key];
    input.addEventListener("change", async () => {
      await browser.storage.local.set({ [key]: input.checked });
      console.info("[YT Prefs] saved", key, input.checked);
    });
    label.append(input, " " + (LABELS[key] ?? key));
    box.append(label);
  }
});
