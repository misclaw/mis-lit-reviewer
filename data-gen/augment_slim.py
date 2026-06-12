#!/usr/bin/env python3
"""Join `added` (date the paper entered the corpus) and `cited` (citation
count) from the local IS corpus onto data-gen/papers.slim.jsonl, then rebuild
the shipped chunks in public/data/ (gzip → ≤20 MiB parts → meta.json manifest).

Line order and count are preserved exactly, so emb_int8.bin stays aligned —
embeddings do NOT need regenerating after this.

Usage:  python3 data-gen/augment_slim.py [--corpus ~/research/is-corpus/papers.jsonl]
"""
import argparse
import gzip
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SLIM = ROOT / "data-gen" / "papers.slim.jsonl"
DATA = ROOT / "public" / "data"
PART = 20 * 1024 * 1024  # Cloudflare Pages rejects files >25 MiB; stay under


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", type=Path, default=Path.home() / "research" / "is-corpus" / "papers.jsonl")
    args = ap.parse_args()

    print("Reading corpus dates/citations…", flush=True)
    extra: dict[str, tuple[str | None, int]] = {}
    with open(args.corpus, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            added = (r.get("crawled_at") or "")[:10] or None
            extra[r["id"]] = (added, int(r.get("cited_by_count") or 0))
    print(f"  {len(extra):,} corpus records")

    print("Augmenting slim records…", flush=True)
    tmp = SLIM.with_suffix(".jsonl.tmp")
    n = hit = 0
    with open(SLIM, encoding="utf-8") as fin, open(tmp, "w", encoding="utf-8") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            added, cited = extra.get(rec["id"], (None, 0))
            if added:
                rec["added"] = added
                hit += 1
            if cited:
                rec["cited"] = cited
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    tmp.replace(SLIM)
    print(f"  {n:,} slim records, {hit:,} matched a corpus date")

    print("Rebuilding shipped chunks…", flush=True)
    gz = SLIM.with_suffix(".jsonl.gz")
    with open(SLIM, "rb") as fin, gzip.open(gz, "wb", compresslevel=9) as fout:
        shutil.copyfileobj(fin, fout)
    blob = gz.read_bytes()
    for old in DATA.glob("papers.slim.jsonl.gz.part*"):
        old.unlink()
    sizes = []
    for i in range(0, len(blob), PART):
        chunk = blob[i:i + PART]
        (DATA / f"papers.slim.jsonl.gz.part{len(sizes)}").write_bytes(chunk)
        sizes.append(len(chunk))
    gz.unlink()

    meta_path = DATA / "meta.json"
    meta = json.loads(meta_path.read_text())
    if meta["count"] != n:
        sys.exit(f"count mismatch: meta says {meta['count']}, slim has {n} — aborting (embeddings misaligned?)")
    meta["files"]["papers.slim.jsonl.gz"] = {"parts": len(sizes), "size": len(blob), "part_sizes": sizes}
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"  {len(sizes)} part(s), {len(blob):,} bytes gzipped; meta.json updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
