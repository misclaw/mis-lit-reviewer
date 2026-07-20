// Optional account sync. The workspace document (streams, sessions, prefs —
// NEVER the LLM API keys) lives in one Supabase row per user, guarded by RLS.
// Model: rev-guarded last-writer-wins on the whole document, with a per-stream
// merge when two devices actually raced. Realtime + focus/interval pulls keep
// other devices live. Signed-out, the app is exactly what it always was:
// local-only.
//
// The URL and anon key are public by design (the anon role can only reach
// rows RLS grants it — i.e. the signed-in user's own row).
import { createClient } from "@supabase/supabase-js";
import * as store from "./store.js";

const SUPABASE_URL = "https://shevaemflnewyxdmlodv.supabase.co";
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNoZXZhZW1mbG5ld3l4ZG1sb2R2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0OTYyNTIsImV4cCI6MjEwMDA3MjI1Mn0.vuGwIkizi1K2ueP6B9keDKaZclze30fqDtgDhY40DYY";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ---- observable state (drives the nav button + account modal) ----
// status: signedout | linking | syncing | idle | error
const state = { user: null, status: "signedout", lastSyncAt: null, error: null };
const listeners = new Set();
export function onState(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getState() { return { ...state }; }
function set(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) { try { fn(getState()); } catch { /* listener error */ } }
}

// ---- auth ----
export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(error.message);
  // With email confirmation on, signUp returns a user but NO session — the
  // account isn't usable until the emailed link is clicked. needsConfirmation
  // tells the UI to show "check your email" instead of waiting for a session.
  return { user: data.user, needsConfirmation: !data.session };
}
export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}
export async function signOut() {
  await supabase.auth.signOut();
}

// ---- engine ----
let knownRev = 0;      // last remote rev this device has seen or written
let lastSynced = null; // the snapshot at that rev — equal snapshot ⇒ nothing to push
let pushT = null;
let channel = null;
let started = false;

// Resolves once the initial session restore has fired, so boot-time logic can
// ask "is anyone signed in?" without racing it.
let readyResolve;
export const ready = new Promise((res) => { readyResolve = res; });

export function start() {
  if (started) return;
  started = true;
  supabase.auth.onAuthStateChange((_event, session) => {
    readyResolve();
    const user = session?.user || null;
    if (user && !state.user) { set({ user, status: "linking", error: null }); link(); }
    else if (!user && state.user) {
      unsubscribe();
      knownRev = 0; lastSynced = null;
      set({ user: null, status: "signedout", error: null });
    }
  });
  store.onLocalChange(schedulePush);
  window.addEventListener("focus", pullIfNewer);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pullIfNewer(); });
  setInterval(() => { if (!document.hidden) pullIfNewer(); }, 90_000); // realtime backstop
}

// First contact after sign-in: adopt, push, or merge.
async function link() {
  try {
    const { data: row, error } = await supabase.from("workspaces").select("data, rev").maybeSingle();
    if (error) throw new Error(error.message);
    const local = store.syncSnapshot();
    if (!row) {
      knownRev = 0; lastSynced = null;
      await push(local);
    } else if (JSON.stringify(row.data) === local) {
      adopt(row.rev, local);
    } else if (store.isPristine()) {
      // fresh device — take the account's workspace wholesale
      store.applyRemote(JSON.stringify(row.data));
      adopt(row.rev, store.syncSnapshot());
    } else {
      // both sides have real content — merge, then publish the union
      knownRev = row.rev;
      const merged = merge(local, row.data);
      store.applyRemote(merged);
      await push(store.syncSnapshot());
    }
    subscribe();
    set({ status: "idle", lastSyncAt: Date.now() });
  } catch (e) {
    set({ status: "error", error: e.message });
  }
}

function adopt(rev, json) {
  knownRev = rev;
  lastSynced = json;
  set({ status: "idle", lastSyncAt: Date.now(), error: null });
}

