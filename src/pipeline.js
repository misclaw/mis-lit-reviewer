// The Within-IS review pipeline (Webster & Watson step 1, inside the field):
//   1. LLM query refinement / expansion  — reduce ambiguity, add synonyms
//   2. embedding similarity over the shipped corpus → top ~100 candidates
//   3. LLM rerank to 20 with a one-line summary + relevance rationale each
// plus the prestige re-ranking option and the Outside-IS web search.
import { loadIndex, searchTopK } from "./search.js";
import { chatJSON, webSearchJSON } from "./llm.js";

// Canonical venue table: familiar abbreviation + publisher for the cards, and
// the names double as the preference chips in onboarding. Names match the
// corpus' venue strings exactly (that's what prestige ranking joins on).
export const VENUES = {
  "MIS Quarterly":                                        { abbr: "MISQ", pub: "MISQ" },
  "Information Systems Research":                         { abbr: "ISR",  pub: "INFORMS" },
  "Journal of Management Information Systems":            { abbr: "JMIS", pub: "Taylor & Francis" },
  "Journal of the Association for Information Systems":   { abbr: "JAIS", pub: "AIS" },
  "European Journal of Information Systems":              { abbr: "EJIS", pub: "Taylor & Francis" },
  "Information Systems Journal":                          { abbr: "ISJ",  pub: "Wiley" },
  "Journal of Strategic Information Systems":             { abbr: "JSIS", pub: "Elsevier" },
  "Journal of Information Technology":                    { abbr: "JIT",  pub: "SAGE" },
  "Management Science":                                   { abbr: "MS",   pub: "INFORMS" },
  "Organization Science":                                 { abbr: "OS",   pub: "INFORMS" },
  "Production and Operations Management":                 { abbr: "POM",  pub: "Wiley" },
  "Marketing Science":                                    { abbr: "MkS",  pub: "INFORMS" },
  "Manufacturing & Service Operations Management":        { abbr: "MSOM", pub: "INFORMS" },
  "ICIS":  { abbr: "ICIS",  pub: "AIS", conf: true },
  "ECIS":  { abbr: "ECIS",  pub: "AIS", conf: true },
  "PACIS": { abbr: "PACIS", pub: "AIS", conf: true },
  "AMCIS": { abbr: "AMCIS", pub: "AIS", conf: true },
  "SSRN":  { abbr: "SSRN",  pub: "SSRN" },
};
export const PRIMARY_JOURNALS = [
  "MIS Quarterly", "Information Systems Research", "Journal of Management Information Systems",
  "Journal of the Association for Information Systems", "European Journal of Information Systems",
  "Information Systems Journal", "Journal of Strategic Information Systems", "Journal of Information Technology",
];
export const SECONDARY_JOURNALS = [
  "Management Science", "Organization Science", "Production and Operations Management",
  "Marketing Science", "Manufacturing & Service Operations Management",
];
export const CONFERENCES = ["ICIS", "ECIS", "PACIS", "AMCIS"];

export function venueAbbr(v) { return VENUES[v]?.abbr || v || "—"; }
export function venuePub(v) { return VENUES[v]?.pub || ""; }

function profileBlurb(profile, prefs) {
  const bits = [];
  if (prefs.topics.length) bits.push(`research interests: ${prefs.topics.join(", ")}`);
  if (prefs.interests.trim()) bits.push(`in their own words: "${prefs.interests.trim()}"`);
  if (prefs.phil) bits.push(`research philosophy: ${prefs.phil}`);
  if (prefs.methods.length) bits.push(`preferred methodologies: ${prefs.methods.join(", ")}`);
  if (prefs.prims.length) bits.push(`primary target venues: ${prefs.prims.map(venueAbbr).join(", ")}`);
  return bits.length
    ? `The researcher's profile (use it to sharpen relevance judgments, not to exclude adjacent work):\n${bits.map((b) => "- " + b).join("\n")}`
    : "No researcher profile available.";
}

// ---- step 1: query refinement / expansion ----
export async function refineQuery({ query, profile, prefs, provider, key, model }) {
  const out = await chatJSON(provider, key, {
    model,
    maxTokens: 1200,
    system:
      "You refine research questions for semantic search over an Information Systems (IS) literature corpus " +
      "(titles + abstracts, embedded with a sentence encoder). Reduce ambiguity, resolve acronyms, and surface synonyms. " +
      "Reply with JSON only: {\"refined_query\": string, \"expansions\": string[]} — refined_query is a single dense " +
      "phrasing of the question using field vocabulary; expansions are up to 3 alternative full phrasings that substitute " +
      "key terms with synonyms or neighboring constructs (each must stand alone as a search query).",
    user: `${profileBlurb(profile, prefs)}\n\nResearch question: ${query}`,
  });
  const refined = typeof out.refined_query === "string" && out.refined_query.trim() ? out.refined_query.trim() : query;
  const expansions = (Array.isArray(out.expansions) ? out.expansions : [])
    .filter((e) => typeof e === "string" && e.trim()).slice(0, 3);
  return { refined, expansions };
}

