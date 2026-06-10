// Browser-side external-paper ingestion. Every field comes from an
// authoritative API (OpenAlex / Crossref) or is parsed verbatim from pasted
// reference text — nothing is generated. OpenAlex and Crossref send CORS
// headers so they work from a static site; arXiv's API does not, so arXiv ids
// are resolved through OpenAlex via the arXiv DOI (10.48550/arXiv.<id>).
const MAILTO = "querydesk@example.com";

export class IngestError extends Error {}

function reconstructAbstract(inv) {
  if (!inv) return null;
  const pos = [];
  for (const [w, idxs] of Object.entries(inv)) for (const i of idxs) pos.push([i, w]);
  pos.sort((a, b) => a[0] - b[0]);
  return pos.length ? pos.map((p) => p[1]).join(" ") : null;
}
function stripDoi(d) {
  return (d || "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim();
}
function colFromType(t, doi) {
  t = (t || "").toLowerCase();
  if (doi && doi.toLowerCase().startsWith("10.2139/ssrn")) return "preprint";
  if (t.includes("proceedings") || t.includes("conference")) return "conference";
  if (t.includes("posted-content") || t.includes("preprint") || t.includes("working")) return "preprint";
  return "journal";
}
const cleanJats = (s) => (s ? s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null : null);

async function openAlexByDoi(doi) {
  const r = await fetch(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?mailto=${MAILTO}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new IngestError("OpenAlex error " + r.status);
  const w = await r.json();
  const prim = w.primary_location || {};
  return {
    title: w.title || w.display_name,
    authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
    year: w.publication_year,
    venue: prim.source?.display_name,
    doi: stripDoi(w.doi || doi),
    url: prim.landing_page_url || `https://doi.org/${doi}`,
    abstract: reconstructAbstract(w.abstract_inverted_index),
    keywords: (w.keywords || []).map((k) => k.display_name).filter(Boolean),
    col: colFromType(w.type, doi),
    provenance: { method: "doi", source: "openalex", identifier: doi, openalex_id: w.id, fetched_at: new Date().toISOString() },
  };
}
async function crossrefByDoi(doi) {
  const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${MAILTO}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new IngestError("Crossref error " + r.status);
  const m = (await r.json()).message || {};
  const yr = m.issued?.["date-parts"]?.[0]?.[0] ?? null;
  return {
    title: (m.title || [])[0],
    authors: (m.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
    year: yr, venue: (m["container-title"] || [])[0],
    doi: stripDoi(m.DOI || doi), url: m.URL || `https://doi.org/${doi}`,
    abstract: cleanJats(m.abstract), keywords: m.subject || [],
    col: colFromType(m.type, doi),
    provenance: { method: "doi", source: "crossref", identifier: doi, fetched_at: new Date().toISOString() },
  };
}

export async function fromDoi(raw) {
  const doi = stripDoi(raw);
  if (!doi || !doi.includes("/")) throw new IngestError(`'${raw}' is not a DOI`);
  let rec = await openAlexByDoi(doi);
  if (!rec || !rec.abstract || !rec.title) {
    const cr = await crossrefByDoi(doi).catch(() => null);
    if (!rec) rec = cr;
    else if (cr) for (const k of ["title", "abstract", "venue", "year", "url"]) if (!rec[k] && cr[k]) rec[k] = cr[k];
  }
  if (!rec) throw new IngestError(`DOI ${doi} not found`);
  return rec;
}

export async function fromArxiv(raw) {
  let id = null;
  let m = raw.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:v\d+)?$/i);
  if (m) id = m[1].replace(/v\d+$/, "");
  else if ((m = raw.match(/(?:arxiv:)?\s*(\d{4}\.\d{4,5})(v\d+)?/i))) id = m[1];
  if (!id) throw new IngestError(`could not parse an arXiv id from '${raw}'`);
  const rec = await openAlexByDoi(`10.48550/arXiv.${id}`);
  if (!rec) throw new IngestError(`arXiv ${id} not yet in OpenAlex — try pasting its BibTeX instead`);
  rec.venue = rec.venue || "arXiv";
  rec.col = "preprint";
  rec.url = `https://arxiv.org/abs/${id}`;
  rec.provenance = { method: "arxiv", source: "openalex", identifier: id, fetched_at: new Date().toISOString() };
  return rec;
}

// ---- pasted reference text ----
export function fromReferenceText(text) {
  const s = (text || "").trim();
  if (!s) throw new IngestError("no reference text provided");
  if (s[0] === "[" || s[0] === "{") return parseCsl(s);
  if (/^\s*TY\s*-\s*/m.test(s)) return parseRis(s);
  if (s.includes("@")) return parseBibtex(s);
  throw new IngestError("unrecognized format (expected BibTeX, RIS, or CSL-JSON)");
}
const flip = (n) => (n.includes(",") ? n.split(",").slice(0, 2).reverse().join(" ").trim() : n.trim());
function mk(source, o) {
  o.doi = o.doi ? stripDoi(o.doi) : null;
  o.col = colFromType(o._type, o.doi); delete o._type;
  o.authors = o.authors || []; o.keywords = o.keywords || [];
  o.provenance = { method: "paste", source, fetched_at: new Date().toISOString() };
  return o;
}
function* bibEntries(text) {
  const re = /@(\w+)\s*\{/g; let m;
  while ((m = re.exec(text))) {
    const type = m[1].toLowerCase();
    if (["string", "comment", "preamble"].includes(type)) continue;
    let depth = 1, j = re.lastIndex;
    while (j < text.length && depth) { const ch = text[j]; if (ch === "{") depth++; else if (ch === "}") depth--; j++; }
    yield [type, text.slice(re.lastIndex, j - 1)];
  }
}
const unwrap = (v) => v.trim().replace(/,$/, "").trim().replace(/^[{"]|[}"]$/g, "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
function parseBibtex(text) {
  const out = [];
  for (const [type, body] of bibEntries(text)) {
    const c = body.indexOf(","), fieldStr = c >= 0 ? body.slice(c + 1) : body;
    const f = {};
    const fre = /(\w+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|[^,\n]+)/g; let fm;
    while ((fm = fre.exec(fieldStr))) f[fm[1].toLowerCase()] = unwrap(fm[2]);
    if (!f.title) continue;
    out.push(mk("bibtex", {
      title: f.title, authors: (f.author || "").split(/\s+and\s+/).filter(Boolean).map(flip),
      year: f.year ? parseInt(f.year, 10) : null, venue: f.journal || f.booktitle || f.publisher,
      doi: f.doi, url: f.url, abstract: f.abstract || null,
      keywords: (f.keywords || "").split(/[;,]/).map((x) => x.trim()).filter(Boolean), _type: type,
    }));
  }
  if (!out.length) throw new IngestError("no usable BibTeX entries found");
  return out;
}
function parseRis(text) {
  const out = []; let cur = null, authors = [], kws = [];
  const flush = () => {
    if (cur?.title) out.push(mk("ris", {
      title: cur.title, authors, year: cur.year ? parseInt(cur.year, 10) : null, venue: cur.venue,
      doi: cur.doi, url: cur.url, abstract: cur.abstract || null, keywords: kws,
      _type: { JOUR: "journal-article", CPAPER: "proceedings-article", CONF: "proceedings-article" }[cur.ty],
    }));
  };
  for (const line of text.split(/\r?\n/)) {
    const mm = line.match(/^([A-Z0-9]{2})\s*-\s?(.*)$/); if (!mm) continue;
    const [, tag, val] = mm;
    if (tag === "TY") { if (cur) flush(); cur = { ty: val }; authors = []; kws = []; }
    else if (!cur) continue;
    else if (tag === "TI" || tag === "T1") cur.title = val;
    else if (tag === "AU" || tag === "A1") authors.push(flip(val));
    else if (tag === "PY" || tag === "Y1") cur.year = val.slice(0, 4);
    else if (["JO", "JF", "T2", "BT"].includes(tag)) cur.venue = cur.venue || val;
    else if (tag === "AB" || tag === "N2") cur.abstract = ((cur.abstract || "") + " " + val).trim();
    else if (tag === "DO") cur.doi = val;
    else if (tag === "UR" || tag === "L1") cur.url = cur.url || val;
    else if (tag === "KW") kws.push(val);
    else if (tag === "ER") { flush(); cur = null; authors = []; kws = []; }
  }
  if (cur?.title) flush();
  if (!out.length) throw new IngestError("no usable RIS entries found");
  return out;
}
function parseCsl(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new IngestError("invalid CSL-JSON: " + e.message); }
  if (!Array.isArray(data)) data = [data];
  const out = [];
  for (const it of data) {
    if (!it.title) continue;
    out.push(mk("csl-json", {
      title: it.title,
      authors: (it.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" ") || a.literal).filter(Boolean),
      year: it.issued?.["date-parts"]?.[0]?.[0] ?? null, venue: it["container-title"],
      doi: it.DOI, url: it.URL, abstract: it.abstract || null,
      keywords: it.keyword ? String(it.keyword).split(",") : [], _type: it.type,
    }));
  }
  if (!out.length) throw new IngestError("no usable CSL-JSON entries found");
  return out;
}
