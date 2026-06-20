// Inbound cross-app handoff: decode papers that reference-viewer encoded into
// the URL fragment (#add=…) so the app can offer to add them to streams.
//
// reference-viewer and this app are separate origins; reference-viewer can't
// write our localStorage, so it hands the selection over in the URL and we —
// first-party to our own store — show the stream picker. This module is PURE
// (no app/DOM deps) so it is unit-testable in isolation.
//
// Wire contract (must stay in sync with reference-viewer/handoff.js):
//   …/#add=<base64url(utf8(JSON))>
//   JSON = { v:1, src:"reference-viewer",
//            papers:[ {title, authors:[…], year, venue, doi, url, col} ] }

const COLS = new Set(["journal", "conference", "preprint"]);

function b64urlDecode(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function sanitize(p) {
  if (!p || typeof p !== "object") return null;
  const title = typeof p.title === "string" ? p.title.trim() : "";
  if (!title) return null; // a paper with no title is unusable
  return {
    title,
    authors: Array.isArray(p.authors) ? p.authors.filter((a) => typeof a === "string").slice(0, 12) : [],
    year: Number.isFinite(p.year) ? p.year : (parseInt(p.year, 10) || null),
    venue: typeof p.venue === "string" ? p.venue : null,
    doi: typeof p.doi === "string" ? p.doi : null,
    url: typeof p.url === "string" ? p.url : null,
    col: COLS.has(p.col) ? p.col : "journal",
  };
}

/**
 * Parse a location.hash (or any string) for an #add= handoff payload.
 * Returns { papers:[…] } with at least one valid paper, or null.
 */
export function parseHandoff(hash) {
  const m = (hash || "").match(/[#&]add=([^&]+)/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(b64urlDecode(decodeURIComponent(m[1])));
  } catch {
    return null;
  }
  if (!data || data.v !== 1 || !Array.isArray(data.papers)) return null;
  const papers = data.papers.map(sanitize).filter(Boolean);
  return papers.length ? { papers, src: data.src || "unknown" } : null;
}
