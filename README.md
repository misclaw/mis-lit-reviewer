# Paper Trails — IS literature review workbench

**Paper Trails** (Backward · Main · Forward) is a structured literature-review
workbench for **Information Systems** scholars, organized around
Webster & Watson (2002): run a **main review** (within IS +
outside IS), then **go backward** through what the main papers cite and
**forward** through what cites them.

Everything runs in the browser against your own LLM API keys — no server, no
accounts. **We keep your preferences only (locally); your research activity —
queries, papers viewed, review streams — is never collected.**

## How it works

**Onboarding / preferences** — a local profile (no password, no backend):
research interests, philosophy, methodologies, and target venues
(primary / secondary / conferences), plus at least one LLM API key
(Anthropic / OpenAI / Gemini). Keys live in `localStorage` and are sent only
to their provider (Anthropic is called with the
`anthropic-dangerous-direct-browser-access` CORS header; OpenAI and Gemini
allow browser calls natively). Worried about pasting a key into a website?
Fair — this repo is the full source: audit it and run it locally.

**Main review — Within IS** (blue zone):

1. *Data preparation* (already done, refreshed by a daily cron): the IS corpus
   — basket journals, major IS conferences, SSRN preprints — crawled,
   deduplicated, and embedded (`bge-small`, int8, shipped as static files).
2. *Query refinement / expansion* — your LLM reduces ambiguity and adds
   synonym phrasings (JSON contract, soft-fails to the original query).
3. *Similarity filtering* — client-side embedding search over ~100k abstracts,
   MAX-pooled over the refined phrasings → top 100.
4. *LLM reranking with rationales* — top 100 → 20 papers, each with a
   one-line summary and a "why relevant" rationale, informed by your profile.
5. *Prestige ranking* (toggle) — re-sorts the 20 by your primary/secondary
   venue preferences instead of pure relevance.

**Main review — Outside IS** (gold zone): IS is interdisciplinary, so the same
question is searched in the reference disciplines via your provider's
**web-search tool** (Anthropic `web_search`, OpenAI Responses `web_search`,
Gemini `google_search`), then enriched with citation counts/DOIs from OpenAlex.
Alternatively (or additionally), the **Import from extension** tab receives
sessions captured on Google Scholar Labs, Asta, Paper Digest, or SciSpace by
the bundled Chrome extension (`extension/`, load-unpacked), or pasted as JSON.

**Go backward / forward** (◀ ▶ floating arrows or the nav crumbs): the 20 main
papers' references (backward) or citing papers (forward) are collected from
**OpenAlex** (the corpus ids are OpenAlex work ids), counted by how many mains
they link to, metadata-fetched, LLM-screened to ~20 with rationales, and drawn
as a two-column **citation graph** with edges to the main review set (click a
paper to highlight its links).

**Review streams** — every research question is a stream (top-left switcher);
results, graphs, and imports persist per stream in `localStorage`. Export /
Import JSON from the stream menu.

## Stack

- **Frontend:** Vite + vanilla JS (`src/`), deployed to Cloudflare Pages.
  - `main.js` shell/routing · `onboard.js` wizard + preferences ·
    `review.js` main mode · `graph.js` citation graph ·
    `pipeline.js` within/outside-IS pipeline · `citegraph.js` OpenAlex tracing ·
    `llm.js` BYO-key provider layer · `search.js` embedding search ·
    `store.js` localStorage persistence · `handoff.js` fragment receiver.
- **Search:** `@huggingface/transformers` with `Xenova/bge-small-en-v1.5`
  (384-dim) over `public/data/emb_int8.bin.part*` +
  `public/data/papers.slim.jsonl.gz.part*` (chunked ≤ 25 MiB for Pages;
  manifest in `public/data/meta.json`).
- **Citations:** OpenAlex (`referenced_works`, `filter=cites:`), CORS-friendly,
  polite-pool `mailto`.
- **Extension:** `extension/` — Manifest V3 content script; see its README.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
```

## Data pipeline (`data-gen/`)

**Index refresh** — run when the corpus has grown enough to be worth
re-shipping (the daily `recent.json` overlay is currently *not* surfaced in
the review UI; the shipped index is the searchable set):

```bash
# 1. reassemble the embeddings file from its shipped parts (resume point)
cat public/data/emb_int8.bin.part* > public/data/emb_int8.bin
# 2. append abstract-bearing corpus records missing from the slim file
python3 data-gen/append_slim.py
# 3. embed only the new rows (resumable; order-preserving)
node data-gen/embed.mjs
# 4. gzip + split into ≤20 MiB parts + rewrite the meta.json manifest
python3 data-gen/ship_chunks.py
```

Never reorder or edit existing lines of `papers.slim.jsonl` — embedding row N
must stay aligned with record line N. Appending is safe; anything else means
`node data-gen/embed.mjs --force` (full re-embed).

## Daily updates

`~/research/is-crawler/daily.sh` (launchd, 09:00 KST) crawls, emails the
digest, then runs `site_export.py`, which commits + pushes
`public/data/status.json` (drives the corpus-stats card) and
`public/data/recent.json`. Push-to-deploy makes the page current ~1 minute
later. Embeddings refresh on the manual cadence above.

The email digest lives in its own project,
[mis-digest](https://github.com/misclaw/mis-digest)
(`mis-digest.misclaw.app`).

## Cross-app handoff

Other apps (reference-viewer, the extension) hand papers over via the URL
fragment: `#add=` (reference-viewer contract, unchanged) or `#import=`
(extension session contract) — both `base64url(utf8(JSON))`, decoded by
`src/handoff.js` into a captured session in the Import tab.
