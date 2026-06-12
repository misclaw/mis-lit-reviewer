// Browse view: the corpus as a filterable, date-sorted reading list.
//
// Data = the shipped search corpus (slim records, each carrying `added` =
// date it entered the corpus and `cited` = citation count) overlaid with
// data/recent.json — papers the daily crawl found AFTER the last search-index
// build. Those render with a "new" badge: browsable today, searchable after
// the next index refresh. data/status.json drives the "updated daily" strip.
import * as engine from "./search.js";
import { el, toast, debounce } from "./dom.js";
import { cite } from "./cite.js";

const PAGE = 80;
const SORTS = [
  ["added_desc", "Recently added"],
  ["year_desc", "Newest published"],
  ["year_asc", "Oldest published"],
  ["cited_desc", "Most cited"],
];

// venueOff = opt-out set: every venue starts selected; unchecking adds it here.
const B = { papers: [], groups: [], cursor: { g: 0, i: 0 }, shown: 0, total: 0, ready: false, venueOff: new Set(), venues: [] };
const $ = (id) => document.getElementById(id);

export async function mountBrowse(root) {
  root.replaceChildren(el("div", { class: "browse" },
    el("div", { class: "b-top" },
      el("div", { class: "b-status", id: "b-status" }, "Loading corpus status…"),
      subscribeBox()),
    el("div", { class: "b-controls" },
      el("input", { id: "b-q", placeholder: "Filter by title, author, venue…" }),
      venueDropdown(),
      sel("b-col", [["", "All types"], ["journal", "Journals"], ["conference", "Conferences"], ["preprint", "Preprints"]]),
      el("input", { id: "b-y0", class: "yr", type: "number", placeholder: "from" }),
      el("input", { id: "b-y1", class: "yr", type: "number", placeholder: "to" }),
      sel("b-abs", [["", "All papers"], ["1", "With abstract"], ["0", "No abstract"]]),
      sel("b-sort", SORTS),
      el("button", { class: "ghost", onclick: clearFilters }, "Clear"),
      el("span", { class: "spacer" }),
      el("span", { id: "b-count", class: "muted" })),
    el("div", { class: "b-scroll" },
      el("div", { id: "b-list", class: "b-list" },
        el("div", { class: "col-note" }, "Loading the corpus…")),
      el("div", { class: "b-foot" },
        el("button", { id: "b-more", class: "ghost", hidden: true, onclick: renderMore }, "Show more")))));

  $("b-q").addEventListener("input", debounce(apply, 250));
  for (const id of ["b-col", "b-abs", "b-sort"]) $(id).addEventListener("change", apply);
  for (const id of ["b-y0", "b-y1"]) $(id).addEventListener("input", debounce(apply, 350));

  const base = import.meta.env.BASE_URL || "./";
  const fetchJson = (name) => fetch(base + "data/" + name).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [status, recent] = await Promise.all([fetchJson("status.json"), fetchJson("recent.json")]);
  renderStatus(status);

  try { await engine.loadIndex(); } catch (e) {
    $("b-list").replaceChildren(el("div", { class: "col-note" }, "Failed to load corpus: " + e.message));
    return;
  }

  const corpus = engine.allPapers();
  const seen = new Set(corpus.map((p) => p.id));
  const fresh = (recent?.papers || []).filter((p) => !seen.has(p.id)).map((p) => ({ ...p, fresh: true }));
  B.papers = fresh.concat(corpus);
  for (const p of B.papers) {
    p._hay = [p.title, (p.authors || []).join(" "), p.venue].filter(Boolean).join(" ").toLowerCase();
  }
  B.total = B.papers.length;
  B.ready = true;

  // Venue list for the multi-select, by descending paper count.
  const counts = new Map();
  for (const p of B.papers) counts.set(p.venue || "Unknown", (counts.get(p.venue || "Unknown") || 0) + 1);
  B.venues = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  renderVenueRows();
  apply();
}

const sel = (id, opts) => el("select", { id }, ...opts.map(([v, t]) => el("option", { value: v }, t)));

function clearFilters() {
  $("b-q").value = ""; $("b-col").value = "";
  $("b-y0").value = ""; $("b-y1").value = ""; $("b-abs").value = ""; $("b-sort").value = "added_desc";
  B.venueOff.clear();
  renderVenueRows();
  apply();
}

// ---- venue multi-select (all venues opt-in by default; uncheck to exclude) ----

