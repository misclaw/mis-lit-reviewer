// Paper Trails Bridge — content script.
// Detects the source tool, the query, and the visible paper list (plus
// rationales/snippets when present) on supported literature-search tools, and
// hands the session to the Backward · Main · Forward workbench via a URL
// fragment (#import=base64url(JSON)) — the same cross-app handoff contract the
// workbench already accepts from reference-viewer.
//
// Site adapters are best-effort: these products change their DOM without
// notice, so every adapter degrades to a generic scholarly-link extractor.
// Alt-click (⌥-click) the button to send to http://localhost:5173 instead of
// the production app (for local development).
(() => {
  const APP_URL = "https://paper-trails.misclaw.app/";
  const DEV_URL = "http://localhost:5173/";
  const MAX_PAPERS = 40;

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const yearOf = (s) => {
    const m = (s || "").match(/\b(19[5-9]\d|20[0-4]\d)\b/);
    return m ? parseInt(m[1], 10) : null;
  };

  // ---------- site adapters ----------
  function detectTool() {
    const h = location.hostname;
    if (h === "scholar.google.com") {
      return location.pathname.includes("scholar_labs") ? "Google Scholar Labs" : "Google Scholar";
    }
    if (h.endsWith("asta.allen.ai")) return "Asta (Ai2)";
    if (h.endsWith("paperdigest.org")) return "Paper Digest";
    if (h.endsWith("scispace.com") || h.endsWith("typeset.io")) return "SciSpace";
    return null;
  }

  function detectQuery() {
    const url = new URL(location.href);
    for (const k of ["q", "query", "question", "search_text", "term"]) {
      const v = url.searchParams.get(k);
      if (v) return clean(v);
    }
    for (const sel of [
      "textarea", 'input[type="search"]', 'input[name="q"]', 'input[type="text"]',
    ]) {
      const el = document.querySelector(sel);
      if (el && clean(el.value).length > 8) return clean(el.value);
    }
    return "";
  }

  // Google Scholar (classic + Labs share the gs_* result markup for citations)
  function extractScholar() {
    const out = [];
    let rows = document.querySelectorAll(".gs_ri");
    if (!rows.length) rows = document.querySelectorAll(".gs_r");
    for (const r of rows) {
      const a = r.querySelector("h3 a, .gs_rt a");
      if (!a) continue;
      const byline = clean(r.querySelector(".gs_a")?.textContent);
      out.push({
        title: clean(a.textContent),
        url: a.href,
        authors: byline.split(/-|—/)[0] || "",
        venue: clean((byline.split(/-|—/)[1] || "").replace(/\d{4}.*/, "").replace(/,\s*$/, "")),
        year: yearOf(byline),
        snippet: clean(r.querySelector(".gs_rs")?.textContent),
      });
    }
    return out;
  }

  // Paper Digest — review tables / result lists
  function extractPaperDigest() {
    const out = [];
    for (const row of document.querySelectorAll("table tr, .paper-item, article")) {
      const a = row.querySelector('a[href*="doi.org"], a[href*="arxiv.org"], a[href*="paperdigest"], a[href^="http"]');
      const title = clean(a?.textContent);
      if (!a || title.length < 15) continue;
      out.push({
        title, url: a.href,
        snippet: clean(row.querySelector("td:last-child, p, .highlight")?.textContent).slice(0, 400),
        year: yearOf(row.textContent),
      });
    }
    return out;
  }

  // Generic fallback: scholarly-looking links anywhere on the page.
  // Links whose anchor text is a plausible title become full records; links
  // that only carry an identifier (a doi.org href with "[1]" or an icon as
  // its text — SciSpace does this) are captured as title-less records and the
  // app's resolution pipeline (Semantic Scholar / OpenAlex) fills them in.
  const SCHOLARLY = /doi\.org|arxiv\.org|semanticscholar\.org|aclanthology|dl\.acm\.org|link\.springer|sciencedirect|onlinelibrary\.wiley|ieee\.org|jstor\.org|pubsonline\.informs|misq\.org|aisel\.aisnet|nature\.com|pnas\.org|tandfonline|sagepub|oup\.com|academic\.oup/i;
  const doiOf = (url) => {
    try {
      const m = decodeURIComponent(new URL(url).pathname).match(/10\.\d{4,9}\/[^\s]+/);
      return m ? m[0].replace(/[.,;)\]]+$/, "") : null;
    } catch { return null; }
  };
  function extractGeneric() {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll("a[href]")) {
      if (!SCHOLARLY.test(a.href)) continue;
      const text = clean(a.textContent);
      const doi = doiOf(a.href);
      const isTitle = text.length >= 20 && text.length <= 300 && !/^(https?|www\.|doi:|10\.\d|\[)/i.test(text);
      if (!isTitle && !doi && !/semanticscholar\.org\/paper\//i.test(a.href)) continue;
      const key = isTitle ? "t:" + text.toLowerCase() : "u:" + (doi || a.href);
      if (seen.has(key)) continue;
      seen.add(key);
      const block = a.closest("li, article, tr, div");
      out.push({
        title: isTitle ? text : "",
        url: a.href,
        doi: doi || undefined,
        year: yearOf(block?.textContent?.slice(0, 600)),
        snippet: "",
      });
    }
    return out;
  }

  function extractPapers(tool) {
    let papers = [];
    try {
      if (tool.startsWith("Google Scholar")) papers = extractScholar();
      else if (tool === "Paper Digest") papers = extractPaperDigest();
    } catch (e) { /* adapter drift — fall through */ }
    if (papers.length < 2) {
      const generic = extractGeneric();
      if (generic.length > papers.length) papers = generic;
    }
    return papers.slice(0, MAX_PAPERS);
  }

  // ---------- handoff ----------
  function b64url(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function send(dev) {
    const tool = detectTool();
    const papers = extractPapers(tool);
    if (!papers.length) {
      note("No papers detected on this page yet — run a search first.");
      return;
    }
    const payload = {
      v: 1, src: "extension", tool,
      query: detectQuery(),
      hasRationales: papers.some((p) => p.snippet),
      papers,
    };
    const target = (dev ? DEV_URL : APP_URL) + "#import=" + b64url(JSON.stringify(payload));
    // Named target: every send reuses ONE Paper Trails tab instead of piling
    // up new ones. The app listens for hashchange, so an already-open tab
    // receives the session live; focus() brings it forward.
    const w = window.open(target, dev ? "paper-trails-dev" : "paper-trails");
    try { w?.focus(); } catch { /* popup handling differs per browser */ }
  }

  // ---------- floating button ----------
  let noteT = null;
  function note(msg) {
    let n = document.getElementById("islr-note");
    if (!n) {
      n = document.createElement("div");
      n.id = "islr-note";
      n.style.cssText =
        "position:fixed;bottom:74px;right:18px;z-index:2147483647;background:#201d17;color:#f7f5ef;" +
        "font:13px/1.4 sans-serif;padding:8px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.25);";
      document.body.append(n);
    }
    n.textContent = msg;
    n.style.display = "block";
    clearTimeout(noteT);
    noteT = setTimeout(() => { n.style.display = "none"; }, 3000);
  }

  function mount() {
    if (document.getElementById("islr-send") || !detectTool()) return;
    const btn = document.createElement("button");
    btn.id = "islr-send";
    btn.textContent = "◀ · ▶ Send to Paper Trails";
    btn.title =
      "Detect the papers on this page and import them into Paper Trails " +
      "(⌥-click to send to localhost:5173 for development)";
    btn.style.cssText =
      "position:fixed;bottom:18px;right:18px;z-index:2147483647;cursor:pointer;" +
      "background:#9c6b1c;color:#fff;border:none;border-radius:999px;padding:10px 18px;" +
      "font:600 13.5px/1 sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25);";
    btn.addEventListener("mouseenter", () => { btn.style.background = "#7d5516"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "#9c6b1c"; });
    btn.addEventListener("click", (e) => send(e.altKey));
    document.body.append(btn);
  }

  mount();
  // SPA tools render results after load — re-mount on soft navigations
  new MutationObserver(() => mount()).observe(document.documentElement, { childList: true, subtree: true });
})();
