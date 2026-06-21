// Device-local PDF attachments for papers, keyed by paper id in IndexedDB.
//
// Why IndexedDB and not the localStorage store: a page served over https can
// NOT open a file:// path (browsers block https → file navigation), and PDF
// bytes / file handles aren't JSON-serialisable. So attachments live in their
// own IndexedDB database, entirely separate from the export/import JSON store —
// which is also correct semantically: a local file is meaningless on another
// machine, so it must not travel with the JSON backup.
//
// Two backing kinds, picked by browser capability:
//   • 'handle' — a FileSystemFileHandle (Chromium: Chrome/Edge/Brave). The PDF
//     stays where it is on disk; we hold only a live reference and read it on
//     demand. "Does it still exist?" is a REAL filesystem check — getFile()
//     throws NotFoundError if the file was moved or deleted, which is exactly
//     the "if it really exists" behaviour we want.
//   • 'blob'   — a copy of the bytes (Firefox/Safari fallback, which lack the
//     File System Access API). Always present once attached.
//
// Either way, opening = make an object URL from the File/Blob and point a tab
// at it, so Chrome's built-in PDF viewer renders it natively ("the PDF tab").

const DB_NAME = "mis-lit-reviewer:pdfs";
const STORE = "pdfs";

let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
function txDone(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); }

// Returns { kind:'handle'|'blob', name, handle?, blob? } or null.
export async function getRecord(id) {
  const d = await db();
  return reqP(d.transaction(STORE, "readonly").objectStore(STORE).get(id));
}
export async function hasPdf(id) {
  return !!(await getRecord(id));
}
async function putRecord(id, rec) {
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(rec, id);
  await txDone(tx);
}
export async function remove(id) {
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
}

// Chromium-only file picker that yields a persistent handle. Feature-detected;
// callers fall back to attachBlob() with a plain <input type=file> elsewhere.
export const canPickFile = () => typeof window.showOpenFilePicker === "function";

// Opens the native picker (requires a user gesture). Resolves to the filename,
// or null if the user cancelled. Throws on real errors.
export async function attachViaPicker(id) {
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
    });
  } catch (e) {
    if (e && e.name === "AbortError") return null; // user dismissed the picker
    throw e;
  }
  await putRecord(id, { kind: "handle", handle, name: handle.name });
  return handle.name;
}

// Fallback path: store a copy of the chosen file's bytes.
export async function attachBlob(id, file) {
  await putRecord(id, { kind: "blob", blob: file, name: file.name });
  return file.name;
}

// Resolve the attachment to a live File/Blob, re-checking permission and
// existence for handle-backed records. Throws:
//   • Error "no PDF attached"                 — nothing stored for this id
//   • DOMException name 'AbortError'          — read permission denied
//   • DOMException name 'NotFoundError'       — handle's file moved / deleted
async function resolveFile(id) {
  const rec = await getRecord(id);
  if (!rec) throw new Error("no PDF attached");
  if (rec.kind === "handle") {
    const h = rec.handle;
    let perm = "granted";
    try { perm = await h.queryPermission({ mode: "read" }); } catch {}
    if (perm !== "granted") {
      perm = await h.requestPermission({ mode: "read" });
      if (perm !== "granted") { const e = new Error("read permission denied"); e.name = "AbortError"; throw e; }
    }
    return { file: await h.getFile(), name: rec.name }; // getFile() throws NotFoundError if gone
  }
  return { file: rec.blob, name: rec.name };
}

// Open the attachment in `win` (a tab the caller reserved synchronously inside
// the click, to dodge popup blockers). Returns the filename on success.
export async function openInto(id, win) {
  const { file, name } = await resolveFile(id);
  const url = URL.createObjectURL(file);
  if (win) win.location.href = url;
  else window.open(url, "_blank", "noopener");
  // Give the tab time to load before reclaiming the URL.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return name;
}
