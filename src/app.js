// Unified workbench: one view that is a date-sorted corpus browser by default
// and a three-column semantic search the moment you type a natural-language
// query. The left sidebar of query streams + pins / notes / added papers /
// .bib export all persist locally (localStorage).
//
// Two modes share the same three columns (Journals / Conferences / Preprints):
//   • browse  — query box empty: each column is its slice of the corpus,
//                venue-filtered, sorted (recently added by default), paged.
//   • query   — query box filled: each column is its top-N semantic matches,
//                with pins / added papers merged in.
// Columns can be hidden and revived freely (the layout collapses to 2- or
// 1-column); the choice persists.
import * as engine from "./search.js";
import * as db from "./store.js";
import * as ingest from "./ingest.js";
import { bibtex, cite as copyCite } from "./cite.js";
import { el, toast, debounce } from "./dom.js";

const COLS = [["journal", "Journals"], ["conference", "Conferences"], ["preprint", "Preprints"]];
const DEFAULT_FILTERS = { top: 25, journalYears: null, confYears: null, preprintYears: 2 };
const SORTS = [
  ["added_desc", "Recently added"],
  ["year_desc", "Newest published"],
  ["year_asc", "Oldest published"],
  ["cited_desc", "Most cited"],
];
const PAGE_COL = 40;                       // browse: papers rendered per column per page
const PREFS_KEY = "mis-lit-reviewer:view"; // global view prefs (columns shown + sort)

const S = {
  streams: [], current: null, externals: [], pins: [], qvec: null,
  // corpus / browse state
  byCol: { journal: [], conference: [], preprint: [] }, // corpus + fresh, per type
  venues: [], venueOff: new Set(), status: null,
  colsOn: new Set(["journal", "conference", "preprint"]),
  sort: "added_desc",
  browse: { journal: { items: [], shown: 0 }, conference: { items: [], shown: 0 }, preprint: { items: [], shown: 0 } },
  lastResults: null, // live search columns, kept so "Save" can snapshot them
  view: "workbench", // "workbench" (browse/query/snapshot) | "pinned" (cross-query library)
  mode: "browse",    // within workbench: "browse" | "query" | "snapshot"
};
const $ = (id) => document.getElementById(id);

// ---- view prefs (columns shown + sort) persist; venue selection resets to
// "all" each load so the default is always every venue checked. ----
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (Array.isArray(p.cols) && p.cols.length) S.colsOn = new Set(p.cols.filter((c) => COLS.some(([k]) => k === c)));
    if (SORTS.some(([v]) => v === p.sort)) S.sort = p.sort;
  } catch {}
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ cols: [...S.colsOn], sort: S.sort })); } catch {}
}

function readFilters() {
  const num = (id) => { const v = $(id).value; return v === "" ? null : parseInt(v, 10); };
  return { top: parseInt($("f-top").value, 10), journalYears: num("f-journal"), confYears: num("f-conf"), preprintYears: num("f-pre") };
}
function applyFilters(f = {}) {
  $("f-top").value = f.top || 25;
  $("f-journal").value = f.journalYears ?? "";
  $("f-conf").value = f.confYears ?? "";
  $("f-pre").value = f.preprintYears ?? 2;
}

