// Main review mode: Within-IS zone (top, blue) · research-question dock ·
// Outside-IS zone (bottom, gold). Owns the pipeline orchestration for both
// zones; results persist on the current stream so switching streams (or
// reloading) restores them.
import { h, fmtCites, toast } from "./ui.js";
import * as store from "./store.js";
import { PROVIDERS, resolveModel, modelLabel, isAuthError } from "./llm.js";
import { exportRow } from "./export.js";
import {
  refineQuery, similarityFilter, rerank, prestigeSort, searchOutside, resolvePapers,
  describeImports, venueShort, VENUES, OUTSIDE_PROMPT_DEFAULT, cleanPoints,
} from "./pipeline.js";
import { dedupeInto, dropWithinOverlap, sourcesOf, recommendersOf, channelsOf } from "./dedupe.js";
import { openPaperModal } from "./paper-modal.js";
import { KEYS_STEP } from "./onboard.js";

// Deep-link into the Settings modal's API-keys step (e.g. from a keyless
// provider chip, or when a run is attempted with no key configured).
function openKeySettings(ctx) {
  ctx.app.prefsOpen = true;
  ctx.app.prefsStep = KEYS_STEP;
  ctx.rerender();
}

function savePrefs(patch) {
  store.saveOnboarding(store.getProfile(), { ...store.getPrefs(), ...patch });
}
const outsideProviderOf = (prefs) => prefs.outsideProvider || prefs.provider;

// Providers the user has actually keyed. The Outside-IS search fans out across
// ALL of these at once (deduping the union), so a paper can be "recommended by"
// more than one model.
const keyedProviders = (prefs) => Object.keys(PROVIDERS).filter((p) => prefs.keys[p]?.trim());
// Which of the keyed providers the outside search will use. Undefined pref =
// "all keyed" (the default); once the user toggles, an explicit list is stored
// and intersected with whatever still has a key.
function selectedOutsideProviders(prefs) {
  const keyed = keyedProviders(prefs);
  if (!Array.isArray(prefs.outsideProviders)) return keyed;
  return keyed.filter((p) => prefs.outsideProviders.includes(p));
}
const osModelFor = (prefs, p) => resolveModel(p, prefs.models?.os?.[p]);
// Human label naming BOTH the provider and the exact model tier that did the
// work, e.g. "Claude (Opus 4.8)" — provenance should say WHICH model searched,
// never a vague "Web search".
const modelChannel = (prefs, p) => `${PROVIDERS[p].label} (${modelLabel(p, osModelFor(prefs, p))})`;

// Provider chips + model dropdown. zone: "wi" | "os" — each zone keeps its
// own provider AND its own per-provider model choice (e.g. Opus for the
// rerank, a cheap model for the outside web search).
export function zoneModel(prefs, zone) {
  const prov = zone === "wi" ? prefs.provider : outsideProviderOf(prefs);
  return resolveModel(prov, prefs.models[zone]?.[prov]);
}
function pickerRow(ctx, zone) {
  const prefs = store.getPrefs();
  const prov = zone === "wi" ? prefs.provider : outsideProviderOf(prefs);
  const model = zoneModel(prefs, zone);
  return h("div", { class: `provider-row ${zone}` },
    h("div", { class: "lab" }, zone === "wi" ? "Reviewer:" : "Provider:"),
    // Single-select. A provider with no key shows dashed/dimmed and, when
    // clicked, jumps to Settings → API keys instead of selecting itself.
    Object.keys(PROVIDERS).map((p) => {
      const has = !!prefs.keys[p]?.trim();
      // A keyless provider isn't disabled — clicking it takes you straight to
      // the Settings API-keys step to add one, rather than being a dead end.
      return h("button", {
        class: `chip${p === prov ? " on " + zone : ""}${has ? "" : " nokey"}`,
        "aria-pressed": String(p === prov),
        title: has ? "" : `No ${PROVIDERS[p].label} key yet — click to add one in Settings`,
        onclick: has ? () => {
          savePrefs(zone === "wi" ? { provider: p } : { outsideProvider: p });
          ctx.rerender();
        } : () => openKeySettings(ctx),
      }, PROVIDERS[p].label, has ? null : h("span", { class: "nokey-tag" }, "no key"));
    }),
    h("select", { class: "model-select",
      "aria-label": (zone === "wi" ? "Within-IS" : "Outside-IS") + " model",
      onchange: (e) => {
        savePrefs({ models: { ...prefs.models, [zone]: { ...prefs.models[zone], [prov]: e.target.value } } });
        ctx.rerender();
      } },
      PROVIDERS[prov].models.map((m) =>
        h("option", { value: m.id, selected: m.id === model }, m.label))),
    zone === "os" && h("div", { class: "note" }, "with web-search tool enabled"));
}

