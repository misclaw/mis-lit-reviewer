// Main review mode: Within-IS zone (top, blue) · research-question dock ·
// Outside-IS zone (bottom, gold). Owns the pipeline orchestration for both
// zones; results persist on the current stream so switching streams (or
// reloading) restores them.
import { h, fmtCites, toast } from "./ui.js";
import * as store from "./store.js";
import { PROVIDERS, resolveModel } from "./llm.js";
import {
  refineQuery, similarityFilter, rerank, prestigeSort, searchOutside, enrichOutside,
  venueAbbr, venuePub, VENUES, OUTSIDE_PROMPT_DEFAULT,
} from "./pipeline.js";

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
        title: has ? "" : "no key configured — add one in Preferences",
        onclick: () => {
          savePrefs(zone === "wi" ? { provider: p } : { outsideProvider: p });
          ctx.rerender();
        },
      }, PROVIDERS[p].label + (has ? "" : " ∅"));
    }),
    h("select", { class: "model-select",
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
  ["Similarity filtering", "Embedding search over the IS corpus → top 100 candidates"],
  ["LLM reranking with rationales", "Top 100 → 20 papers, each with a relevance rationale"],
];
const OUT_STAGES = (provider) => [
  [`Searching with ${PROVIDERS[provider]?.label || provider} + web-search tool`,
    "Querying reference disciplines: management, psychology, HCI, economics"],
  ["Screening & enriching results", "Metadata + citation counts via OpenAlex, dropping IS-corpus overlaps"],
];

// ---- pipeline actions ----
export async function runReview(ctx, query) {
  const { app, run, rerender } = ctx;
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

  // reset runtime + persisted results for this stream
  run.isRunning = true; run.isStage = 1; run.isError = null; run.refineNote = null;
  store.updateStream(streamId, {
    query, refined: null, expansions: [], within: null, backward: null, forward: null,
  });
  const s = store.getStream(streamId);
  if (/^Untitled/i.test(s.name)) {
    store.updateStream(streamId, { name: query.length > 48 ? query.slice(0, 48) + "…" : query });
  }
  rerender();

  if (prefs.outsideEnabled) runOutside(ctx, query); // runs alongside

  try {
    // 1 — refinement (soft-fails to the original query)
    let refined = query, expansions = [];
    try {
      ({ refined, expansions } = await refineQuery({ query, profile, prefs, provider, key, model }));
    } catch (e) {
      run.refineNote = "refinement unavailable (" + e.message + ") — searched with the original phrasing";
    }
    store.updateStream(streamId, { refined, expansions });
    run.isStage = 2; rerender();

    // 2 — similarity filtering
    const candidates = await similarityFilter({ query, refined, expansions }, 100);
    if (!candidates.length) throw new Error("no candidates found in the corpus");
    run.isStage = 3; rerender();

    // 3 — LLM rerank with rationales
    const within = await rerank({ query, refined, candidates, profile, prefs, provider, key, model }, 20);
    store.updateStream(streamId, { within });
    run.isRunning = false; run.isStage = 0;
  } catch (e) {
    console.error(e);
    run.isRunning = false; run.isStage = 0; run.isError = e.message;
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
  store.updateStream(streamId, { outside: null });
  rerender();
  try {
    const found = await searchOutside(
      { query, profile, prefs, provider, key, model, prompt: prefs.outsidePrompt }, 8);
    run.outStage = 2; rerender();
    let papers = await enrichOutside(found);
    // drop overlaps with the within-IS result set (Crossref-style dedupe by title)
    const s = store.getStream(streamId);
    const wTitles = new Set((s.within || []).map((p) => normTitle(p.title)));
    papers = papers.filter((p) => !wTitles.has(normTitle(p.title)));
    const existing = (s.outside || []).filter((p) => p.source === "import");
    store.updateStream(streamId, { outside: [...papers, ...existing] });
    run.outRunning = false; run.outStage = 0;
  } catch (e) {
    console.error(e);
    run.outRunning = false; run.outStage = 0; run.outError = e.message;
  }
  rerender();
}
const normTitle = (t) => (t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();

export function importSession(ctx, session) {
  const { stream, rerender } = ctx;
  const s = store.getStream(stream.id);
  const have = new Set((s.outside || []).map((p) => normTitle(p.title)));
  const fresh = session.papers
    .filter((p) => !have.has(normTitle(p.title)))
    .map((p) => ({ ...p, source: "import", badge: session.tool }));
  store.updateStream(stream.id, { outside: [...(s.outside || []), ...fresh] });
  store.markImported(session.id, stream.id);
  toast(`Imported ${fresh.length} paper${fresh.length === 1 ? "" : "s"} from ${session.tool}`);
  // enrich in the background, then persist
  enrichOutside(fresh).then((enriched) => {
    const cur = store.getStream(stream.id);
    if (!cur) return;
    const byTitle = new Map(enriched.map((p) => [normTitle(p.title), p]));
    store.updateStream(stream.id, {
      outside: (cur.outside || []).map((p) => byTitle.get(normTitle(p.title)) || p),
    });
    rerender();
  });
  rerender();
}

// ---- rendering ----
function stageCard(stages, current, { os = false, error = null } = {}) {
  return h("div", { class: `stage-card${os ? " os" : ""}` },
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
  return h("div", { class: `paper-card ${variant}` },
    h("div", { class: "top" },
      rank != null && h("div", { class: "rank" }, "#" + rank),
      h("div", { class: "body" },
        h("div", { class: "p-title" },
          p.url || p.doi
            ? h("a", { href: p.url || "https://doi.org/" + p.doi, target: "_blank", rel: "noopener" }, p.title)
            : p.title),
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
  } else if (run.isError) {
    bodyEl = stageCard(IS_STAGES, 0, { error: "Review failed — " + run.isError });
  } else if (done) {
    const list = prestige ? prestigeSort(stream.within, prefs) : stream.within;
    bodyEl = [
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
        done && h("button", {
          class: `prestige-btn${prestige ? " on" : ""}`,
          onclick: () => { store.updateStream(stream.id, { prestige: !prestige }); ctx.rerender(); },
        }, prestige ? "Prestige ranking: on" : "Prestige ranking: off")),
      !run.isRunning && pickerRow(ctx, "wi"),
      bodyEl));
}

function queryDock(ctx) {
  const { run, stream } = ctx;
  const done = !!stream.within && !run.isRunning;
  const input = h("input", {
    value: stream.query || "",
    placeholder: "e.g. How does trust shape user adoption of AI-based advisory systems?",
    onkeydown: (e) => { if (e.key === "Enter" && !run.isRunning) runReview(ctx, e.target.value.trim()); },
  });
  return h("div", { class: "query-dock" },
    h("div", { class: "inner" },
      h("div", { class: "label" }, "Research question"),
      h("div", { class: "row" },
        input,
        h("button", { class: "btn-ink", disabled: run.isRunning,
          onclick: () => { if (!run.isRunning && input.value.trim()) runReview(ctx, input.value.trim()); } },
          run.isRunning ? "Reviewing…" : "Review")),
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

function outsideZone(ctx) {
  const { run, stream } = ctx;
  const prefs = store.getPrefs();
  const tab = run.outsideTab || "llm";

  let bodyEl;
  if (tab === "ext") {
    bodyEl = extPanel(ctx);
  } else if (!prefs.outsideEnabled) {
    bodyEl = h("div", { class: "os-note" },
      "General LLM search is disabled in your preferences. Use the browser extension to import results from Google Scholar Labs, Asta, Paper Digest, or SciSpace — or enable it in Preferences.");
  } else if (run.outRunning) {
    bodyEl = stageCard(OUT_STAGES(prefs.outsideProvider || prefs.provider), run.outStage, { os: true });
  } else if (run.outError) {
    bodyEl = stageCard(OUT_STAGES(prefs.outsideProvider || prefs.provider), 0, { os: true, error: "Outside-IS search failed — " + run.outError });
  } else if (stream.outside?.length) {
    bodyEl = h("div", { class: "results-grid" },
      stream.outside.map((p) => paperCard(p, {
        variant: "os",
        badge: p.source === "import" ? (p.badge || "Imported") : (p.discipline || "Web search"),
      })));
  } else {
    bodyEl = h("div", { class: "os-note" },
      "Runs alongside the IS search. Following Webster & Watson, IS reviews must also look ",
      h("em", {}, "outside"),
      " the field — this pane searches reference disciplines via your LLM provider's web-search tool.");
  }

  const showControls = prefs.outsideEnabled && tab === "llm" && !run.outRunning;
  return h("div", { class: "zone-os" },
    h("div", { class: "zone-inner" },
      h("div", { class: "zone-head" },
        h("div", { class: "zone-title" }, "Outside IS"),
        h("div", { class: "zone-sub" }, "Reference disciplines — management, psychology, HCI, economics & beyond"),
        h("div", { class: "spacer" }),
        h("div", { class: "pillbar" },
          h("button", { class: `pill${tab === "llm" ? " on" : ""}`,
            onclick: () => { run.outsideTab = "llm"; ctx.rerender(); } }, "LLM web search"),
          h("button", { class: `pill${tab === "ext" ? " on" : ""}`,
            onclick: () => { run.outsideTab = "ext"; ctx.rerender(); } }, "Import from extension"))),
      showControls && pickerRow(ctx, "os"),
      showControls && promptEditor(ctx),
      bodyEl));
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
          "Extension not detected in this browser. Install it once, then results from the tools below flow back here with one click."),
        h("div", { class: "ext-actions" },
          h("a", { class: "btn-import", href: EXT_REPO_URL, target: "_blank", rel: "noopener" },
            "Install the extension"),
          h("button", { class: "btn btn-sm",
            onclick: () => {
              if (extVersion()) { toast("Extension detected ✓"); ctx.rerender(); }
              else toast("Not detected yet — after loading it, reload this page and verify again");
            } }, "Verify installation")),
        h("details", { class: "ext-paste" },
          h("summary", {}, "Install steps"),
          h("ol", { class: "ext-steps" },
            h("li", {}, "Download the repo (or just its extension/ folder) from GitHub"),
            h("li", {}, "Open chrome://extensions and enable Developer mode (top right)"),
            h("li", {}, "Click “Load unpacked” and select the extension/ folder"),
            h("li", {}, "Reload this page, then click “Verify installation”"))));

  const launcher = h("div", { class: "ext-launch" },
    h("div", { class: "lab" }, q ? "Run your research question on:" : "Open a tool (run a main review first to prefill your question):"),
    h("div", { class: "ext-launch-row" },
      TOOLS.map((t) =>
        h("a", { class: "tool-launch", href: t.url(q), target: "_blank", rel: "noopener" }, t.name + " ↗"))));

  return h("div", { class: "ext-card" },
    h("div", { class: "ext-head" },
      h("div", { class: "t" }, "Bridge from other literature tools"),
      h("div", { class: "s" },
        "The extension detects the source, query, paper list, and rationales (when available) on these tools and hands them to this workbench — nothing goes through any server.")),
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
