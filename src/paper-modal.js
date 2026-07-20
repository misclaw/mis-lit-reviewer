// Paper detail modal: full metadata + abstract for any card.
//
// Opened by clicking a paper card's body (the title link still navigates to the
// paper). Within-IS corpus papers already carry a full abstract; outside /
// imported papers get one during resolution (pipeline.resolvePapers). When a
// paper still has no abstract, this fetches one on demand from OpenAlex (by DOI,
// then OpenAlex id, then a title search) and — via the optional `persist`
// callback — writes it back onto the stored paper so it's held for next time.
import { h, fmtCites } from "./ui.js";
import { reconstructAbstract, venuePub, venueAbbr } from "./pipeline.js";
import { sourcesOf, recommendersOf } from "./dedupe.js";

const MAILTO = "gwonedgar@gmail.com";
const OA_SELECT =
  "id,title,doi,abstract_inverted_index,primary_location,authorships,publication_year,cited_by_count";

// Stable-ish identity for the session cache: strongest identifier we have.
function cacheKey(p) {
  return (p.doi && "doi:" + p.doi.toLowerCase()) || oaIdOf(p) || p.url || (p.title ? "ti:" + p.title.toLowerCase() : null);
}
function oaIdOf(p) {
  if (p.openalex) return String(p.openalex).replace("https://openalex.org/", "");
  if (typeof p.id === "string" && /^W\d+$/.test(p.id)) return p.id; // corpus records key on the OpenAlex id
  return null;
}

// null = fetched, none found · string = abstract · absent = never fetched
const abstractCache = new Map();

