// Backward · Main · Forward — entry point and app shell.
// Owns: theme, routing (onboarding ↔ app), the top nav (stream switcher,
// Backward·Main·Forward crumbs, settings), the floating direction arrows,
// the inbound fragment receiver, and the render loop. Views live in
// review.js (main mode) and graph.js (backward/forward modes).
import "./style.css";
import { h, toast, MAC_APP_URL } from "./ui.js";
import * as store from "./store.js";
import { renderOnboard, KEYS_STEP } from "./onboard.js";
import { renderReview } from "./review.js";
import { renderGraph, ensureGraph } from "./graph.js";
import { parseInbound } from "./handoff.js";
import { startTour } from "./tour.js";
import * as sync from "./sync.js";
import { authNavButton, accountModal, storageNoticeModal } from "./account.js";

const root = document.getElementById("app");

const app = {
  // welcome (front door: sign in vs guest) → onboard (wizard) → app
  screen: store.isOnboarded() ? "app" : "welcome",
  streamId: store.getLastStreamId(), // resume where the user left off
  mode: "main", // main | back | fwd
  streamOpen: false,
  prefsOpen: false,
  prefsStep: 0,               // which step the Settings modal opens on (deep-link)
  prefsFocusProvider: null,   // which provider's key input to focus on open (deep-link)
  accountOpen: false,
  noticeOpen: false,          // one-time local-storage caution (guest path)
  status: null, // public/data/status.json — corpus stats for the idle card
  runs: new Map(), // streamId → runtime (non-persisted) pipeline state
};

function runFor(id) {
  if (!app.runs.has(id)) {
    app.runs.set(id, {
      isRunning: false, isStage: 0, isError: null, refineNote: null, isProgress: null,
      outRunning: false, outStage: 0, outError: null, outProgress: null,
      graph: { back: { running: false, stage: 0, error: null, sel: null },
               fwd: { running: false, stage: 0, error: null, sel: null } },
    });
  }
  return app.runs.get(id);
}

function currentStream() {
  let streams = store.listStreams();
  if (!streams.length) {
    const s = store.createStream("Untitled review stream");
    app.streamId = s.id;
    store.setLastStreamId(s.id);
    return s;
  }
  let s = streams.find((x) => x.id === app.streamId);
  if (!s) {
    // no remembered selection (or it was deleted) — fall back to the most
    // recently touched stream, so returning from the extension or a reload
    // lands on the recent work, not the oldest stream
    s = streams.reduce((a, b) => ((b.updated_at || "") > (a.updated_at || "") ? b : a));
    app.streamId = s.id;
    store.setLastStreamId(s.id);
  }
  // NOTE: don't persist on the found path — currentStream runs on every
  // render (including renders triggered by other tabs via the storage event),
  // and writing here would clobber a selection just made in another tab
  return store.getStream(s.id);
}

// ---- theme (shared mc-theme cookie across *.misclaw.app; pre-paint reader
// in index.html applies it before first paint) ----
function setTheme(next) {
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch { /* private mode */ }
  try {
    let c = "mc-theme=" + next + ";path=/;max-age=31536000;samesite=lax";
    if (location.hostname === "misclaw.app" || location.hostname.endsWith(".misclaw.app")) {
      c += ";domain=.misclaw.app";
    }
    if (location.protocol === "https:") c += ";secure";
    document.cookie = c;
  } catch { /* ignore */ }
}
function toggleTheme() {
  const current = document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  setTheme(current === "dark" ? "light" : "dark");
}

// ---- actions shared by views ----
const actions = {
  goMode(m) {
    const stream = currentStream();
    if (m !== "main" && !stream.within?.length) return; // arrows gated on a finished review
    app.mode = m;
    app.streamOpen = false;
    render();
    if (m === "back" || m === "fwd") ensureGraph(ctx(), m);
  },
};

function ctx() {
  const stream = currentStream();
  return { app, stream, run: runFor(stream.id), actions, rerender: render };
}

