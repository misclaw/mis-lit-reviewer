// Device-local persistence for the Backward · Main · Forward workbench.
// Everything lives in localStorage under one namespaced key: the local profile,
// research preferences (including LLM API keys — they never leave this
// browser), review streams with their saved results, and sessions captured by
// the browser extension. Whole-store Export / Import JSON for backup.

const KEY = "mis-lit-reviewer:v2";

const DEFAULT_PREFS = () => ({
  topics: [],
  interests: "",
  phil: "",
  methods: [],
  prims: [],
  secs: [],
  confs: [],
  keys: { anthropic: "", openai: "", gemini: "" },
  verified: {},           // {anthropic: true, …} — last verify ping succeeded
  outsideEnabled: true,   // general (outside-IS) search via LLM API
  provider: "anthropic",  // provider for the within-IS pipeline + citation screening
  outsideProvider: "",    // provider for the outside-IS search ("" = same as provider)
  models: { wi: {}, os: {} }, // per-zone, per-provider model choice {wi: {anthropic: "claude-…"}, os: {…}}
  outsidePrompt: "",      // custom outside-IS system prompt ("" = built-in default)
});

const EMPTY = () => ({
  profile: { name: "", email: "" },
  prefs: DEFAULT_PREFS(),
  onboarded: false,
  tourSeen: false,
  storageNoticeSeen: false, // one-time local-only-storage caution acknowledged
  streams: [],
  lastStreamId: null, // the stream the user last worked in — restored on boot
  sessions: [], // captured by the extension / handed off from other apps
});

let cache = null;

// ---- cross-tab consistency ----
// Another tab (e.g. one the extension opened) may write the store; the
// `storage` event fires here when that happens. Drop the in-memory cache so
// the next read is fresh, and tell the app so it can re-render.
const externalListeners = new Set();
export function onExternalChange(fn) { externalListeners.add(fn); }
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    cache = null;
    for (const fn of externalListeners) { try { fn(); } catch { /* listener error */ } }
  });
}

function load() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return (cache = EMPTY());
    const d = JSON.parse(raw);
    cache = {
      ...EMPTY(),
      ...d,
      prefs: { ...DEFAULT_PREFS(), ...(d.prefs || {}) },
      streams: Array.isArray(d.streams) ? d.streams : [],
      sessions: Array.isArray(d.sessions) ? d.sessions : [],
    };
    cache.prefs.keys = { anthropic: "", openai: "", gemini: "", ...(cache.prefs.keys || {}) };
    // migrate a flat models map (pre zone-scoping) to {wi, os}
    const m = cache.prefs.models || {};
    if (!("wi" in m) || !("os" in m)) {
      cache.prefs.models = { wi: { ...m }, os: { ...m } };
    }
    return cache;
  } catch {
    return (cache = EMPTY());
  }
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(cache));
  notifyLocal();
}

// ---- cloud sync hooks ----
// Local writes notify the sync engine (in-tab; cross-tab writes arrive via the
// storage event above). The engine decides whether anything actually changed.
const localListeners = new Set();
export function onLocalChange(fn) { localListeners.add(fn); }
function notifyLocal() {
  for (const fn of localListeners) { try { fn(); } catch { /* listener error */ } }
}

// The document that syncs: everything except LLM API keys and their verified
// flags — keys are paid, device-local credentials and never leave this browser.
export function syncSnapshot() {
  const d = load();
  return JSON.stringify({
    ...d,
    prefs: { ...d.prefs, keys: { anthropic: "", openai: "", gemini: "" }, verified: {} },
  });
}

// True when this device has nothing worth keeping — lets a sign-in adopt the
// account's workspace wholesale instead of merging into it.
export function isPristine() {
  const d = load();
  const touched = d.streams.some((s) => s.query || s.within || s.outside || s.backward || s.forward);
  return !d.onboarded && !touched && !d.sessions.length;
}

// Quiet replacement from cloud sync: swap in the account's document, keep this
// browser's keys/verified flags, skip the import-backup ceremony (sync flows
// continuously in both directions). Notifies UI listeners but NOT the local-
// change hook — the sync engine orchestrates its own pushes around this.
export function applyRemote(json) {
  const d = JSON.parse(json);
  const cur = load();
  cache = {
    ...EMPTY(),
    ...d,
    prefs: {
      ...DEFAULT_PREFS(), ...(d.prefs || {}),
      keys: { ...cur.prefs.keys }, verified: { ...cur.prefs.verified },
    },
    streams: Array.isArray(d.streams) ? d.streams : [],
    sessions: Array.isArray(d.sessions) ? d.sessions : [],
  };
  localStorage.setItem(KEY, JSON.stringify(cache));
  for (const fn of externalListeners) { try { fn(); } catch { /* listener error */ } }
}
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// ---- profile / prefs ----
export function getProfile() { return { ...load().profile }; }
export function getPrefs() { return structuredClone(load().prefs); }
export function isOnboarded() { return !!load().onboarded; }
export function saveOnboarding(profile, prefs) {
  const d = load();
  d.profile = { ...d.profile, ...profile };
  d.prefs = { ...d.prefs, ...prefs };
  d.onboarded = true;
  save();
}