async function fetchTimeout(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// Best-effort OpenAlex lookup → { abstract, cited, venue, year, authors, doi, url, openalex }
// (only the abstract is required; the rest fills display gaps).
async function fetchFromOpenAlex(paper) {
  const oaId = oaIdOf(paper);
  let url;
  if (paper.doi) url = `https://api.openalex.org/works/doi:${encodeURIComponent(paper.doi)}?select=${OA_SELECT}&mailto=${MAILTO}`;
  else if (oaId) url = `https://api.openalex.org/works/${encodeURIComponent(oaId)}?select=${OA_SELECT}&mailto=${MAILTO}`;
  else if (paper.title) url = `https://api.openalex.org/works?search=${encodeURIComponent(paper.title)}&per-page=1&select=${OA_SELECT}&mailto=${MAILTO}`;
  else return null;
  const res = await fetchTimeout(url);
  if (!res.ok) return null;
  const j = await res.json();
  const w = (paper.doi || oaId) ? j : j.results?.[0];
  if (!w) return null;
  const authors = (w.authorships || []).slice(0, 12).map((a) => a.author?.display_name).filter(Boolean);
  return {
    abstract: reconstructAbstract(w.abstract_inverted_index),
    cited: w.cited_by_count ?? null,
    venue: w.primary_location?.source?.display_name || null,
    year: w.publication_year || null,
    authors: authors.length ? authors.join(", ") : null,
    openalex: w.id?.replace("https://openalex.org/", "") || null,
  };
}

// ---- rendering ----
let openEl = null;
let keyHandler = null;
let lastFocus = null;

function closeModal() {
  if (keyHandler) { document.removeEventListener("keydown", keyHandler); keyHandler = null; }
  if (openEl) { openEl.remove(); openEl = null; }
  document.body.style.overflow = "";
  try { lastFocus?.focus?.(); } catch { /* element gone */ }
  lastFocus = null;
}

function metaRow(label, value) {
  if (value == null || value === "") return null;
  return h("div", { class: "pm-meta-row" },
    h("div", { class: "pm-meta-k" }, label),
    h("div", { class: "pm-meta-v" }, value));
}

function link(href, text) {
  return h("a", { href, target: "_blank", rel: "noopener" }, text);
}

// paper: the card's paper object · accent: "wi" | "os" (colour theme) ·
// persist: optional (patch) => void to hold newly fetched fields.
export function openPaperModal(paper, { accent = "wi", persist = null } = {}) {
  if (openEl) closeModal();
  lastFocus = document.activeElement;

  const authors = typeof paper.authors === "string" ? paper.authors : (paper.authors || []).join(", ");
  const pub = venuePub(paper.venue);
  const cites = fmtCites(paper.cited);
  const href = paper.url || (paper.doi ? "https://doi.org/" + paper.doi : null);
  const title = paper.title || (paper.doi ? "doi:" + paper.doi : paper.url) || "(unresolved paper)";
  const oaId = oaIdOf(paper);

  // provenance: which models recommended it + any import tools (skip the generic tag)
  const recs = recommendersOf(paper);
  const tools = sourcesOf(paper).filter((s) => s !== "Web search");
  const provParts = [];
  if (recs.length) provParts.push((recs.length > 1 ? "Recommended by " : "Found by ") + recs.join(" · "));
  if (tools.length) provParts.push("Imported from " + tools.join(" · "));

  const abstractBox = h("div", { class: "pm-abstract-body" });
  const setAbstract = (text) => {
    abstractBox.replaceChildren();
    if (text) {
      abstractBox.append(h("p", { class: "pm-abstract-text" }, text));
    } else {
      abstractBox.append(h("div", { class: "pm-abstract-empty" },
        "No abstract available for this record",
        href ? [" — ", link(href, "open the paper ↗")] : ""));
    }
  };

  const dialog = h("div", { class: `paper-modal ${accent}`, role: "dialog", "aria-modal": "true",
    "aria-label": title },
    h("button", { class: "pm-close", "aria-label": "Close", onclick: closeModal }, "✕"),
    h("div", { class: "pm-head" },
      h("div", { class: "pm-kicker" },
        (paper.discipline ? paper.discipline + " · " : "") +
        (VENUE_KICKER(paper) || "Paper details")),
      h("div", { class: "pm-title" }, href ? link(href, title) : title),
      authors && h("div", { class: "pm-authors" }, authors)),
    h("div", { class: "pm-meta" },
      metaRow("Venue", paper.venue ? h("span", {}, h("strong", {}, paper.venue), pub ? ` · ${pub}` : "") : null),
      metaRow("Year", paper.year || null),
      metaRow("Citations", cites != null ? `Cited by ${cites}` : null),
      metaRow("DOI", paper.doi ? link("https://doi.org/" + paper.doi, paper.doi) : null),
      metaRow("Provenance", provParts.length ? provParts.join("  ·  ") : null)),
    paper.summary && h("div", { class: "pm-summary" }, h("span", { class: "pm-lab" }, "Summary"), paper.summary),
    paper.rationale && h("div", { class: "pm-rationale" }, h("span", { class: "pm-lab" }, "Why relevant"), paper.rationale),
    h("div", { class: "pm-abstract" },
      h("div", { class: "pm-lab" }, "Abstract"),
      abstractBox),
    h("div", { class: "pm-links" },
      href && link(href, "Open paper / PDF ↗"),
      paper.doi && link("https://doi.org/" + paper.doi, "DOI ↗"),
      oaId && link("https://openalex.org/" + oaId, "OpenAlex ↗"),
      link("https://scholar.google.com/scholar?q=" + encodeURIComponent(title), "Google Scholar ↗")));

  // abstract: use what we hold, else the session cache, else fetch on demand
  const key = cacheKey(paper);
  if (paper.abstract) {
    setAbstract(paper.abstract);
  } else if (key && abstractCache.has(key)) {
    setAbstract(abstractCache.get(key));
  } else {
    abstractBox.append(h("div", { class: "pm-abstract-loading" },
      h("div", { class: "pm-spin" }), "Fetching abstract from OpenAlex…"));
    fetchFromOpenAlex(paper).then((got) => {
      const abstract = got?.abstract || null;
      if (key) abstractCache.set(key, abstract);
      // only touch the DOM if this modal is still the open one
      if (openEl === overlay) setAbstract(abstract);
      if (abstract && persist) {
        const patch = { abstract };
        if (got.cited != null && paper.cited == null) patch.cited = got.cited;
        if (got.venue && !paper.venue) patch.venue = got.venue;
        if (got.year && !paper.year) patch.year = got.year;
        if (got.authors && !authors) patch.authors = got.authors;
        if (got.openalex && !paper.openalex) patch.openalex = got.openalex;
        try { persist(patch); } catch { /* persistence is best-effort */ }
      }
    }).catch(() => {
      if (key) abstractCache.set(key, null);
      if (openEl === overlay) setAbstract(null);
    });
  }

  const overlay = h("div", { class: "modal-overlay pm-overlay",
    onclick: (e) => { if (e.target === overlay) closeModal(); } }, dialog);
  document.body.append(overlay);
  document.body.style.overflow = "hidden";
  openEl = overlay;
  keyHandler = (e) => { if (e.key === "Escape") closeModal(); };
  document.addEventListener("keydown", keyHandler);
  requestAnimationFrame(() => dialog.querySelector(".pm-close")?.focus());
  return overlay;
}

// A compact kicker: the venue abbreviation when it's a known IS venue.
function VENUE_KICKER(p) {
  if (!p.venue) return null;
  const abbr = venueAbbr(p.venue);
  return abbr && abbr !== p.venue ? abbr : null;
}