export async function mountApp(root) {
  loadPrefs();
  root.replaceChildren(el("div", { class: "shell" },
    el("aside", { id: "sidebar" },
      el("div", { class: "side-actions" },
        el("button", { class: "primary", id: "new-stream", onclick: newStream }, "+ New query stream"),
        el("button", { class: "ghost lib-btn", id: "pinned-btn", onclick: showPinned }, "★ Pinned papers")),
      el("ul", { id: "stream-list" })),
    el("section", { class: "workspace" },
      el("div", { class: "topbar" },
        el("div", { class: "title-row" },
          el("input", { id: "stream-name", placeholder: "Scratch search", disabled: true, onchange: renameCurrent }),
          el("span", { class: "scratch-badge", id: "scratch-badge", hidden: true }, "scratch · not saved"),
          el("span", { class: "spacer" }),
          el("button", { class: "ghost", id: "t-add", onclick: () => $("add-panel").classList.toggle("open") }, "+ Add paper"),
          el("button", { class: "ghost", id: "t-notes", onclick: () => $("notes-panel").classList.toggle("open") }, "Notes"),
          el("a", { class: "ghost", id: "export-bib", href: "#", hidden: true, onclick: exportBib }, "Export .bib")),
        el("div", { class: "searchbar" },
          el("input", { id: "q", placeholder: "Search the corpus in plain language — or leave blank to browse by date  (Enter to search)" }),
          el("button", { class: "primary", id: "go", onclick: runSearch }, "Search"),
          el("button", { class: "save", id: "save-q", hidden: true, onclick: saveQuery, title: "Save this query and a snapshot of its results to the sidebar" }, "☆ Save query"),
          el("button", { class: "ghost", id: "rerun-q", hidden: true, onclick: () => runSearch(), title: "Re-run this saved query against the current (live) corpus" }, "↻ Re-run"),
          el("button", { class: "ghost", id: "clear-q", hidden: true, onclick: clearQuery }, "Clear")),
        el("div", { class: "q-expansion muted", id: "q-expansion", hidden: true }),
        el("div", { class: "filters" },
          venueDropdown(),
          columnsDropdown(),
          sel("f-sort", "Sort", SORTS, S.sort),
          el("span", { class: "fsep" }),
          sel("f-top", "Results/col", [["10", "10"], ["25", "25"], ["50", "50"]], "25"),
          sel("f-journal", "Yr · journals", [["", "all"], ["5", "5y"], ["10", "10y"]], ""),
          sel("f-conf", "conf.", [["", "all"], ["5", "5y"], ["10", "10y"]], ""),
          sel("f-pre", "preprints", [["1", "1y"], ["2", "2y"], ["3", "3y"], ["5", "5y"], ["", "all"]], "2"),
          el("span", { class: "spacer" }),
          el("span", { id: "status", class: "muted" }),
          el("span", { id: "counts", class: "muted" })),
        addPanel(), notesPanel()),
      el("div", { id: "cols", class: "columns" },
        ...COLS.map(([k, label]) =>
          el("div", { class: "col col-" + k, id: "col-" + k },
            el("div", { class: "col-head" },
              el("span", { class: "dot" }),
              el("span", { class: "col-label" }, label),
              el("span", { class: "cnt", id: "cnt-" + k }),
              el("span", { class: "spacer" }),
              el("button", { class: "col-x ghost", title: "Hide this column", onclick: () => toggleCol(k, false) }, "✕")),
            el("div", { class: "col-list", id: "list-" + k }),
            el("div", { class: "col-foot" },
              el("button", { class: "ghost col-more", id: "more-" + k, hidden: true, onclick: () => renderColMore(k) }, "Show more")))),
        el("div", { id: "col-rails", class: "col-rails", hidden: true })),
      el("div", { id: "cols-empty", class: "col-note", hidden: true }, "All columns hidden — click a tab on the right to bring one back."),
      el("div", { id: "pinned-view" }))));

  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
  $("q").addEventListener("input", () => {
    $("clear-q").hidden = !$("q").value;
    if (!S.current) $("scratch-badge").hidden = !$("q").value;
    if (!$("q").value.trim() && S.mode === "query") render(); // emptied → fall back to browse
  });
  $("f-sort").addEventListener("change", () => { S.sort = $("f-sort").value; savePrefs(); render(); });
  for (const id of ["f-top", "f-journal", "f-conf", "f-pre"]) $(id).addEventListener("change", render);
  $("notes").addEventListener("input", debounce(async () => { if (S.current) await db.updateStream(S.current.id, { notes: $("notes").value }); }, 700));

  syncColumnsUI();

  const overlay = el("div", { class: "overlay" }, el("div", { class: "spinner" }), el("p", { id: "load-step" }, "Loading…"));
  root.append(overlay);
  const base = import.meta.env.BASE_URL || "./";
  const fetchJson = (name) => fetch(base + "data/" + name).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  try {
    const [, status, recent] = await Promise.all([
      engine.loadIndex((s) => { const p = $("load-step"); if (p) p.textContent = s; }),
      fetchJson("status.json"),
      fetchJson("recent.json"),
    ]);
    overlay.remove();
    buildCorpus(recent);
    S.status = status;
    renderStatus();
  } catch (e) { overlay.querySelector("p").textContent = "Failed to load corpus: " + e.message; return; }

  render(); // browse by default (no query yet)

  try { S.streams = await db.listStreams(); } catch (e) { toast("Streams unavailable: " + e.message); }
  renderSidebar();
  updatePinnedCount();
}

const sel = (id, label, opts, s) => el("label", {}, label + " ",
  el("select", { id }, ...opts.map(([v, t]) => el("option", v === s ? { value: v, selected: true } : { value: v }, t))));

// ---- corpus assembly: shipped corpus + recent.json overlay, split by type ----
function buildCorpus(recent) {
  const corpus = engine.allPapers();
  const seen = new Set(corpus.map((p) => p.id));
  const fresh = (recent?.papers || []).filter((p) => !seen.has(p.id)).map((p) => ({ ...p, fresh: true }));
  const all = fresh.concat(corpus);
  const byCol = { journal: [], conference: [], preprint: [] };
  const venueCount = new Map();
  for (const p of all) {
    (byCol[p.col] || byCol.journal).push(p);
    const v = p.venue || "Unknown";
    venueCount.set(v, (venueCount.get(v) || 0) + 1);
  }
  S.byCol = byCol;
  S.venues = [...venueCount.entries()].sort((a, b) => b[1] - a[1]);
  renderVenueRows();
}

