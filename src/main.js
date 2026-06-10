// MIS Lit Reviewer — static entry point. No auth: the app boots straight into
// the search UI. Streams / pins / notes live in this browser (localStorage);
// the header offers Export / Import JSON for backup or moving devices.
import "./style.css";
import { mountApp } from "./app.js";
import { exportStore, importStore } from "./store.js";

const main = document.getElementById("main");
const controls = document.getElementById("data-controls");

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

mountDataControls();
main.replaceChildren();
mountApp(main);