// ---- top navigation ----
const SUN = `<svg class="mc-icon-sun" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`;
const MOON = `<svg class="mc-icon-moon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

function themeButton() {
  const b = h("button", { class: "nav-btn mc-theme", title: "Toggle light / dark mode", onclick: toggleTheme });
  b.innerHTML = SUN + MOON;
  return b;
}

function streamMenu(stream) {
  const streams = store.listStreams();
  const file = h("input", { type: "file", accept: "application/json,.json", hidden: true,
    onchange: async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        const info = store.previewImport(text);
        const nStreams = store.listStreams().length;
        const nSessions = store.listSessions().length;
        const ok = confirm(
          `Import “${f.name}”` +
          (info.exported_at ? ` (exported ${info.exported_at.slice(0, 10)})` : "") + `?\n\n` +
          `This REPLACES the current workspace — ${nStreams} stream${nStreams === 1 ? "" : "s"}, ` +
          `${nSessions} captured session${nSessions === 1 ? "" : "s"} — with the file's contents ` +
          `(${info.streams} stream${info.streams === 1 ? "" : "s"}, ${info.sessions} session${info.sessions === 1 ? "" : "s"}).\n\n` +
          `Your API keys are kept as they are. The current workspace is saved as a backup, ` +
          `restorable from this menu.`);
        if (!ok) return;
        store.importStore(text);
        location.reload();
      } catch (err) { toast("Import failed: " + err.message); }
    } });
  return h("div", { class: "stream-menu" },
    h("div", { class: "menu-label" }, "Review streams"),
    streams.map((s) =>
      h("div", { class: "row" },
        h("button", { class: `stream-item${s.id === stream.id ? " on" : ""}`,
          onclick: () => {
            app.streamId = s.id; store.setLastStreamId(s.id);
            app.streamOpen = false; app.mode = "main"; render();
          } },
          s.name),
        streams.length > 1 && h("button", { class: "stream-del", title: "Delete stream",
          onclick: () => {
            if (!confirm(`Delete review stream “${s.name}”?`)) return;
            store.deleteStream(s.id);
            app.runs.delete(s.id);
            if (app.streamId === s.id) app.streamId = null;
            render();
          } }, "✕"))),
    h("button", { class: "stream-add",
      onclick: () => {
        const s = store.createStream("Untitled review stream " + (streams.length + 1));
        app.streamId = s.id; store.setLastStreamId(s.id);
        app.streamOpen = false; app.mode = "main";
        render();
      } }, "+ New review stream"),
    h("button", { class: "stream-add", style: { borderTop: "none", color: "var(--muted)", fontWeight: 400 },
      onclick: () => {
        const blob = new Blob([store.exportStore()], { type: "application/json" });
        const a = h("a", { href: URL.createObjectURL(blob), download: "is-lit-review-export.json" });
        document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
      } }, "Export data (JSON — no API keys)"),
    h("button", { class: "stream-add", style: { borderTop: "none", color: "var(--muted)", fontWeight: 400 },
      onclick: () => file.click() }, "Import data (JSON)"),
    store.hasImportBackup() && h("button", {
      class: "stream-add", style: { borderTop: "none", color: "var(--muted)", fontWeight: 400 },
      onclick: () => {
        if (!confirm("Restore the workspace as it was before the last import? The imported data will be discarded.")) return;
        try { store.restoreImportBackup(); location.reload(); }
        catch (err) { toast("Restore failed: " + err.message); }
      } }, "Restore pre-import backup"),
    file);
}