// Outside-IS model picker: a MULTI-select. Every provider shows as a toggle
// chip; a provider without a key shows dashed/dimmed and, when clicked, jumps
// to Settings → API keys. The search fans out to all selected+keyed models.
// A per-model dropdown appears for each selected model so you can pick the tier.
function outsidePicker(ctx) {
  const prefs = store.getPrefs();
  const selected = new Set(selectedOutsideProviders(prefs));
  const setSelection = (next) => {
    savePrefs({ outsideProviders: [...next] });
    ctx.rerender();
  };
  const chips = h("div", { class: "provider-row os" },
    h("div", { class: "lab" }, "Search with:"),
    Object.keys(PROVIDERS).map((p) => {
      const has = !!prefs.keys[p]?.trim();
      const on = has && selected.has(p);
      return h("button", {
        class: `chip multi${on ? " on os" : ""}${has ? "" : " nokey"}`,
        "aria-pressed": String(on),
        title: has
          ? (on ? `Searching with ${PROVIDERS[p].label} — click to exclude` : `Click to include ${PROVIDERS[p].label}`)
          : `No ${PROVIDERS[p].label} key yet — click to add one in Settings`,
        onclick: has ? () => {
          const next = new Set(selectedOutsideProviders(prefs));
          next.has(p) ? next.delete(p) : next.add(p);
          setSelection(next);
        } : () => openKeySettings(ctx),
      }, PROVIDERS[p].label, has ? (on ? h("span", { class: "tick" }, "✓") : null) : h("span", { class: "nokey-tag" }, "no key"));
    }));
  // per-selected-model tier dropdowns
  const models = [...selected].length
    ? h("div", { class: "os-model-picks" },
        [...selected].map((p) =>
          h("label", { class: "os-model-pick" },
            h("span", { class: "mp-name" }, PROVIDERS[p].label),
            h("select", { class: "model-select",
              "aria-label": PROVIDERS[p].label + " model",
              onchange: (e) => {
                savePrefs({ models: { ...prefs.models, os: { ...prefs.models.os, [p]: e.target.value } } });
                ctx.rerender();
              } },
              PROVIDERS[p].models.map((m) =>
                h("option", { value: m.id, selected: m.id === osModelFor(prefs, p) }, m.label))))))
    : null;
  return h("div", {}, chips, models);
}

// Card provenance line: which models recommended it, plus any import tools.
function badgeFor(p) {
  const parts = [];
  const rec = recommendersOf(p);
  if (rec.length) parts.push((rec.length > 1 ? "Recommended by " : "Found by ") + rec.join(" · "));
  const tools = sourcesOf(p).filter((s) => s !== "Web search");
  if (tools.length) parts.push(tools.join(" · "));
  if (!parts.length) parts.push(sourcesOf(p).join(" · "));
  return (p.discipline ? p.discipline + " — " : "") + parts.join(" · ");
}

const IS_STAGES = [
  ["Query refinement & expansion", "LLM reduces ambiguity, adds synonyms & field vocabulary"],
  ["Similarity filtering", "Embedding search over the IS corpus → top 100 candidates " +
    "(first run downloads ~65 MB of corpus + model data, cached after that)"],
  ["LLM reranking with rationales", "Top 100 → 20 papers, each with a relevance rationale"],
];
const OUT_STAGES = (label) => [
  [`Searching with ${label}`,
    "Each model searches the scholarly web in parallel, with its web-search tool enabled"],
  ["Merging & enriching results", "De-duplicating across models, fetching metadata + citations via OpenAlex, dropping papers already in your within-IS set"],
];

// ---- pipeline actions ----
export async function runReview(ctx, query) {
  const { app, run, rerender } = ctx;
  query = (query || "").trim();
  if (!query) {
    toast("Type a research question first");
    document.querySelector(".query-dock input")?.focus();
    return;
  }
  if (run.isRunning) return;
  const prefs = store.getPrefs();
  const provider = prefs.provider;
  const key = prefs.keys[provider];
  if (!key || !key.trim()) {
    toast("Add an API key in Settings first");
    openKeySettings(ctx);
    return;
  }
  const model = zoneModel(prefs, "wi");
  const streamId = ctx.stream.id;
  const profile = store.getProfile();

  // Only the query (and an auto-name) persist now — the previous review's
  // results stay in the store until the new run SUCCEEDS, so a failed run
  // never destroys finished work.
  run.isRunning = true; run.isStage = 1; run.isError = null; run.refineNote = null; run.isProgress = null;
  const patch = { query };
  if (/^Untitled/i.test(ctx.stream.name)) {
    patch.name = query.length > 48 ? query.slice(0, 48) + "…" : query;
  }
  store.updateStream(streamId, patch);
  rerender();

  if (prefs.outsideEnabled) runOutside(ctx, query); // runs alongside

  try {
    // 1 — refinement (soft-fails to the original query — unless the key
    // itself is rejected, which would fail every later stage too)
    let refined = query, expansions = [];
    try {
      ({ refined, expansions } = await refineQuery({ query, profile, prefs, provider, key, model }));
    } catch (e) {
      if (isAuthError(e)) throw new Error(e.message + " — the API key was rejected; check it in Settings");
      run.refineNote = "refinement unavailable (" + e.message + ") — searched with the original phrasing";
    }
    run.isStage = 2;
    run.isProgress = "Scanning the embedded IS corpus for the closest candidates…";
    rerender();

    // 2 — similarity filtering
    const candidates = await similarityFilter({ query, refined, expansions }, 100);
    if (!candidates.length) throw new Error("no candidates found in the corpus");
    run.isStage = 3;
    run.isProgress = `${candidates.length} candidate papers found — ${modelLabel(provider, model)} is re-ranking them to the 20 most relevant…`;
    rerender();

    // 3 — LLM rerank with rationales; backward/forward belong to the old
    // main set, so they reset only here, together with its replacement
    const within = await rerank({ query, refined, candidates, profile, prefs, provider, key, model }, 20);
    store.updateStream(streamId, { refined, expansions, within, backward: null, forward: null });
    run.isRunning = false; run.isStage = 0; run.isProgress = null;
  } catch (e) {
    console.error(e);
    run.isRunning = false; run.isStage = 0; run.isProgress = null;
    run.isError = isAuthError(e) ? e.message + " — the API key was rejected; check it in Settings" : e.message;
  }
  rerender();
}

