// In-browser semantic search over the IS corpus.
//
// Loads the shipped int8 embeddings + slim metadata once, embeds the query with
// bge-small (the SAME model used to build the embeddings, so vectors match),
// and ranks each of the three columns by cosine similarity. All client-side —
// no server, no data leaves the browser.
import { pipeline } from "@huggingface/transformers";

const MODEL = "Xenova/bge-small-en-v1.5";
const COLS = ["journal", "conference", "preprint"];

let extractorP = null;
let DATA = null;
let indexP = null;

export function isLoaded() {
  return !!DATA;
}

export function corpusStats() {
  if (!DATA) return null;
  const c = { journal: 0, conference: 0, preprint: 0 };
  for (const p of DATA.papers) c[p.col]++;
  return { total: DATA.count, ...c, currentYear: DATA.currentYear };
}

export function loadModel() {
  if (!extractorP) extractorP = pipeline("feature-extraction", MODEL, { dtype: "q8" });
  return extractorP;
}

// The big data files are shipped split into <25 MiB chunks (Cloudflare Pages
// rejects larger files): <name>.part0, .part1, … as listed in meta.json's
// "files" manifest. Fetch all parts in parallel and concatenate in order —
// for the gzip file the concatenated bytes are byte-identical to the original.
async function fetchChunked(base, name, manifest) {
  const parts = manifest?.parts || 1;
  const urls = [];
  for (let i = 0; i < parts; i++) urls.push(`${base}data/${name}.part${i}`);
  const bufs = await Promise.all(urls.map(async (u) => {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`fetch ${u}: HTTP ${res.status}`);
    return res.arrayBuffer();
  }));
  const total = bufs.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) { out.set(new Uint8Array(b), off); off += b.byteLength; }
  return out;
}

// Memoized: search and browse views both call this; only the first call
// actually downloads (concurrent callers share the same promise).
export function loadIndex(onStep) {
  if (!indexP) indexP = _loadIndex(onStep);
  return indexP;
}

async function _loadIndex(onStep) {
  if (DATA) return DATA;
  const base = import.meta.env.BASE_URL || "./";
  onStep?.("Loading index metadata…");
  const meta = await (await fetch(base + "data/meta.json")).json();

  onStep?.("Downloading embeddings + papers (~65 MB)…");
  const [embBytes, gzBytes] = await Promise.all([
    fetchChunked(base, "emb_int8.bin", meta.files?.["emb_int8.bin"]),
    fetchChunked(base, "papers.slim.jsonl.gz", meta.files?.["papers.slim.jsonl.gz"]),
  ]);
  const emb = new Int8Array(embBytes.buffer, embBytes.byteOffset, embBytes.byteLength);

  let text;
  if (gzBytes[0] === 0x1f && gzBytes[1] === 0x8b) {
    // Raw gzip bytes — decompress in-browser.
    const stream = new Response(gzBytes).body.pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(stream).text();
  } else {
    // Server already decompressed it via Content-Encoding.
    text = new TextDecoder().decode(gzBytes);
  }

  onStep?.("Parsing…");
  const papers = [];
  let maxYear = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const p = JSON.parse(line);
    papers.push(p);
    if (p.year && p.year > maxYear) maxYear = p.year;
  }
  if (papers.length !== meta.count) {
    console.warn(`paper/embedding count mismatch: ${papers.length} vs ${meta.count}`);
  }
  DATA = { meta, emb, papers, dim: meta.dim, count: papers.length, currentYear: maxYear || 2026 };

  onStep?.("Warming up the embedding model…");
  loadModel(); // kick off in background; first query awaits it
  return DATA;
}

export async function embedQuery(q) {
  const ex = await loadModel();
  const out = await ex((DATA.meta.query_prefix || "") + q, { pooling: "mean", normalize: true });
  return out.data; // Float32Array, unit length
}

// Embed a DOCUMENT (no query prefix — matches how the corpus was embedded), and
// return a base64 int8 vector for compact storage.
export async function embedDocB64(text) {
  const ex = await loadModel();
  const out = await ex(text, { pooling: "mean", normalize: true });
  const v = out.data, n = v.length, bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let q = Math.round(v[i] * 127);
    bytes[i] = (q > 127 ? 127 : q < -128 ? -128 : q) & 0xff;
  }
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// Cosine of a query float vector against a base64 int8 doc vector.
export function cosineQB64(qvec, b64) {
  if (!b64) return null;
  const s = atob(b64), n = s.length;
  let dot = 0;
  for (let i = 0; i < n; i++) {
    let b = s.charCodeAt(i);
    if (b > 127) b -= 256; // int8
    dot += qvec[i] * b;
  }
  return Math.max(0, dot / 127);
}

// filters: { top, journalYears, confYears, preprintYears }  (years = window or null=all)
export async function search(query, filters = {}) {
  if (!DATA) throw new Error("index not loaded");
  const qv = await embedQuery(query);
  const { dim, count, papers, emb, currentYear } = DATA;
  const top = filters.top || 25;
  const floor = {
    journal: filters.journalYears ? currentYear - filters.journalYears + 1 : null,
    conference: filters.confYears ? currentYear - filters.confYears + 1 : null,
    preprint: filters.preprintYears ? currentYear - filters.preprintYears + 1 : null,
  };
  const buckets = { journal: [], conference: [], preprint: [] };
  for (let r = 0; r < count; r++) {
    const p = papers[r];
    const f = floor[p.col];
    if (f && p.year && p.year < f) continue;
    let s = 0;
    const base = r * dim;
    for (let i = 0; i < dim; i++) s += qv[i] * emb[base + i];
    buckets[p.col].push([s / 127, r]);
  }
  const out = { qvec: qv };
  for (const c of COLS) {
    buckets[c].sort((a, b) => b[0] - a[0]);
    out[c] = buckets[c].slice(0, top).map(([s, r]) => ({ ...papers[r], score: Math.max(0, s) }));
  }
  return out;
}

// Full corpus array (slim records) for the browse view. Empty until loaded.
export function allPapers() {
  return DATA ? DATA.papers : [];
}

// Look up a corpus paper by id (for placing pinned papers that fell outside top-N).
export function paperById(id) {
  if (!DATA) return null;
  // linear scan is fine — only called for the handful of pinned ids
  return DATA.papers.find((p) => p.id === id) || null;
}

export function scorePaper(qvec, paper) {
  const idx = DATA.papers.indexOf(paper);
  if (idx < 0) return 0;
  const { dim, emb } = DATA, base = idx * dim;
  let s = 0;
  for (let i = 0; i < dim; i++) s += qvec[i] * emb[base + i];
  return Math.max(0, s / 127);
}