function nav(stream) {
  const ready = !!stream.within?.length;
  return h("div", { class: "nav" },
    h("div", { class: "nav-inner" },
      h("div", { class: "wordmark" }, "Paper Trails"),
      h("div", { class: "stream-wrap" },
        h("button", { class: "stream-btn", onclick: () => { app.streamOpen = !app.streamOpen; render(); } },
          h("span", { class: "dot" }),
          h("span", { class: "name" }, stream.name),
          h("span", { class: "caret" }, "▾")),
        app.streamOpen && streamMenu(stream)),
      h("div", { class: "nav-spacer" }),
      h("div", { class: "crumbs" },
        [["Backward", "back"], ["Main", "main"], ["Forward", "fwd"]].map(([label, m]) =>
          h("button", { class: `crumb${app.mode === m ? " on" : ""}`,
            disabled: m !== "main" && !ready,
            onclick: () => actions.goMode(m) }, label))),
      h("div", { class: "nav-spacer" }),
      // Signed in, sync is automatic and the "Sign out" button says as much, so
      // the passive status chip only earns its place signed-out — as the
      // local-only reassurance.
      !sync.getState().user &&
        h("div", { class: "privacy",
          title: "Your research activity — questions, streams, results — is stored only in this browser. " +
            "AI requests (your question + researcher profile) go directly to the provider you chose, with your key. " +
            "Production pages load Google Analytics for anonymous page-view stats." },
          h("span", { class: "dot" }), "Research data stays in this browser"),
      // Keep the action controls together so the theme toggle can't wrap to a
      // second line on its own — the whole group moves as a unit if it must.
      h("div", { class: "nav-actions" },
        authNavButton({
          onSignIn: () => { app.accountOpen = true; render(); },
          onSignOut: async () => {
            try { await sync.signOut(); toast("Signed out — your work stays in this browser"); }
            catch (e) { toast("Sign out failed: " + e.message); }
            render();
          },
        }),
        h("button", { class: "nav-btn nav-help", title: "How this works — take the quick tour",
          onclick: () => startTour(ctx()) }, "?"),
        h("button", { class: "nav-btn nav-prefs", title: "Settings",
          onclick: () => { app.prefsOpen = true; app.prefsStep = 0; app.prefsFocusProvider = null; render(); } },
          "Settings"),
        themeButton())));
}

function arrows(stream) {
  const ready = !!stream.within?.length;
  const mk = (side, glyph, target, tip) =>
    h("button", {
      class: `arrow-btn ${side}${ready ? " enabled" : ""}`,
      title: ready ? tip : "Run a main review first",
      onclick: () => { if (ready) actions.goMode(target); },
    }, glyph);
  if (app.mode === "main") return [
    mk("left", "◀", "back", "Go backward — papers cited by the main set"),
    mk("right", "▶", "fwd", "Go forward — papers citing the main set"),
  ];
  return [
    mk("left", "◀", app.mode === "fwd" ? "main" : "back", app.mode === "fwd" ? "Return to main review" : "Go backward"),
    mk("right", "▶", app.mode === "back" ? "main" : "fwd", app.mode === "back" ? "Return to main review" : "Go forward"),
  ];
}

// Escape works no matter where focus sits (document-level listener; re-added
// idempotently on each render, removed when the modal closes).
let prefsKeyHandler = null;
function setPrefsKeyHandler(fn) {
  if (prefsKeyHandler) document.removeEventListener("keydown", prefsKeyHandler);
  prefsKeyHandler = fn;
  if (fn) document.addEventListener("keydown", fn);
}