// ---- top-level render: pick browse vs query mode from the query box ----
function render() {
  exitPinned();
  const q = $("q").value.trim();
  S.mode = q && engine.isLoaded() ? "query" : "browse";
  $("clear-q").hidden = !$("q").value;
  $("f-sort").disabled = S.mode === "query"; // ranking is by relevance while searching
  if (S.mode === "query") runSearch();
  else renderBrowse();
}
// Re-render whatever view is currently showing (after a pin/unpin etc.)
function rerenderCurrent() {
  if (S.view === "pinned") return renderPinned();
  if (S.mode === "snapshot" && S.current?.snapshot?.length) return renderSnapshot(S.current.snapshot);
  return render();
}

function clearQuery() {
  $("q").value = ""; $("clear-q").hidden = true;
  if (!S.current) $("scratch-badge").hidden = true;
  render();
}

// ---- browse mode: corpus by column, filtered + sorted + paged ----
function yearFloors() {
  const cy = engine.corpusStats()?.currentYear || new Date().getFullYear();
  const f = readFilters();
  return {
    journal: f.journalYears ? cy - f.journalYears + 1 : null,
    conference: f.confYears ? cy - f.confYears + 1 : null,
    preprint: f.preprintYears ? cy - f.preprintYears + 1 : null,
  };
}
function sortItems(items, sort) {
  const byYearDesc = (a, b) => (b.year || 0) - (a.year || 0) || (a.title || "").localeCompare(b.title || "");
  if (sort === "added_desc") items.sort((a, b) => (b.added || "").localeCompare(a.added || "") || byYearDesc(a, b));
  else if (sort === "year_desc") items.sort(byYearDesc);
  else if (sort === "year_asc") items.sort((a, b) => (a.year || 9999) - (b.year || 9999) || (a.title || "").localeCompare(b.title || ""));
  else if (sort === "cited_desc") items.sort((a, b) => (b.cited || 0) - (a.cited || 0) || byYearDesc(a, b));
  return items;
}
function renderBrowse() {
  const exp = $("q-expansion"); if (exp) exp.hidden = true;
  if (!S.byCol.journal.length && !S.byCol.conference.length && !S.byCol.preprint.length) return;
  const off = S.venueOff, floors = yearFloors();
  const parts = [];
  for (const [k] of COLS) {
    if (!S.colsOn.has(k)) continue;
    const floor = floors[k];
    const items = sortItems(S.byCol[k].filter((p) =>
      !(off.size && off.has(p.venue || "Unknown")) && !(floor && (!p.year || p.year < floor))
    ), S.sort);
    S.browse[k] = { items, shown: 0 };
    $("cnt-" + k).textContent = items.length.toLocaleString();
    $("list-" + k).replaceChildren();
    renderColMore(k);
    parts.push(items.length);
  }
  $("counts").textContent = parts.length ? parts.join(" / ") : "";
  updateActionButtons();
}
function renderColMore(k) {
  if (S.mode !== "browse") return;
  const st = S.browse[k], list = $("list-" + k);
  if (st.shown === 0 && !st.items.length) list.append(el("div", { class: "col-empty" }, "no papers"));
  const end = Math.min(st.shown + PAGE_COL, st.items.length);
  for (let i = st.shown; i < end; i++) list.append(card(st.items[i], k));
  st.shown = end;
  const more = $("more-" + k), remaining = st.items.length - st.shown;
  more.hidden = remaining <= 0;
  if (remaining > 0) more.textContent = `Show more (${remaining.toLocaleString()})`;
}

// ---- venue multi-select (every venue checked by default; uncheck to exclude) ----
function venueDropdown() {
  const panel = el("div", { class: "dd-panel", id: "venue-panel", hidden: true },
    el("div", { class: "dd-actions" },
      el("button", { class: "ghost", onclick: () => setAllVenues(true) }, "Select all"),
      el("button", { class: "ghost", onclick: () => setAllVenues(false) }, "None")),
    el("div", { class: "dd-rows", id: "venue-rows" }));
  const btn = el("button", { class: "dd-btn", id: "venue-btn", onclick: (e) => { e.stopPropagation(); closeDropdowns(panel); panel.hidden = !panel.hidden; } }, "Venues: all ▾");
  panel.addEventListener("click", (e) => e.stopPropagation());
  return el("div", { class: "dd" }, btn, panel);
}
function setAllVenues(on) {
  S.venueOff = on ? new Set() : new Set(S.venues.map(([v]) => v));
  renderVenueRows();
  render();
}
function renderVenueRows() {
  const rows = $("venue-rows");
  if (!rows) return;
  rows.replaceChildren(...S.venues.map(([v, n]) => {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !S.venueOff.has(v);
    cb.addEventListener("change", () => { cb.checked ? S.venueOff.delete(v) : S.venueOff.add(v); updateVenueBtn(); render(); });
    return el("label", { class: "dd-row" }, cb, el("span", { class: "dd-name" }, v), el("span", { class: "dd-n" }, n.toLocaleString()));
  }));
  updateVenueBtn();
}
function updateVenueBtn() {
  const btn = $("venue-btn");
  if (!btn) return;
  const off = S.venueOff.size, total = S.venues.length;
  btn.textContent = off === 0 ? "Venues: all ▾" : off >= total ? "Venues: none ▾" : `Venues: ${total - off} of ${total} ▾`;
  btn.classList.toggle("filtering", off > 0);
}

