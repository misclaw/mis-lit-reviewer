# Store listing — Paper Trails Bridge

Everything needed to submit the extension to the Chrome Web Store and Firefox
Add-ons (AMO). Copy blocks are ready to paste.

## Package to upload

Rebuild the submission zip from the `extension/` folder (no build step — the
files ship as-is):

```sh
cd extension && rm -f ../paper-trails-bridge.zip && zip -qr ../paper-trails-bridge.zip . -x '.*' -x '__MACOSX*'
npx addons-linter ../paper-trails-bridge.zip   # expect 0 errors / 0 warnings
```

Current version: **0.5.4**. Privacy policy URL (same for both stores):
**https://paper-trails.misclaw.app/privacy** (also resolves at the former
alias https://mis-lit-reviewer.misclaw.app/privacy).

**Live on the Chrome Web Store:**
https://chromewebstore.google.com/detail/paper-trails-bridge/limegkoddehgnlanihimnhflbcfdceom

Screenshots (1280×800 JPEG) are in `../store-assets/`; suggested order:
`1-scholar-button` → `2-session-received` → `4-imported-collection` → `3-workbench`.

Store icon: `icons/icon128.png` (128×128) — the misclaw logo (the red "MIS"
lobster on the brand card). Re-upload it on the dashboard's "Store listing" tab
when refreshing the listing; the packaged manifest also references it.

---

## Chrome Web Store

- **Name:** Paper Trails Bridge
- **Summary (≤132 chars):** Send results from Google Scholar, Asta, Paper Digest, and SciSpace into Paper Trails, the IS literature review workbench.
- **Category:** Productivity (or Tools)
- **Language:** English

**Detailed description:**

> Paper Trails Bridge connects the natural-language literature-search tools you
> already use to **Paper Trails** — a Backward · Main · Forward literature-review
> workbench for Information Systems scholars (paper-trails.misclaw.app).
>
> Rigorous literature reviews shouldn't be limited to one search method. Paper
> Trails runs its own IS-corpus pipeline, but the wider literature lives across
> tools like Google Scholar Labs, Asta, Paper Digest, and SciSpace — each strong
> at a different kind of query. This bridge lets you pull results from all of them
> into one workspace, so you cover more ground, avoid reinventing the wheel, and
> review the literature more thoroughly instead of trusting any single engine.
>
> On a supported search site — Google Scholar / Scholar Labs, Asta (Ai2), Paper
> Digest, or SciSpace — a floating "◀ · ▶ Send to Paper Trails" button appears.
> Click it and the extension reads the papers on the page (titles, authors,
> venues, links, and any snippets), then opens Paper Trails with that session
> ready to import into a review stream, deduplicated against what you already have.
>
> Nothing goes through a server. The results travel directly from one browser
> tab to another, encoded in the page URL, and land in Paper Trails' local
> workspace. The extension has no accounts, no tracking, and no background
> activity — it acts only when you click.
>
> Open source: https://github.com/misclaw/mis-lit-reviewer

### Privacy tab answers

- **Single purpose:**
  > Paper Trails Bridge does one thing: when the user clicks its "Send to Paper
  > Trails" button on a supported academic search site (Google Scholar / Scholar
  > Labs, Asta, Paper Digest, SciSpace), it reads the list of papers visible on
  > that page and opens the Paper Trails literature-review web app
  > (paper-trails.misclaw.app) in a tab, with those results encoded in the
  > URL fragment, so the user can import them into their review workspace. It has
  > no other features: no background activity, no browsing monitoring, no data
  > storage, no tracking. It acts only on the user's explicit click.

- **Host permission justification:**
  > The five literature-search hosts (scholar.google.com, asta.allen.ai,
  > paperdigest.org, scispace.com, typeset.io) are where the content script draws
  > the "Send to Paper Trails" button and — only when the user clicks it — reads
  > the visible search-result list (paper titles, authors, links, snippets). This
  > is the extension's entire function and requires access to those pages' DOM.
  > The remaining app hosts — paper-trails.misclaw.app and its former alias
  > mis-lit-reviewer.misclaw.app (plus localhost:5173 for development of the
  > same app) — run a one-line script that stamps the
  > extension's version on the page so the app's "Verify installation" button can
  > detect it; it reads nothing from the page. All data transfer happens inside
  > the user's browser via the URL fragment of a tab opened by the user's click —
  > URL fragments are never transmitted to any server, and the extension contacts
  > no server of its own.

- **Remote code:** No, I am not using remote code.
- **Data usage — collected data types:** none (check no boxes). Reading page
  content on click is not collection: it never leaves the user's browser.
- **Certify all three disclosures** (no selling/transfer, no unrelated use, no
  creditworthiness use) — all true.
- **Permissions used:** no `permissions` beyond content-script host matches
  (no `activeTab`, `storage`, `tabs`, etc.), so only the host justification
  above is required.

---

## Firefox Add-ons (AMO)

Submit at https://addons.mozilla.org → Developer Hub → Submit a New Add-on →
"On this site". Upload the same zip.

- **Name:** Paper Trails Bridge
- **Summary:** Send results from Google Scholar, Asta, Paper Digest, and SciSpace into Paper Trails, the IS literature-review workbench.
- **Description:** reuse the detailed description above (AMO has no 132-char cap).
- **Categories:** Other / Productivity (search-tools adjacent)
- **Privacy policy:** https://paper-trails.misclaw.app/privacy
- **Source code submission:** **No** — there is no build step, minifier, or
  bundler; the uploaded files are the original sources (also on GitHub).
- The manifest already carries the AMO essentials: `browser_specific_settings.
  gecko` (add-on id, `strict_min_version` 140), `gecko_android` (142), and
  `data_collection_permissions: { required: ["none"] }`.

---

## After a listing goes live

Done for Chrome: `src/review.js` (`extPanel`) now shows an **"Add to Chrome —
Web Store ↗"** button (`EXT_STORE_URL`) to Chromium users, with the manual
load-unpacked steps tucked behind a disclosure. Firefox users still get the
temporary-add-on-from-GitHub flow — the **AMO listing is under review**; once it's
approved, swap that branch to the AMO install link.