export async function runOutside(ctx, query) {
  const { run, rerender } = ctx;
  const prefs = store.getPrefs();
  const providers = selectedOutsideProviders(prefs);
  if (!providers.length) return;
  const streamId = ctx.stream.id;
  const profile = store.getProfile();

  run.outRunning = true; run.outStage = 1; run.outError = null;
  run.outProgress = `${providers.length} model${providers.length === 1 ? "" : "s"} searching the scholarly web in parallel — ` +
    providers.map((p) => modelChannel(prefs, p)).join(", ");
  rerender();
  try {
    // Fan out: every selected model searches the web in parallel. Each result
    // is tagged with the exact model that recommended it (e.g. "Claude (Opus
    // 4.8)"); when the same paper comes back from several models, dedupeInto
    // (via mergePapers) unions those tags — that's what makes it cross-channel.
    const settled = await Promise.allSettled(providers.map((p) =>
      searchOutside({
        query, profile, prefs, provider: p, key: prefs.keys[p],
        model: osModelFor(prefs, p), prompt: prefs.outsidePrompt,
      }, 8)));
    const found = [];
    const errors = [];
    const okModels = [];
    providers.forEach((p, i) => {
      const r = settled[i];
      if (r.status === "fulfilled") {
        okModels.push(modelChannel(prefs, p));
        for (const paper of r.value) {
          found.push({ ...paper, sources: ["Web search"], recommenders: [modelChannel(prefs, p)] });
        }
      } else {
        errors.push(`${PROVIDERS[p].label}: ${r.reason?.message || r.reason}`);
      }
    });
    if (!found.length) throw new Error(errors.join(" · ") || "no papers found");

    run.outStage = 2;
    run.outProgress = `${found.length} paper${found.length === 1 ? "" : "s"} returned by ${okModels.join(", ")} — ` +
      "de-duplicating and resolving metadata + citations…";
    // A fresh web search replaces the previous LLM findings; imported papers
    // (any record whose sources go beyond "Web search") stay in the collection.
    // The replacement happens only now, AFTER at least one model succeeded — a
    // fully failed search leaves the existing collection untouched.
    const prevOutside = store.getStream(streamId)?.outside || [];
    const keptImports = prevOutside.filter((p) => sourcesOf(p).some((s) => s !== "Web search"));
    store.updateStream(streamId, { outside: keptImports, outsideStats: null });
    rerender();
    await integrateOutside(ctx, found, "papers from the web search");
    run.outRunning = false; run.outStage = 0; run.outProgress = null;
    // Some models succeeded, some didn't — surface it without failing the run.
    if (errors.length) toast("Some models couldn't search — " + errors.join("; "));
  } catch (e) {
    console.error(e);
    run.outRunning = false; run.outStage = 0; run.outProgress = null; run.outError = e.message;
  }
  rerender();
}

// Explicit "Search the web" button — runs the outside search on its own, even
// with no within-IS review: falls back to whatever is typed in the query dock
// (and saves it on the stream so reloads keep it).
export function startOutside(ctx) {
  const { app, run, rerender, stream } = ctx;
  if (run.outRunning) return;
  let query = (stream.query || "").trim();
  if (!query) {
    query = document.querySelector(".query-dock input")?.value.trim() || "";
    if (query) {
      const patch = { query };
      if (/^Untitled/i.test(stream.name)) {
        patch.name = query.length > 48 ? query.slice(0, 48) + "…" : query;
      }
      store.updateStream(stream.id, patch);
    }
  }
  if (!query) {
    toast("Type a research question first");
    document.querySelector(".query-dock input")?.focus();
    return;
  }
  const prefs = store.getPrefs();
  if (!keyedProviders(prefs).length) {
    toast("Add an API key in Settings first");
    openKeySettings(ctx);
    return;
  }
  if (!selectedOutsideProviders(prefs).length) {
    toast("Pick at least one model to search with");
    rerender();
    return;
  }
  runOutside(ctx, query);
}

export function importSession(ctx, session) {
  const { stream, rerender } = ctx;
  store.markImported(session.id, stream.id);
  const papers = session.papers.map((p) => ({ ...p, source: "import", sources: [session.tool] }));
  toast(`Importing ${papers.length} paper${papers.length === 1 ? "" : "s"} from ${session.tool} — resolving metadata…`);
  integrateOutside(ctx, papers, `papers from ${session.tool}`).then(({ added, merged, overlap }) => {
    const bits = [`${added} added`];
    if (merged) bits.push(`${merged} merged with existing`);
    if (overlap) bits.push(`${overlap} already in the IS set`);
    toast(`${session.tool}: ${bits.join(", ")}`);
  });
  rerender();
}

// THE single entry path into the outside-IS collection, for web-search results
// and imports alike: resolve identities (S2/OpenAlex — fills title-less
// records, normalizes DOIs) → drop papers already in the within-IS main set →
// merge into the stream's collection (richest-field merge, sources unioned) →
// LLM pass for missing summaries/rationales. Rigorous dedupe lives in
// dedupe.js; identity keys are DOI, OpenAlex id, arXiv id, S2 id, then title.
async function integrateOutside(ctx, incoming, label = "papers") {
  const streamId = ctx.stream.id;
  const { run } = ctx;
  // Live count so the user can watch the batch move through resolution instead
  // of waiting on a silent spinner — this is where "many papers" get fetched.
  const total = incoming.length;
  run.outProgress = `Reviewing 0/${total} ${label} — resolving metadata & citations…`;
  ctx.rerender();
  const resolved = await resolvePapers(incoming, {
    onProgress: (done) => {
      run.outProgress = `Reviewing ${done}/${total} ${label} — resolving metadata & citations…`;
      ctx.rerender();
    },
  });
  const cur = store.getStream(streamId);
  if (!cur) { run.outProgress = null; return { added: 0, merged: 0, overlap: 0 }; }
  const { kept, overlap } = dropWithinOverlap(resolved, cur.within);
  let { list, merged } = dedupeInto(cur.outside || [], kept);

  // Retry earlier stragglers: records that resisted resolution (e.g. an
  // S2-only link during a Semantic Scholar rate-limit window) get another
  // attempt on every integration — and a late resolution can reveal a
  // duplicate, so re-dedupe afterwards.
  const unresolved = list.filter((p) => !p.title && (p.doi || p.url || p.s2id));
  if (unresolved.length) {
    const re = await resolvePapers(unresolved);
    const byKey = new Map(re.map((p, i) => [unresolved[i].url || unresolved[i].doi, p]));
    const replaced = list.map((p) => (!p.title && byKey.get(p.url || p.doi)) || p);
    const r2 = dedupeInto([], replaced);
    list = r2.list;
    merged += r2.merged;
  }

  const prev = cur.outsideStats || { merged: 0, overlap: 0 };
  store.updateStream(streamId, {
    outside: list,
    outsideStats: { merged: prev.merged + merged, overlap: prev.overlap + overlap },
  });
  run.outProgress = null;
  ctx.rerender();
  describeMissing(ctx, streamId);
  return { added: kept.length - merged, merged, overlap };
}