// ---- column add / remove / revive ----
function columnsDropdown() {
  const panel = el("div", { class: "dd-panel narrow", id: "cols-panel", hidden: true },
    el("div", { class: "dd-rows", id: "cols-rows" },
      ...COLS.map(([k, label]) => {
        const cb = el("input", { type: "checkbox", id: "colcb-" + k });
        cb.addEventListener("change", () => toggleCol(k, cb.checked));
        return el("label", { class: "dd-row" }, cb, el("span", { class: "dd-name" }, label));
      })));
  const btn = el("button", { class: "dd-btn", id: "cols-btn", onclick: (e) => { e.stopPropagation(); closeDropdowns(panel); panel.hidden = !panel.hidden; } }, "Columns ▾");
  panel.addEventListener("click", (e) => e.stopPropagation());
  return el("div", { class: "dd" }, btn, panel);
}
function toggleCol(k, on) {
  if (on) S.colsOn.add(k); else S.colsOn.delete(k);
  savePrefs();
  syncColumnsUI();
  render();
}
function syncColumnsUI() {
  const on = COLS.filter(([k]) => S.colsOn.has(k));
  for (const [k] of COLS) {
    $("col-" + k).hidden = !S.colsOn.has(k);
    const cb = $("colcb-" + k); if (cb) cb.checked = S.colsOn.has(k);
  }
  // right-edge tabs to revive each hidden column in one click
  const rails = $("col-rails");
  const hidden = COLS.filter(([k]) => !S.colsOn.has(k));
  rails.replaceChildren(...hidden.map(([k, label]) =>
    el("button", { class: "col-rail col-" + k, title: `Show the ${label} column`, onclick: () => toggleCol(k, true) },
      el("span", { class: "dot" }),
      el("span", { class: "col-rail-label" }, label),
      el("span", { class: "col-rail-plus", "aria-hidden": "true" }, "+"))));
  rails.hidden = hidden.length === 0;
  $("cols-empty").hidden = on.length > 0;
  const btn = $("cols-btn");
  if (btn) { btn.textContent = on.length === COLS.length ? "Columns ▾" : `Columns: ${on.length} ▾`; btn.classList.toggle("filtering", on.length < COLS.length); }
}
function closeDropdowns(except) {
  for (const p of document.querySelectorAll(".dd-panel")) if (p !== except) p.hidden = true;
}
document.addEventListener("click", () => closeDropdowns());

// ---- status line (from data/status.json) ----
function renderStatus() {
  const box = $("status");
  if (!box) return;
  const st = S.status;
  if (!st) { box.textContent = "updated daily from OpenAlex + AIS eLibrary"; return; }
  const run = st.last_run || {};
  const bits = [el("span", { class: "live" }, "● updated daily")];
  if (run.date) bits.push(document.createTextNode(` · ${run.date}: ${(run.new_papers ?? 0).toLocaleString()} new`));
  if (st.totals?.searchable) bits.push(document.createTextNode(` · ${st.totals.searchable.toLocaleString()} searchable`));
  box.replaceChildren(...bits);
}

function addPanel() {
  return el("div", { class: "panel", id: "add-panel" },
    el("div", { class: "add-grid" },
      el("select", { id: "add-method", onchange: () => { const p = $("add-method").value === "paste"; $("add-textarea").hidden = !p; $("add-input").hidden = p; } },
        el("option", { value: "doi" }, "DOI"), el("option", { value: "arxiv" }, "arXiv id / URL"), el("option", { value: "paste" }, "Paste BibTeX / RIS / CSL-JSON")),
      el("input", { id: "add-input", placeholder: "10.25300/MISQ/…  or  https://doi.org/…" }),
      el("textarea", { id: "add-textarea", hidden: true, placeholder: "Paste one or more BibTeX / RIS / CSL-JSON entries…" }),
      el("select", { id: "add-col" }, el("option", { value: "" }, "auto column"), el("option", { value: "journal" }, "journal"), el("option", { value: "conference" }, "conference"), el("option", { value: "preprint" }, "preprint")),
      el("button", { class: "primary", id: "add-go", onclick: addExternal }, "Add")),
    el("div", { class: "hint" }, "Metadata & abstracts are fetched from OpenAlex / Crossref or parsed from your paste — never generated. Added papers attach to this stream and rank in their column."));
}
function notesPanel() {
  return el("div", { class: "panel", id: "notes-panel" }, el("textarea", { id: "notes", placeholder: "Notes for this query stream… (autosaves)" }));
}

