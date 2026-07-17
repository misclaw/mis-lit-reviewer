// Go backward / go forward (Webster & Watson steps 2–3), on the 20 main
// review papers. All citation data comes from OpenAlex (the corpus ids ARE
// OpenAlex work ids); the final ~20 selection + rationales come from the LLM.
//
//   backward: references OF the mains  — /works/{id}?select=referenced_works,
//             count how many mains cite each, metadata-fetch the top slice
//   forward:  papers CITING the mains  — /works?filter=cites:{id} per main,
//             count how many mains each citing paper cites
import { chatJSON } from "./llm.js";
import { venueAbbr, reconstructAbstract } from "./pipeline.js";

const MAILTO = "gwonedgar@gmail.com";
const OA = "https://api.openalex.org";

const shortId = (id) => (id || "").replace("https://openalex.org/", "");

async function oaJSON(url) {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "mailto=" + MAILTO);
  if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
  return res.json();
}

// Bounded-concurrency map that tolerates per-item failures (returns null).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  }));
  return out;
}

const WORK_FIELDS = "id,title,authorships,publication_year,primary_location,cited_by_count,doi";

function normWork(w) {
  return {
    id: shortId(w.id),
    title: w.title || "(untitled)",
    authors: (w.authorships || []).slice(0, 6).map((a) => a.author?.display_name).filter(Boolean),
    year: w.publication_year || null,
    venue: w.primary_location?.source?.display_name || "",
    cited: w.cited_by_count ?? null,
    doi: w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//, "") : null,
    url: w.doi || (w.id ? "https://openalex.org/" + shortId(w.id) : null),
  };
}

// ---- backward: collect all references of the mains, keep link multiplicity ----
export async function collectBackward(mains, onProgress) {
  const mainIds = new Set(mains.map((m) => m.id));
  const refLists = await mapLimit(mains, 6, async (m) => {
    const j = await oaJSON(`${OA}/works/${m.id}?select=id,referenced_works`);
    return (j.referenced_works || []).map(shortId);
  });
  const links = new Map(); // candidate id → [main indices that cite it]
  let totalRefs = 0;
  refLists.forEach((refs, mi) => {
    if (!refs) return;
    totalRefs += refs.length;
    for (const rid of refs) {
      if (mainIds.has(rid)) continue;
      if (!links.has(rid)) links.set(rid, []);
      links.get(rid).push(mi);
    }
  });
  onProgress?.({ totalRefs, unique: links.size });

  // Rank candidates by how many mains cite them; fetch metadata for the top
  // slice only (batches of 50 via the openalex id filter).
  const ranked = [...links.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 150);
  const metas = [];
  for (let i = 0; i < ranked.length; i += 50) {
    const batch = ranked.slice(i, i + 50);
    const j = await oaJSON(`${OA}/works?filter=openalex:${batch.map(([id]) => id).join("|")}` +
      `&select=${WORK_FIELDS}&per-page=50`);
    metas.push(...(j.results || []));
  }
  const byId = new Map(metas.map((w) => [shortId(w.id), w]));
  const candidates = ranked
    .filter(([id]) => byId.has(id))
    .map(([id, mis]) => ({ ...normWork(byId.get(id)), links: mis }));
  return { candidates, stats: { totalRefs, unique: links.size } };
}

// ---- forward: collect papers citing each main (top 100 by citations per main) ----
export async function collectForward(mains, onProgress) {
  const mainIds = new Set(mains.map((m) => m.id));
  const perMain = await mapLimit(mains, 6, async (m) => {
    const j = await oaJSON(`${OA}/works?filter=cites:${m.id}&select=${WORK_FIELDS}` +
      `&per-page=100&sort=cited_by_count:desc`);
    return { count: j.meta?.count || 0, works: j.results || [] };
  });
  const links = new Map();  // citing id → [main indices it cites]
  const byId = new Map();
  let totalCiting = 0;
  perMain.forEach((r, mi) => {
    if (!r) return;
    totalCiting += r.count;
    for (const w of r.works) {
      const id = shortId(w.id);
      if (mainIds.has(id)) continue;
      if (!links.has(id)) { links.set(id, []); byId.set(id, w); }
      links.get(id).push(mi);
    }
  });
  onProgress?.({ totalCiting, unique: links.size });
  const candidates = [...links.entries()]
    .sort((a, b) => b[1].length - a[1].length ||
      (byId.get(b[0]).cited_by_count || 0) - (byId.get(a[0]).cited_by_count || 0))
    .slice(0, 150)
    .map(([id, mis]) => ({ ...normWork(byId.get(id)), links: mis }));
  return { candidates, stats: { totalCiting, unique: links.size } };
}

// ---- LLM relevance screening of the candidate slice → ~20 with rationales ----
export async function screenCandidates({ dir, mains, candidates, query, provider, key, model }, n = 20) {
  const mainsList = mains.map((m, i) => `[M${i}] ${m.title} (${venueAbbr(m.venue)} ${m.year || "?"})`).join("\n");
  const candList = candidates.slice(0, 80).map((c, i) =>
    `[${i}] ${c.title} — ${c.authors.slice(0, 3).join(", ")}${c.authors.length > 3 ? " et al." : ""} · ` +
    `${c.venue || "?"} · ${c.year || "?"} · cited ${c.cited ?? "?"} · ` +
    (dir === "back" ? `cited by ${c.links.length}/${mains.length} mains` : `cites ${c.links.length}/${mains.length} mains`)
  ).join("\n");
  const out = await chatJSON(provider, key, {
    model,
    maxTokens: 6000,
    system:
      `You are doing the "${dir === "back" ? "go backward" : "go forward"}" step of a Webster & Watson (2002) literature review. ` +
      (dir === "back"
        ? "The candidates are prior works CITED BY the main review set — pick the ones a reviewer must trace back to (foundational theory, source constructs, seminal methods)."
        : "The candidates are later works CITING the main review set — pick the ones that carry the conversation forward (extensions, boundary conditions, recent turns of the stream).") +
      ` Select and rank the ${n} most important for this research question. Reply with JSON only: ` +
      "{\"picks\": [{\"i\": <candidate index>, \"rationale\": <one sentence on why it belongs in the review>}]} " +
      `— exactly ${n} picks (fewer only if fewer are relevant), most important first.`,
    user: `Research question: ${query}\n\nMain review set:\n${mainsList}\n\nCandidates:\n${candList}`,
  });
  const picks = Array.isArray(out.picks) ? out.picks : [];
  const seen = new Set();
  const selected = [];
  for (const p of picks) {
    const i = Number(p.i);
    if (!Number.isInteger(i) || i < 0 || i >= Math.min(candidates.length, 80) || seen.has(i)) continue;
    seen.add(i);
    selected.push({
      ...candidates[i],
      rationale: typeof p.rationale === "string" ? p.rationale : "Selected by LLM relevance screening.",
    });
    if (selected.length >= n) break;
  }
  if (!selected.length) throw new Error("screening returned no usable picks");
  return selected;
}

// Fetch abstract for one work (used for card expansion; best-effort).
export async function fetchAbstract(id) {
  try {
    const j = await oaJSON(`${OA}/works/${id}?select=abstract_inverted_index`);
    return reconstructAbstract(j.abstract_inverted_index);
  } catch { return null; }
}
