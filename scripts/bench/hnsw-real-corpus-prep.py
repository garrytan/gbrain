#!/usr/bin/env python3
"""Real-text corpus for scripts/bench/hnsw-iterative-scan.ts (`--corpus dir`).

Downloads English Wikipedia shards (wikimedia/wikipedia, 20231101.en, parquet)
and writes brain-shaped pages and chunks into OUT_DIR. Each article becomes one
page; its text is cut on paragraph and sentence boundaries into chunks of up to
CHUNK_CHARS characters, at most 60 per page, until CHUNKS chunks exist.

  pip install pyarrow
  python3 scripts/bench/hnsw-real-corpus-prep.py OUT_DIR [--chunks 1000000] [--chunk-chars 1200]

Writes:
  pages.tsv   page index, slug, chunk count (title kept out: the bench needs none)
  chunks.txt  one chunk per line, in page order (newlines and tabs replaced by spaces)
No embeddings are made here: the bench embeds chunks.txt with voyage-4 and caches
the vectors beside it (vectors.f32), recording tokens and dollars in ledger.json.
"""
import argparse
import os
import re
import urllib.request

import pyarrow.parquet as pq

BASE = 'https://huggingface.co/datasets/wikimedia/wikipedia/resolve/main/20231101.en/train-{:05d}-of-00041.parquet'
SENTENCE = re.compile(r'(?<=[.!?])\s+')


def chunks_of(text, limit):
    out, cur = [], ''
    for para in (p.strip() for p in text.split('\n')):
        if not para:
            continue
        pieces = [para] if len(para) <= limit else SENTENCE.split(para)
        for piece in pieces:
            while len(piece) > limit:
                if cur:
                    out.append(cur)
                    cur = ''
                out.append(piece[:limit])
                piece = piece[limit:]
            if cur and len(cur) + 1 + len(piece) > limit:
                out.append(cur)
                cur = ''
            cur = f'{cur} {piece}' if cur else piece
    if cur:
        out.append(cur)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--chunks', type=int, default=1_000_000)
    ap.add_argument('--chunk-chars', type=int, default=1200)
    ap.add_argument('--min-chars', type=int, default=300)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    total = pages = 0
    with open(os.path.join(args.out, 'pages.tsv'), 'w') as pf, open(os.path.join(args.out, 'chunks.txt'), 'w') as cf:
        for shard in range(41):
            path = os.path.join(args.out, f'shard-{shard:05d}.parquet')
            if not os.path.exists(path):
                # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- the URL is the fixed https Hugging Face BASE with an integer shard number; no caller input reaches it
                urllib.request.urlretrieve(BASE.format(shard), path + '.part')
                os.rename(path + '.part', path)
            table = pq.read_table(path, columns=['id', 'text'])
            for wid, text in zip(table.column('id').to_pylist(), table.column('text').to_pylist()):
                if len(text) < args.min_chars:
                    continue
                parts = [re.sub(r'[\t\r\n]+', ' ', c) for c in chunks_of(text, args.chunk_chars)][:60]
                parts = parts[: args.chunks - total]
                if not parts:
                    break
                pf.write(f'{pages}\twiki/{wid}\t{len(parts)}\n')
                cf.write('\n'.join(parts) + '\n')
                pages += 1
                total += len(parts)
                if total >= args.chunks:
                    break
            print(f'shard {shard}: {pages} pages, {total} chunks', flush=True)
            if total >= args.chunks:
                break


if __name__ == '__main__':
    main()
