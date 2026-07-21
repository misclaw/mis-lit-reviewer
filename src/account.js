// Account & sync UI: the nav status button and the account modal.
// The button re-labels itself on sync-state changes via direct DOM updates —
// a full app re-render on every idle↔syncing flip would drop input focus.
import { h, toast, MAC_APP_URL } from "./ui.js";
import * as sync from "./sync.js";

const ago = (t) => {
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  return Math.round(s / 3600) + " h ago";
};

// Sync is automatic once signed in (sync.js pushes on every change, pulls on
// focus + realtime), so the nav needs no manual sync control — just a sign-in /
// sign-out toggle. It relabels itself in place on auth changes so a full app
// re-render (which would drop input focus) isn't needed.
let navBtn = null, navHandlers = null;
function paintAuthBtn(st = sync.getState()) {
  if (!navBtn) return;
  const inn = !!st.user;
  navBtn.textContent = inn ? "Sign out" : "Sign in";
  navBtn.className = "nav-btn nav-auth" + (inn ? " on" : "");
  navBtn.title = inn
    ? `Signed in as ${st.user.email} — your workspace syncs automatically. Click to sign out (your work stays in this browser).`
    : "Sign in to sync your workspace across devices. Optional — the app works fully signed-out.";
  navBtn.onclick = inn ? navHandlers.onSignOut : navHandlers.onSignIn;
}
sync.onState((st) => { if (navBtn?.isConnected) paintAuthBtn(st); });

export function authNavButton(handlers) {
  navHandlers = handlers;
  navBtn = h("button", { class: "nav-btn nav-auth" });
  paintAuthBtn();
  return navBtn;
}

// One-time caution for working without an account: local-only storage is
// honest-to-goodness fragile (browser cleanups, per-browser isolation,
// mobile eviction). Shown once; either choice acknowledges it.
export function storageNoticeModal({ onRegister, onContinue } = {}) {
  const overlay = h("div", { class: "modal-overlay",
    onclick: (e) => { if (e.target === overlay) onContinue?.(); } });
  overlay.append(
    h("div", { class: "acct-card", role: "dialog", "aria-modal": "true", "aria-label": "Where your work is saved" },
      h("div", { class: "onb-h" }, "A quick word about where your work is saved"),
      h("div", { class: "onb-sub" },
        "Right now everything you build here — review streams, imported sessions, settings — lives ",
        h("strong", {}, "only in this browser, on this device"), ". That works, with two honest caveats:"),
      h("ul", { class: "notice-list" },
        h("li", {},
          h("strong", {}, "Browsers can clear it. "),
          "Storage cleanups, privacy tools, or private-browsing windows can silently erase local data. " +
          "Safari on iPhone/iPad in particular may evict data from sites you haven't opened in a while."),
        h("li", {},
          h("strong", {}, "It doesn't follow you. "),
          "Open Paper Trails in a different browser, on your phone, or on another computer, and your work won't be there.")),
      h("div", { class: "onb-sub", style: { marginBottom: "6px" } },
        "A free account fixes both: your workspace syncs privately and can be restored anywhere — it takes about 20 seconds, " +
        "no email verification. Your LLM API keys stay in this browser either way."),
      h("div", { class: "acct-actions" },
        h("button", { class: "btn-ink", onclick: () => onRegister?.() }, "Create a free account"),
        h("button", { class: "btn", onclick: () => onContinue?.() }, "I understand — continue without one")),
      h("div", { class: "acct-note" },
        "Not nagging you again — this is shown once. You can sign up any time from the Sign in button in the top bar, " +
        "and Export data (JSON) in the stream menu is always there for manual backups.")));
  return overlay;
}

