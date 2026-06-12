# MIS Lit Reviewer

A public semantic-search workbench over the Information Systems literature
corpus — journals, conferences, and preprints. Two tabs:

- **Search** — rank the corpus by meaning, running **entirely in your
  browser**. Save query streams, pin papers, attach your own sources, keep
  notes — all stored locally (localStorage), with Export / Import JSON backup.
- **Browse** — the corpus as a filterable reading list: filter by text /
  venue / type / year / abstract, sort by date added, publication year, or
  citations. A status strip shows the latest daily crawl, and papers crawled
  since the last index build appear with a "new" badge. Includes the **daily
  digest subscription** form.

🔎 The search itself has no server and no accounts: query embedding (bge-small
via transformers.js) and cosine ranking happen client-side over shipped int8
embeddings. The only backend is two tiny Pages Functions for the email digest
subscription (double opt-in via Resend).

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

- `public/data/status.json` — drives the "updated daily" strip on Browse
- `public/data/recent.json` — last ~35 days of crawled papers; Browse overlays
  whatever isn't in the shipped index yet (badge: "new")

Push-to-deploy makes the page current ~1 minute later. No index rebuild
happens daily — embeddings refresh on the manual cadence above.

## Email digest subscription

`functions/api/subscribe.js` + `confirm.js` implement double opt-in with **no
database**: contacts live in a Resend segment, pending ones are
`unsubscribed=true`, and the confirmation link carries an HMAC token bound to
the email address. The daily broadcast (sent by `digest.py` with
`provider = "resend"` on the crawler side) goes to the segment; Resend
appends per-recipient unsubscribe links.

Pages project environment variables (dashboard → Settings → Environment
variables, or via API): `RESEND_API_KEY` (secret), `RESEND_SEGMENT_ID`,
`CONFIRM_SECRET` (secret; any long random string), optional `DIGEST_FROM`.

## Scope
Only papers **with abstracts** are searchable. Preprint coverage is sparse by
design and meant to be topped up per-query via your own added sources
(DOI / arXiv / Zotero), whose metadata is fetched from OpenAlex/Crossref or
parsed from your paste — never generated.