function venueDropdown() {
  const panel = el("div", { class: "dd-panel", id: "venue-panel", hidden: true },
    el("div", { class: "dd-actions" },
      el("button", { class: "ghost", onclick: () => setAllVenues(true) }, "Select all"),
      el("button", { class: "ghost", onclick: () => setAllVenues(false) }, "None")),
    el("div", { class: "dd-rows", id: "venue-rows" }));
  const btn = el("button", { class: "dd-btn", id: "venue-btn", onclick: (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  } }, "Venues: all ▾");
  const wrap = el("div", { class: "dd" }, btn, panel);
  panel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { panel.hidden = true; });
  return wrap;
}

function setAllVenues(on) {
  B.venueOff = on ? new Set() : new Set(B.venues.map(([v]) => v));
  renderVenueRows();
  apply();
}

function renderVenueRows() {
  const rows = $("venue-rows");
  if (!rows) return;
  rows.replaceChildren(...B.venues.map(([v, n]) => {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !B.venueOff.has(v);
    cb.addEventListener("change", () => {
      cb.checked ? B.venueOff.delete(v) : B.venueOff.add(v);
      updateVenueBtn();
      apply();
    });
    return el("label", { class: "dd-row" }, cb,
      el("span", { class: "dd-name" }, v),
      el("span", { class: "dd-n" }, n.toLocaleString()));
  }));
  updateVenueBtn();
}

function updateVenueBtn() {
  const btn = $("venue-btn");
  if (!btn) return;
  const off = B.venueOff.size, total = B.venues.length;
  btn.textContent = off === 0 ? "Venues: all ▾"
    : off >= total ? "Venues: none ▾"
    : `Venues: ${total - off} of ${total} ▾`;
  btn.classList.toggle("filtering", off > 0);
}

// ---- status strip + subscribe ----

function renderStatus(st) {
  const box = $("b-status");
  if (!box) return;
  if (!st) {
    box.replaceChildren(el("span", {}, "Updated daily from OpenAlex + AIS eLibrary."));
    return;
  }
  const run = st.last_run || {};
  const bits = [el("span", { class: "b-live" }, "● updated daily")];
  if (run.date) {
    bits.push(el("strong", {}, ` ${run.date}: `),
      el("span", {}, `${(run.new_papers ?? 0).toLocaleString()} new paper${run.new_papers === 1 ? "" : "s"} crawled`));
    if (run.digest_sent) bits.push(el("span", { class: "muted" }, " · digest emailed"));
  }
  if (st.totals?.corpus) {
    bits.push(el("span", { class: "muted" },
      ` · corpus ${st.totals.corpus.toLocaleString()} records (${(st.totals.searchable || 0).toLocaleString()} searchable here)`));
  }
  box.replaceChildren(...bits);
}

function subscribeBox() {
  const email = el("input", { id: "sub-email", type: "email", placeholder: "you@university.edu", autocomplete: "email" });
  // Honeypot: invisible to humans, tempting to bots; non-empty → silently dropped.
  const hp = el("input", { class: "hp", name: "website", tabindex: "-1", autocomplete: "off" });
  const btn = el("button", { class: "primary", onclick: submit }, "Subscribe");
  const note = el("div", { class: "hint" }, "One email a day with newly published IS papers. Confirm by email · unsubscribe anytime.");
  email.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  async function submit() {
    const addr = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return toast("Enter a valid email address");
    btn.disabled = true; btn.textContent = "Subscribing…";
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: addr, website: hp.value }),
      });
      const out = await res.json().catch(() => ({}));
      if (res.status === 503) toast("Subscriptions aren't open quite yet — check back soon.");
      else if (!res.ok) toast(out.error || "Subscription failed — try again later");
      else {
        note.textContent = out.already
          ? "You're already subscribed — see you tomorrow morning."
          : "Almost done — open the confirmation email we just sent you.";
        email.value = "";
        toast(out.already ? "Already subscribed" : "Confirmation email sent");
      }
    } catch { toast("Network error — try again"); }
    btn.disabled = false; btn.textContent = "Subscribe";
  }

  return el("div", { class: "b-subscribe" },
    el("div", { class: "b-sub-title" }, "✉ Daily digest"),
    el("div", { class: "b-sub-row" }, email, hp, btn),
    note);
}

// ---- filtering / sorting / grouping ----