// LLM summaries/rationales for collection entries that still lack them
// (needs a key — imports themselves work without one).
let describeBusy = false;
async function describeMissing(ctx, streamId) {
  if (describeBusy) return;
  const prefs = store.getPrefs();
  const provider = outsideProviderOf(prefs);
  const key = prefs.keys[provider]?.trim() ? prefs.keys[provider]
    : prefs.keys[prefs.provider]?.trim() ? prefs.keys[prefs.provider] : null;
  const cur = store.getStream(streamId);
  if (!key || !cur?.query) return;
  const missing = (cur.outside || []).filter((p) =>
    p.title && (!p.summary || (!p.points?.length && !p.rationale)));
  if (!missing.length) return;
  describeBusy = true;
  try {
    const described = await describeImports({
      papers: missing, query: cur.query, profile: store.getProfile(),
      prefs, provider, key, model: zoneModel(prefs, "os"),
    });
    const byTitle = new Map(described.map((p) => [p.title, p]));
    const now = store.getStream(streamId);
    if (now) {
      store.updateStream(streamId, {
        outside: (now.outside || []).map((p) => byTitle.get(p.title) || p),
      });
      ctx.rerender();
    }
  } catch (e) {
    console.warn(e);
  } finally {
    describeBusy = false;
  }
}

// ---- rendering ----
// A live "how many papers are moving through the pipeline right now" line —
// shown while a search runs so the user can watch the system actually working
// (and trust it) instead of staring at a static spinner.
function progressBanner(text, os = false) {
  if (!text) return null;
  return h("div", { class: `progress-banner${os ? " os" : ""}`, role: "status", "aria-live": "polite" },
    h("div", { class: `progress-spin${os ? " os" : ""}` }),
    h("div", { class: "progress-text" }, text));
}

function stageCard(stages, current, { os = false, error = null } = {}) {
  return h("div", { class: `stage-card${os ? " os" : ""}`, role: "status", "aria-live": "polite" },
    stages.map(([lab, det], i) => {
      const n = i + 1;
      const state = current > n ? "done" : current === n ? "active" : "pending";
      return h("div", { class: `stage-row ${state}` },
        h("div", { class: "icon" },
          state === "active" ? h("div", { class: "stage-spin" })
            : state === "done" ? h("div", { class: "stage-done" }, "✓")
            : h("div", { class: "stage-pending" })),
        h("div", {},
          h("div", { class: "lab" }, lab),
          h("div", { class: "det" }, det)));
    }),
    error && h("div", { class: "stage-err" }, error));
}

// Google Scholar Labs presentation: two bullet points, each a bold key phrase
// + short description. Falls back to the older single "Why relevant" sentence
// for papers reviewed before points existed. normPoints yields {term, desc}.
export const normPoints = (p) => cleanPoints(p.points);
export const pointText = (pt) => (pt ? (pt.term ? `${pt.term}: ${pt.desc}` : pt.desc) : "");
function pointsBlock(p) {
  const pts = normPoints(p);
  if (pts.length) return h("ul", { class: "p-points" },
    pts.map((pt) => h("li", {}, pt.term ? [h("strong", {}, pt.term), ": ", pt.desc] : pt.desc)));
  if (p.rationale) return h("div", { class: "p-rationale" }, h("strong", {}, "Why relevant: "), p.rationale);
  return null;
}

// Google-Scholar-style author: given names collapse to concatenated initials
// before the surname — "Marshall Scott Poole" → "MS Poole", "Yang Zhao" → "Y Zhao".
function abbreviateAuthor(name) {
  const n = (name || "").trim();
  if (!n) return "";
  if (n.includes(",")) { // "Last, First M" → "FM Last"
    const [last, rest = ""] = n.split(",");
    const initials = rest.trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join("");
    return (initials ? initials + " " : "") + last.trim();
  }
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return n;
  const last = parts[parts.length - 1];
  const initials = parts.slice(0, -1).map((w) => w[0].toUpperCase()).join("");
  return initials + " " + last;
}
// Shorten an author list the way Scholar does: abbreviate each name, show the
// first few, and trail a "…" (no "et al.") when there are more.
export function fmtAuthors(authors, maxAuthors = 4) {
  const list = Array.isArray(authors) ? authors : String(authors || "").split(/,\s*/);
  const names = list.map(abbreviateAuthor).filter(Boolean);
  if (!names.length) return "";
  if (names.length <= maxAuthors) return names.join(", ");
  return names.slice(0, maxAuthors).join(", ") + "…";
}

// Result columns: default one column (Google-Scholar-style), opt-in two.
export const gridLayoutClass = () => (store.getPrefs().layout === "two" ? "results-grid cols-2" : "results-grid");
const isOneCol = () => store.getPrefs().layout !== "two";

