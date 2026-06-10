// Device-local persistence for streams / external papers / pins, backed by
// localStorage. Drop-in replacement for the previous remote-DB module: same
// async function signatures and return shapes, but everything stays in this
// browser.
//
// Shape under the single namespaced key:
//   { streams: [...], externals: [...], pins: [...] }
// Rows keep the same field names the old tables used (id, stream_id,
// paper_id, created_at/updated_at ISO strings, …) so the rest of the app is
// unchanged.

const KEY = "mis-lit-reviewer:v1";

const EMPTY = () => ({ streams: [], externals: [], pins: [] });

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY();
    const d = JSON.parse(raw);
    return {
      streams: Array.isArray(d.streams) ? d.streams : [],
      externals: Array.isArray(d.externals) ? d.externals : [],
      pins: Array.isArray(d.pins) ? d.pins : [],
    };
  } catch {
    return EMPTY();
  }
}
function save(d) {
  localStorage.setItem(KEY, JSON.stringify(d));
}
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// ---- streams ----
export async function listStreams() {
  const d = load();
  return [...d.streams].sort(
    (a, b) => (a.position - b.position) || a.created_at.localeCompare(b.created_at)
  );
}
export async function createStream(name, query = "", filters = {}) {
  const d = load();
  const row = {
    id: uuid(), name, query, filters,
    notes: "", position: 0, created_at: now(), updated_at: now(),
  };
  d.streams.push(row);
  save(d);
  return { ...row };
}
export async function updateStream(id, fields) {
  const d = load();
  const row = d.streams.find((s) => s.id === id);
  if (!row) throw new Error("stream not found");
  Object.assign(row, fields, { updated_at: now() });
  save(d);
  return { ...row };
}
export async function deleteStream(id) {
  const d = load();
  d.streams = d.streams.filter((s) => s.id !== id);
  // cascade, like the SQL "on delete cascade"
  d.externals = d.externals.filter((e) => e.stream_id !== id);
  d.pins = d.pins.filter((p) => p.stream_id !== id);
  save(d);
}

// ---- external papers ----
export async function listExternals(streamId) {
  const d = load();
  return d.externals
    .filter((e) => e.stream_id === streamId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at)); // newest first
}
export async function addExternal(streamId, rec) {
  const d = load();
  const row = {
    id: uuid(), stream_id: streamId,
    col: "journal", title: null, authors: [], year: null, venue: null,
    doi: null, url: null, abstract: null, keywords: [], emb: null, provenance: {},
    ...rec,
    created_at: now(),
  };
  d.externals.push(row);
  save(d);
  return { ...row };
}
export async function deleteExternal(id) {
  const d = load();
  d.externals = d.externals.filter((e) => e.id !== id);
  save(d);
}

// ---- pins ----
export async function listPins(streamId) {
  const d = load();
  return d.pins.filter((p) => p.stream_id === streamId);
}
export async function addPin(streamId, paperId, col) {
  const d = load();
  // upsert on (stream_id, paper_id), like the old onConflict
  const existing = d.pins.find((p) => p.stream_id === streamId && p.paper_id === paperId);
  if (existing) existing.col = col;
  else d.pins.push({ id: uuid(), stream_id: streamId, paper_id: paperId, col, created_at: now() });
  save(d);
}
export async function removePin(streamId, paperId) {
  const d = load();
  d.pins = d.pins.filter((p) => !(p.stream_id === streamId && p.paper_id === paperId));
  save(d);
}

// ---- export / import (whole store as JSON) ----
export function exportStore() {
  return JSON.stringify({ version: 1, exported_at: now(), ...load() }, null, 2);
}
export function importStore(json) {
  const d = JSON.parse(json);
  if (!d || typeof d !== "object" || !("streams" in d || "externals" in d || "pins" in d))
    throw new Error("not a valid export file");
  const next = {
    streams: Array.isArray(d.streams) ? d.streams : [],
    externals: Array.isArray(d.externals) ? d.externals : [],
    pins: Array.isArray(d.pins) ? d.pins : [],
  };
  save(next);
  return next;
}
