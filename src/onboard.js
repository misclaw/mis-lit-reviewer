// Onboarding wizard (first run) and Preferences editor (same component in a
// modal). Five steps: workspace profile → interests → philosophy & methods →
// target journals → LLM API keys. No password and no backend — the "account"
// is a local profile; keys and preferences live in this browser only.
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

// mode: "onboard" (first run, full page) | "edit" (preferences modal)
export function renderOnboard(container, { mode = "onboard", onDone, onCancel } = {}) {
  const draft = {
    profile: getProfile(),
    prefs: getPrefs(),
    step: 0,
    verifying: {}, // provider → "busy" | "ok" | "err"
  };
  for (const [prov, ok] of Object.entries(draft.prefs.verified || {})) {
    if (ok && draft.prefs.keys[prov]) draft.verifying[prov] = "ok";
  }

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
          onclick: () => { onPick(val); render(); },
        }, label);
      }));
  }

  function stepBody() {
    const p = draft.prefs;
    if (draft.step === 0) return [
      h("div", { class: "onb-h" }, mode === "edit" ? "Your workspace" : "Set up your workspace"),
      h("div", { class: "onb-sub" },
        "This demo runs entirely in your browser — no account, no server. Open-source: audit the code and run it locally if you prefer."),
      h("label", { class: "field" }, "Name",
        h("input", { value: draft.profile.name, placeholder: "Ada Scholar",
          oninput: (e) => { draft.profile.name = e.target.value; } })),
      h("label", { class: "field" }, "Email (optional — only stored locally)",
        h("input", { value: draft.profile.email, placeholder: "ada@university.edu",
          oninput: (e) => { draft.profile.email = e.target.value; } })),
      h("div", { class: "privacy-note" },
        h("strong", {}, "Privacy — "),
        "we keep your ", h("strong", {}, "preferences only"), ", in this browser. Your research activity — queries, papers viewed, review streams — is never collected or sent anywhere except the APIs you call with your own keys."),
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
      h("div", { class: "onb-h" }, "Connect an LLM provider"),
      h("div", { class: "onb-sub" },
        "The Within-IS pipeline (query refinement, reranking, rationales) needs at least one key. " +
        "Outside-IS works without any API — the browser extension imports from external tools — " +
        "though its own web search also needs a key. Keys are stored in this browser and sent only to their provider."),
      Object.keys(PROVIDERS).map((prov) => keyRow(prov)),
      h("button", { class: `outside-toggle${p.outsideEnabled ? " on" : ""}`,
        onclick: () => { p.outsideEnabled = !p.outsideEnabled; render(); } },
        h("div", { class: "box" }, p.outsideEnabled ? "✓" : ""),
        h("div", {},
          h("div", { class: "big" }, "Enable general (outside-IS) literature search via LLM API"),
          h("div", { class: "small" },
            "If disabled, use the browser extension to import results manually from Google Scholar Labs, Asta, Paper Digest, or SciSpace."))),
      h("div", { class: "privacy-note" },
        h("strong", {}, "Worried about pasting a key into a website? "),
        "Fair. This project is open-source — review the code and run it locally instead. We collect preferences only, never your search activity."),
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
        oninput: (e) => {
          p.keys[prov] = e.target.value;
          if (draft.verifying[prov]) { delete draft.verifying[prov]; p.verified[prov] = false; }
          // live-sync the affordances without a re-render (which would drop focus):
          // this row's Verify button, and the footer's finish gate
          const vb = e.target.closest(".key-row")?.querySelector(".btn-verify");
          if (vb) {
            vb.className = e.target.value.trim() ? "btn-verify ready" : "btn-verify";
            vb.textContent = "Verify";
          }
          const foot = container.querySelector(".onb-foot .btn-ink");
          if (foot && draft.step === STEPS.length - 1) foot.disabled = !anyKey();
        } }),
      h("button", { class: btnClass, disabled: state === "busy",
        onclick: async (e) => {
          if (!has && !p.keys[prov].trim()) return;
          draft.verifying[prov] = "busy"; render();
          try {
            await verifyKey(prov, p.keys[prov]);
            draft.verifying[prov] = "ok"; p.verified[prov] = true;
          } catch (err) {
            draft.verifying[prov] = "err"; p.verified[prov] = false;
            console.warn(err);
          }
          render();
        } }, btnLabel));
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

  function render() {
    const isLast = draft.step === STEPS.length - 1;
    const canNext = !isLast || anyKey();
    container.replaceChildren(
      h("div", { class: "onb-wrap" },
        mode === "onboard" && h("div", { class: "onb-title" },
          h("div", { class: "t" }, "Paper Trails"),
          h("div", { class: "s" }, "Backward · Main · Forward — a structured literature review workbench for Information Systems scholars, after Webster & Watson (2002)")),
        h("div", { class: "onb-steps" },
          STEPS.map((label, i) =>
            h("div", { class: `onb-step${i === draft.step ? " now" : i < draft.step ? " past" : ""}` },
              h("div", { class: "step-dot" }, i < draft.step ? "✓" : String(i + 1)),
              h("div", { class: "step-lab" }, label)))),
        h("div", { class: "onb-card" },
          stepBody(),
          h("div", { class: "onb-foot" },
            draft.step === 0 && mode === "edit"
              ? h("button", { class: "btn", onclick: () => onCancel?.() }, "Cancel")
              : h("button", { class: "btn", disabled: draft.step === 0,
                  onclick: () => { if (draft.step > 0) { draft.step--; render(); } } }, "Back"),
            h("button", { class: "btn-ink", disabled: !canNext,
              onclick: () => {
                if (!isLast) { draft.step++; render(); }
                else if (anyKey()) finish();
              } },
              isLast ? (mode === "edit" ? "Save preferences" : "Start reviewing →") : "Continue")))));
  }

  render();
}
