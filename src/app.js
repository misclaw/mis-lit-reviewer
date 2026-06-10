// Main app: sidebar of query streams + three-column semantic search, with
// streams / pins / added papers / notes persisted locally (localStorage).
import * as engine from "./search.js";
import * as db from "./store.js";
import * as ingest from "./ingest.js";

const COLS = [["journal", "Journals"], ["conference", "Conferences"], ["preprint", "Preprints"]];
const DEFAULT_FILTERS = { top: 25, journalYears: null, confYears: null, preprintYears: 2 };

const S = { streams: [], current: null, externals: [], pins: [], qvec: null };

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
};
let toastTimer;
function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) { t = el("div", { id: "toast" }); document.body.append(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
const $ = (id) => document.getElementById(id);

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
  root.replaceChildren(el("div", { class: "shell" },
    el("aside", { id: "sidebar" },
      el("div", { class: "side-actions" }, el("button", { class: "primary", id: "new-stream", onclick: newStream }, "+ New query stream")),
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
          el("input", { id: "q", placeholder: "Describe what you're looking for, in plain language…  (Enter to search)" }),
          el("button", { class: "primary", id: "go", onclick: runSearch }, "Search")),
        el("div", { class: "filters" },
          sel("f-top", "Results/col", [["10", "10"], ["25", "25"], ["50", "50"]], "25"),
          sel("f-journal", "Journals", [["", "all years"], ["5", "last 5y"], ["10", "last 10y"]], ""),
          sel("f-conf", "Conferences", [["", "all years"], ["5", "last 5y"], ["10", "last 10y"]], ""),
          sel("f-pre", "Preprints", [["1", "last 1y"], ["2", "last 2y"], ["3", "last 3y"], ["5", "last 5y"], ["", "all years"]], "2"),
          el("span", { class: "spacer" }), el("span", { id: "counts", class: "muted" })),
        addPanel(), notesPanel()),
      el("div", { id: "cols", class: "columns" }, ...COLS.map(([k, label]) =>
        el("div", { class: "col col-" + k },
          el("div", { class: "col-head" }, el("span", { class: "dot" }), label, el("span", { class: "cnt", id: "cnt-" + k })),
          el("div", { class: "col-list", id: "list-" + k })))))));

  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
  $("q").addEventListener("input", () => { if (!S.current) $("scratch-badge").hidden = !$("q").value; });
  for (const id of ["f-top", "f-journal", "f-conf", "f-pre"]) $(id).addEventListener("change", () => { if ($("q").value.trim()) runSearch(); });
  $("notes").addEventListener("input", debounce(async () => { if (S.current) await db.updateStream(S.current.id, { notes: $("notes").value }); }, 700));

  const overlay = el("div", { class: "overlay" }, el("div", { class: "spinner" }), el("p", { id: "load-step" }, "Loading…"));
  root.append(overlay);
  try {
    await engine.loadIndex((s) => { const p = $("load-step"); if (p) p.textContent = s; });
    overlay.remove();
    const st = engine.corpusStats();
    placeholderNote(`Ready — ${st.total.toLocaleString()} papers (${st.journal.toLocaleString()} journal · ${st.conference.toLocaleString()} conference · ${st.preprint} preprint). First query also downloads the ~30 MB model (cached after).`);
  } catch (e) { overlay.querySelector("p").textContent = "Failed to load index: " + e.message; return; }

  try { S.streams = await db.listStreams(); } catch (e) { toast("Streams unavailable: " + e.message); }
  renderSidebar();
}

