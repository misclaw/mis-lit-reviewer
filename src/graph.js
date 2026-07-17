// Go backward / go forward view: a two-column citation graph. Backward puts
// the LLM-selected references on the left and the main review set on the
// right (prior work → mains); forward mirrors it (mains → citing work).
// SVG bezier edges connect each selected paper to the mains it links to;
// clicking a paper highlights its edges.
import { h, fmtCites } from "./ui.js";
import * as store from "./store.js";
import { collectBackward, collectForward, screenCandidates } from "./citegraph.js";
import { venueAbbr } from "./pipeline.js";
import { resolveModel } from "./llm.js";

const PITCH = 160;       // vertical rhythm of the selected-paper column
const CARD_W = 470;      // both columns
const MAIN_H = 96;
const CANVAS_W = 1200;

const STAGES = (dir) => [
  ["Collecting citation links",
    dir === "back" ? "All references of the main papers — OpenAlex" : "All papers citing the main papers — OpenAlex"],
  ["Fetching metadata & counting links",
    dir === "back" ? "Counting how many main papers cite each reference" : "Counting how many main papers each citing work cites"],
  ["LLM relevance screening", "Selecting ~20 with rationales, ranked by relevance × link count"],
];

// Kick off collection + screening for a direction if not already done/running.
export async function ensureGraph(ctx, dir) {
  const { run, rerender } = ctx;
  const field = dir === "back" ? "backward" : "forward";
  const g = run.graph[dir];
  const stream = store.getStream(ctx.stream.id);
  if (!stream?.within?.length || stream[field] || g.running) return;

  const prefs = store.getPrefs();
  const provider = prefs.provider;
  const key = prefs.keys[provider];
  const model = resolveModel(provider, prefs.models.wi?.[provider]);
  if (!key?.trim()) { g.error = "no API key configured — add one in Preferences"; rerender(); return; }

  g.running = true; g.stage = 1; g.error = null;
  rerender();
  try {
    const mains = stream.within;
    const collect = dir === "back" ? collectBackward : collectForward;
    const { candidates, stats } = await collect(mains, () => { g.stage = 2; rerender(); });
    if (!candidates.length) throw new Error("no citation links found");
    g.stage = 3; rerender();
    const selected = await screenCandidates({
      dir, mains, candidates, query: stream.query, provider, key, model,
    }, 20);
    store.updateStream(ctx.stream.id, { [field]: { selected, stats } });
    g.running = false; g.stage = 0;
  } catch (e) {
    console.error(e);
    g.running = false; g.stage = 0; g.error = e.message;
  }
  rerender();
}