// ---- streams sidebar ----
function renderSidebar() {
  const ul = $("stream-list"); ul.replaceChildren();
  if (!S.streams.length) { ul.append(el("li", { class: "empty-side" }, "No streams yet. Search, then pin a paper or save to create one.")); return; }
  for (const s of S.streams) {
    ul.append(el("li", { class: "stream" + (S.current?.id === s.id ? " active" : ""), onclick: () => selectStream(s.id) },
      el("div", { class: "row1" }, el("div", { class: "nm" }, s.name), el("div", { class: "sub" }, s.query ? "“" + s.query.slice(0, 40) + "”" : "empty")),
      el("button", { class: "x ghost", title: "Delete", onclick: (e) => { e.stopPropagation(); deleteStream(s); } }, "✕")));
  }
}
async function newStream() {
  const name = prompt("Name this query stream:", "Untitled stream"); if (name === null) return;
  try {
    const s = await db.createStream(name.trim() || "Untitled stream", "", readFilters());
    S.streams.unshift(s); selectStream(s.id);
  } catch (e) { toast("Could not create stream: " + e.message); }
}
async function selectStream(id) {
  const s = S.streams.find((x) => x.id === id); if (!s) return;
  exitPinned();
  S.current = s;
  [S.externals, S.pins] = await Promise.all([db.listExternals(id), db.listPins(id)]);
  $("stream-name").value = s.name; $("stream-name").disabled = false;
  $("scratch-badge").hidden = true; $("notes").value = s.notes || "";
  $("export-bib").hidden = false; applyFilters(s.filters); $("q").value = s.query || "";
  $("clear-q").hidden = !$("q").value;
  renderSidebar();
  if (s.snapshot?.length) renderSnapshot(s.snapshot); // show the frozen results
  else render();                                      // no snapshot → live
}
async function deleteStream(s) {
  if (!confirm(`Delete stream “${s.name}”? Its pins, notes and added papers are removed.`)) return;
  await db.deleteStream(s.id);
  S.streams = S.streams.filter((x) => x.id !== s.id);
  if (S.current?.id === s.id) { S.current = null; S.externals = []; S.pins = []; resetScratch(); render(); }
  renderSidebar();
}
async function renameCurrent() {
  if (!S.current) return;
  S.current = await db.updateStream(S.current.id, { name: $("stream-name").value.trim() || "Untitled" });
  S.streams = S.streams.map((x) => (x.id === S.current.id ? S.current : x)); renderSidebar();
}
function resetScratch() {
  $("stream-name").value = ""; $("stream-name").disabled = true; $("export-bib").hidden = true;
  $("notes").value = ""; $("scratch-badge").hidden = !$("q").value;
}
async function ensureStream() {
  if (S.current) return S.current;
  const q = $("q").value.trim();
  const s = await db.createStream(q ? q.slice(0, 48) : "Untitled stream", q, readFilters());
  S.streams.unshift(s); S.current = s; S.externals = []; S.pins = [];
  $("stream-name").value = s.name; $("stream-name").disabled = false; $("scratch-badge").hidden = true; $("export-bib").hidden = false;
  renderSidebar(); return s;
}

const saveMeta = debounce(async () => { if (S.current) await db.updateStream(S.current.id, { query: $("q").value, filters: readFilters() }); }, 600);

// ---- query mode: three-column semantic search ----
async function runSearch() {
  const q = $("q").value.trim();
  if (!q) return render(); // empty → browse
  if (!engine.isLoaded()) return toast("Corpus still loading…");
  S.mode = "query";
  $("f-sort").disabled = true;
  for (const [k] of COLS) { if (S.colsOn.has(k)) { $("more-" + k).hidden = true; $("list-" + k).replaceChildren(el("div", { class: "loading" }, k === "journal" ? "searching…" : "")); } }
  $("scratch-badge").hidden = !!S.current;
  try {
    const res = await engine.search(q, { ...readFilters(), venueOff: S.venueOff, cols: S.colsOn });
    S.qvec = res.qvec;
    const exp = $("q-expansion");
    if (res.expansion?.length) { exp.textContent = "＋ also matching: " + res.expansion.join(" · "); exp.hidden = false; }
    else exp.hidden = true;
    const cols = { journal: [...res.journal], conference: [...res.conference], preprint: [...res.preprint] };
    if (S.current) mergeStream(cols);
    S.lastResults = cols; // remember for "Save query" snapshot
    const parts = [];
    for (const [k] of COLS) {
      if (!S.colsOn.has(k)) continue;
      $("cnt-" + k).textContent = cols[k].length;
      const list = $("list-" + k); list.replaceChildren();
      if (!cols[k].length) { list.append(el("div", { class: "col-empty" }, "no matches")); }
      else for (const r of cols[k]) list.append(card(r, k));
      parts.push(cols[k].length);
    }
    $("counts").textContent = parts.join(" / ");
    updateActionButtons();
    if (S.current) saveMeta();
  } catch (e) { toast("Search failed: " + e.message); console.error(e); }
}

