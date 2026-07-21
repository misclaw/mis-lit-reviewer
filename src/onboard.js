// Onboarding wizard (first run) and Settings editor (same component in a
// modal). Five steps: workspace profile → interests → philosophy & methods →
// target journals → LLM API keys. The profile here is local; the optional
// sync account (account.js) is separate, and keys never leave this browser.
import { h } from "./ui.js";
import { getProfile, getPrefs, saveOnboarding } from "./store.js";
import { PROVIDERS, verifyKey } from "./llm.js";
import { PRIMARY_JOURNALS, SECONDARY_JOURNALS, CONFERENCES, venueAbbr } from "./pipeline.js";

const TOPICS = [
  "AI & algorithmic advice", "Trust in technology", "Digital platforms", "IT governance",
  "E-commerce", "Dark side of IT", "Digital transformation", "Health IT",
  "Open source & communities", "Future of work",
];
const PHILS = ["Positivist", "Interpretivist", "Critical realist", "Pragmatist", "Design science"];
const METHODS = [
  "Quantitative / survey", "Experiment", "Econometrics / secondary data",
  "Qualitative / case study", "Mixed methods", "Design science / DSR", "Meta-analysis / review",
];
const STEPS = ["Workspace", "Interests", "Philosophy", "Journals", "API keys"];
// The API-keys step is the last one; callers deep-link here when a key is missing.
export const KEYS_STEP = STEPS.length - 1;

