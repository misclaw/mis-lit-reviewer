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
  describeImports, venuePub, VENUES, OUTSIDE_PROMPT_DEFAULT,
} from "./pipeline.js";
import { dedupeInto, dropWithinOverlap, sourcesOf } from "./dedupe.js";

function savePrefs(patch) {
  store.saveOnboarding(store.getProfile(), { ...store.getPrefs(), ...patch });
}
const outsideProviderOf = (prefs) => prefs.outsideProvider || prefs.provider;

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
    Object.keys(PROVIDERS).map((p) => {
      const has = !!prefs.keys[p]?.trim();
      return h("button", {
        class: `chip${p === prov ? " on " + zone : ""}`,
        "aria-pressed": String(p === prov),
        title: has ? "" : "no key configured — add one in Preferences",
        onclick: () => {
          savePrefs(zone === "wi" ? { provider: p } : { outsideProvider: p });
          ctx.rerender();
        },
      }, PROVIDERS[p].label + (has ? "" : " ∅"));
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

const IS_STAGES = [
  ["Query refinement & expansion", "LLM reduces ambiguity, adds synonyms & field vocabulary"],
  ["Similarity filtering", "Embedding search over the IS corpus → top 100 candidates " +
    "(first run downloads ~65 MB of corpus + model data, cached after that)"],
  ["LLM reranking with rationales", "Top 100 → 20 papers, each with a relevance rationale"],
];
const OUT_STAGES = (provider) => [
  [`Searching with ${PROVIDERS[provider]?.label || provider} + web-search tool`,
    "Looking for relevant papers beyond the IS corpus"],
  ["Screening & enriching results", "Metadata + citation counts via OpenAlex, dropping IS-corpus overlaps"],
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
    toast("Add an API key in Preferences first");
    app.prefsOpen = true;
    rerender();
    return;
  }
  const model = zoneModel(prefs, "wi");
  const streamId = ctx.stream.id;
  const profile = store.getProfile();

  // Only the query (and an auto-name) persist now — the previous review's
  // results stay in the store until the new run SUCCEEDS, so a failed run
  // never destroys finished work.
  run.isRunning = true; run.isStage = 1; run.isError = null; run.refineNote = null;
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
      if (isAuthError(e)) throw new Error(e.message + " — the API key was rejected; check it in Preferences");
      run.refineNote = "refinement unavailable (" + e.message + ") — searched with the original phrasing";
    }
    run.isStage = 2; rerender();

    // 2 — similarity filtering
    const candidates = await similarityFilter({ query, refined, expansions }, 100);
    if (!candidates.length) throw new Error("no candidates found in the corpus");
    run.isStage = 3; rerender();

    // 3 — LLM rerank with rationales; backward/forward belong to the old
    // main set, so they reset only here, together with its replacement
    const within = await rerank({ query, refined, candidates, profile, prefs, provider, key, model }, 20);
    store.updateStream(streamId, { refined, expansions, within, backward: null, forward: null });
    run.isRunning = false; run.isStage = 0;
  } catch (e) {
    console.error(e);
    run.isRunning = false; run.isStage = 0;
    run.isError = isAuthError(e) ? e.message + " — the API key was rejected; check it in Preferences" : e.message;
  }
  rerender();
}

