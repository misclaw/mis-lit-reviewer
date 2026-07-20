// Runs on the Paper Trails app origins only: stamps the extension's presence
// (and version) on the page so the app's "Verify installation" button can
// detect it. No page data is read.
// `browser` is the canonical namespace in Firefox, `chrome` in Chromium.
document.documentElement.dataset.ptExtension =
  (globalThis.browser ?? globalThis.chrome).runtime.getManifest().version;
