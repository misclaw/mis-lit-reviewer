# MIS Lit Reviewer

A public, **fully static** semantic-search workbench over the Information
Systems literature corpus — journals, conferences, and preprints — ranked by
meaning, running **entirely in your browser**. Save query streams, pin papers,
attach your own sources, and keep notes — all stored locally in your browser
(localStorage), with Export / Import JSON for backup.

🔎 No server, no accounts: query embedding (bge-small via transformers.js) and
cosine ranking happen client-side over shipped int8 embeddings. Nothing you do
leaves the browser.

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
The shipped dataset is regenerated from the local IS corpus:
1. export the abstract-bearing slim records → `data-gen/papers.slim.jsonl` (staging),
2. gzip → `papers.slim.jsonl.gz`,
3. `node data-gen/embed.mjs` → `emb_int8.bin` + `meta.json` (resumable),
4. split each big file into ≤20 MiB chunks and update the manifest in
   `public/data/meta.json`, e.g.:
   ```bash
   split -d -a 1 -b 20m papers.slim.jsonl.gz public/data/papers.slim.jsonl.gz.part
   split -d -a 1 -b 20m emb_int8.bin public/data/emb_int8.bin.part
   ```
   (do **not** ship the unsplit originals — Cloudflare Pages rejects files >25 MiB).

## Scope
Only papers **with abstracts** are searchable. Preprint coverage is sparse by
design and meant to be topped up per-query via your own added sources
(DOI / arXiv / Zotero), whose metadata is fetched from OpenAlex/Crossref or
parsed from your paste — never generated.
