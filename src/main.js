// MIS Lit Reviewer — static entry point. No auth: the app boots straight into
// the unified workbench (date-sorted corpus browser that becomes a three-column
// semantic search the moment you type). Streams / pins / notes live in this
// browser (localStorage); the header offers Export / Import JSON for backup.
import "./style.css";
import { mountApp } from "./app.js";
import { exportStore, importStore } from "./store.js";

const DIGEST_URL = "https://mis-digest.misclaw.app";
const LABS_URL = "https://scholar.google.com/scholar_labs/search";
const main = document.getElementById("main");
const controls = document.getElementById("data-controls");

// Erlenmeyer flask — marks the link out to Google Scholar Labs (broad reviews).
const FLASK_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.75h6M10 3v6.4L4.8 18.3A1.5 1.5 0 0 0 6.1 20.6h11.8a1.5 1.5 0 0 0 1.3-2.3L14 9.4V3"/><path d="M7.6 14h8.8"/></svg>';

// ---- theme toggle: no data-theme attribute means "follow the system";
// clicking pins an explicit choice (read before paint in index.html) ----
document.getElementById("theme-toggle").addEventListener("click", () => {
  const current = document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
});

function mountDataControls() {
  const note = document.createElement("span");
  note.className = "muted";
  note.textContent = "Data is stored in this browser";

  const exp = document.createElement("button");
  exp.className = "ghost";
  exp.textContent = "Export JSON";
  exp.addEventListener("click", () => {
    const blob = new Blob([exportStore()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mis-lit-reviewer-export.json";
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  });

  const imp = document.createElement("button");
  imp.className = "ghost";
  imp.textContent = "Import JSON";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "application/json,.json";
  file.hidden = true;
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      importStore(await f.text());
      location.reload(); // simplest way to re-render everything from the new store
    } catch (e) {
      alert("Import failed: " + e.message);
    } finally {
      file.value = "";
    }
  });
  imp.addEventListener("click", () => file.click());

  controls.replaceChildren(note, exp, imp, file);
}

// ---- header links: daily digest, a guide, and an out-link to Scholar Labs ----
function mountNav() {
  const nav = document.getElementById("nav-tabs");

  const guide = Object.assign(document.createElement("button"), {
    className: "nav-link", type: "button", title: "How to use MIS Lit Reviewer",
    innerHTML: '<span aria-hidden="true">?</span> Guide',
  });
  guide.addEventListener("click", openHelp);

  const digest = Object.assign(document.createElement("a"), {
    href: DIGEST_URL, className: "nav-link", title: "Subscribe to the daily email digest of new IS papers",
    innerHTML: '<span aria-hidden="true">✉</span> Daily digest',
  });

  const labs = Object.assign(document.createElement("a"), {
    href: LABS_URL, className: "nav-link", target: "_blank", rel: "noopener",
    title: "Google Scholar Labs — for broad, cross-discipline literature review. This corpus is deliberately IS-focused.",
    innerHTML: FLASK_ICON + " Scholar Labs",
  });

  nav.append(guide, digest, labs);
}

// ---- help / guide modal: purpose + a short how-to, opened from the header ----
const HELP_HTML = `
  <div class="help-card" role="dialog" aria-modal="true" aria-label="How to use MIS Lit Reviewer">
    <button class="help-close" type="button" aria-label="Close">✕</button>
    <h2>How to use MIS Lit Reviewer</h2>
    <p class="help-lead">A fast semantic search over a curated <strong>Information Systems</strong> corpus — the basket journals, the major IS conferences, and IS preprints. It is built to surface relevant work <em>within the IS discipline</em> quickly and reproducibly.</p>
    <p class="help-note"><span aria-hidden="true">🧪</span> Doing a broad, cross-discipline review? Reach for <a href="${LABS_URL}" target="_blank" rel="noopener">Google Scholar Labs</a> (the flask in the header) or general tools — this corpus is deliberately IS-focused, which is exactly what makes in-discipline search here so quick.</p>
    <h3>The basics</h3>
    <ol class="help-steps">
      <li><strong>Browse</strong> — leave the search box empty to scan the corpus by date. Narrow it with the <strong>venue chips</strong> (click to include / exclude an outlet — your selection is remembered) and the year filters.</li>
      <li><strong>Search</strong> — type a research question in plain language and press Enter. Three columns — <strong>Journals · Conferences · Preprints</strong> — rank papers by meaning, not keywords.</li>
      <li><strong>Streams</strong> — click <strong>+ New query stream</strong> to open a saved line of inquiry. Every search you run auto-saves as that stream's snapshot and lands in its <strong>⟲ History</strong> — click any earlier query to roll back to it.</li>
      <li><strong>Pin &amp; collect</strong> — pin (☆) the papers worth keeping; they gather under <strong>★ Pinned papers</strong> across all of your streams.</li>
      <li><strong>Add &amp; export</strong> — paste a DOI, arXiv id, or BibTeX to attach a paper to a stream, then export the whole stream as <strong>.bib</strong>.</li>
    </ol>
    <p class="help-foot">Everything lives in this browser — nothing is uploaded. Use <strong>Export / Import JSON</strong> in the header to back up or move between devices.</p>
  </div>`;

let helpEl = null;
function openHelp() {
  if (!helpEl) {
    helpEl = document.createElement("div");
    helpEl.className = "help-overlay";
    helpEl.innerHTML = HELP_HTML;
    helpEl.addEventListener("click", (e) => { if (e.target === helpEl || e.target.closest(".help-close")) closeHelp(); });
    document.body.append(helpEl);
  }
  helpEl.classList.add("open");
  document.addEventListener("keydown", onHelpKey);
}
function closeHelp() {
  helpEl?.classList.remove("open");
  document.removeEventListener("keydown", onHelpKey);
}
function onHelpKey(e) { if (e.key === "Escape") closeHelp(); }

mountDataControls();
mountNav();
main.replaceChildren();
const view = document.createElement("div");
view.className = "view active";
main.append(view);
mountApp(view);
