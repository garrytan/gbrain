#!/usr/bin/env python
"""
Phase 2 of the 3-phase embed-recovery: read stale-chunks JSONL, call OpenAI
in parallel with reliable timeouts, write (id, vec) JSONL.

Why Python: bun on Windows has been observed to hang indefinitely on fetch
calls with AbortSignal not firing, and Bun.spawn'ing curl hit Windows EPERM
after a few hundred invocations. Python's requests + ThreadPoolExecutor
uses socket-level timeouts that work reliably.

Usage:
    python embed-phase2-call-openai.py <input.jsonl> <output.jsonl>

Env:
    OPENAI_API_KEY    required
    PARALLEL          default 2 (TPM-bound at tier 5)
    MAX_BATCH_TOKENS  default 180000
"""
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

import requests
import tiktoken

# Lazy tokenizer — required for accurate token-aware truncation. Dense CSV
# and CJK content can hit 2.5 tokens/char, blowing past the 8192-token
# per-input cap on text-embedding-3-large even after char-based truncation.
_ENC = tiktoken.encoding_for_model("text-embedding-3-large")

API_KEY = os.environ.get("OPENAI_API_KEY")
if not API_KEY:
    print("OPENAI_API_KEY not set", file=sys.stderr)
    sys.exit(1)

PARALLEL = int(os.environ.get("PARALLEL", "2"))
MAX_BATCH_TOKENS = int(os.environ.get("MAX_BATCH_TOKENS", "180000"))
MAX_BATCH_ROWS = 2048
MAX_INPUT_TOKENS = 8000
CALL_TIMEOUT = 60  # seconds

INPUT_PATH = sys.argv[1]
OUTPUT_PATH = sys.argv[2]


def est_tokens(text):
    # For packing only — fast char-based estimate. truncate() uses tiktoken
    # for exact bounds.
    return (len(text) + 2) // 2.5


def truncate(text, max_tokens=MAX_INPUT_TOKENS):
    # Use tiktoken for an exact token cap. Char-based truncation fails on
    # CJK / multi-byte content where tokens-per-char can exceed 2.5.
    tokens = _ENC.encode(text)
    if len(tokens) <= max_tokens:
        return text
    return _ENC.decode(tokens[:max_tokens])


def parse_retry_after(msg):
    m = re.search(r"try again in (\d+)ms", msg, re.I)
    if m:
        return int(m.group(1))
    m = re.search(r"try again in ([\d.]+)s", msg, re.I)
    if m:
        return int(float(m.group(1)) * 1000)
    return None


def make_batches(chunks):
    """Pack chunks into batches under MAX_BATCH_TOKENS."""
    batches = []
    current = []
    current_tokens = 0
    for c in chunks:
        t = min(est_tokens(c["text"]), MAX_INPUT_TOKENS)
        if current and (current_tokens + t > MAX_BATCH_TOKENS or len(current) >= MAX_BATCH_ROWS):
            batches.append(current)
            current = []
            current_tokens = 0
        current.append(c)
        current_tokens += t
    if current:
        batches.append(current)
    return batches


def call_openai(inputs):
    """Make a single OpenAI embeddings call with 429 retry. Returns list of vectors."""
    for attempt in range(1, 7):
        try:
            r = requests.post(
                "https://api.openai.com/v1/embeddings",
                headers={
                    "Authorization": f"Bearer {API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "text-embedding-3-large",
                    "input": inputs,
                    "dimensions": 1536,
                },
                timeout=CALL_TIMEOUT,
            )
        except requests.exceptions.Timeout:
            if attempt < 6:
                print(f"  [timeout] attempt {attempt}, retrying", flush=True)
                continue
            raise
        except requests.exceptions.RequestException as e:
            if attempt < 6:
                print(f"  [conn error] {e}, retrying", flush=True)
                time.sleep(1)
                continue
            raise

        if r.status_code == 429:
            retry_ms = parse_retry_after(r.text) or 1000
            jittered_ms = int(retry_ms * (1 + 0.4 * (hash(str(inputs[:1])) % 100) / 100))
            print(f"  [429] retry in {jittered_ms}ms (attempt {attempt})", flush=True)
            time.sleep(jittered_ms / 1000.0)
            continue
        if r.status_code >= 400:
            raise Exception(f"HTTP {r.status_code}: {r.text[:200]}")
        return [d["embedding"] for d in r.json()["data"]]
    raise Exception("retries exhausted")


def main():
    chunks = []
    with open(INPUT_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                chunks.append(json.loads(line))
    print(f"Loaded {len(chunks)} stale chunks from {INPUT_PATH}")

    batches = make_batches(chunks)
    total_batches = len(batches)
    print(f"Packed into {total_batches} batches (avg {len(chunks) // max(total_batches, 1)} chunks each)")

    completed = 0
    errors = 0
    lock = Lock()
    start = time.time()

    out = open(OUTPUT_PATH, "w", encoding="utf-8")

    def process_batch(batch):
        nonlocal completed, errors
        batch_start = time.time()
        try:
            inputs = [truncate(c["text"]) for c in batch]
            vectors = call_openai(inputs)
            if len(vectors) != len(batch):
                raise Exception(f"mismatch: {len(vectors)} vs {len(batch)}")
            with lock:
                for i, c in enumerate(batch):
                    out.write(json.dumps({"id": c["id"], "vec": vectors[i]}) + "\n")
                out.flush()
                completed += len(batch)
                dt = time.time() - batch_start
                total_dt = time.time() - start
                rate = completed / total_dt
                remaining = len(chunks) - completed
                eta_min = remaining / max(rate, 0.001) / 60
                print(
                    f"  OK {dt:.1f}s | done={completed}/{len(chunks)} "
                    f"({completed/len(chunks)*100:.1f}%) avg={rate:.1f}/s eta={eta_min:.1f}min",
                    flush=True,
                )
        except Exception as e:
            with lock:
                errors += 1
                dt = time.time() - batch_start
                print(f"  FAIL {dt:.1f}s ({len(batch)} chunks, first id {batch[0]['id']}): {e}", flush=True)

    with ThreadPoolExecutor(max_workers=PARALLEL) as ex:
        futures = [ex.submit(process_batch, b) for b in batches]
        for fut in as_completed(futures):
            try:
                fut.result()
            except Exception as e:
                print(f"  unhandled: {e}", flush=True)

    out.close()
    total_dt = time.time() - start
    print(
        f"\nDone. Embedded {completed}/{len(chunks)} in {total_dt:.1f}s "
        f"(avg {completed/total_dt:.1f}/s). Errors: {errors}. Output: {OUTPUT_PATH}"
    )


if __name__ == "__main__":
    main()