export async function runOutside(ctx, query) {
  const { run, rerender } = ctx;
  const prefs = store.getPrefs();
  const provider = outsideProviderOf(prefs);
  const key = prefs.keys[provider];
  if (!key || !key.trim()) return;
  const model = zoneModel(prefs, "os");
  const streamId = ctx.stream.id;
  const profile = store.getProfile();

  run.outRunning = true; run.outStage = 1; run.outError = null;
  rerender();
  try {
    const found = await searchOutside(
      { query, profile, prefs, provider, key, model, prompt: prefs.outsidePrompt }, 8);
    run.outStage = 2;
    // a fresh web search replaces the previous LLM findings; imported papers
    // (any record whose sources go beyond "Web search") stay in the collection.
    // The replacement happens only now, AFTER the search succeeded — a failed
    // search leaves the existing collection untouched.
    const prevOutside = store.getStream(streamId)?.outside || [];
    const keptImports = prevOutside.filter((p) => sourcesOf(p).some((s) => s !== "Web search"));
    store.updateStream(streamId, { outside: keptImports, outsideStats: null });
    rerender();
    await integrateOutside(ctx, found.map((p) => ({ ...p, sources: ["Web search"] })));
    run.outRunning = false; run.outStage = 0;
  } catch (e) {
    console.error(e);
    run.outRunning = false; run.outStage = 0; run.outError = e.message;
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
  if (!prefs.keys[outsideProviderOf(prefs)]?.trim()) {
    toast("Add an API key in Preferences first");
    app.prefsOpen = true;
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
  integrateOutside(ctx, papers).then(({ added, merged, overlap }) => {
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
async function integrateOutside(ctx, incoming) {
  const streamId = ctx.stream.id;
  const resolved = await resolvePapers(incoming);
  const cur = store.getStream(streamId);
  if (!cur) return { added: 0, merged: 0, overlap: 0 };
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
  const missing = (cur.outside || []).filter((p) => p.title && (!p.summary || !p.rationale));
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

export function paperCard(p, { variant, rank = null, badge = null }) {
  const authors = typeof p.authors === "string" ? p.authors : (p.authors || []).join(", ");
  const cites = fmtCites(p.cited);
  const pub = venuePub(p.venue);
  // a record that resisted resolution may have no title — show its identifier
  const title = p.title || (p.doi ? "doi:" + p.doi : p.url) || "(unresolved paper)";
  return h("div", { class: `paper-card ${variant}` },
    h("div", { class: "top" },
      rank != null && h("div", { class: "rank" }, "#" + rank),
      h("div", { class: "body" },
        h("div", { class: "p-title" },
          p.url || p.doi
            ? h("a", { href: p.url || "https://doi.org/" + p.doi, target: "_blank", rel: "noopener" }, title)
            : title),
        h("div", { class: "p-meta" },
          authors, authors ? " · " : "",
          h("strong", {}, p.venue || "—"),
          p.year ? ` · ${p.year}` : "",
          pub ? ` · ${pub}` : ""),
        p.summary && h("div", { class: "p-summary" }, p.summary),
        p.rationale && h("div", { class: "p-rationale" }, h("strong", {}, "Why relevant: "), p.rationale),
        h("div", { class: "p-foot" },
          cites != null && h("span", {}, `Cited by ${cites}`),
          badge && h("span", {}, badge)))));
}

function withinZone(ctx) {
  const { app, run, stream } = ctx;
  const prefs = store.getPrefs();
  const done = !!stream.within && !run.isRunning;
  const prestige = !!stream.prestige;

  let bodyEl;
  if (run.isRunning) {
    bodyEl = stageCard(IS_STAGES, run.isStage);
  } else if (run.isError && !stream.within) {
    bodyEl = stageCard(IS_STAGES, 0, { error: "Review failed — " + run.isError });
  } else if (done || (run.isError && stream.within)) {
    const list = prestige ? prestigeSort(stream.within, prefs) : stream.within;
    bodyEl = [
      run.isError && h("div", { class: "stage-err banner", role: "alert" },
        "Review failed — " + run.isError + " · your previous results below are unchanged"),
      h("div", { class: "refined-line" },
        "Refined query: ", h("em", {}, `“${stream.refined || stream.query}”`),
        stream.expansions?.length ? [" · expansions: ", h("em", {}, stream.expansions.join(" · "))] : "",
        ` · ${fmtCites(app.status?.totals?.searchable) || "the"} abstracts → 100 by similarity → `,
        h("strong", {}, `${stream.within.length} reranked`),
        run.refineNote ? h("span", { style: { color: "var(--danger)" } }, ` · ${run.refineNote}`) : ""),
      h("div", { class: "results-grid" },
        list.map((p, i) => paperCard(p, {
          variant: "wi", rank: i + 1,
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
        done && exportRow(prestige ? prestigeSort(stream.within, prefs) : stream.within, "within-is-review"),
        done && h("button", {
          class: `prestige-btn${prestige ? " on" : ""}`,
          "aria-pressed": String(prestige),
          onclick: () => { store.updateStream(stream.id, { prestige: !prestige }); ctx.rerender(); },
        }, prestige ? "Prestige ranking: on" : "Prestige ranking: off")),
      !run.isRunning && pickerRow(ctx, "wi"),
      bodyEl));
}

function queryDock(ctx) {
  const { run, stream } = ctx;
  const done = !!stream.within && !run.isRunning;
  const prefs = store.getPrefs();
  const wiProv = prefs.provider;
  const osProv = outsideProviderOf(prefs);
  const outsideRuns = prefs.outsideEnabled && !!prefs.keys[osProv]?.trim();
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
          ? ` and auto-runs the Outside-IS web search on ${PROVIDERS[osProv].label} (${modelLabel(osProv, zoneModel(prefs, "os"))}) — toggle that off in the Outside IS zone.`
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
  const provider = outsideProviderOf(prefs);
  const auto = !!prefs.outsideEnabled;

  const outsideGrid = (list) => {
    const st = stream.outsideStats || {};
    const imp = list.filter((p) => sourcesOf(p).some((x) => x !== "Web search")).length;
    const web = list.filter((p) => sourcesOf(p).includes("Web search")).length;
    const bits = [`${list.length} paper${list.length === 1 ? "" : "s"}`];
    if (web) bits.push(`${web} from web search`);
    if (imp) bits.push(`${imp} imported`);
    if (st.merged) bits.push(`${st.merged} duplicate${st.merged === 1 ? "" : "s"} merged`);
    if (st.overlap) bits.push(`${st.overlap} already in the IS set`);
    return [
      h("div", { class: "outside-line" }, bits.join(" · "), exportRow(list, "outside-is-collection")),
      h("div", { class: "results-grid" },
        list.map((p) => paperCard(p, {
          variant: "os",
          badge: (p.discipline ? p.discipline + " — " : "") + sourcesOf(p).join(" · "),
        }))),
    ];
  };

  const llmBody = run.outRunning
    ? stageCard(OUT_STAGES(provider), run.outStage, { os: true })
    : [
        pickerRow(ctx, "os"),
        promptEditor(ctx),
        h("div", { class: "m-actions" },
          h("button", { class: "btn-import", onclick: () => startOutside(ctx) },
            stream.outside?.some((p) => sourcesOf(p).includes("Web search")) ? "Search the web again" : "Search the web"),
          h("button", { class: `auto-toggle${auto ? " on" : ""}`,
            "aria-pressed": String(auto),
            title: "When on, this web search also runs automatically with every Review",
            onclick: () => { savePrefs({ outsideEnabled: !auto }); ctx.rerender(); } },
            auto ? "✓ auto-runs with each review" : "auto-run with each review: off")),
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
            h("div", { class: "s" }, "Your provider's web-search tool finds papers beyond the IS corpus")),
          llmBody),
        extPanel(ctx)),
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

function extPanel(ctx) {
  const sessions = store.listSessions();
  const detected = extVersion();
  const q = ctx.stream.query || "";
  const paste = h("textarea", { placeholder: '{"v":1,"tool":"…","query":"…","papers":[{"title":"…"}]}' });

  const setup = detected
    ? h("div", { class: "ext-status ok" }, `✓ Extension detected (v${detected}) — run your question on a tool below and click “Send to Paper Trails” there.`)
    : h("div", { class: "ext-setup" },
        h("div", { class: "ext-status" },
          "Extension not detected in this browser. It installs manually — download it from GitHub, " +
          "then load it unpacked (4 quick steps below). After that, results from the tools flow back here with one click."),
        h("div", { class: "ext-actions" },
          h("a", { class: "btn-import", href: EXT_REPO_URL, target: "_blank", rel: "noopener" },
            "Get the extension (GitHub) ↗"),
          h("button", { class: "btn btn-sm",
            onclick: () => {
              if (extVersion()) { toast("Extension detected ✓"); ctx.rerender(); }
              else toast("Not detected yet — after loading it, reload this page and verify again");
            } }, "Verify installation")),
        h("details", { class: "ext-paste", open: true },
          h("summary", {}, "Install steps"),
          h("ol", { class: "ext-steps" },
            h("li", {}, "Download the repo (or just its extension/ folder) from GitHub"),
            h("li", {}, "Open chrome://extensions and enable Developer mode (top right)"),
            h("li", {}, "Click “Load unpacked” and select the extension/ folder"),
            h("li", {}, "Reload this page, then click “Verify installation”"))));

  const launcher = h("div", { class: "ext-launch" },
    h("div", { class: "lab" }, q ? "Run your research question on:" : "Open a tool (your question is prefilled once you run a review or web search):"),
    h("div", { class: "ext-launch-row" },
      TOOLS.map((t) =>
        h("a", { class: "tool-launch", href: t.url(q), target: "_blank", rel: "noopener" }, t.name + " ↗"))));

  return h("div", { class: "os-method ext-card" },
    h("div", { class: "m-head" },
      h("div", { class: "t" }, "External literature tools"),
      h("div", { class: "s" },
        "Run your question on the tools below; the extension sends their results back here — nothing goes through any server.")),
    setup,
    launcher,
    sessions.length > 0 && h("div", { class: "ext-rows" },
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
          h("button", { class: "stream-del", title: "Dismiss session",
            onclick: () => { store.deleteSession(x.id); ctx.rerender(); } }, "✕")))),
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
  return h("div", { class: "main-mode" },
    withinZone(ctx),
    queryDock(ctx),
    outsideZone(ctx));
}
