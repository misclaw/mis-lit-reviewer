#!/usr/bin/env python3
"""Append corpus records that are missing from data-gen/papers.slim.jsonl.

Selection matches the original slim export: abstract-bearing records only.
New records are APPENDED (existing line order untouched), so the existing
rows of emb_int8.bin stay aligned and `node data-gen/embed.mjs` resumes from
the first new row. Finish with ship_chunks.py to package + update meta.json.

Usage:  python3 data-gen/append_slim.py [--corpus ~/research/is-corpus/papers.jsonl]
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SLIM = ROOT / "data-gen" / "papers.slim.jsonl"


def classify(rec: dict) -> str:
    if rec.get("source") == "aisel-oai":
        return "conference"
    venue = (rec.get("venue") or "").lower()
    if "ssrn" in venue or "social science research network" in venue or rec.get("source") == "ssrn-rss":
        return "preprint"
    return "journal"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", type=Path, default=Path.home() / "research" / "is-corpus" / "papers.jsonl")
    args = ap.parse_args()

    have = set()
    with open(SLIM, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                have.add(json.loads(line)["id"])
    print(f"slim has {len(have):,} records")

    added = 0
    with open(args.corpus, encoding="utf-8") as fin, open(SLIM, "a", encoding="utf-8") as fout:
        for line in fin:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec["id"] in have or not (rec.get("abstract") or "").strip():
                continue
            have.add(rec["id"])
            out = {
                "id": rec["id"],
                "title": rec.get("title"),
                "authors": [a.get("name") for a in (rec.get("authors") or []) if a.get("name")],
                "year": rec.get("year"),
                "venue": rec.get("venue"),
                "doi": rec.get("doi"),
                "url": rec.get("url"),
                "abstract": rec.get("abstract"),
                "col": classify(rec),
                "added": (rec.get("crawled_at") or "")[:10] or None,
            }
            if rec.get("cited_by_count"):
                out["cited"] = rec["cited_by_count"]
            if out["added"] is None:
                del out["added"]
            fout.write(json.dumps(out, ensure_ascii=False) + "\n")
            added += 1
    print(f"appended {added:,} → slim now {len(have):,} records")
    print("next: node data-gen/embed.mjs   then   python3 data-gen/ship_chunks.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
