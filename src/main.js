// MIS Lit Reviewer — static entry point. No auth: the app boots straight into
// the search UI. Streams / pins / notes live in this browser (localStorage);
// the header offers Export / Import JSON for backup or moving devices.
import "./style.css";
import { mountApp } from "./app.js";
import { mountBrowse } from "./browse.js";
import { exportStore, importStore } from "./store.js";

const main = document.getElementById("main");
const controls = document.getElementById("data-controls");

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

// ---- tabs: Search (semantic search workbench) | Browse (corpus by date) ----
const views = {};
let browseMounted = false;

function switchTab(id) {
  for (const [k, v] of Object.entries(views)) v.classList.toggle("active", k === id);
  for (const b of document.querySelectorAll("#nav-tabs .tab")) b.classList.toggle("active", b.dataset.tab === id);
  if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
  if (id === "browse" && !browseMounted) { browseMounted = true; mountBrowse(views.browse); }
}

function mountTabs() {
  const nav = document.getElementById("nav-tabs");
  for (const [id, label] of [["search", "Search"], ["browse", "Browse"]]) {
    const b = document.createElement("button");
    b.className = "tab";
    b.dataset.tab = id;
    b.textContent = label;
    b.addEventListener("click", () => switchTab(id));
    nav.append(b);
  }
}

mountDataControls();
main.replaceChildren();
for (const id of ["search", "browse"]) {
  const v = document.createElement("div");
  v.className = "view";
  views[id] = v;
  main.append(v);
}
mountTabs();
mountApp(views.search);
switchTab(location.hash === "#browse" ? "browse" : "search");
window.addEventListener("hashchange", () => {
  const id = location.hash === "#browse" ? "browse" : "search";
  switchTab(id);
});
