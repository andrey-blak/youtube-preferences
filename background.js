browser.action.onClicked.addListener(() => {
  browser.tabs.create({
    url: browser.runtime.getURL("options.html")
  });
});