// mode: "onboard" (first run, full page) | "edit" (settings modal)
// initialStep: which step to open on (edit mode deep-links here, e.g. API keys)
export function renderOnboard(container, { mode = "onboard", onDone, onCancel, initialStep = 0 } = {}) {
  const draft = {
    profile: getProfile(),
    prefs: getPrefs(),
    step: Math.min(Math.max(0, initialStep | 0), STEPS.length - 1),
    verifying: {},  // provider → "busy" | "ok" | "err"
    verifyErr: {},  // provider → last verification error message
    keyWarn: null,  // footer warning after a failed finish-time verification
    allowUnverified: false, // second click on "Start anyway" proceeds
  };
  for (const [prov, ok] of Object.entries(draft.prefs.verified || {})) {
    if (ok && draft.prefs.keys[prov]) draft.verifying[prov] = "ok";
  }
  const baseline = JSON.stringify({ profile: draft.profile, prefs: draft.prefs });

  const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const anyKey = () => Object.values(draft.prefs.keys).some((k) => k && k.trim());

  function chipRow(values, selected, onPick, { single = false, accent = "" } = {}) {
    return h("div", { class: "chips" },
      values.map((v) => {
        const label = typeof v === "object" ? v.label : v;
        const val = typeof v === "object" ? v.value : v;
        const on = single ? selected === val : selected.includes(val);
        return h("button", {
          class: `chip${on ? " on" : ""}${on && accent ? " " + accent : ""}`,
          "aria-pressed": String(on),
          onclick: () => { onPick(val); render(); },
        }, label);
      }));
  }

  function stepBody() {
    const p = draft.prefs;
    if (draft.step === 0) return [
      h("div", { class: "onb-h" }, mode === "edit" ? "Your workspace" : "Set up your workspace"),
      h("div", { class: "onb-sub" },
        "Runs in your browser — no account required. An optional free account (⇅ in the top bar later) " +
        "syncs your workspace across devices. Open-source: audit the code and run it locally if you prefer."),
      h("label", { class: "field" }, "Name",
        h("input", { value: draft.profile.name, placeholder: "Ada Scholar",
          oninput: (e) => { draft.profile.name = e.target.value; } })),
      h("label", { class: "field" }, "Email (optional — only stored locally)",
        h("input", { value: draft.profile.email, placeholder: "ada@university.edu",
          oninput: (e) => { draft.profile.email = e.target.value; } })),
      h("div", { class: "privacy-note" },
        h("strong", {}, "Privacy — "),
        "we keep your ", h("strong", {}, "settings only"), ", in this browser. Your research activity — queries, papers viewed, review streams — is never collected or sent anywhere except the APIs you call with your own keys."),
    ];
    if (draft.step === 1) return [
      h("div", { class: "onb-h" }, "Your research interests"),
      h("div", { class: "onb-sub" }, "Used to seed query refinement and relevance ranking."),
      chipRow(TOPICS, p.topics, (v) => { p.topics = toggle(p.topics, v); }),
      h("label", { class: "field", style: { marginTop: "18px" } }, "In your own words",
        h("textarea", { rows: 3, value: p.interests,
          placeholder: "e.g. How organizations and individuals come to trust, adopt, and appropriately rely on AI-based systems…",
          oninput: (e) => { p.interests = e.target.value; } })),
    ];
    if (draft.step === 2) return [
      h("div", { class: "onb-h" }, "Philosophy & methodology"),
      h("div", { class: "onb-sub" }, "Shapes how rationales are written and which papers get surfaced."),
      h("div", { class: "group-lab" }, "Research philosophy"),
      chipRow(PHILS, p.phil, (v) => { p.phil = p.phil === v ? "" : v; }, { single: true }),
      h("div", { class: "group-lab" }, "Preferred methodologies ", h("span", { class: "opt" }, "(pick any)")),
      chipRow(METHODS, p.methods, (v) => { p.methods = toggle(p.methods, v); }),
    ];
    if (draft.step === 3) return [
      h("div", { class: "onb-h" }, "Target journals & venues"),
      h("div", { class: "onb-sub" }, "Primary venues drive the prestige-ranking option; the corpus covers all of them."),
      h("div", { class: "group-lab" }, "Primary — IS journals"),
      chipRow(PRIMARY_JOURNALS.map((v) => ({ value: v, label: `${venueAbbr(v)} · ${v}` })), p.prims,
        (v) => { p.prims = toggle(p.prims, v); }, { accent: "wi" }),
      h("div", { class: "group-lab" }, "Secondary — adjacent journals"),
      chipRow(SECONDARY_JOURNALS, p.secs, (v) => { p.secs = toggle(p.secs, v); }, { accent: "wi" }),
      h("div", { class: "group-lab" }, "Conference proceedings"),
      chipRow(CONFERENCES, p.confs, (v) => { p.confs = toggle(p.confs, v); }, { accent: "wi" }),
    ];
    // step 4 — API keys
    return [
      h("div", { class: "onb-h" }, "Connect an LLM provider ", h("span", { class: "opt" }, "(optional)")),
      h("div", { class: "onb-sub" },
        "The AI features (query refinement, reranking, rationales, web search) need one key, verified before you start. " +
        "No key? You can still start and import papers from external tools via the browser extension — " +
        "add a key any time in Settings. Keys are stored in this browser and sent only to their provider."),
      Object.keys(PROVIDERS).map((prov) => keyRow(prov)),
      h("button", { class: `outside-toggle${p.outsideEnabled ? " on" : ""}`,
        "aria-pressed": String(!!p.outsideEnabled),
        onclick: () => { p.outsideEnabled = !p.outsideEnabled; render(); } },
        h("div", { class: "box" }, p.outsideEnabled ? "✓" : ""),
        h("div", {},
          h("div", { class: "big" }, "Auto-run the outside-IS web search with each review"),
          h("div", { class: "small" },
            "Either way you can run it manually on the main page — or import results from Google Scholar Labs, Asta, Paper Digest, or SciSpace via the browser extension."))),
      h("div", { class: "privacy-note" },
        h("strong", {}, "Worried about pasting a key into a website? "),
        "Fair. This project is open-source — review the code and run it locally instead. We collect settings only, never your search activity."),
    ];
  }

  function keyRow(prov) {
    const p = draft.prefs;
    const meta = PROVIDERS[prov];
    const state = draft.verifying[prov];
    const has = !!(p.keys[prov] && p.keys[prov].trim());
    const btnClass = state === "busy" ? "btn-verify" :
      state === "ok" ? "btn-verify ok" :
      state === "err" ? "btn-verify err" :
      has ? "btn-verify ready" : "btn-verify";
    const btnLabel = state === "busy" ? "Verifying…" : state === "ok" ? "Verified ✓" : state === "err" ? "Retry" : "Verify";
    return h("div", { class: "key-row" },
      h("div", { class: "kname" }, meta.label),
      h("input", { type: "password", value: p.keys[prov], placeholder: meta.ph,
        "aria-label": meta.label + " API key",
        oninput: (e) => {
          p.keys[prov] = e.target.value;
          if (draft.verifying[prov]) { delete draft.verifying[prov]; p.verified[prov] = false; }
          delete draft.verifyErr[prov];
          draft.allowUnverified = false; draft.keyWarn = null;
          // live-sync the affordances without a re-render (which would drop focus):
          // this row's Verify button, and the footer's label
          const vb = e.target.closest(".key-row")?.querySelector(".btn-verify");
          if (vb) {
            vb.className = e.target.value.trim() ? "btn-verify ready" : "btn-verify";
            vb.textContent = "Verify";
          }
          e.target.closest(".key-row")?.querySelector(".key-err")?.remove();
          const foot = container.querySelector(".onb-foot .btn-ink");
          if (foot && draft.step === STEPS.length - 1) foot.textContent = finishLabel();
        } }),
      h("button", { class: btnClass, disabled: state === "busy",
        onclick: async (e) => {
          if (!has && !p.keys[prov].trim()) return;
          draft.verifying[prov] = "busy"; render();
          try {
            await verifyKey(prov, p.keys[prov]);
            draft.verifying[prov] = "ok"; p.verified[prov] = true;
            delete draft.verifyErr[prov];
          } catch (err) {
            draft.verifying[prov] = "err"; p.verified[prov] = false;
            draft.verifyErr[prov] = err.message;
            console.warn(err);
          }
          render();
        } }, btnLabel),
      state === "err" && draft.verifyErr[prov] &&
        h("div", { class: "key-err", role: "alert" }, "Key rejected — " + draft.verifyErr[prov]));
  }

  function finish() {
    // default pipeline provider: first verified key, else first entered key
    const p = draft.prefs;
    const provs = Object.keys(PROVIDERS);
    p.provider = provs.find((x) => p.verified[x] && p.keys[x].trim())
      || provs.find((x) => p.keys[x].trim()) || p.provider;
    saveOnboarding(draft.profile, p);
    onDone?.();
  }

  function finishLabel() {
    if (mode === "edit") return draft.allowUnverified ? "Save anyway" : "Save settings";
    if (draft.allowUnverified) return "Start anyway →";
    if (!anyKey()) return "Start without a key →";
    return "Start reviewing →";
  }

  // Finish gate: entered keys get verified before completion so a bad key
  // fails HERE, with a diagnosis — not minutes later inside a review run.
  // A second click ("Start anyway") lets the user proceed regardless.
  async function tryFinish() {
    const entered = Object.keys(PROVIDERS).filter((x) => draft.prefs.keys[x]?.trim());
    const unverified = entered.filter((x) => draft.verifying[x] !== "ok");
    if (!unverified.length || draft.allowUnverified) { finish(); return; }
    draft.keyWarn = null;
    for (const x of unverified) draft.verifying[x] = "busy";
    render();
    const failed = [];
    await Promise.all(unverified.map(async (x) => {
      try {
        await verifyKey(x, draft.prefs.keys[x]);
        draft.verifying[x] = "ok"; draft.prefs.verified[x] = true;
        delete draft.verifyErr[x];
      } catch (err) {
        draft.verifying[x] = "err"; draft.prefs.verified[x] = false;
        draft.verifyErr[x] = err.message;
        failed.push(PROVIDERS[x].label);
      }
    }));
    if (!failed.length) { finish(); return; }
    draft.allowUnverified = true;
    draft.keyWarn = `The ${failed.join(" and ")} key ${failed.length === 1 ? "was" : "were"} rejected ` +
      `(details above) — fix it, or click “${finishLabel()}” to continue with a key that will likely fail.`;
    render();
  }

  // Step navigation, shared by the Back/Continue buttons and the arrow keys.
  // Arrow keys only move between steps — they never finish/submit.
  function goPrev() { if (draft.step > 0) { draft.step--; render(); } }
  function goNext() { if (draft.step < STEPS.length - 1) { draft.step++; render(); } }

  function render() {
    const isLast = draft.step === STEPS.length - 1;
    const busy = Object.values(draft.verifying).includes("busy");
    container.replaceChildren(
      h("div", { class: "onb-wrap" },
        mode === "onboard" && h("div", { class: "onb-title" },
          h("div", { class: "t" }, "Paper Trails"),
          h("div", { class: "s" }, "Backward · Main · Forward — a structured literature review workbench for Information Systems scholars")),
        h("div", { class: "onb-progress" },
          h("div", { class: "onb-progress-head" },
            h("div", { class: "onb-step-name" }, STEPS[draft.step]),
            h("div", { class: "onb-step-count" }, `Step ${draft.step + 1} / ${STEPS.length}`)),
          h("div", { class: "onb-progress-track" },
            STEPS.map((label, i) =>
              h("div", {
                class: `onb-seg${i < draft.step ? " done" : i === draft.step ? " now" : ""}`,
                title: label,
                // let users jump back to a completed step, not forward
                onclick: i < draft.step ? () => { draft.step = i; render(); } : undefined,
              })))),
        h("div", { class: "onb-card" },
          h("div", { class: "onb-body" },
            stepBody(),
            isLast && draft.keyWarn && h("div", { class: "key-warn", role: "alert" }, draft.keyWarn)),
          h("div", { class: "onb-foot" },
            mode === "edit" && h("button", { class: "btn", onclick: () => onCancel?.() }, "Cancel"),
            h("button", { class: "btn", disabled: draft.step === 0,
              onclick: goPrev }, "Back"),
            h("button", { class: "btn-ink", disabled: busy,
              onclick: () => {
                if (!isLast) { draft.step++; render(); }
                else tryFinish();
              } },
              isLast ? (busy ? "Verifying…" : finishLabel()) : "Continue")))));
  }

  render();
  return {
    isDirty: () => JSON.stringify({ profile: draft.profile, prefs: draft.prefs }) !== baseline,
    prev: goPrev,
    next: goNext,
  };
}
