// Runs on the Paper Trails app origins only: stamps the extension's presence
// (and version) on the page so the app's "Verify installation" button can
// detect it. No page data is read.
document.documentElement.dataset.ptExtension = chrome.runtime.getManifest().version;
