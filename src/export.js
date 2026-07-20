// Scholarly export of a result set — BibTeX, RIS, CSV — from the slim paper
// records the app carries (title, authors, venue, year, doi, url, cited,
// summary, rationale). Conference venues become @inproceedings/CPAPER.
import { h } from "./ui.js";
import { VENUES } from "./pipeline.js";

const authorsOf = (p) =>
  typeof p.authors === "string"
    ? p.authors.split(/,\s*|\s+and\s+/).filter(Boolean)
    : (p.authors || []);

const isConf = (p) => !!VENUES[p.venue]?.conf;

function bibKey(p, seen) {
  const first = (authorsOf(p)[0] || "anon").split(/\s+/).pop() || "anon";
  const word = (p.title || "untitled").split(/\s+/).find((w) => w.length > 3) || "paper";
  let key = (first + (p.year || "") + word).toLowerCase().replace(/[^a-z0-9]/g, "");
  while (seen.has(key)) key += "x";
  seen.add(key);
  return key;
}
const bibEsc = (s) => String(s).replace(/[{}]/g, "").replace(/([&%#_])/g, "\\$1");

export function toBibtex(papers) {
  const seen = new Set();
  return papers.map((p) => {
    const conf = isConf(p);
    const fields = [
      ["title", p.title && `{${bibEsc(p.title)}}`],
      ["author", authorsOf(p).length && `{${authorsOf(p).map(bibEsc).join(" and ")}}`],
      [conf ? "booktitle" : "journal", p.venue && `{${bibEsc(p.venue)}}`],
      ["year", p.year && `{${p.year}}`],
      ["doi", p.doi && `{${p.doi}}`],
      ["url", !p.doi && p.url && `{${p.url}}`],
    ].filter(([, v]) => v);
    return `@${conf ? "inproceedings" : "article"}{${bibKey(p, seen)},\n` +
      fields.map(([k, v]) => `  ${k} = ${v}`).join(",\n") + "\n}";
  }).join("\n\n") + "\n";
}

export function toRIS(papers) {
  return papers.map((p) => [
    "TY  - " + (isConf(p) ? "CPAPER" : "JOUR"),
    p.title && "TI  - " + p.title,
    ...authorsOf(p).map((a) => "AU  - " + a),
    p.venue && (isConf(p) ? "T2  - " : "JO  - ") + p.venue,
    p.year && "PY  - " + p.year,
    p.doi && "DO  - " + p.doi,
    p.url && "UR  - " + p.url,
    p.summary && "AB  - " + p.summary,
    "ER  - ",
  ].filter(Boolean).join("\n")).join("\n") + "\n";
}

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCSV(papers) {
  const cols = ["title", "authors", "venue", "year", "doi", "url", "cited_by", "summary", "rationale"];
  const rows = papers.map((p) => [
    p.title, authorsOf(p).join("; "), p.venue, p.year, p.doi, p.url, p.cited, p.summary, p.rationale,
  ].map(csvCell).join(","));
  return cols.join(",") + "\n" + rows.join("\n") + "\n";
}

function download(name, mime, text) {
  const a = h("a", {
    href: URL.createObjectURL(new Blob([text], { type: mime })),
    download: name,
  });
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}

const FORMATS = [
  ["BibTeX", ".bib", "application/x-bibtex", toBibtex],
  ["RIS", ".ris", "application/x-research-info-systems", toRIS],
  ["CSV", ".csv", "text/csv", toCSV],
];

// Compact "Export: BibTeX · RIS · CSV" control for a set of papers.
export function exportRow(papers, basename) {
  return h("div", { class: "export-row" },
    h("span", { class: "lab" }, "Export:"),
    FORMATS.map(([label, ext, mime, fn]) =>
      h("button", { class: "export-btn", title: `Download these ${papers.length} papers as ${label}`,
        onclick: () => download(basename + ext, mime, fn(papers)) }, label)));
}