// ---- step 2: similarity filtering ----
export async function similarityFilter({ query, refined, expansions }, k = 100) {
  await loadIndex();
  return searchTopK([query, refined, ...expansions], k);
}

// ---- step 3: LLM reranking with rationales ----
const clip = (s, n) => (s && s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s || "");

export async function rerank({ query, refined, candidates, profile, prefs, provider, key, model }, n = 20) {
  const listing = candidates.map((p, i) =>
    `[${i}] ${p.title} (${venueAbbr(p.venue)} ${p.year || "?"}${p.cited != null ? `, cited ${p.cited}` : ""})\n${clip(p.abstract, 420)}`
  ).join("\n\n");
  const out = await chatJSON(provider, key, {
    model,
    maxTokens: 6000,
    system:
      "You are screening candidate papers for a literature review in Information Systems, following Webster & Watson (2002). " +
      `Given a research question and ${candidates.length} candidates (pre-filtered by embedding similarity), select and rank the ${n} most relevant. ` +
      "Judge by conceptual relevance to the question — theory, constructs, phenomenon, and method fit — not by citation count alone. " +
      "Reply with JSON only: {\"picks\": [{\"i\": <candidate index>, \"summary\": <one-line summary of the paper itself>, " +
      "\"rationale\": <one sentence on why it matters for THIS question>}]} " +
      `— exactly ${n} picks (fewer only if fewer are genuinely relevant), ordered most relevant first.`,
    user: `${profileBlurb(profile, prefs)}\n\nResearch question: ${query}\nRefined phrasing: ${refined}\n\nCandidates:\n\n${listing}`,
  });
  const picks = Array.isArray(out.picks) ? out.picks : [];
  const seen = new Set();
  const results = [];
  for (const p of picks) {
    const i = Number(p.i);
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length || seen.has(i)) continue;
    seen.add(i);
    results.push({
      ...candidates[i],
      summary: typeof p.summary === "string" ? p.summary : clip(candidates[i].abstract, 180),
      rationale: typeof p.rationale === "string" ? p.rationale : "Selected by LLM relevance screening.",
    });
    if (results.length >= n) break;
  }
  if (!results.length) throw new Error("reranker returned no usable picks");
  return results;
}