function apply() {
  if (!B.ready) return;
  const q = $("b-q").value.trim().toLowerCase();
  const col = $("b-col").value, abs = $("b-abs").value;
  const y0 = parseInt($("b-y0").value, 10) || null, y1 = parseInt($("b-y1").value, 10) || null;
  const sort = $("b-sort").value;
  const off = B.venueOff;

  const out = [];
  for (const p of B.papers) {
    if (off.size && off.has(p.venue || "Unknown")) continue;
    if (col && p.col !== col) continue;
    if (abs === "1" && !p.abstract) continue;
    if (abs === "0" && p.abstract) continue;
    if (y0 && (!p.year || p.year < y0)) continue;
    if (y1 && (!p.year || p.year > y1)) continue;
    if (q && !p._hay.includes(q)) continue;
    out.push(p);
  }

  const byYearDesc = (a, b) => (b.year || 0) - (a.year || 0) || (a.title || "").localeCompare(b.title || "");
  if (sort === "added_desc") out.sort((a, b) => (b.added || "").localeCompare(a.added || "") || byYearDesc(a, b));
  else if (sort === "year_desc") out.sort(byYearDesc);
  else if (sort === "year_asc") out.sort((a, b) => (a.year || 9999) - (b.year || 9999) || (a.title || "").localeCompare(b.title || ""));
  else if (sort === "cited_desc") out.sort((a, b) => (b.cited || 0) - (a.cited || 0) || byYearDesc(a, b));

  // Group for display: by corpus-entry date / publication year; flat for citations.
  const groups = [];
  let cur = null;
  for (const p of out) {
    const key = sort === "added_desc" ? (p.added ? "Added " + p.added : "Date unknown")
      : sort === "cited_desc" ? null
      : String(p.year || "Year unknown");
    if (!cur || cur.key !== key) { cur = { key, items: [] }; groups.push(cur); }
    cur.items.push(p);
  }

  B.groups = groups; B.cursor = { g: 0, i: 0 }; B.shown = 0;
  $("b-count").textContent = `${out.length.toLocaleString()} of ${B.total.toLocaleString()} papers`;
  $("b-list").replaceChildren();
  if (!out.length) $("b-list").append(el("div", { class: "col-note" }, "No papers match these filters."));
  renderMore();
}

function renderMore() {
  const list = $("b-list");
  let budget = PAGE;
  const { cursor, groups } = B;
  while (budget > 0 && cursor.g < groups.length) {
    const grp = groups[cursor.g];
    if (cursor.i === 0 && grp.key !== null) {
      list.append(el("div", { class: "b-group" }, grp.key,
        el("span", { class: "cnt" }, ` · ${grp.items.length.toLocaleString()} paper${grp.items.length === 1 ? "" : "s"}`)));
    }
    while (budget > 0 && cursor.i < grp.items.length) {
      list.append(card(grp.items[cursor.i]));
      cursor.i++; budget--; B.shown++;
    }
    if (cursor.i >= grp.items.length) { cursor.g++; cursor.i = 0; }
  }
  const remaining = B.groups.reduce((n, g) => n + g.items.length, 0) - B.shown;
  const more = $("b-more");
  more.hidden = remaining <= 0;
  if (remaining > 0) more.textContent = `Show more (${remaining.toLocaleString()} remaining)`;
}

// ---- card ----

function card(p) {
  const authors = (p.authors || []).slice(0, 6).join(", ") + ((p.authors || []).length > 6 ? " et al." : "");
  const meta = el("div", { class: "meta" });
  if (p.fresh) meta.append(el("span", { class: "badge new", title: "Crawled after the last search-index build — browsable now, in semantic search after the next refresh" }, "new"));
  if (!p.abstract) meta.append(el("span", { class: "badge noabs" }, "no abstract"));
  meta.append(document.createTextNode([authors, p.year, p.venue].filter(Boolean).join(" · ")));
  if (p.cited > 0) meta.append(el("span", { class: "muted" }, ` · ${p.cited.toLocaleString()} citation${p.cited === 1 ? "" : "s"}`));
  if (p.added) meta.append(el("span", { class: "muted" }, ` · added ${p.added}`));

  const link = p.url || (p.doi ? "https://doi.org/" + p.doi.replace(/^https?:\/\/doi\.org\//, "") : null);
  const ttl = link ? el("a", { href: link, target: "_blank", rel: "noopener" }, p.title || "(untitled)")
    : document.createTextNode(p.title || "(untitled)");
  const abs = el("div", { class: "abs" }, p.abstract || "— no abstract on record —");
  const c = el("div", { class: "card" + (p.fresh ? " fresh" : "") }, el("div", { class: "ttl" }, ttl), meta, abs);
  requestAnimationFrame(() => {
    if (abs.scrollHeight > abs.clientHeight + 4) {
      abs.classList.add("clip");
      const more = el("span", { class: "more", onclick: () => { abs.classList.toggle("expanded"); abs.classList.toggle("clip"); more.textContent = abs.classList.contains("expanded") ? "show less" : "show more"; } }, "show more");
      abs.after(more);
    }
  });
  c.append(el("div", { class: "acts" }, el("button", { class: "ghost", onclick: () => cite(p, toast) }, "❝ cite")));
  return c;
}