function schedulePush() {
  if (!state.user || state.status === "linking") return;
  clearTimeout(pushT);
  pushT = setTimeout(async () => {
    const json = store.syncSnapshot();
    if (json === lastSynced) return;
    try { await push(json); } catch (e) { set({ status: "error", error: e.message }); }
  }, 1200);
}

// Compare-and-swap on rev: the update only lands if the remote row is still at
// the rev we last saw. A miss means another device wrote — pull, merge, retry.
async function push(json) {
  set({ status: "syncing" });
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = JSON.parse(json);
    if (knownRev === 0) {
      const { error } = await supabase.from("workspaces")
        .insert({ user_id: state.user.id, data, rev: 1 });
      if (!error) { adopt(1, json); return; }
      if (error.code !== "23505") throw new Error(error.message); // not a duplicate-row race
    } else {
      const { data: upd, error } = await supabase.from("workspaces")
        .update({ data, rev: knownRev + 1, updated_at: new Date().toISOString() })
        .eq("user_id", state.user.id).eq("rev", knownRev)
        .select("rev");
      if (error) throw new Error(error.message);
      if (upd?.length) { adopt(knownRev + 1, json); return; }
    }
    await refetchAndMerge();
    json = store.syncSnapshot();
  }
  throw new Error("another device kept writing — will retry on the next change");
}

async function refetchAndMerge() {
  const { data: row, error } = await supabase.from("workspaces").select("data, rev").maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) { knownRev = 0; return; }
  knownRev = row.rev;
  store.applyRemote(merge(store.syncSnapshot(), row.data));
}

export async function pullIfNewer() {
  if (!state.user || state.status === "linking" || state.status === "syncing") return;
  try {
    const { data: row } = await supabase.from("workspaces").select("data, rev").maybeSingle();
    if (!row || row.rev <= knownRev) return;
    const remote = JSON.stringify(row.data);
    if (store.syncSnapshot() === lastSynced) {
      // no local edits in flight — take remote as-is
      store.applyRemote(remote);
      adopt(row.rev, store.syncSnapshot());
    } else {
      // raced with local edits — merge and let the push loop publish it
      knownRev = row.rev;
      store.applyRemote(merge(store.syncSnapshot(), row.data));
      schedulePush();
    }
  } catch { /* offline — the next pull or push will catch up */ }
}

export async function syncNow() {
  await pullIfNewer();
  const json = store.syncSnapshot();
  if (state.user && json !== lastSynced) await push(json);
}

// Realtime: any write to my row from another device triggers a pull. The
// payload itself is ignored — a fresh REST fetch avoids payload size limits.
function subscribe() {
  unsubscribe();
  channel = supabase.channel("workspace-sync")
    .on("postgres_changes",
      { event: "*", schema: "public", table: "workspaces", filter: `user_id=eq.${state.user.id}` },
      () => pullIfNewer())
    .subscribe();
}
function unsubscribe() {
  if (channel) { supabase.removeChannel(channel); channel = null; }
}

// Union merge for a genuine two-device race. Per stream: newer updated_at
// wins. Sessions: union by id. Scalars and prefs: the local (actively used)
// device wins. Known trade-off: a deletion that races a concurrent edit on
// another device can resurrect — preferable to silently losing edits.
function merge(localJson, remoteData) {
  const a = JSON.parse(localJson);
  const b = typeof remoteData === "string" ? JSON.parse(remoteData) : remoteData;
  const streams = new Map();
  for (const s of b.streams || []) streams.set(s.id, s);
  for (const s of a.streams || []) {
    const r = streams.get(s.id);
    if (!r || (s.updated_at || "") >= (r.updated_at || "")) streams.set(s.id, s);
  }
  const sessions = new Map();
  for (const s of [...(b.sessions || []), ...(a.sessions || [])]) sessions.set(s.id, s);
  return JSON.stringify({
    ...b, ...a,
    streams: [...streams.values()]
      .sort((x, y) => (x.created_at || "").localeCompare(y.created_at || "")),
    sessions: [...sessions.values()]
      .sort((x, y) => (y.received_at || "").localeCompare(x.received_at || "")).slice(0, 50),
  });
}
