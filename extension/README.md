# Paper Trails Bridge (Chrome & Firefox extension)

Bridges searches you run on general literature tools into the
**Paper Trails** workbench (Backward · Main · Forward) as *outside-IS* imports:

- Google Scholar / Google Scholar Labs
- Asta (asta.allen.ai)
- Paper Digest (paperdigest.org)
- SciSpace (scispace.com)

On a supported site, a floating **"◀ · ▶ Send to Paper Trails"** button
appears. Clicking it detects the source, your query, and the visible paper
list (with snippets/rationales when the tool shows them), then opens
`paper-trails.misclaw.app` with the session encoded in the URL fragment
(`#import=base64url(JSON)`). Nothing is sent to any server — the data travels
inside the URL, from one tab to another, and lands in the workbench's
local-only store. The Import tab there lets you merge it into a review stream.

**⌥-click (Alt-click)** the button to target `http://localhost:5173` instead
(local development).

## Install — Chrome (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this `extension/` folder

(Chrome may warn about the `browser_specific_settings` manifest key — that's
the Firefox block; it's ignored by Chrome and harmless.)

## Install — Firefox (temporary add-on)

Requires Firefox **140+** (the manifest's `strict_min_version` — the current ESR).

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → select this folder's `manifest.json`
3. If the button doesn't appear on a supported site, open
   `about:addons` → Paper Trails Bridge → **Permissions** and make sure
   access to the listed sites is granted (Firefox treats MV3 site access
   as grantable)

Temporary add-ons are removed when Firefox quits — reload after a restart.
A permanent install needs the add-on signed by Mozilla (AMO); the manifest
already carries the required `gecko.id` and data-collection declaration
(`none`), so the folder can be submitted as-is if we ever want that.

## Verify

The extension also stamps its presence on the app's origin
(`presence.js` → `data-pt-extension` on `<html>`), which powers the
**Verify installation** button in the app's Import tab.

## Notes

- Site adapters are best-effort: these products change their DOM without
  notice. Every adapter falls back to a generic extractor that collects
  scholarly-looking links (doi.org, arXiv, ACM, Springer, INFORMS, AISeL, …)
  from the page.
- Payload contract (kept in sync with `src/handoff.js` in the app):

  ```json
  { "v": 1, "src": "extension", "tool": "Google Scholar Labs",
    "query": "…", "hasRationales": true,
    "papers": [{ "title": "…", "authors": "…", "year": 2023,
                  "venue": "…", "url": "…", "snippet": "…" }] }
  ```
