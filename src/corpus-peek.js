// "Recent additions to the IS corpus" peek — the evidence behind the Within-IS
// subtitle ("Curated IS corpus — basket journals + major IS conferences, crawled
// daily"). Clicking that subtitle opens this modal, which lazily loads
// public/data/recent.json (written by the daily crawler) and lists the latest
// papers, premier IS journals first, each linking out to its DOI so the freshness
// is verifiable — not just a claim.
import { h } from "./ui.js";
import { VENUES, PRIMARY_JOURNALS, SECONDARY_JOURNALS, venueAbbr } from "./pipeline.js";

// One shared fetch, memoized: the peek can be reopened without re-downloading.
let recentPromise = null;
function loadRecent() {
  if (!recentPromise) {
    recentPromise = fetch((import.meta.env.BASE_URL || "./") + "data/recent.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return recentPromise;
}

const PRIMARY = new Set(PRIMARY_JOURNALS);
const SECONDARY = new Set(SECONDARY_JOURNALS);
// premier IS journals first (the most convincing evidence), then adjacent
// journals, then other journals, then conferences — recency within each tier.
function tier(v) { return PRIMARY.has(v) ? 0 : SECONDARY.has(v) ? 1 : VENUES[v]?.conf ? 3 : 2; }
function recencyKey(p) { return String(p.added || p.year || ""); }
function pickRecent(papers, n = 18) {
  return [...papers]
    .sort((a, b) =>
      tier(a.venue) - tier(b.venue) ||
      recencyKey(b).localeCompare(recencyKey(a)) ||
      (b.year || 0) - (a.year || 0))
    .slice(0, n);
}

// Some crawled records keep source markup in the title/abstract (e.g.
// "<scp>ISJ</scp>"); strip tags for display (h() renders text nodes, so this is
// cosmetic, not a safety fix).
function stripTags(s) {
  return (s || "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
}
function fmtAuthors(authors) {
  const a = Array.isArray(authors) ? authors : (authors ? [authors] : []);
  if (!a.length) return "";
  return a.length <= 3 ? a.join(", ") : a.slice(0, 3).join(", ") + ", …";
}
function hrefOf(p) {
  if (p.url) return p.url;
  if (!p.doi) return null;
  return /^https?:/i.test(p.doi) ? p.doi : "https://doi.org/" + p.doi;
}

function paperRow(p) {
  const href = hrefOf(p);
  const primary = PRIMARY.has(p.venue);
  const meta = [fmtAuthors(p.authors), p.year].filter(Boolean).join(" · ");
  const title = stripTags(p.title) || "(untitled)";
  return h("div", { class: "cp-row" },
    h("div", { class: `cp-venue${primary ? " primary" : ""}`, title: p.venue || "" }, venueAbbr(p.venue)),
    h("div", { class: "cp-main" },
      h("div", { class: "cp-title" },
        href ? h("a", { href, target: "_blank", rel: "noopener" }, title) : title),
      meta && h("div", { class: "cp-meta" }, meta),
      p.abstract && h("div", { class: "cp-abs" }, stripTags(p.abstract))));
}

// ---- overlay lifecycle (self-contained, like paper-modal / toast) ----
let openEl = null, keyHandler = null, lastFocus = null;
function close() {
  if (keyHandler) { document.removeEventListener("keydown", keyHandler); keyHandler = null; }
  if (openEl) { openEl.remove(); openEl = null; }
  document.body.style.overflow = "";
  try { lastFocus?.focus?.(); } catch { /* element gone */ }
  lastFocus = null;
}

export function openCorpusPeek() {
  if (openEl) close();
  lastFocus = document.activeElement;

  const list = h("div", { class: "cp-list" },
    h("div", { class: "cp-loading" }, h("div", { class: "pm-spin" }), "Loading recent additions…"));

  const dialog = h("div", { class: "corpus-peek", role: "dialog", "aria-modal": "true",
    "aria-label": "Recent additions to the IS corpus" },
    h("button", { class: "pm-close", "aria-label": "Close", onclick: close }, "✕"),
    h("div", { class: "cp-head" },
      h("div", { class: "cp-kicker" }, "Curated IS corpus"),
      h("div", { class: "cp-h" }, "Recent additions"),
      h("div", { class: "cp-sub" },
        "The daily crawl keeps the basket journals current — MISQ, ISR, JMIS, JAIS and the rest, " +
        "plus the major IS conferences. Here are the latest papers it pulled in; every title links to the source.")),
    list);

  const overlay = h("div", { class: "modal-overlay cp-overlay",
    onclick: (e) => { if (e.target === overlay) close(); } }, dialog);
  document.body.append(overlay);
  document.body.style.overflow = "hidden";
  openEl = overlay;
  keyHandler = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", keyHandler);
  requestAnimationFrame(() => dialog.querySelector(".pm-close")?.focus());

  loadRecent().then((data) => {
    if (openEl !== overlay) return; // closed (or reopened) before the fetch landed
    const papers = data?.papers || [];
    if (!papers.length) {
      list.replaceChildren(h("div", { class: "cp-empty" },
        "Couldn't load the recent-papers feed right now — the corpus stats above still reflect the daily crawl."));
      return;
    }
    const when = data.generated_at ? String(data.generated_at).slice(0, 10) : null;
    list.replaceChildren(
      h("div", { class: "cp-count" },
        `${papers.length.toLocaleString("en-US")} papers indexed in the recent crawl window` +
        (when ? ` · updated ${when}` : "")),
      ...pickRecent(papers).map(paperRow));
  });

  return overlay;
}