function stageCard(dir, current, error) {
  return h("div", { class: "stage-card" },
    STAGES(dir).map(([lab, det], i) => {
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

function gCard(p, { main = false, x, y, hClamp, sel = false, linkNote, onClick }) {
  return h("div", {
    class: `gcard ${main ? "main" : "other"}${sel ? " sel" : ""}`,
    style: { left: x + "px", top: y + "px", height: hClamp + "px" },
    onclick: onClick,
  },
    h("div", { class: "gt" },
      p.url || p.doi
        ? h("a", { href: p.url || "https://doi.org/" + p.doi, target: "_blank", rel: "noopener",
            onclick: (e) => e.stopPropagation() }, p.title)
        : h("a", {}, p.title)),
    h("div", { class: "gm" },
      (typeof p.authors === "string" ? p.authors : (p.authors || []).slice(0, 4).join(", ")),
      " · ", h("strong", {}, venueAbbr(p.venue)), p.year ? ` · ${p.year}` : ""),
    h("div", { class: "gr" }, p.rationale || p.summary || ""),
    h("div", { class: "gf" },
      h("span", {}, linkNote),
      fmtCites(p.cited) != null && h("span", {}, `Cited by ${fmtCites(p.cited)}`)));
}

function graphBody(ctx, dir, data) {
  const { run } = ctx;
  const stream = ctx.stream;
  const mains = stream.within || [];
  const others = data.selected;
  const isBack = dir === "back";
  const nO = others.length, nM = mains.length;
  const canvasH = Math.max(nO * PITCH, nM * (MAIN_H + 24)) - 18;
  const mainPitch = nM > 1 ? (canvasH - MAIN_H) / (nM - 1) : 0;
  const otherX = isBack ? 0 : CANVAS_W - CARD_W;
  const mainX = isBack ? CANVAS_W - CARD_W : 0;
  const sel = run.graph[dir].sel;

  // edges: from the inner edge of the "other" column to the inner edge of mains
  const K = 0.55;
  const xa = isBack ? CARD_W + 2 : CANVAS_W - CARD_W - 2;
  const xb = isBack ? CANVAS_W - CARD_W - 2 : CARD_W + 2;
  const svgKids = [];
  others.forEach((p, i) => {
    const y1 = i * PITCH + (PITCH - 18) / 2;
    for (const m of p.links || []) {
      if (m < 0 || m >= nM) continue;
      const y2 = m * mainPitch + MAIN_H / 2;
      const cls = sel == null ? "" : sel === i ? " hot" : " dim";
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${xa} ${y1} C ${xa + (xb - xa) * K} ${y1}, ${xb - (xb - xa) * K} ${y2}, ${xb} ${y2}`);
      path.setAttribute("class", "edge" + cls);
      svgKids.push(path);
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", xb); dot.setAttribute("cy", y2); dot.setAttribute("r", 3);
      dot.setAttribute("class", "edge-dot" + cls);
      svgKids.push(dot);
    }
  });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", CANVAS_W); svg.setAttribute("height", Math.max(canvasH, 0));
  svg.append(...svgKids);

  return [
    h("div", { class: "graph-scroll" },
      h("div", { style: { minWidth: CANVAS_W + "px" } },
        h("div", { class: "graph-cols" },
          h("div", { class: "c" }, isBack ? "References (prior work)" : "Main review set"),
          h("div", { class: "gap" }),
          h("div", { class: "c" }, isBack ? "Main review set" : "Citing papers (later work)")),
        h("div", { class: "graph-canvas", style: { height: canvasH + "px" } },
          svg,
          others.map((p, i) => gCard(p, {
            x: otherX, y: i * PITCH, hClamp: PITCH - 18, sel: sel === i,
            linkNote: (isBack ? "Cited by " : "Cites ") + (p.links?.length || 0) + `/${nM} main`,
            onClick: () => { run.graph[dir].sel = sel === i ? null : i; ctx.rerender(); },
          })),
          mains.map((p, i) => gCard(p, {
            main: true, x: mainX, y: i * mainPitch, hClamp: MAIN_H,
            linkNote: "Main review #" + (i + 1),
          }))))),
    h("div", { class: "graph-foot" },
      `Showing ${others.length} LLM-selected papers · edges show citation links to the main review set · ` +
      "click a paper to highlight its links · citation data via OpenAlex"),
  ];
}

export function renderGraph(ctx, dir) {
  const stream = ctx.stream;
  const g = ctx.run.graph[dir];
  const field = dir === "back" ? "backward" : "forward";
  const data = stream[field];
  const isBack = dir === "back";

  let sub = "";
  if (data) {
    const st = data.stats || {};
    sub = isBack
      ? `${fmtCites(st.totalRefs) || "—"} references collected from the ${stream.within?.length || 0} main papers (${fmtCites(st.unique) || "—"} unique) → ${data.selected.length} selected by LLM`
      : `${fmtCites(st.totalCiting) || "—"} citing papers found for the ${stream.within?.length || 0} main papers → ${data.selected.length} selected by LLM`;
  }

  let bodyEl;
  if (!stream.within?.length) {
    bodyEl = h("div", { class: "graph-empty" }, "Run a main review first — the backward/forward steps trace citations from its 20 papers.");
  } else if (data) {
    bodyEl = graphBody(ctx, dir, data);
  } else if (g.running) {
    bodyEl = stageCard(dir, g.stage, null);
  } else if (g.error) {
    bodyEl = stageCard(dir, 0, g.error);
  } else {
    bodyEl = stageCard(dir, 1, null); // about to start (ensureGraph fires on entry)
  }

  return h("div", { class: `graph-zone ${dir}` },
    h("div", { class: "graph-inner" },
      h("div", { class: "zone-head" },
        h("div", { class: "zone-title" }, isBack ? "◀ Go backward" : "Go forward ▶"),
        h("div", { class: "zone-sub" }, sub),
        h("div", { class: "spacer" }),
        h("button", { class: "btn btn-sm", onclick: () => ctx.actions.goMode("main") }, "Return to main review")),
      bodyEl));
}
