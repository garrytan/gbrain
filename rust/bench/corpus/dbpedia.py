#!/usr/bin/env python3
"""Build gbrain-bench-corpus/1 directories from a public set of real embeddings.

Source: the Hugging Face dataset Qdrant/dbpedia-entities-openai3-text-embedding-3-large-1536-1M
(DBpedia abstracts embedded with OpenAI text-embedding-3-large at 1,536 dimensions).
text-embedding-3 models are trained so that a prefix of the vector is itself an embedding
(OpenAI's `dimensions` parameter shortens the same way), so each vector is cut to its first
`--dims` values and renormalized to unit length. The result is a real 1,024-dimension
embedding distribution, unlike the scale fixture's 16 nonzero dimensions.

Every 4 consecutive rows become one page with 4 chunks. 10% of pages go to source
`scale-b` (page index % 10 == 9), the rest to `default`. Page types cycle concept, person,
company, note by page index. Rows after the corpus are held out as query vectors.

Known quirk: because 4 and 10 share a factor, the source and the type are correlated. `scale-b`
holds only `person` and `note` pages (50% each), so "scale-b plus one type" is about 5% of all
pages, not 2.5%. The baseline runner measures and reports the real selectivity.

Usage (needs pyarrow + numpy; downloads are not part of this script):
  for i in 0 1 2 3 4 5; do curl -sSL -o $i.parquet \
    https://huggingface.co/api/datasets/Qdrant/dbpedia-entities-openai3-text-embedding-3-large-1536-1M/parquet/default/train/$i.parquet; done
  python3 dbpedia.py --parquet-dir . --out ../corpus-200k --chunks 200000
  python3 dbpedia.py --parquet-dir . --out ../corpus-10k --chunks 10000
"""
import argparse
import glob
import json
import os
import re

import numpy as np
import pyarrow.parquet as pq

TYPES = ["concept", "person", "company", "note"]
CHUNKS_PER_PAGE = 4
COLUMN = "text-embedding-3-large-1536-embedding"


def slugify(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s[:60] or "page"


def rows(parquet_dir: str):
    for path in sorted(glob.glob(os.path.join(parquet_dir, "*.parquet")), key=lambda p: int(os.path.basename(p).split(".")[0])):
        f = pq.ParquetFile(path)
        for batch in f.iter_batches(batch_size=4096, columns=["title", "text", COLUMN]):
            titles = batch.column("title").to_pylist()
            texts = batch.column("text").to_pylist()
            vecs = batch.column(COLUMN)
            flat = np.asarray(vecs.values.to_numpy(zero_copy_only=False), dtype=np.float64)
            width = len(flat) // len(titles)
            mat = flat.reshape(len(titles), width)
            for t, x, v in zip(titles, texts, mat):
                yield t or "", x or "", v


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--chunks", type=int, required=True)
    ap.add_argument("--queries", type=int, default=1000)
    ap.add_argument("--dims", type=int, default=1024)
    ap.add_argument("--query-offset", type=int, default=200000,
                    help="first held-out row; must be >= the largest corpus built, so queries never overlap any corpus")
    a = ap.parse_args()
    if a.chunks % CHUNKS_PER_PAGE:
        raise SystemExit("--chunks must be a multiple of 4")
    if a.query_offset < a.chunks:
        raise SystemExit("--query-offset must be >= --chunks")
    os.makedirs(a.out, exist_ok=True)
    # Cached exact ground truth belongs to the corpus files being replaced.
    stale_truth = os.path.join(a.out, "truth_top10.json")
    if os.path.exists(stale_truth):
        os.remove(stale_truth)
    pages_f = open(os.path.join(a.out, "pages.jsonl"), "w")
    chunks_f = open(os.path.join(a.out, "chunks.jsonl"), "w")
    vec_f = open(os.path.join(a.out, "vectors.f32"), "wb")
    q_f = open(os.path.join(a.out, "queries.jsonl"), "w")
    qv_f = open(os.path.join(a.out, "queries.f32"), "wb")
    page_rows = []
    n_pages = 0
    n_queries = 0

    def unit(v):
        v = np.asarray(v[: a.dims], dtype=np.float64)
        return (v / np.linalg.norm(v)).astype("<f4")

    def flush_page(prows):
        nonlocal n_pages
        i = n_pages
        title = prows[0][0]
        source = "scale-b" if i % 10 == 9 else "default"
        ptype = TYPES[i % len(TYPES)]
        body = "# " + title + "\n\n" + "\n\n".join(f"{t}. {x}" for t, x, _ in prows) + "\n"
        page = {
            "i": i, "source_id": source, "slug": f"wiki/{slugify(title)}-{i}", "type": ptype, "title": title,
            "frontmatter": {"type": ptype, "title": title, "tags": ["dbpedia", ptype]},
            "body": body, "chunk_start": i * CHUNKS_PER_PAGE, "chunk_count": len(prows),
        }
        pages_f.write(json.dumps(page, ensure_ascii=False) + "\n")
        for idx, (t, x, v) in enumerate(prows):
            chunks_f.write(json.dumps({"page": i, "idx": idx, "text": f"{t}. {x}"}, ensure_ascii=False) + "\n")
            vec_f.write(unit(v).tobytes())
        n_pages += 1

    for r, (t, x, v) in enumerate(rows(a.parquet_dir)):
        if r < a.chunks:
            page_rows.append((t, x, v))
            if len(page_rows) == CHUNKS_PER_PAGE:
                flush_page(page_rows)
                page_rows = []
        elif r >= a.query_offset:
            q_f.write(json.dumps({"q": n_queries, "text": f"{t}. {x}"}, ensure_ascii=False) + "\n")
            qv_f.write(unit(v).tobytes())
            n_queries += 1
            if n_queries >= a.queries:
                break
    for f in (pages_f, chunks_f, vec_f, q_f, qv_f):
        f.close()
    manifest = {
        "format": "gbrain-bench-corpus/1", "dims": a.dims, "pages": n_pages, "chunks": n_pages * CHUNKS_PER_PAGE,
        "queries": n_queries, "sources": ["default", "scale-b"],
        "origin": "Qdrant/dbpedia-entities-openai3-text-embedding-3-large-1536-1M, first "
                  f"{a.dims} dims renormalized; queries from rows {a.query_offset}+",
    }
    json.dump(manifest, open(os.path.join(a.out, "manifest.json"), "w"), indent=2)
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