const sel = (id, label, opts, s) => el("label", {}, label + " ",
  el("select", { id }, ...opts.map(([v, t]) => el("option", v === s ? { value: v, selected: true } : { value: v }, t))));

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
  S.current = s;
  [S.externals, S.pins] = await Promise.all([db.listExternals(id), db.listPins(id)]);
  $("stream-name").value = s.name; $("stream-name").disabled = false;
  $("scratch-badge").hidden = true; $("notes").value = s.notes || "";
  $("export-bib").hidden = false; applyFilters(s.filters); $("q").value = s.query || "";
  renderSidebar();
  if (s.query) runSearch(); else clearColumns();
}
async function deleteStream(s) {
  if (!confirm(`Delete stream “${s.name}”? Its pins, notes and added papers are removed.`)) return;
  await db.deleteStream(s.id);
  S.streams = S.streams.filter((x) => x.id !== s.id);
  if (S.current?.id === s.id) { S.current = null; S.externals = []; S.pins = []; resetScratch(); }
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

// ---- search ----
function clearColumns() { for (const [k] of COLS) $("list-" + k).replaceChildren(); $("counts").textContent = ""; }
function placeholderNote(msg) { $("list-journal").replaceChildren(el("div", { class: "col-note" }, msg)); }

async function runSearch() {
  const q = $("q").value.trim();
  if (!q) return toast("Type something to search");
  if (!engine.isLoaded()) return toast("Index still loading…");
  for (const [k] of COLS) $("list-" + k).replaceChildren(el("div", { class: "loading" }, k === "journal" ? "searching…" : ""));
  $("scratch-badge").hidden = !!S.current;
  try {
    const res = await engine.search(q, readFilters());
    S.qvec = res.qvec;
    const cols = { journal: [...res.journal], conference: [...res.conference], preprint: [...res.preprint] };
    if (S.current) mergeStream(cols);
    for (const [k] of COLS) {
      $("cnt-" + k).textContent = cols[k].length;
      const list = $("list-" + k); list.replaceChildren();
      if (!cols[k].length) { list.append(el("div", { class: "col-empty" }, "no matches")); continue; }
      for (const r of cols[k]) list.append(card(r, k));
    }
    $("counts").textContent = `${cols.journal.length} / ${cols.conference.length} / ${cols.preprint.length}`;
    if (S.current) saveMeta();
  } catch (e) { toast("Search failed: " + e.message); console.error(e); }
}

function mergeStream(cols) {
  for (const ext of S.externals) {
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

// ---- card ----
function card(r, col) {
  const authors = (r.authors || []).slice(0, 4).join(", ") + ((r.authors || []).length > 4 ? " et al." : "");
  const meta = el("div", { class: "meta" });
  if (r.score != null) meta.append(el("span", { class: "score" }, r.score.toFixed(3)));
  if (r.pinned && !r.external) meta.append(el("span", { class: "badge pin" }, "pinned"));
  if (r.external) meta.append(el("span", { class: "badge ext" }, "added"));
  if (!r.abstract) meta.append(el("span", { class: "badge noabs" }, "no abstract"));
  meta.append(document.createTextNode([authors, r.year, r.venue].filter(Boolean).join(" · ")));

  const link = r.url || (r.doi ? "https://doi.org/" + r.doi.replace(/^https?:\/\/doi\.org\//, "") : null);
  const ttl = link ? el("a", { href: link, target: "_blank", rel: "noopener" }, r.title || "(untitled)") : document.createTextNode(r.title || "(untitled)");
  const abs = el("div", { class: "abs" }, r.abstract || "— no abstract on record —");
  const cls = "card" + (r.external ? " external" : "") + (r.pinned ? " pinned" : "");
  const c = el("div", { class: cls }, el("div", { class: "ttl" }, ttl), meta, abs);
  requestAnimationFrame(() => {
    if (abs.scrollHeight > abs.clientHeight + 4) {
      abs.classList.add("clip");
      const more = el("span", { class: "more", onclick: () => { abs.classList.toggle("expanded"); abs.classList.toggle("clip"); more.textContent = abs.classList.contains("expanded") ? "show less" : "show more"; } }, "show more");
      abs.after(more);
    }
  });
  const acts = el("div", { class: "acts" });
  if (!r.external) acts.append(el("button", { class: "ghost", onclick: () => togglePin(r, col) }, r.pinned ? "★ unpin" : "☆ pin"));
  acts.append(el("button", { class: "ghost", onclick: () => cite(r) }, "❝ cite"));
  acts.append(el("span", { class: "spacer" }));
  if (r.external) acts.append(el("button", { class: "ghost", onclick: () => removeExternal(r) }, "remove"));
  c.append(acts);
  return c;
}

async function togglePin(r, col) {
  try {
    const s = await ensureStream();
    if (r.pinned) { await db.removePin(s.id, r.id); S.pins = S.pins.filter((p) => p.paper_id !== r.id); toast("Unpinned"); }
    else { await db.addPin(s.id, r.id, r.col || col); S.pins.push({ paper_id: r.id, col: r.col || col }); toast("Pinned to stream"); }
    runSearch();
  } catch (e) { toast("Pin failed: " + e.message); console.error(e); }
}
async function removeExternal(r) {
  try { await db.deleteExternal(r.id); S.externals = S.externals.filter((x) => x.id !== r.id); toast("Removed"); runSearch(); }
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

function bibtex(r) {
  const type = { journal: "article", conference: "inproceedings", preprint: "misc" }[r.col] || "misc";
  const vf = type === "article" ? "journal" : type === "inproceedings" ? "booktitle" : "howpublished";
  const last = ((r.authors || ["anon"])[0]?.split(" ").pop() || "anon").replace(/[^A-Za-z]/g, "");
  const key = (last + (r.year || "") + ((r.title || "x").split(" ")[0] || "")).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const doi = r.doi ? r.doi.replace(/^https?:\/\/doi\.org\//, "") : null;
  const L = [`@${type}{${key},`, `  title = {${r.title || ""}},`];
  if (r.authors?.length) L.push(`  author = {${r.authors.join(" and ")}},`);
  if (r.year) L.push(`  year = {${r.year}},`);
  if (r.venue) L.push(`  ${vf} = {${r.venue}},`);
  if (doi) L.push(`  doi = {${doi}},`);
  if (r.url) L.push(`  url = {${r.url}},`);
  L.push("}");
  return L.join("\n");
}
function cite(r) {
  const b = bibtex(r);
  navigator.clipboard.writeText(b).then(() => toast("BibTeX copied"), () => prompt("Copy BibTeX:", b));
}
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
