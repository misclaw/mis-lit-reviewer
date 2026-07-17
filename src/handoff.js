// Inbound cross-app handoff via URL fragment. Two producers:
//   #import=…  — the Backward·Main·Forward browser extension (extension/):
//                { v:1, src:"extension", tool, query, hasRationales,
//                  papers:[{title, authors?, year?, venue?, url?, doi?, snippet?}] }
//   #add=…     — reference-viewer (legacy contract, kept verbatim):
//                { v:1, src:"reference-viewer", papers:[{title, authors:[…], year, venue, doi, url, col}] }
// Both are base64url(utf8(JSON)). Other origins can't write our localStorage,
// so the payload rides the URL and we — first-party to our own store — turn it
// into a captured session the Import tab can pull from.

function b64urlDecode(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function str(v, max = 500) { return typeof v === "string" ? v.slice(0, max).trim() : ""; }

function sanitizePaper(p) {
  if (!p || typeof p !== "object") return null;
  const title = str(p.title, 400);
  if (!title) return null;
  return {
    title,
    authors: Array.isArray(p.authors)
      ? p.authors.filter((a) => typeof a === "string").slice(0, 12).join(", ")
      : str(p.authors, 300),
    year: Number.isFinite(p.year) ? p.year : (parseInt(p.year, 10) || null),
    venue: str(p.venue, 200),
    doi: str(p.doi, 120) || null,
    url: str(p.url, 600) || null,
    summary: "",
    rationale: str(p.snippet ?? p.rationale, 600),
    discipline: "",
    cited: null,
    source: "import",
  };
}

// Parse a location.hash; returns a session record for store.addSession, or null.
export function parseInbound(hash) {
  const m = (hash || "").match(/[#&](import|add)=([^&]+)/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(b64urlDecode(decodeURIComponent(m[2])));
  } catch {
    return null;
  }
  if (!data || data.v !== 1 || !Array.isArray(data.papers)) return null;
  const papers = data.papers.map(sanitizePaper).filter(Boolean).slice(0, 60);
  if (!papers.length) return null;
  return {
    tool: m[1] === "add" ? "Reference Viewer" : str(data.tool, 80) || "Browser extension",
    query: str(data.query, 300),
    papers,
    hasRationales: !!data.hasRationales || papers.some((p) => p.rationale),
  };
}
