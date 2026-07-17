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

// ---- query-side synonym / acronym expansion (multi-vector MAX) ----
// No browser-feasible embedding model reliably treats "LLM" and "large language
// models" as the same thing (measured: 1–4/10 result overlap across
// bge-small/base/large, mxbai, nomic). So we expand the query into variants
// (substituting each term with its synonyms IN PLACE, preserving the rest of
// the query) and score each paper by its BEST-matching variant. Concatenating
// synonyms into one vector barely helps (centroid shift); MAX over separate
// variant vectors takes "LLM↔large language models" overlap from 3/10 to 10/10.
// Cheap, client-side, no re-embed. Groups are tight (true synonyms only) to
// keep precision; extend by adding mutually-interchangeable sets.
const SYNONYM_GROUPS = [
  ["LLM", "LLMs", "large language model", "large language models"],
  ["GenAI", "gen ai", "generative AI", "generative artificial intelligence"],
  ["NLP", "natural language processing"],
  ["RAG", "retrieval-augmented generation", "retrieval augmented generation"],
];
const MAX_VARIANTS = 4; // cap parallel query vectors (each adds one full corpus scan)
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Returns { variants, added }: parallel full-query phrasings to MAX over, and
// the alternate terms introduced (for the UI hint). variants[0] is the original.
export function queryVariants(q) {
  const variants = [q];
  const added = [];
  for (const group of SYNONYM_GROUPS) {
    const present = group.find((t) => new RegExp("\\b" + escapeRe(t) + "\\b", "i").test(q));
    if (!present) continue;
    const re = new RegExp("\\b" + escapeRe(present) + "\\b", "gi");
    for (const alt of group) {
      if (group.some((g) => g.toLowerCase() === alt.toLowerCase() && new RegExp("\\b" + escapeRe(g) + "\\b", "i").test(q))) continue;
      if (variants.length >= MAX_VARIANTS) break;
      variants.push(q.replace(re, alt));
      added.push(alt);
    }
  }
  return { variants: [...new Set(variants)], added: [...new Set(added)] };
}

async function embedText(text) {
  const ex = await loadModel();
  const out = await ex((DATA.meta.query_prefix || "") + text, { pooling: "mean", normalize: true });
  return out.data; // Float32Array, unit length
}

export async function embedQuery(q) {
  return embedText(queryVariants(q).variants[0]);
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

// filters: { top, journalYears, confYears, preprintYears, venueOff?, cols? }
//   venueOff = Set of venue names to exclude; cols = Set of enabled columns.
export async function search(query, filters = {}) {
  if (!DATA) throw new Error("index not loaded");
  const { variants, added } = queryVariants(query);
  const qvecs = [];
  for (const v of variants) qvecs.push(await embedText(v));
  const qv = qvecs[0]; // original-query vector; used for pins/externals scoring
  const { dim, count, papers, emb, currentYear } = DATA;
  const top = filters.top || 25;
  const off = filters.venueOff, on = filters.cols;
  const floor = {
    journal: filters.journalYears ? currentYear - filters.journalYears + 1 : null,
    conference: filters.confYears ? currentYear - filters.confYears + 1 : null,
    preprint: filters.preprintYears ? currentYear - filters.preprintYears + 1 : null,
  };
  const buckets = { journal: [], conference: [], preprint: [] };
  for (let r = 0; r < count; r++) {
    const p = papers[r];
    if (on && !on.has(p.col)) continue;
    if (off && off.size && off.has(p.venue || "Unknown")) continue;
    const f = floor[p.col];
    if (f && p.year && p.year < f) continue;
    const base = r * dim;
    let best = -Infinity;
    for (const q of qvecs) { // score by the best-matching synonym variant
      let s = 0;
      for (let i = 0; i < dim; i++) s += q[i] * emb[base + i];
      if (s > best) best = s;
    }
    buckets[p.col].push([best / 127, r]);
  }
  const out = { qvec: qv, expansion: added };
  for (const c of COLS) {
    buckets[c].sort((a, b) => b[0] - a[0]);
    out[c] = buckets[c].slice(0, top).map(([s, r]) => ({ ...papers[r], score: Math.max(0, s) }));
  }
  return out;
}

// Whole-corpus top-K for the review pipeline: embed each query phrasing
// (original + LLM-refined + expansions), score every paper by its
// best-matching phrasing (MAX pooling, same rationale as queryVariants), and
// return the top K records with scores. No column bucketing.
export async function searchTopK(queries, k = 100) {
  if (!DATA) throw new Error("index not loaded");
  const phrasings = [...new Set(queries.filter((q) => q && q.trim()))].slice(0, 5);
  if (!phrasings.length) return [];
  const qvecs = [];
  for (const q of phrasings) qvecs.push(await embedText(q));
  const { dim, count, papers, emb } = DATA;
  const scored = [];
  for (let r = 0; r < count; r++) {
    const base = r * dim;
    let best = -Infinity;
    for (const q of qvecs) {
      let s = 0;
      for (let i = 0; i < dim; i++) s += q[i] * emb[base + i];
      if (s > best) best = s;
    }
    scored.push([best / 127, r]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, k).map(([s, r]) => ({ ...papers[r], score: Math.max(0, s) }));
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