// The "Refined query · N abstracts → 100 → reranked" line. Collapsible (its
// width is capped + centered in one-column mode so it doesn't sprawl above the
// centered result column).
function refinedLine(ctx, stream) {
  const { app, run } = ctx;
  const prefs = store.getPrefs();
  const cls = `refined-line${isOneCol() ? " narrow" : ""}`;
  const toggle = h("button", { class: "refined-toggle", "aria-expanded": String(!prefs.hideRefined),
    title: prefs.hideRefined ? "Show refined query & stats" : "Hide refined query & stats",
    onclick: () => { savePrefs({ hideRefined: !prefs.hideRefined }); ctx.rerender(); } },
    prefs.hideRefined ? "▸ Refined query" : "▾");
  if (prefs.hideRefined) return h("div", { class: cls + " collapsed" }, toggle);
  return h("div", { class: cls },
    toggle, " Refined query: ", h("em", {}, `“${stream.refined || stream.query}”`),
    stream.expansions?.length ? [" · expansions: ", h("em", {}, stream.expansions.join(" · "))] : "",
    ` · ${fmtCites(app.status?.totals?.searchable) || "the"} abstracts → 100 by similarity → `,
    h("strong", {}, `${stream.within.length} reranked`),
    run.refineNote ? h("span", { style: { color: "var(--danger)" } }, ` · ${run.refineNote}`) : "");
}
export function layoutToggle(ctx) {
  const cur = store.getPrefs().layout === "two" ? "two" : "one";
  const set = (v) => { savePrefs({ layout: v }); ctx.rerender(); };
  return h("div", { class: "layout-toggle", role: "group", "aria-label": "Result columns" },
    [["one", "☰", "One column"], ["two", "▦", "Two columns"]].map(([v, glyph, label]) =>
      h("button", { class: `chip${cur === v ? " on" : ""}`, "aria-pressed": String(cur === v),
        title: label, onclick: () => set(v) }, glyph)));
}

export function paperCard(p, { variant, rank = null, badge = null, cross = null, ctx = null }) {
  const authors = fmtAuthors(p.authors);
  const cites = fmtCites(p.cited);
  const vd = venueShort(p.venue); // abbreviation (known) / truncation (outside) + full-name hover
  // a record that resisted resolution may have no title — show its identifier
  const title = p.title || (p.doi ? "doi:" + p.doi : p.url) || "(unresolved paper)";
  // Clicking the card body opens the detail + abstract modal; the title link
  // (and any other anchor) keeps its own navigation — guarded via closest("a").
  // A fetched abstract is written back onto the stored paper so it's held.
  const persist = ctx ? (patch) => {
    try { store.patchPaperInStream(ctx.stream.id, p, patch); } catch { /* best-effort */ }
  } : null;
  const open = () => openPaperModal(p, { accent: variant === "os" ? "os" : "wi", persist });
  return h("div", {
    class: `paper-card ${variant}${cross ? " cross" : ""} clickable`,
    role: "button", tabindex: 0,
    "aria-label": "Open details & abstract for: " + title,
    title: "Click for metadata & abstract",
    onclick: (e) => { if (e.target.closest("a")) return; open(); },
    onkeydown: (e) => {
      if ((e.key === "Enter" || e.key === " ") && !e.target.closest("a")) { e.preventDefault(); open(); }
    },
  },
    h("div", { class: "top" },
      rank != null && h("div", { class: "rank" }, "#" + rank),
      h("div", { class: "body" },
        cross && h("div", { class: "cross-ribbon", title: "Found through more than one channel — the strongest corroboration signal" },
          h("span", { class: "cx-dot" }, "◆"),
          h("span", {}, `Found across ${cross.length} channels — `, h("strong", {}, cross.join(" · "))))
        ,
        h("div", { class: "p-title" },
          p.url || p.doi
            ? h("a", { href: p.url || "https://doi.org/" + p.doi, target: "_blank", rel: "noopener" }, title)
            : title),
        h("div", { class: "p-meta" },
          authors, authors ? " · " : "",
          h("strong", { title: vd.title || null }, vd.text),
          p.year ? ` · ${p.year}` : ""),
        p.summary && h("div", { class: "p-summary" }, p.summary),
        pointsBlock(p),
        h("div", { class: "p-foot" },
          cites != null && h("span", {}, `Cited by ${cites}`),
          badge && h("span", {}, badge),
          h("span", { class: "p-open-hint" }, "Details & abstract →")))));
}

