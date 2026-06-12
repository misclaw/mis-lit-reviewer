// BibTeX generation + copy-to-clipboard, shared by the search and browse views.

export function bibtex(r) {
  const type = { journal: "article", conference: "inproceedings", preprint: "misc" }[r.col] || "misc";
  const vf = type === "article" ? "journal" : type === "inproceedings" ? "booktitle" : "howpublished";
  const last = ((r.authors || ["anon"])[0]?.split(" ").pop() || "anon").replace(/[^A-Za-z]/g, "");
  const key = (last + (r.year || "") + ((r.title || "x").split(" ")[0] || "")).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const doi = r.doi ? r.doi.replace(/^https?:\/\/doi\.org\//, "") : null;
  const L = [`@${type}{${key},`, `  title = {${r.title || ""}},`];
  if (r.authors?.length) L.push(`  author = {${r.authors.join(" and ")}},`);
  if (r.year) L.push(`  year = {${r.year}},`);
  if (r.venue) L.push(`  ${vf} = {${r.venue}},`);
  if (doi) L.push(`  doi = {${doi}},`);
  if (r.url) L.push(`  url = {${r.url}},`);
  L.push("}");
  return L.join("\n");
}

export function cite(r, toast) {
  const b = bibtex(r);
  navigator.clipboard.writeText(b).then(() => toast("BibTeX copied"), () => prompt("Copy BibTeX:", b));
}
