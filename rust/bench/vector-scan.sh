#!/usr/bin/env bash
# Vector-search bench step: one `searchVector` (and the `cosinesByChunkIds` re-score the hybrid
# pipeline sends after it) on an invented brain, before and after the bounded scan.
#
# "Before" is the full scan (`GBRAIN_RUST_VECTOR_SCAN=full`), the path every call took before the
# bounded scan; "after" is the default path. Both run the same binary on the same store, one fresh
# process each. The tool is `rust/crates/gbrain-store/examples/vector_scale.rs`; its header
# explains the corpus, the modes and what `verify` compares.
#
# Usage (from anywhere): rust/bench/vector-scan.sh [sizes=10000,50000] [queries=40] [limit=50]
# Env: VECTOR_BENCH_DIR  scratch root (default: ${TMPDIR:-/var/tmp}). The script makes a new
#                        directory inside it, writes the stores there and deletes only that
#                        directory at the end; nothing else under the root is touched.
#      VECTOR_BENCH_VERIFY=0  skip the byte-for-byte comparison of the two paths.
# Prints one line per (size, filter, path) and a summary table: machine, pages, chunks, N, p50/p99.
set -euo pipefail

sizes="${1:-10000,50000}"
queries="${2:-40}"
limit="${3:-50}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="${VECTOR_BENCH_DIR:-${TMPDIR:-/var/tmp}}"
mkdir -p "$scratch"
root="$(mktemp -d "$scratch/gbrain-vector-bench.XXXXXX")"
trap 'rm -rf "$root"' EXIT

(cd "$here" && cargo build --release --locked -q -p gbrain-store --example vector_scale)
tool="$here/target/release/examples/vector_scale"
results="$root/results.jsonl"
: >"$results"

for size in ${sizes//,/ }; do
  store="$root/store-$size"
  echo "loading $size pages into $store" >&2
  "$tool" load "$store" "$size" 2 1536 >"$root/load-$size.json"
  for filter in none small-source type; do
    GBRAIN_RUST_VECTOR_SCAN=full "$tool" run "$store" "$queries" "$limit" "$filter" >>"$results"
    "$tool" run "$store" "$queries" "$limit" "$filter" >>"$results"
  done
  if [ "${VECTOR_BENCH_VERIFY:-1}" != 0 ]; then
    echo "verify $size (bounded scan against the full scan, full result bytes)" >&2
    "$tool" verify "$store" 10 | tee "$root/verify-$size.json" | head -c 400 >&2
    echo >&2
  fi
  rm -rf "$store"
done

python3 - "$results" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
m = rows[0]["machine"]
print(f"machine: {m['cpu']}, {m['cores']} cores, {m['mem_gib']} GiB; dims {rows[0]['dims']}; limit {rows[0]['limit']}")
print("| pages | chunks | filter | N | searchVector before p50/p99 ms | after p50/p99 ms | cosinesByChunkIds p50 ms |")
print("|---|---|---|---|---|---|---|")
by = {}
for r in rows:
    by[(r["pages"], r["filter"], r["scan"])] = r
for (pages, flt, scan), r in sorted(by.items()):
    if scan != "full":
        continue
    a = by.get((pages, flt, "default"))
    b, s = r["search_vector_ms"], (a or {}).get("search_vector_ms", {})
    print(f"| {pages} | {r['chunks']} | {flt} | {r['n']} | {b['p50']:.1f} / {b['p99']:.1f} | "
          f"{s.get('p50', float('nan')):.1f} / {s.get('p99', float('nan')):.1f} | {(a or r)['cosines_ms']['p50']:.1f} |")
PY
