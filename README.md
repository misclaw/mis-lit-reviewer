# MIS Lit Reviewer

A public workbench over the Information Systems literature corpus — journals,
conferences, and preprints — in **one unified view**:

- **Browse by default** — with the query box empty, the three columns
  (Journals / Conferences / Preprints) show the corpus sorted by date added
  (or publication year / citations). Papers crawled since the last index build
  appear with a "new" badge.
- **Search by typing** — a natural-language query re-ranks the same three
  columns by meaning, running **entirely in your browser**.
- **Free venue + column control** — every venue is selected by default; uncheck
  any to exclude it. Hide any of the three type-columns (the layout collapses to
  2- or 1-column) and bring them back from "Columns ▾".
- **Workbench** — **Save** a query to freeze a snapshot of its results in the
  sidebar (with a **Re-run** to refresh against the live corpus); pin papers,
  attach your own sources, keep notes, export `.bib`. Pins are **query-scoped**
  (a paper pinned in query A isn't pinned in query B), and a separate
  **★ Pinned papers** view collects everything you've pinned across all queries,
  tagged by source query. All stored locally (localStorage), with Export /
  Import JSON backup.

🔎 No server and no accounts: query embedding (bge-small via transformers.js)
and cosine ranking happen client-side over shipped int8 embeddings. The email
digest subscription lives in its own project,
[mis-digest](https://github.com/misclaw/mis-digest)
(**[mis-digest.misclaw.app](https://mis-digest.misclaw.app)**), linked from the
header.

## Stack
- **Frontend:** Vite + vanilla JS (`src/`), deployed to Cloudflare Pages at the
  domain root.
- **Search:** `@huggingface/transformers` with `Xenova/bge-small-en-v1.5` (384-dim),
  over `public/data/emb_int8.bin.part*` (int8) + `public/data/papers.slim.jsonl.gz.part*`.
  The data files are split into <25 MiB chunks (Cloudflare Pages per-file limit);
  `public/data/meta.json` lists the chunk manifest and the loader reassembles
  them at runtime.
- **Persistence:** browser localStorage (`src/store.js`, key `mis-lit-reviewer:v1`)
  for streams / external papers / pins, with whole-store Export / Import JSON.

## Develop
```bash
npm install
npm run dev      # http://localhost:5173
```

## Data pipeline (`data-gen/`)

**Index refresh** — run when the corpus has grown enough to be worth
re-shipping (the daily `recent.json` overlay covers the gap between
refreshes):

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

`data-gen/augment_slim.py` was a one-shot that joined `added` (corpus-entry
date) and `cited` (citation count) onto every pre-existing slim record; new
records get those fields from `append_slim.py` directly.

Never reorder or edit existing lines of `papers.slim.jsonl` — embedding row N
must stay aligned with record line N. Appending is safe; anything else means
`node data-gen/embed.mjs --force` (full re-embed).

## Daily updates

`~/research/is-crawler/daily.sh` (launchd, 09:00 KST) crawls, emails the
digest, then runs `site_export.py`, which commits + pushes two files here:

- `public/data/status.json` — drives the muted "updated daily" status line
- `public/data/recent.json` — last ~35 days of crawled papers; the columns
  overlay whatever isn't in the shipped index yet (badge: "new")

Push-to-deploy makes the page current ~1 minute later. No index rebuild
happens daily — embeddings refresh on the manual cadence above.

## Email digest subscription

The subscription form + double-opt-in backend now live in a separate project,
[**mis-digest**](https://github.com/misclaw/mis-digest)
(`mis-digest.misclaw.app`). This site only links to it (header → "✉ Daily
digest"). The daily broadcast is sent by `digest.py` (`provider = "resend"`,
crawler side) to the same Resend segment, unchanged by the move.

## Scope
Only papers **with abstracts** are searchable. Preprint coverage is sparse by
design and meant to be topped up per-query via your own added sources
(DOI / arXiv / Zotero), whose metadata is fetched from OpenAlex/Crossref or
parsed from your paste — never generated.
