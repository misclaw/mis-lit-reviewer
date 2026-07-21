// Guided tour: dims the page, spotlights one element at a time, and explains
// it in a floating card. Pure DOM, no library. Steps whose target is missing
// are skipped; the page stays scrollable underneath. Auto-offered once after
// onboarding, and re-runnable any time from the "?" button in the nav.
import { h } from "./ui.js";
import * as store from "./store.js";

const STEPS = [
  { sel: ".query-dock .inner", title: "Ask a research question",
    body: "Everything starts here. Type a research question and press Review — it runs the Within-IS pipeline, and the web search too if auto-run is on." },
  { sel: ".zone-is .zone-head", title: "Within IS",
    body: "A curated IS corpus, crawled daily. Your question is refined by an LLM, matched by embedding similarity, then reranked to ~20 papers, each with a rationale." },
  { sel: ".os-method-llm", title: "General search — LLM + web",
    body: "Searches the wider literature with your provider's web-search tool. Run it on its own with “Search the web”, or let it auto-run with each review." },
  { sel: ".ext-card", title: "General search — external tools",
    body: "Prefer Google Scholar Labs, Asta, Paper Digest, or SciSpace? Launch them from here and send their results back with the browser extension. Everything lands in one deduplicated collection." },
  { sel: ".crumbs", title: "Backward · Main · Forward",
    body: "After a review, trace citations: Backward shows what your main papers cite, Forward shows what cites them — ~20 LLM-screened papers each way." },
  { sel: ".stream-btn", title: "Review streams",
    body: "Each stream is one question with its own results. Switch, add, or export streams here — everything is stored in this browser only." },
  { sel: ".nav-prefs", title: "Settings",
    body: "Your profile, target venues, API keys, and per-zone provider + model. Rerun this tour any time from the ? button." },
];

export function startTour(ctx) {
  if (document.querySelector(".tour-layer")) return;
  if (ctx.app.mode !== "main") { ctx.app.mode = "main"; ctx.rerender(); }
  const steps = STEPS.filter((s) => document.querySelector(s.sel));
  if (!steps.length) return;

  let i = 0;
  const layer = h("div", { class: "tour-layer" });
  const ring = h("div", { class: "tour-ring" });
  const card = h("div", { class: "tour-card" });
  layer.append(ring, card);
  document.body.append(layer);

  function place() {
    const target = document.querySelector(steps[i].sel);
    if (!target) return;
    const r = target.getBoundingClientRect();
    const pad = 8;
    Object.assign(ring.style, {
      left: r.left - pad + "px", top: r.top - pad + "px",
      width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px",
    });
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const left = Math.min(Math.max(r.left, 16), Math.max(innerWidth - cw - 16, 16));
    let top = r.bottom + pad + 14;
    if (top + ch > innerHeight - 12) top = r.top - pad - ch - 14;
    if (top < 12) top = Math.max((innerHeight - ch) / 2, 12);
    card.style.left = left + "px";
    card.style.top = top + "px";
  }

  function stop() {
    removeEventListener("resize", place);
    removeEventListener("scroll", place, true);
    removeEventListener("keydown", onKey);
    layer.remove();
    store.markTourSeen();
  }

  function onKey(e) {
    if (e.target.matches?.("input, textarea, select")) return;
    if (e.key === "Escape") stop();
    else if (e.key === "ArrowRight") show(i + 1);
    else if (e.key === "ArrowLeft") show(i - 1);
  }

  function show(n) {
    if (n < 0) n = 0;
    if (n >= steps.length) return stop();
    i = n;
    const s = steps[i];
    const last = i === steps.length - 1;
    card.replaceChildren(
      h("div", { class: "tour-step" }, `${i + 1} / ${steps.length}`),
      h("div", { class: "tour-title" }, s.title),
      h("div", { class: "tour-body" }, s.body),
      h("div", { class: "tour-actions" },
        h("button", { class: "btn btn-sm", onclick: stop }, "Skip tour"),
        h("div", { class: "spacer" }),
        i > 0 && h("button", { class: "btn btn-sm", onclick: () => show(i - 1) }, "Back"),
        h("button", { class: "btn-ink btn-sm", onclick: () => (last ? stop() : show(i + 1)) },
          last ? "Done" : "Next →")));
    // instant, not smooth — smooth scrollIntoView silently no-ops in some
    // environments, which would leave the spotlight pointing off-screen
    document.querySelector(s.sel)?.scrollIntoView({ block: "center" });
    place();
  }

  addEventListener("resize", place);
  addEventListener("scroll", place, true); // tracks smooth scrolling + user scrolls
  addEventListener("keydown", onKey);
  show(0);
}