function withinZone(ctx) {
  const { app, run, stream } = ctx;
  const prefs = store.getPrefs();
  const done = !!stream.within && !run.isRunning;
  const prestige = !!stream.prestige;

  let bodyEl;
  if (run.isRunning) {
    bodyEl = [stageCard(IS_STAGES, run.isStage), progressBanner(run.isProgress)];
  } else if (run.isError && !stream.within) {
    bodyEl = stageCard(IS_STAGES, 0, { error: "Review failed — " + run.isError });
  } else if (done || (run.isError && stream.within)) {
    const list = prestige ? prestigeSort(stream.within, prefs) : stream.within;
    bodyEl = [
      run.isError && h("div", { class: "stage-err banner", role: "alert" },
        "Review failed — " + run.isError + " · your previous results below are unchanged"),
      refinedLine(ctx, stream),
      h("div", { class: gridLayoutClass() },
        list.map((p, i) => paperCard(p, {
          variant: "wi", rank: i + 1, ctx,
          badge: prestige ? "Prestige rank" : "Relevance rank",
        }))),
    ];
  } else {
    const st = app.status;
    bodyEl = h("div", { class: "stats-card" },
      h("div", { class: "stat" },
        h("div", { class: "n" }, st ? fmtCites(st.totals.corpus) : "—"),
        h("div", { class: "l" }, "records crawled (IS journals + conferences)")),
      h("div", { class: "stat" },
        h("div", { class: "n" }, st ? fmtCites(st.totals.searchable) : "—"),
        h("div", { class: "l" }, "deduplicated & embedded (title + abstract)")),
      h("div", { class: "stat" },
        h("div", { class: "n" }, String(Object.keys(VENUES).length)),
        h("div", { class: "l" }, "journals & conference series")),
      h("div", { class: "stat" },
        h("div", { class: "n" }, st ? st.last_run.date : "—"),
        h("div", { class: "l" }, "last crawl (daily cron)")),
      h("div", { class: "blurb" },
        "Enter a research question below — we refine it, filter ~100 candidates by embedding similarity, then LLM-rerank to ~20 with rationales."));
  }

  return h("div", { class: "zone-is" },
    h("div", { class: "zone-inner" },
      h("div", { class: "zone-head" },
        h("div", { class: "zone-title" }, "Within IS"),
        h("div", { class: "zone-sub" }, "Curated IS corpus — basket journals + major IS conferences, crawled daily"),
        h("div", { class: "spacer" }),
        done && layoutToggle(ctx),
        done && exportRow(prestige ? prestigeSort(stream.within, prefs) : stream.within, "within-is-review"),
        done && h("button", {
          class: `prestige-btn${prestige ? " on" : ""}`,
          "aria-pressed": String(prestige),
          onclick: () => { store.updateStream(stream.id, { prestige: !prestige }); ctx.rerender(); },
        }, prestige ? "Prestige ranking: on" : "Prestige ranking: off")),
      !run.isRunning && pickerRow(ctx, "wi"),
      !run.isRunning && !keyedProviders(prefs).length && h("div", { class: "wi-nokey-note" },
        "The reviewer models are disabled until you add an API key in Settings."),
      bodyEl));
}

function queryDock(ctx) {
  const { run, stream } = ctx;
  const done = !!stream.within && !run.isRunning;
  const prefs = store.getPrefs();
  const wiProv = prefs.provider;
  const osProviders = selectedOutsideProviders(prefs);
  const outsideRuns = prefs.outsideEnabled && osProviders.length > 0;
  const input = h("input", {
    value: stream.query || "",
    "aria-label": "Research question",
    placeholder: "e.g. How does trust shape user adoption of AI-based advisory systems?",
    onkeydown: (e) => { if (e.key === "Enter" && !run.isRunning) runReview(ctx, e.target.value); },
  });
  return h("div", { class: "query-dock" },
    h("div", { class: "inner" },
      h("div", { class: "label" }, "Research question"),
      h("div", { class: "row" },
        input,
        h("button", { class: "btn-ink", disabled: run.isRunning,
          onclick: () => { if (!run.isRunning) runReview(ctx, input.value); } },
          run.isRunning ? "Reviewing…" : "Review")),
      // what "Review" will actually spend, before it's pressed
      !run.isRunning && h("div", { class: "hint run-summary" },
        `Review makes 2 AI calls on your ${PROVIDERS[wiProv].label} key (${modelLabel(wiProv, zoneModel(prefs, "wi"))})` +
        (outsideRuns
          ? ` and auto-runs the Outside-IS web search on ${osProviders.map((p) => modelChannel(prefs, p)).join(" + ")} — toggle that off in the Outside IS zone.`
          : ".")),
      done && h("div", { class: "hint" },
        "Use the ", h("strong", {}, "◀ backward"), " / ", h("strong", {}, "forward ▶"),
        ` arrows to trace citations from these ${stream.within.length} main papers.`)));
}

// Disclosed + adjustable outside-IS system prompt. Stored in prefs
// (empty = built-in default); the researcher profile + question are always
// appended as the user message, and {n} is replaced by the paper count.
function promptEditor(ctx) {
  const prefs = store.getPrefs();
  const ta = h("textarea", { rows: 8, value: prefs.outsidePrompt || OUTSIDE_PROMPT_DEFAULT });
  return h("details", { class: "prompt-tweak" },
    h("summary", {}, "Search prompt ", h("span", { class: "note" },
      prefs.outsidePrompt ? "(customized)" : "(default — click to view / edit)")),
    h("div", { class: "prompt-note" },
      "This system prompt drives the outside-IS web search. {n} becomes the paper count; your researcher " +
      "profile and the research question are appended as the user message. Edit freely — keep the JSON reply " +
      "contract or the results can't be parsed."),
    ta,
    h("div", { class: "prompt-actions" },
      h("button", { class: "btn btn-sm",
        onclick: () => {
          const v = ta.value.trim();
          savePrefs({ outsidePrompt: v === OUTSIDE_PROMPT_DEFAULT.trim() ? "" : v });
          toast("Outside-IS prompt saved");
          ctx.rerender();
        } }, "Save prompt"),
      h("button", { class: "btn btn-sm",
        onclick: () => { savePrefs({ outsidePrompt: "" }); toast("Reset to default"); ctx.rerender(); } },
        "Reset to default")));
}