// mode "app" (from the nav) | "onboard" (sign in to restore, before onboarding)
export function accountModal({ onClose, onSignedIn } = {}) {
  const overlay = h("div", { class: "modal-overlay",
    onclick: (e) => { if (e.target === overlay) onClose?.(); } });
  const card = h("div", { class: "acct-card", role: "dialog", "aria-modal": "true", "aria-label": "Account & sync" });
  overlay.append(card);
  let busy = null; // "in" | "up" | "out" | "now"
  const draft = { email: "", pass: "" }; // survives repaints while signing in

  const unsub = sync.onState((st) => {
    // A sign-in/up just finished linking: hand control back to the caller
    if ((busy === "in" || busy === "up") && st.user && (st.status === "idle" || st.status === "error")) {
      busy = null; unsub();
      onSignedIn?.();
      return;
    }
    paint(st);
  });
  const close = () => { unsub(); onClose?.(); };

  function paint(st = sync.getState()) {
    const email = h("input", { type: "email", placeholder: "ada@university.edu", autocomplete: "email",
      value: draft.email, oninput: (e) => { draft.email = e.target.value; } });
    const pass = h("input", { type: "password", placeholder: "password (min 6 characters)", autocomplete: "current-password",
      value: draft.pass, oninput: (e) => { draft.pass = e.target.value; } });
    const err = h("div", { class: "acct-err", role: "alert" });
    const go = async (kind) => {
      const e = draft.email.trim(), p = draft.pass;
      if (!e || p.length < 6) { err.textContent = "Enter your email and a password of at least 6 characters."; return; }
      busy = kind; paint();
      try {
        if (kind === "up") {
          const { needsConfirmation } = await sync.signUp(e, p);
          if (needsConfirmation) { busy = null; draft.confirmSent = e; paint(); return; }
          // no confirmation required (autoconfirm) — fall through to wait for link
        } else {
          await sync.signIn(e, p);
        }
        // now wait for the engine to link — the onState hook above closes the loop
      } catch (ex) {
        busy = null; paint();
        const notConfirmed = /not confirmed/i.test(ex.message);
        card.querySelector(".acct-err").textContent = notConfirmed
          ? "Please confirm your email first — click the link we sent, then sign in."
          : (kind === "up" ? "Could not create the account — " : "Could not sign in — ") + ex.message;
      }
    };

    // h() flattens nested child arrays; raw replaceChildren does not
    card.replaceChildren(h("div", {},
      h("div", { class: "onb-h" }, "Account & sync"),
      !st.user ? draft.confirmSent
        ? [ // post-signup: waiting for the emailed confirmation link
            h("div", { class: "onb-sub" },
              "Almost there — we emailed a confirmation link to ",
              h("strong", {}, draft.confirmSent),
              ". Click it to activate your account, then sign in here. " +
              "(Check spam if it's not in your inbox within a minute.)"),
            h("div", { class: "acct-actions" },
              h("button", { class: "btn-ink",
                onclick: () => { draft.confirmSent = null; draft.pass = ""; paint(); } }, "Back to sign in"),
              h("button", { class: "btn", onclick: close }, "Close")),
          ]
        : [
            h("div", { class: "onb-sub" },
              "Optional. One free account keeps your review streams, imported sessions, and settings in sync on every device — browser or Mac app. ",
              h("strong", {}, "API keys never sync"), " — they stay in each browser you enter them in."),
            h("label", { class: "field" }, "Email", email),
            h("label", { class: "field" }, "Password", pass),
            err,
            h("div", { class: "acct-actions" },
              h("button", { class: "btn-ink", disabled: !!busy, onclick: () => go("in") },
                busy === "in" ? "Signing in…" : "Sign in"),
              h("button", { class: "btn", disabled: !!busy, onclick: () => go("up") },
                busy === "up" ? "Creating…" : "Create account"),
              h("button", { class: "btn", onclick: close }, "Close")),
            h("div", { class: "acct-note" },
              "Creating an account emails you a confirmation link — click it, then sign in. " +
              "Keep your password in a password manager (there's no reset yet). " +
              "Sync stores your research data (never keys) in a private row only your account can read."),
            h("div", { class: "acct-mac" },
              "Also available as a native ",
              h("a", { href: MAC_APP_URL, target: "_blank", rel: "noopener" }, "Mac app"),
              " — the same workbench in a desktop window, kept in sync with this account."),
          ]
        : [
            h("div", { class: "onb-sub" }, "Signed in as ", h("strong", {}, st.user.email)),
            h("div", { class: `acct-status${st.status === "error" ? " err" : ""}` },
              st.status === "error" ? "Sync error: " + (st.error || "unknown")
              : st.status === "syncing" || st.status === "linking" ? "Syncing…"
              : "✓ Synced " + (ago(st.lastSyncAt) || "just now")),
            h("div", { class: "acct-actions" },
              h("button", { class: "btn", disabled: !!busy,
                onclick: async () => {
                  busy = "now"; paint();
                  try { await sync.syncNow(); toast("Synced"); }
                  catch (ex) { toast("Sync failed: " + ex.message); }
                  busy = null; paint();
                } }, busy === "now" ? "Syncing…" : "Sync now"),
              h("button", { class: "btn", disabled: !!busy,
                onclick: async () => { busy = "out"; paint(); await sync.signOut(); busy = null; close(); } },
                busy === "out" ? "Signing out…" : "Sign out"),
              h("button", { class: "btn-ink", onclick: close }, "Done")),
            h("div", { class: "acct-note" },
              "Signing out keeps everything on this device — it just stops syncing."),
          ]));
  }

  paint();
  requestAnimationFrame(() => card.querySelector("input, button")?.focus());
  return overlay;
}
