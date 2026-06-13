// MIS Lit Reviewer — static entry point. No auth: the app boots straight into
// the unified workbench (date-sorted corpus browser that becomes a three-column
// semantic search the moment you type). Streams / pins / notes live in this
// browser (localStorage); the header offers Export / Import JSON for backup.
import "./style.css";
import { mountApp } from "./app.js";
import { exportStore, importStore } from "./store.js";

const DIGEST_URL = "https://mis-digest.misclaw.app";
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

// ---- header link to the separate daily-digest subscription site ----
function mountNav() {
  const nav = document.getElementById("nav-tabs");
  nav.append(Object.assign(document.createElement("a"), {
    href: DIGEST_URL, className: "nav-link", title: "Subscribe to the daily email digest of new IS papers",
    innerHTML: '<span aria-hidden="true">✉</span> Daily digest',
  }));
}

mountDataControls();
mountNav();
main.replaceChildren();
const view = document.createElement("div");
view.className = "view active";
main.append(view);
mountApp(view);