function prefsModal() {
  // Backdrop click and Escape both go through the dirty check — dismissing
  // the modal must never silently discard edits.
  const tryClose = () => {
    if (api.isDirty() && !confirm("Discard unsaved settings changes?")) return;
    app.prefsOpen = false; render();
  };
  const overlay = h("div", { class: "modal-overlay",
    onclick: (e) => { if (e.target === overlay) tryClose(); } });
  const wrap = h("div", { role: "dialog", "aria-modal": "true", "aria-label": "Settings" });
  overlay.append(wrap);
  const api = renderOnboard(wrap, {
    mode: "edit",
    initialStep: app.prefsStep,
    onDone: () => { app.prefsOpen = false; toast("Settings saved"); render(); },
    onCancel: tryClose,
  });
  // Escape closes; ← / → walk the steps — but never while the caret is in a
  // text field or a select (there the arrows belong to the control itself).
  setPrefsKeyHandler((e) => {
    if (e.key === "Escape") { tryClose(); return; }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    e.preventDefault();
    (e.key === "ArrowLeft" ? api.prev : api.next)();
  });
  // Deep-linked from a keyless provider chip: land the caret in THAT provider's
  // key input (and flash its row) rather than the generic first field.
  requestAnimationFrame(() => {
    const target = app.prefsFocusProvider &&
      wrap.querySelector(`.key-row input[data-prov="${app.prefsFocusProvider}"]`);
    if (target) {
      target.focus();
      const row = target.closest(".key-row");
      row?.classList.add("flash");
      setTimeout(() => row?.classList.remove("flash"), 1400);
    } else {
      wrap.querySelector("input, select, textarea, button")?.focus();
    }
  });
  return overlay;
}

// ---- render loop ----
function accountOverlay() {
  const done = () => {
    app.accountOpen = false;
    // A signed-in account may already carry an onboarded workspace (restore) —
    // land in the app; a brand-new sign-in still needs the wizard.
    if (store.isOnboarded()) app.screen = "app";
    else if (app.screen === "welcome") app.screen = "onboard";
    render();
  };
  return accountModal({ onClose: done, onSignedIn: done });
}

// The one-time "your work lives in this browser" caution, shown when a guest
// chooses to continue without an account. Either choice acknowledges it.
function noticeOverlay() {
  const ack = () => { store.markStorageNoticeSeen(); app.noticeOpen = false; };
  return storageNoticeModal({
    onRegister: () => { ack(); app.accountOpen = true; render(); },
    onContinue: () => {
      ack();
      if (app.screen === "welcome") app.screen = "onboard"; // guest → wizard
      render();
      if (app.screen === "app" && !store.isTourSeen()) startTour(ctx());
    },
  });
}

// Front door: sign in / register (sync) vs continue as guest (local only).
function welcomeScreen() {
  return h("div", { class: "welcome" },
    h("div", { class: "welcome-inner" },
      h("div", { class: "welcome-brand" },
        h("div", { class: "wb-title" }, "Paper Trails"),
        h("div", { class: "wb-tag" },
          "Backward · Main · Forward — a structured literature-review workbench for Information Systems scholars")),
      h("div", { class: "welcome-choices" },
        h("button", { class: "welcome-card primary",
          onclick: () => { app.accountOpen = true; render(); } },
          h("div", { class: "wc-title" }, "Sign in  ·  Create account"),
          h("div", { class: "wc-sub" }, "Sync your workspace across every device — browser and Mac app"),
          h("div", { class: "wc-go" }, "→")),
        h("button", { class: "welcome-card",
          onclick: beginGuest },
          h("div", { class: "wc-title" }, "Continue as guest"),
          h("div", { class: "wc-sub" }, "Start right away — your work stays in this browser"),
          h("div", { class: "wc-go" }, "→"))),
      h("a", { class: "welcome-mac", href: MAC_APP_URL, target: "_blank", rel: "noopener" },
        h("img", { class: "mac-glyph", src: (import.meta.env.BASE_URL || "/") + "misclaw.png",
          alt: "", width: 34, height: 34 }),
        h("span", {},
          h("strong", {}, "Prefer a native window? Get Paper Trails for Mac"),
          h("span", { class: "mac-sub" }, "A desktop app that stays signed in and syncs with your browser — build it from the repo ↗"))),
      h("div", { class: "welcome-foot" }, "Open source · bring your own LLM keys · no tracking")));
}

function beginGuest() {
  if (store.isStorageNoticeSeen()) { app.screen = "onboard"; render(); return; }
  app.noticeOpen = true; // notice → onContinue advances welcome → onboard
  render();
}