function mergeStream(cols) {
  for (const ext of S.externals) {
    if (S.venueOff.size && S.venueOff.has(ext.venue || "Unknown")) continue;
    const col = cols[ext.col] || cols.journal;
    const score = ext.emb ? engine.cosineQB64(S.qvec, ext.emb) : null;
    col.unshift({ ...ext, score, external: true, pinned: ext.emb == null });
  }
  const pinnedIds = new Set(S.pins.map((p) => p.paper_id));
  const present = new Set();
  for (const k of Object.keys(cols)) for (const r of cols[k]) if (!r.external) { present.add(r.id); if (pinnedIds.has(r.id)) r.pinned = true; }
  for (const pin of S.pins) {
    if (present.has(pin.paper_id)) continue;
    const p = engine.paperById(pin.paper_id);
    if (p) { const col = cols[p.col] || cols.journal; col.unshift({ ...p, score: engine.scorePaper(S.qvec, p), pinned: true }); }
  }
  for (const k of Object.keys(cols)) cols[k].sort((a, b) => (a.pinned ? 0 : 1) - (b.pinned ? 0 : 1) || (b.score || 0) - (a.score || 0));
}

// ---- save query (frozen result snapshot) + re-run ----
const SNAP_FIELDS = ["id", "col", "score", "title", "authors", "year", "venue", "doi", "url", "abstract", "fresh", "external", "cited"];
function buildSnapshot() {
  const snap = [];
  for (const [k] of COLS) for (const r of (S.lastResults?.[k] || [])) {
    const e = {}; for (const f of SNAP_FIELDS) if (r[f] !== undefined) e[f] = r[f];
    e.col = e.col || k;
    snap.push(e);
  }
  return snap;
}
async function saveQuery() {
  const q = $("q").value.trim();
  if (!q) return toast("Run a search first — Save captures its results");
  if (!S.lastResults) return toast("Run the search, then Save");
  const snapshot = buildSnapshot();
  try {
    if (S.current) {
      S.current = await db.updateStream(S.current.id, { query: q, filters: readFilters(), snapshot });
      S.streams = S.streams.map((x) => (x.id === S.current.id ? S.current : x));
      toast(`Snapshot updated — ${snapshot.length} papers`);
    } else {
      const created = await db.createStream(q.slice(0, 60), q, readFilters());
      S.current = await db.updateStream(created.id, { snapshot });
      S.streams.unshift(S.current); S.externals = []; S.pins = [];
      $("stream-name").value = S.current.name; $("stream-name").disabled = false;
      $("scratch-badge").hidden = true; $("export-bib").hidden = false;
      toast(`Query saved — ${snapshot.length} papers`);
    }
    renderSidebar();
    updateActionButtons();
  } catch (e) { toast("Save failed: " + e.message); }
}

// Render a saved query's frozen snapshot into the columns (no live search).
function renderSnapshot(snap) {
  exitPinned();
  S.mode = "snapshot";
  $("q-expansion").hidden = true;
  $("f-sort").disabled = true;
  const pinnedIds = new Set(S.pins.map((p) => p.paper_id));
  const byCol = { journal: [], conference: [], preprint: [] };
  for (const r of snap) (byCol[r.col] || byCol.journal).push(r);
  const parts = [];
  for (const [k] of COLS) {
    if (!S.colsOn.has(k)) continue;
    $("more-" + k).hidden = true;
    const items = byCol[k] || [];
    $("cnt-" + k).textContent = items.length;
    const list = $("list-" + k); list.replaceChildren();
    if (!items.length) list.append(el("div", { class: "col-empty" }, "—"));
    else for (const r of items) list.append(card({ ...r, pinned: pinnedIds.has(r.id) }, k));
    parts.push(items.length);
  }
  $("counts").textContent = parts.join(" / ");
  updateActionButtons();
}

// Show Save in live-query mode, Re-run when viewing a snapshot, neither in browse.
function updateActionButtons() {
  const save = $("save-q"), rerun = $("rerun-q");
  if (!save || !rerun) return;
  if (S.view === "pinned") { save.hidden = true; rerun.hidden = true; return; }
  if (S.mode === "query") {
    save.hidden = false;
    save.textContent = (S.current && S.current.snapshot?.length) ? "⤓ Update snapshot" : "☆ Save query";
    rerun.hidden = true;
  } else if (S.mode === "snapshot") {
    save.hidden = true; rerun.hidden = false;
  } else { save.hidden = true; rerun.hidden = true; }
}