// ---- last active stream / tour flag ----
export function getLastStreamId() { return load().lastStreamId || null; }
export function setLastStreamId(id) {
  const d = load();
  if (d.lastStreamId === id) return;
  d.lastStreamId = id;
  save();
}
export function isTourSeen() { return !!load().tourSeen; }
export function markTourSeen() {
  const d = load();
  if (!d.tourSeen) { d.tourSeen = true; save(); }
}
export function isStorageNoticeSeen() { return !!load().storageNoticeSeen; }
export function markStorageNoticeSeen() {
  const d = load();
  if (!d.storageNoticeSeen) { d.storageNoticeSeen = true; save(); }
}

// ---- review streams ----
export function listStreams() {
  return load().streams.map((s) => ({ ...s }));
}
export function getStream(id) {
  const s = load().streams.find((s) => s.id === id);
  return s ? structuredClone(s) : null;
}
export function createStream(name) {
  const d = load();
  const row = {
    id: uuid(), name,
    query: "", refined: null, expansions: [],
    within: null,   // 20 reranked papers with summary + rationale
    outside: null,  // outside-IS results (LLM web search and/or imports)
    backward: null, // {selected:[…], stats:{…}}
    forward: null,
    created_at: now(), updated_at: now(),
  };
  d.streams.push(row);
  save();
  return { ...row };
}
export function updateStream(id, fields) {
  const d = load();
  const row = d.streams.find((s) => s.id === id);
  if (!row) throw new Error("stream not found");
  Object.assign(row, fields, { updated_at: now() });
  save();
  return { ...row };
}
export function deleteStream(id) {
  const d = load();
  d.streams = d.streams.filter((s) => s.id !== id);
  save();
}

// ---- extension-captured sessions ----
export function listSessions() {
  return load().sessions
    .map((s) => ({ ...s }))
    .sort((a, b) => b.received_at.localeCompare(a.received_at));
}
export function addSession(rec) {
  const d = load();
  const row = {
    id: uuid(), tool: rec.tool || "Unknown source", query: rec.query || "",
    papers: Array.isArray(rec.papers) ? rec.papers : [],
    hasRationales: !!rec.hasRationales,
    received_at: now(), imported: {},
  };
  // dedupe: identical tool+query+count within the last minute (double hash fire)
  const dup = d.sessions.find((s) =>
    s.tool === row.tool && s.query === row.query && s.papers.length === row.papers.length &&
    Math.abs(new Date(s.received_at) - new Date(row.received_at)) < 60_000);
  if (dup) return { ...dup };
  d.sessions.unshift(row);
  d.sessions = d.sessions.slice(0, 50);
  save();
  return { ...row };
}
export function markImported(sessionId, streamId) {
  const d = load();
  const row = d.sessions.find((s) => s.id === sessionId);
  if (row) { row.imported = { ...row.imported, [streamId]: true }; save(); }
}
export function deleteSession(id) {
  const d = load();
  d.sessions = d.sessions.filter((s) => s.id !== id);
  save();
}

// ---- export / import (whole store as JSON) ----
// Exports NEVER include API keys (or their verified flags): an export file is
// meant to be shareable/archivable, and keys are paid credentials.
export function exportStore() {
  const d = load();
  return JSON.stringify({
    version: 2, exported_at: now(), ...d,
    prefs: { ...d.prefs, keys: { anthropic: "", openai: "", gemini: "" }, verified: {} },
  }, null, 2);
}

// Validate + summarize an export file without touching the store, so the UI
// can show what an import would do before it happens.
export function previewImport(json) {
  const d = JSON.parse(json);
  if (!d || typeof d !== "object" || !("streams" in d || "prefs" in d))
    throw new Error("not a valid export file");
  return {
    streams: Array.isArray(d.streams) ? d.streams.length : 0,
    sessions: Array.isArray(d.sessions) ? d.sessions.length : 0,
    exported_at: d.exported_at || null,
  };
}

const BACKUP_KEY = KEY + ":backup";
export function hasImportBackup() {
  try { return !!localStorage.getItem(BACKUP_KEY); } catch { return false; }
}
export function restoreImportBackup() {
  const b = localStorage.getItem(BACKUP_KEY);
  if (!b) throw new Error("no pre-import backup found");
  localStorage.setItem(KEY, b);
  localStorage.removeItem(BACKUP_KEY);
  cache = null;
}

export function importStore(json) {
  const d = JSON.parse(json);
  if (!d || typeof d !== "object" || !("streams" in d || "prefs" in d))
    throw new Error("not a valid export file");
  const cur = load();
  // keys survive an import: exports don't carry them, and clobbering the
  // browser's working keys with blanks would silently break every pipeline
  const keys = { ...cur.prefs.keys };
  for (const [k, v] of Object.entries(d.prefs?.keys || {})) {
    if (v && v.trim()) keys[k] = v;
  }
  try { localStorage.setItem(BACKUP_KEY, localStorage.getItem(KEY) || ""); } catch { /* quota */ }
  cache = {
    ...EMPTY(),
    profile: d.profile || EMPTY().profile,
    prefs: {
      ...DEFAULT_PREFS(), ...(d.prefs || {}), keys,
      verified: { ...cur.prefs.verified, ...(d.prefs?.verified || {}) },
    },
    onboarded: !!d.onboarded,
    tourSeen: !!d.tourSeen,
    storageNoticeSeen: !!d.storageNoticeSeen,
    streams: Array.isArray(d.streams) ? d.streams : [],
    lastStreamId: d.lastStreamId || null,
    sessions: Array.isArray(d.sessions) ? d.sessions : [],
  };
  save();
  return cache;
}