// The whole outside zone lives on one page — no tabs. Two method cards side
// by side (LLM web search · external tools via the extension), and below them
// ONE integrated collection: web-search finds and imports live together,
// deduped by identity; each card shows its discipline + where it came from.
function outsideZone(ctx) {
  const { run, stream } = ctx;
  const prefs = store.getPrefs();
  const auto = !!prefs.outsideEnabled;
  const selected = selectedOutsideProviders(prefs);
  const anyKey = keyedProviders(prefs).length > 0;
  const stageLabel = (selected.length ? selected : keyedProviders(prefs))
    .map((p) => modelChannel(prefs, p)).join(", ") || "your models";

  const outsideGrid = (list) => {
    const st = stream.outsideStats || {};
    const imp = list.filter((p) => sourcesOf(p).some((x) => x !== "Web search")).length;
    const web = list.filter((p) => sourcesOf(p).includes("Web search")).length;
    // Papers corroborated across several channels (2+ models, or a model AND an
    // import tool) rise to the top and are highlighted — independent sources
    // agreeing is the strongest signal in the collection.
    const cross = list.filter((p) => channelsOf(p).length > 1).length;
    const ranked = list
      .map((p, i) => ({ p, i, c: channelsOf(p).length }))
      .sort((a, b) => b.c - a.c || a.i - b.i)
      .map((x) => x.p);
    const bits = [`${list.length} paper${list.length === 1 ? "" : "s"}`];
    if (cross) bits.push(`${cross} across multiple channels`);
    if (web) bits.push(`${web} from web search`);
    if (imp) bits.push(`${imp} imported`);
    if (st.merged) bits.push(`${st.merged} duplicate${st.merged === 1 ? "" : "s"} merged`);
    if (st.overlap) bits.push(`${st.overlap} already in the IS set`);
    return [
      h("div", { class: "outside-line" }, bits.join(" · "), layoutToggle(ctx), exportRow(list, "outside-is-collection")),
      h("div", { class: gridLayoutClass() },
        ranked.map((p) => {
          const chs = channelsOf(p);
          return paperCard(p, { variant: "os", ctx, badge: badgeFor(p), cross: chs.length > 1 ? chs : null });
        })),
    ];
  };

  const llmBody = run.outRunning
    ? stageCard(OUT_STAGES(stageLabel), run.outStage, { os: true })
    : [
        outsidePicker(ctx),
        promptEditor(ctx),
        h("div", { class: "m-actions" },
          h("button", { class: "btn-import", disabled: !selected.length,
            onclick: () => startOutside(ctx) },
            stream.outside?.some((p) => sourcesOf(p).includes("Web search")) ? "Search the web again" : "Search the web"),
          h("button", { class: `auto-toggle${auto ? " on" : ""}`,
            "aria-pressed": String(auto),
            title: "When on, the web search also runs automatically with every Review",
            onclick: () => { savePrefs({ outsideEnabled: !auto }); ctx.rerender(); } },
            auto ? "✓ auto-runs with each review" : "auto-run with each review: off")),
        !anyKey && h("div", { class: "os-nokey-note" },
          "Add an API key in Settings to search the web with an LLM."),
        anyKey && !selected.length && h("div", { class: "os-nokey-note" },
          "Select at least one model above to search."),
        run.outError && h("div", { class: "stage-err" }, "Web search failed — " + run.outError),
      ];

  return h("div", { class: "zone-os" },
    h("div", { class: "zone-inner" },
      h("div", { class: "zone-head" },
        h("div", { class: "zone-title" }, "Outside IS"),
        h("div", { class: "zone-sub" }, "The wider literature — LLM web search and external tools feed one deduplicated collection")),
      h("div", { class: "os-methods" },
        h("div", { class: "os-method os-method-llm" },
          h("div", { class: "m-head" },
            h("div", { class: "t" }, "LLM web search"),
            h("div", { class: "s" }, "Each connected model searches the web in parallel — results merged & deduplicated.")),
          llmBody),
        extPanel(ctx)),
      progressBanner(run.outProgress, true),
      stream.outside?.length
        ? outsideGrid(stream.outside)
        : h("div", { class: "outside-line empty" },
            "No outside papers yet — run the web search, or import from an external tool.")));
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}

// The extension's presence script stamps this attribute on our origin.
const extVersion = () => document.documentElement.dataset.ptExtension || null;

const EXT_REPO_URL = "https://github.com/misclaw/mis-lit-reviewer/tree/main/extension";
const TOOLS = [
  { name: "Google Scholar Labs", url: (q) => "https://scholar.google.com/scholar_labs/search" + (q ? "?q=" + encodeURIComponent(q) : "") },
  { name: "Asta (Ai2)", url: () => "https://asta.allen.ai/" },
  { name: "Paper Digest", url: () => "https://www.paperdigest.org/review/" },
  { name: "SciSpace", url: (q) => "https://scispace.com/search" + (q ? "?q=" + encodeURIComponent(q) : "") },
];

// Lightweight query-similarity for the "looks related — import?" nudge. Content
// tokens only (drop stopwords), overlap coefficient = |A∩B| / min(|A|,|B|) — so
// a captured search that's the same question with a few extra words still scores
// high. Deliberately cheap and best-effort: missing a match is fine.
const STOPWORDS = new Set(("a an the of to in on for and or but with without within into over under how does do "
  + "is are was were be been being this that these those it its as at by from about their our your my we you they "
  + "which what when where who whom whose why can could would should may might will shall not no yes than then " +
  "between across via using use used based user users effect effects role impact").split(/\s+/));
function contentTokens(s) {
  return [...new Set((s || "").toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => t.length > 2 && !STOPWORDS.has(t)) || [])];
}
export function querySim(a, b) {
  const A = contentTokens(a), B = new Set(contentTokens(b));
  if (!A.length || !B.size) return 0;
  const inter = A.filter((t) => B.has(t)).length;
  return inter / Math.min(A.length, B.size); // overlap coefficient
}
const SIM_THRESHOLD = 0.8;

