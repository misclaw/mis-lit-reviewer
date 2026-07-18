// Identity resolution + rigorous deduplication for the outside-IS collection.
//
// Papers arrive from heterogeneous sources — LLM web search, Google Scholar,
// SciSpace, Asta, Paper Digest, reference-viewer — carrying different subsets
// of identifiers: a DOI, a publisher URL with a DOI buried in the path, an
// arXiv id, a Semantic Scholar link, sometimes only a title. Two records are
// the same paper if ANY normalized identifier matches; merged records keep the
// richest value per field and the union of their sources.

// ---- identifier normalization ----

// Normalize any DOI spelling: bare, doi:-prefixed, doi.org URL, URL-encoded.
export function normDoi(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  try { s = decodeURIComponent(s); } catch { /* keep as-is */ }
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim();
  const m = s.match(/10\.\d{4,9}\/\S+/);
  if (!m) return null;
  // trailing punctuation / fragments are never part of a DOI
  return m[0].replace(/[.,;)\]]+$/, "").replace(/[#?].*$/, "").toLowerCase();
}

// Pull a DOI out of a publisher/aggregator URL (Wiley, SAGE, Springer, ACM,
// T&F, INFORMS, ScienceDirect via /doi/ paths, doi.org itself, …).
export function doiFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  let path;
  try { path = decodeURIComponent(new URL(url).pathname); } catch { return null; }
  const m = path.match(/10\.\d{4,9}\/[^\s]+/);
  if (!m) return null;
  return m[0].replace(/\/(abstract|full|pdf|epdf|meta|references)$/i, "")
    .replace(/[.,;)\]]+$/, "").toLowerCase();
}

export function arxivIdFrom(str) {
  if (!str || typeof str !== "string") return null;
  const m = str.match(/arxiv(?:\.org\/(?:abs|pdf)\/|[:\s/])(\d{4}\.\d{4,5})/i)
    || str.match(/10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i);
  return m ? m[1] : null;
}

// semanticscholar.org/paper/Some-Slug/<40-hex> · /paper/<40-hex> · CorpusID:n
export function s2IdFrom(url) {
  if (!url || typeof url !== "string") return null;
  let m = url.match(/semanticscholar\.org\/paper\/(?:[^/]+\/)?([0-9a-f]{40})/i);
  if (m) return m[1].toLowerCase();
  m = url.match(/CorpusID:?(\d+)/i);
  if (m) return "CorpusID:" + m[1];
  return null;
}

export function normTitleKey(t) {
  const s = (t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length >= 15 ? s : null; // short strings collide too easily
}

// All identity keys of a record, strongest first.
export function paperKeys(p) {
  const keys = [];
  const doi = normDoi(p.doi) || doiFromUrl(p.url);
  if (doi) keys.push("doi:" + doi);
  if (p.openalex) keys.push("oa:" + String(p.openalex).toUpperCase());
  const ax = arxivIdFrom(p.doi || "") || arxivIdFrom(p.url || "");
  if (ax) { keys.push("arxiv:" + ax); keys.push("doi:10.48550/arxiv." + ax); }
  const s2 = s2IdFrom(p.url || "") || (p.s2id ? String(p.s2id) : null);
  if (s2) keys.push("s2:" + s2);
  const ti = normTitleKey(p.title);
  if (ti) keys.push("ti:" + ti);
  return keys;
}

// ---- merging ----
const longer = (a, b) => ((b || "").length > (a || "").length ? b : a);

export function sourcesOf(p) {
  if (Array.isArray(p.sources) && p.sources.length) return p.sources;
  if (p.source === "import") return [p.badge || "Imported"];
  if (p.source === "llm") return ["Web search"];
  return [p.badge || "Web search"];
}

// Merge b into a: keep the richest value per field, union the sources.
export function mergePapers(a, b) {
  const sources = [...new Set([...sourcesOf(a), ...sourcesOf(b)])];
  return {
    ...a,
    title: longer(a.title, b.title),
    authors: longer(a.authors, b.authors),
    venue: longer(a.venue, b.venue),
    year: a.year || b.year || null,
    doi: normDoi(a.doi) || normDoi(b.doi) || doiFromUrl(a.url) || doiFromUrl(b.url) || null,
    url: a.url || b.url || null,
    openalex: a.openalex || b.openalex || null,
    s2id: a.s2id || b.s2id || null,
    cited: a.cited ?? b.cited ?? null,
    abstract: longer(a.abstract, b.abstract) || null,
    summary: longer(a.summary, b.summary),
    rationale: longer(a.rationale, b.rationale),
    discipline: a.discipline || b.discipline || "",
    sources,
    source: sources.some((s) => s !== "Web search") ? "import" : "llm",
  };
}

// Fold `incoming` into `existing` (both arrays of papers). Returns
// { list, merged } — merged counts records that collapsed into an existing
// entry. Order-preserving; also dedupes incoming against itself.
export function dedupeInto(existing, incoming) {
  const list = existing.map((p) => ({ ...p, sources: sourcesOf(p) }));
  const index = new Map(); // key → list position
  list.forEach((p, i) => { for (const k of paperKeys(p)) if (!index.has(k)) index.set(k, i); });
  let merged = 0;
  for (const raw of incoming) {
    const p = { ...raw, sources: sourcesOf(raw) };
    const keys = paperKeys(p);
    const hit = keys.map((k) => index.get(k)).find((i) => i !== undefined);
    if (hit !== undefined) {
      list[hit] = mergePapers(list[hit], p);
      merged++;
      for (const k of paperKeys(list[hit])) if (!index.has(k)) index.set(k, hit);
    } else {
      list.push(p);
      const at = list.length - 1;
      for (const k of keys) if (!index.has(k)) index.set(k, at);
    }
  }
  return { list, merged };
}

// Drop outside papers that are already in the within-IS main set.
export function dropWithinOverlap(papers, within) {
  const withinKeys = new Set();
  for (const w of within || []) {
    for (const k of paperKeys({ ...w, openalex: w.id })) withinKeys.add(k);
  }
  const kept = [], overlap = [];
  for (const p of papers) {
    if (paperKeys(p).some((k) => withinKeys.has(k))) overlap.push(p);
    else kept.push(p);
  }
  return { kept, overlap: overlap.length };
}