// ---- prestige ranking: user's primary venues first, then secondary, then rest;
// stable within a tier (keeps the LLM's relevance order). ----
export function prestigeSort(results, prefs) {
  const rank = new Map();
  prefs.prims.forEach((v, i) => rank.set(v, i));
  prefs.secs.forEach((v, i) => rank.set(v, 100 + i));
  prefs.confs.forEach((v, i) => rank.set(v, 200 + i));
  return results
    .map((p, i) => ({ p, i, r: rank.has(p.venue) ? rank.get(p.venue) : 900 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p);
}

// ---- Outside IS: LLM provider + web-search tool ----
// The system prompt is user-visible and user-adjustable (Outside IS →
// "Search prompt"). {n} is substituted with the requested paper count; the
// researcher profile + research question are always appended as the user turn.
export const OUTSIDE_PROMPT_DEFAULT =
  "You help an Information Systems (IS) scholar look OUTSIDE the IS discipline, per Webster & Watson (2002): " +
  "IS is interdisciplinary, so reviews must also draw on reference disciplines (management, psychology, HCI, economics, " +
  "marketing, computer science, operations…). Use your web search tool to find real, verifiable academic papers from " +
  "OUTSIDE the core IS journals/conferences that bear on the research question. Never invent papers — every entry must " +
  "come from something you actually found. Reply with JSON only:\n" +
  "{\"papers\": [{\"title\": str, \"authors\": str, \"venue\": str, \"year\": int, \"discipline\": str, " +
  "\"url\": str, \"doi\": str|null, \"summary\": <one-line summary>, \"rationale\": <why it matters for this question>}]}\n" +
  "— up to {n} papers, most relevant first. Prefer highly-cited foundational work plus recent developments.";

export async function searchOutside({ query, profile, prefs, provider, key, model, prompt }, n = 8) {
  const system = (prompt && prompt.trim() ? prompt : OUTSIDE_PROMPT_DEFAULT).replaceAll("{n}", String(n));
  const out = await webSearchJSON(provider, key, {
    model,
    maxTokens: 8000,
    system,
    user: `${profileBlurb(profile, prefs)}\n\nResearch question: ${query}`,
  });
  const papers = (Array.isArray(out.papers) ? out.papers : [])
    .filter((p) => p && typeof p.title === "string" && p.title.trim())
    .slice(0, n)
    .map((p) => ({
      title: p.title.trim(),
      authors: typeof p.authors === "string" ? p.authors : "",
      venue: typeof p.venue === "string" ? p.venue : "",
      year: Number(p.year) || null,
      discipline: typeof p.discipline === "string" ? p.discipline : "",
      url: typeof p.url === "string" ? p.url : (p.doi ? "https://doi.org/" + p.doi : null),
      doi: typeof p.doi === "string" ? p.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") : null,
      summary: typeof p.summary === "string" ? p.summary : "",
      rationale: typeof p.rationale === "string" ? p.rationale : "",
      cited: null,
      source: "llm",
    }));
  if (!papers.length) throw new Error("web search returned no usable papers");
  return papers;
}

// ---- metadata enrichment for outside/imported papers (OpenAlex title match).
// On a confident match, OpenAlex's canonical metadata wins over whatever the
// source page showed (Scholar bylines truncate venues and authors). Fetches
// the abstract too so imported papers can be LLM-summarized like within-IS
// results. Best-effort: failures leave the paper as it came. ----
const MAILTO = "gwonedgar@gmail.com";

export function reconstructAbstract(inv) {
  if (!inv) return null;
  const pos = [];
  for (const [w, idxs] of Object.entries(inv)) for (const i of idxs) pos.push([i, w]);
  pos.sort((a, b) => a[0] - b[0]);
  return pos.length ? pos.map((p) => p[1]).join(" ") : null;
}

const OA_SELECT = "id,title,doi,cited_by_count,publication_year,primary_location,authorships,abstract_inverted_index";

export async function enrichOutside(papers, { concurrency = 4, timeoutMs = 9000 } = {}) {
  const enrichOne = async (p) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const q = p.doi
        ? `https://api.openalex.org/works/doi:${encodeURIComponent(p.doi)}?select=${OA_SELECT}&mailto=${MAILTO}`
        : `https://api.openalex.org/works?search=${encodeURIComponent(p.title)}&per-page=1&select=${OA_SELECT}&mailto=${MAILTO}`;
      const res = await fetch(q, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return p;
      const j = await res.json();
      const w = p.doi ? j : j.results?.[0];
      if (!w || (!p.doi && !titleClose(p.title, w.title))) return p;
      const authors = (w.authorships || []).slice(0, 8).map((a) => a.author?.display_name).filter(Boolean);
      const venue = w.primary_location?.source?.display_name;
      const doi = w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//, "") : null;
      return {
        ...p,
        title: w.title || p.title,
        authors: authors.length ? authors.join(", ") : p.authors,
        venue: venue || p.venue,
        openalex: w.id?.replace("https://openalex.org/", "") || null,
        cited: w.cited_by_count ?? p.cited,
        doi: p.doi || doi,
        url: p.url || (doi ? "https://doi.org/" + doi : null),
        year: w.publication_year || p.year || null,
        abstract: clip(reconstructAbstract(w.abstract_inverted_index), 1200) || p.abstract || null,
      };
    } catch { return p; }
  };
  const out = new Array(papers.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, papers.length) }, async () => {
    while (idx < papers.length) { const i = idx++; out[i] = await enrichOne(papers[i]); }
  }));
  return out;
}
function titleClose(a, b) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  const na = norm(a), nb = norm(b);
  return na && nb && (na === nb || na.includes(nb) || nb.includes(na));
}

// ---- LLM pass over imported papers: one-line summary + relevance rationale,
// so imports get the same card format as within-IS results. ----
export async function describeImports({ papers, query, profile, prefs, provider, key, model }) {
  const listing = papers.map((p, i) =>
    `[${i}] ${p.title} — ${p.authors || "?"} · ${p.venue || "?"} · ${p.year || "?"}\n` +
    clip(p.abstract || p.rationale || "", 500)
  ).join("\n\n");
  const out = await chatJSON(provider, key, {
    model,
    maxTokens: 4000,
    system:
      "An Information Systems scholar imported these papers from an external literature tool into their review. " +
      "For each paper, write a one-line summary of the paper itself and one sentence on why it matters for the " +
      "research question (its discipline lens, construct, or finding). Also name the paper's home discipline. " +
      "Reply with JSON only: {\"items\": [{\"i\": <index>, \"summary\": str, \"rationale\": str, \"discipline\": str}]} " +
      "— one item per paper, same indices.",
    user: `${profileBlurb(profile, prefs)}\n\nResearch question: ${query}\n\nImported papers:\n\n${listing}`,
  });
  const items = Array.isArray(out.items) ? out.items : [];
  const byIdx = new Map(items.map((x) => [Number(x.i), x]));
  return papers.map((p, i) => {
    const x = byIdx.get(i);
    if (!x) return p;
    return {
      ...p,
      summary: typeof x.summary === "string" && x.summary ? x.summary : p.summary,
      rationale: typeof x.rationale === "string" && x.rationale ? x.rationale : p.rationale,
      discipline: typeof x.discipline === "string" && x.discipline ? x.discipline : p.discipline,
    };
  });
}