function extPanel(ctx) {
  const sessions = store.listSessions();
  const detected = extVersion();
  const q = ctx.stream.query || "";
  const paste = h("textarea", { placeholder: '{"v":1,"tool":"…","query":"…","papers":[{"title":"…"}]}' });
  // Un-imported captures that closely match the current question — surface these
  // as an active suggestion instead of leaving them buried in the history list.
  const suggestions = q.trim()
    ? sessions.filter((x) => !x.imported[ctx.stream.id] && !x.suggestDismissed
        && querySim(q, x.query) >= SIM_THRESHOLD)
    : [];

  // Firefox loads the same folder as a temporary add-on; Chromium loads it
  // unpacked. Show the steps for the browser we're actually running in.
  const isFirefox = /firefox/i.test(navigator.userAgent);
  const steps = isFirefox
    ? [
        "Download the repo (or just its extension/ folder) from GitHub",
        "Open about:debugging#/runtime/this-firefox",
        "Click “Load Temporary Add-on…” and select the extension folder's manifest.json",
        "Reload this page, then click “Verify installation”",
      ]
    : [
        "Download the repo (or just its extension/ folder) from GitHub",
        "Open chrome://extensions and enable Developer mode (top right)",
        "Click “Load unpacked” and select the extension/ folder",
        "Reload this page, then click “Verify installation”",
      ];
  const setup = detected
    ? h("div", { class: "ext-status ok" }, `✓ Extension detected (v${detected}) — run a tool below, then click “Send to Paper Trails”.`)
    : h("div", { class: "ext-setup" },
        h("div", { class: "ext-status" },
          "Extension not detected in this browser. It works in Chrome and Firefox and installs manually — " +
          "download it from GitHub, then follow the 4 quick steps below. " +
          "After that, results from the tools flow back here with one click."),
        h("div", { class: "ext-actions" },
          h("a", { class: "btn-import", href: EXT_REPO_URL, target: "_blank", rel: "noopener" },
            "Get the extension (GitHub) ↗"),
          h("button", { class: "btn btn-sm",
            onclick: () => {
              if (extVersion()) { toast("Extension detected ✓"); ctx.rerender(); }
              else toast("Not detected yet — after loading it, reload this page and verify again");
            } }, "Verify installation")),
        h("details", { class: "ext-paste", open: true },
          h("summary", {}, isFirefox ? "Install steps (Firefox)" : "Install steps (Chrome)"),
          h("ol", { class: "ext-steps" }, steps.map((s) => h("li", {}, s))),
          isFirefox && h("div", { class: "ext-note" },
            "Firefox removes temporary add-ons when it quits — reload it after a restart. " +
            "If the button doesn't show on a tool site, grant site access under about:addons → Permissions.")));

  const launcher = h("div", { class: "ext-launch" },
    h("div", { class: "lab" }, q ? "Run your research question on:" : "Open a tool (your question is prefilled once you run a review or web search):"),
    h("div", { class: "ext-launch-row" },
      TOOLS.map((t) =>
        h("a", { class: "tool-launch", href: t.url(q), target: "_blank", rel: "noopener" }, t.name + " ↗"))));

  return h("div", { class: "os-method ext-card" },
    h("div", { class: "m-head" },
      h("div", { class: "t" }, "External literature tools"),
      h("div", { class: "s" },
        "Run your question on a tool below; results come straight back here — no server.")),
    setup,
    launcher,
    // Active suggestions: captured searches that match the current question.
    suggestions.length > 0 && h("div", { class: "ext-suggests" },
      suggestions.map((x) =>
        h("div", { class: "ext-suggest" },
          h("div", { class: "sg-body" },
            h("div", { class: "sg-head" }, "Looks related to your question"),
            h("div", { class: "sg-q" },
              h("strong", {}, x.tool), " · ",
              x.query ? `“${x.query}” — ` : "", `${x.papers.length} paper${x.papers.length === 1 ? "" : "s"}`)),
          h("div", { class: "sg-actions" },
            h("button", { class: "btn-import", onclick: () => importSession(ctx, x) }, "Import"),
            h("button", { class: "btn btn-sm", title: "Don't suggest this capture again",
              onclick: () => { store.dismissSuggestion(x.id); ctx.rerender(); } }, "Not now"))))),
    // Full capture history is collapsed by default — it accumulates over time.
    sessions.length > 0 && h("details", { class: "ext-history" },
      h("summary", {}, `Capture history (${sessions.length})`),
      h("div", { class: "ext-rows" },
        sessions.map((x) =>
          h("div", { class: "ext-row" },
            h("div", { class: "badge" }, (x.tool || "?")[0].toUpperCase()),
            h("div", { class: "mid" },
              h("div", { class: "tool" }, x.tool, " ", h("span", { class: "when" }, "· " + timeAgo(x.received_at))),
              h("div", { class: "q" },
                x.query ? `“${x.query}” — ` : "", `${x.papers.length} papers`,
                x.hasRationales ? ", with rationales" : "")),
            x.imported[ctx.stream.id]
              ? h("button", { class: "btn-import done" }, "Imported ✓")
              : h("button", { class: "btn-import", onclick: () => importSession(ctx, x) }, "Import"),
            h("button", { class: "stream-del", title: "Delete capture",
              onclick: () => { store.deleteSession(x.id); ctx.rerender(); } }, "✕"))))),
    h("details", { class: "ext-paste" },
      h("summary", {}, "Paste a session as JSON instead"),
      paste,
      h("button", { class: "btn btn-sm", style: { marginTop: "8px" },
        onclick: () => {
          try {
            const data = JSON.parse(paste.value);
            const rec = store.addSession({
              tool: data.tool || "Pasted JSON", query: data.query || "",
              papers: (data.papers || []).filter((p) => p && p.title),
              hasRationales: !!data.hasRationales,
            });
            toast(`Captured ${rec.papers.length} papers — click Import`);
            ctx.rerender();
          } catch (e) { toast("Invalid JSON: " + e.message); }
        } }, "Add session")));
}

export function renderReview(ctx) {
  // In one-column mode the whole category (header, refined line, method panels,
  // results) is capped to the common paper-column width; two-column fills.
  return h("div", { class: "main-mode " + (isOneCol() ? "onecol" : "twocol") },
    withinZone(ctx),
    queryDock(ctx),
    outsideZone(ctx));
}