function render() {
  // A background sync restore can flip the workspace to onboarded while we're
  // still on the front door — jump straight into the app when that happens.
  if (app.screen !== "app" && store.isOnboarded()) app.screen = "app";

  if (app.screen === "welcome") {
    root.replaceChildren(...[
      welcomeScreen(),
      app.accountOpen ? accountOverlay() : null,
      app.noticeOpen ? noticeOverlay() : null,
    ].filter(Boolean));
    return;
  }
  if (app.screen === "onboard") {
    const wrap = h("div");
    renderOnboard(wrap, {
      mode: "onboard",
      onDone: () => {
        app.screen = "app";
        if (!store.listStreams().length) store.createStream("Untitled review stream");
        render();
        if (!store.isTourSeen()) startTour(ctx()); // first run → offer the tour
      },
    });
    root.replaceChildren(...[
      wrap,
      h("button", { class: "onb-signin",
        onclick: () => { app.accountOpen = true; render(); } },
        "Already use Paper Trails? Sign in to restore your workspace"),
      app.accountOpen ? accountOverlay() : null,
    ].filter(Boolean));
    return;
  }
  const stream = currentStream();
  const c = ctx();
  if (!app.prefsOpen) setPrefsKeyHandler(null);
  root.replaceChildren(...[
    nav(stream),
    ...arrows(stream),
    app.mode === "main" ? renderReview(c) : renderGraph(c, app.mode),
    app.prefsOpen ? prefsModal() : null,
    app.accountOpen ? accountOverlay() : null,
    app.noticeOpen ? noticeOverlay() : null,
  ].filter(Boolean));
}

// ---- boot ----
// Inbound handoff (#import= from the extension, #add= from reference-viewer).
// The extension reuses one named app tab, so later sends arrive as pure hash
// changes on an already-running app — receive those live, without a reload.
function receiveHandoff({ rerender = false } = {}) {
  const rec = parseInbound(location.hash);
  if (!rec) return false;
  history.replaceState(null, "", location.pathname + location.search);
  const row = store.addSession(rec);
  toast(`Received ${row.papers.length} papers from ${row.tool} — see External tools under Outside IS`);
  if (app.screen === "app" && rerender) {
    app.mode = "main";
    render();
    document.querySelector(".ext-card")?.scrollIntoView({ block: "center" });
  }
  return true;
}
const bootHandoff = receiveHandoff();
window.addEventListener("hashchange", () => receiveHandoff({ rerender: true }));

// Another app tab changed the store (captured session, finished review, edited
// prefs) — refresh this one. Skipped mid-onboarding / with the settings
// modal open so in-progress edits aren't clobbered; the store cache is already
// invalidated, so the next render picks the changes up regardless.
store.onExternalChange(() => {
  // A sync restore (from sign-in on the front door) can make us onboarded —
  // advance into the app even from welcome/onboard.
  if (app.screen !== "app" && store.isOnboarded()) { app.screen = "app"; render(); return; }
  if (app.screen === "app" && !app.prefsOpen && !app.accountOpen) render();
});

// Cloud sync (no-op unless the user signs in; restores a saved session on boot)
sync.start();

// Existing local-only users get the storage caution once too — but only after
// the session restore settles, so signed-in users never see a false alarm.
sync.ready.then(() => {
  if (app.screen === "app" && !sync.getState().user && !store.isStorageNoticeSeen()
      && !app.noticeOpen && !app.accountOpen) {
    app.noticeOpen = true;
    render();
  }
});

fetch((import.meta.env.BASE_URL || "./") + "data/status.json")
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => { if (j) { app.status = j; if (app.mode === "main") render(); } })
  .catch(() => { /* stats card shows placeholders */ });

render();
// A fresh tab opened by the extension: after the boot render (which already
// restored the last active stream), bring the External-tools panel into view.
if (bootHandoff && app.screen === "app") {
  requestAnimationFrame(() =>
    document.querySelector(".ext-card")?.scrollIntoView({ block: "center" }));
}