// ---- cross-query pinned-papers library (paper-level, not query-level) ----
async function updatePinnedCount() {
  const btn = $("pinned-btn"); if (!btn) return;
  let n = 0; try { n = await db.pinnedCount(); } catch {}
  btn.textContent = n ? `★ Pinned papers (${n})` : "★ Pinned papers";
}
async function showPinned() {
  S.view = "pinned";
  document.querySelector(".workspace").classList.add("pinned-mode");
  $("pinned-btn").classList.add("active");
  for (const li of document.querySelectorAll("#stream-list .stream")) li.classList.remove("active");
  await renderPinned();
  updateActionButtons();
}
function exitPinned() {
  if (S.view !== "pinned") return;
  S.view = "workbench";
  document.querySelector(".workspace").classList.remove("pinned-mode");
  $("pinned-btn").classList.remove("active");
}
function closePinned() {
  exitPinned();
  if (S.current?.snapshot?.length) renderSnapshot(S.current.snapshot);
  else render();
}
async function renderPinned() {
  const wrap = $("pinned-view");
  let pins = [];
  try { pins = await db.allPinnedPapers(); } catch {}
  const list = el("div", { class: "pinned-list" });
  if (!pins.length) {
    list.append(el("div", { class: "col-note" }, "No pinned papers yet. Open a query and pin (☆) the papers worth keeping — they collect here, tagged with the query they came from."));
  } else {
    for (const pin of pins) {
      const p = engine.paperById(pin.paper_id);
      if (p) list.append(pinnedCard(p, pin));
    }
  }
  wrap.replaceChildren(
    el("div", { class: "pinned-head" },
      el("button", { class: "ghost", onclick: closePinned }, "← Back"),
      el("h2", {}, "★ Pinned papers"),
      el("span", { class: "muted" }, `${pins.length} paper${pins.length === 1 ? "" : "s"} across your saved queries`)),
    list);
}
function pinnedCard(p, pin) {
  const authors = (p.authors || []).slice(0, 5).join(", ") + ((p.authors || []).length > 5 ? " et al." : "");
  const meta = el("div", { class: "meta" });
  if (!p.abstract) meta.append(el("span", { class: "badge noabs" }, "no abstract"));
  meta.append(document.createTextNode([authors, p.year, p.venue].filter(Boolean).join(" · ")));
  if (p.cited > 0) meta.append(el("span", { class: "muted" }, ` · ${p.cited.toLocaleString()} cite${p.cited === 1 ? "" : "s"}`));
  const link = p.url || (p.doi ? "https://doi.org/" + p.doi.replace(/^https?:\/\/doi\.org\//, "") : null);
  const ttl = link ? el("a", { href: link, target: "_blank", rel: "noopener" }, p.title || "(untitled)") : document.createTextNode(p.title || "(untitled)");
  const abs = el("div", { class: "abs" }, p.abstract || "— no abstract on record —");
  const c = el("div", { class: "card pinned" }, el("div", { class: "ttl" }, ttl), meta, abs);
  requestAnimationFrame(() => {
    if (abs.scrollHeight > abs.clientHeight + 4) {
      abs.classList.add("clip");
      const more = el("span", { class: "more", onclick: () => { abs.classList.toggle("expanded"); abs.classList.toggle("clip"); more.textContent = abs.classList.contains("expanded") ? "show less" : "show more"; } }, "show more");
      abs.after(more);
    }
  });
  const tags = el("div", { class: "pin-sources" }, el("span", { class: "muted" }, "pinned in: "));
  for (const s of pin.sources) tags.append(el("button", { class: "pin-tag", title: "Open this query", onclick: () => selectStream(s.id) }, s.name));
  const acts = el("div", { class: "acts" },
    el("button", { class: "ghost", onclick: () => cite(p) }, "❝ cite"),
    el("span", { class: "spacer" }),
    el("button", { class: "ghost", onclick: () => removeFromLibrary(pin) }, "remove from library"));
  c.append(tags, acts);
  return c;
}
async function removeFromLibrary(pin) {
  try {
    for (const s of pin.sources) await db.removePin(s.id, pin.paper_id);
    if (S.current) S.pins = await db.listPins(S.current.id);
    toast("Removed from library");
    updatePinnedCount();
    renderPinned();
  } catch (e) { toast("Remove failed: " + e.message); }
}

// ---- card (shared by browse + query) ----
function card(r, col) {
  const authors = (r.authors || []).slice(0, 5).join(", ") + ((r.authors || []).length > 5 ? " et al." : "");
  const meta = el("div", { class: "meta" });
  if (r.score != null) meta.append(el("span", { class: "score" }, r.score.toFixed(3)));
  if (r.fresh) meta.append(el("span", { class: "badge new", title: "Crawled after the last search-index build — browsable now, searchable after the next refresh" }, "new"));
  if (r.pinned && !r.external) meta.append(el("span", { class: "badge pin" }, "pinned"));
  if (r.external) meta.append(el("span", { class: "badge ext" }, "added"));
  if (!r.abstract) meta.append(el("span", { class: "badge noabs" }, "no abstract"));
  meta.append(document.createTextNode([authors, r.year, r.venue].filter(Boolean).join(" · ")));
  if (r.cited > 0) meta.append(el("span", { class: "muted" }, ` · ${r.cited.toLocaleString()} cite${r.cited === 1 ? "" : "s"}`));
  if (r.added && S.mode === "browse") meta.append(el("span", { class: "muted" }, ` · added ${r.added}`));

  const link = r.url || (r.doi ? "https://doi.org/" + r.doi.replace(/^https?:\/\/doi\.org\//, "") : null);
  const ttl = link ? el("a", { href: link, target: "_blank", rel: "noopener" }, r.title || "(untitled)") : document.createTextNode(r.title || "(untitled)");
  const abs = el("div", { class: "abs" }, r.abstract || "— no abstract on record —");
  const cls = "card" + (r.external ? " external" : "") + (r.pinned ? " pinned" : "") + (r.fresh ? " fresh" : "");
  const c = el("div", { class: cls }, el("div", { class: "ttl" }, ttl), meta, abs);
  requestAnimationFrame(() => {
    if (abs.scrollHeight > abs.clientHeight + 4) {
      abs.classList.add("clip");
      const more = el("span", { class: "more", onclick: () => { abs.classList.toggle("expanded"); abs.classList.toggle("clip"); more.textContent = abs.classList.contains("expanded") ? "show less" : "show more"; } }, "show more");
      abs.after(more);
    }
  });
  const acts = el("div", { class: "acts" });
  if (!r.external && !r.fresh) acts.append(el("button", { class: "ghost", onclick: () => togglePin(r, col) }, r.pinned ? "★ unpin" : "☆ pin"));
  acts.append(el("button", { class: "ghost", onclick: () => cite(r) }, "❝ cite"));
  acts.append(el("span", { class: "spacer" }));
  if (r.external) acts.append(el("button", { class: "ghost", onclick: () => removeExternal(r) }, "remove"));
  c.append(acts);
  return c;
}

async function togglePin(r, col) {
  try {
    const s = await ensureStream();
    if (r.pinned) { await db.removePin(s.id, r.id); S.pins = S.pins.filter((p) => p.paper_id !== r.id); toast("Unpinned from this query"); }
    else { await db.addPin(s.id, r.id, r.col || col); S.pins.push({ paper_id: r.id, col: r.col || col }); toast("Pinned — added to your library"); }
    updatePinnedCount();
    rerenderCurrent();
  } catch (e) { toast("Pin failed: " + e.message); console.error(e); }
}
async function removeExternal(r) {
  try { await db.deleteExternal(r.id); S.externals = S.externals.filter((x) => x.id !== r.id); toast("Removed"); render(); }
  catch (e) { toast("Remove failed: " + e.message); }
}
async function addExternal() {
  const method = $("add-method").value;
  const payload = (method === "paste" ? $("add-textarea").value : $("add-input").value).trim();
  if (!payload) return toast("Enter an identifier or paste a reference");
  const s = await ensureStream();
  const forceCol = $("add-col").value;
  $("add-go").disabled = true; $("add-go").textContent = "Fetching…";
  try {
    let recs;
    if (method === "doi") recs = [await ingest.fromDoi(payload)];
    else if (method === "arxiv") recs = [await ingest.fromArxiv(payload)];
    else recs = ingest.fromReferenceText(payload);
    let added = 0;
    for (const rec of recs) {
      if (forceCol) rec.col = forceCol;
      if (rec.doi && S.externals.some((e) => e.doi === rec.doi)) continue;
      let emb = null;
      const text = [rec.title, rec.abstract].filter(Boolean).join("\n\n");
      if (text) { try { emb = await engine.embedDocB64(text); } catch {} }
      const row = await db.addExternal(s.id, {
        col: rec.col || "journal", title: rec.title, authors: rec.authors || [], year: rec.year,
        venue: rec.venue, doi: rec.doi, url: rec.url, abstract: rec.abstract, keywords: rec.keywords || [],
        emb, provenance: rec.provenance || {},
      });
      S.externals.unshift(row); added++;
    }
    toast(added ? `Added ${added} paper${added > 1 ? "s" : ""}` : "Nothing added (duplicate?)");
    $("add-input").value = ""; $("add-textarea").value = "";
    if ($("q").value.trim()) runSearch();
  } catch (e) { toast("Add failed: " + e.message); }
  finally { $("add-go").disabled = false; $("add-go").textContent = "Add"; }
}

const cite = (r) => copyCite(r, toast);
function exportBib(e) {
  e.preventDefault();
  if (!S.current) return;
  const entries = [];
  for (const ext of S.externals) entries.push(bibtex(ext));
  for (const pin of S.pins) { const p = engine.paperById(pin.paper_id); if (p) entries.push(bibtex(p)); }
  const blob = new Blob([entries.join("\n\n") || "% no pinned or added papers\n"], { type: "text/plain" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `${(S.current.name || "stream").replace(/\W+/g, "-")}.bib` });
  document.body.append(a); a.click(); a.remove();
}
