# Running real-world eval benchmarks against your gbrain changes

Audience: gbrain maintainers and contributors. If you're touching retrieval
(search, ranking, embeddings, intent classification, query expansion, source
boost, hybrid fusion), this is the doc.

For the **NDJSON wire format** consumed by gbrain-evals, see
[`eval-capture.md`](./eval-capture.md). This doc is the human dev loop
that lives on top of that format.

## Prerequisite: turn on contributor mode

Capture is **off by default** for production users (privacy-positive — no
surprise data accumulation). Contributors flip it on with one line:

```bash
# In ~/.zshrc or ~/.bashrc:
export GBRAIN_CONTRIBUTOR_MODE=1
```

Verify:

```bash
gbrain query "anything" >/dev/null
psql $DATABASE_URL -c 'SELECT count(*) FROM eval_candidates'   # should be > 0
```

To override (force on/off regardless of env var), edit `~/.gbrain/config.json`:

```json
{"eval": {"capture": true}}    // force on
{"eval": {"capture": false}}   // force off
```

Explicit config beats the env var both directions.

## The 4-command loop

```bash
# ① Capture: writes to eval_candidates whenever CONTRIBUTOR_MODE is set.
#   Inspect what's been collected:
gbrain doctor                                     # surfaces capture failures
psql $DATABASE_URL -c 'SELECT count(*) FROM eval_candidates'

# ② Snapshot: freeze a baseline before your code change.
gbrain eval export --since 7d > baseline.ndjson

# ③ Code change: do whatever you want — tune RRF_K, swap embed model, edit
#    hybrid.ts, add a new boost source, change the intent classifier.

# ④ Replay: re-run every captured query against the current build.
gbrain eval replay --against baseline.ndjson
```

Output:

```
Replaying 247 captured queries…
  ...25/247
  ...50/247
  ...
Replayed 247 of 247 captured queries (0 skipped, 0 errored)
Mean Jaccard@k:    0.927
Top-1 stability:   91.5%
Mean latency Δ:    +14ms (current vs captured)

Top 5 regression(s):
  jaccard=0.20  captured=12  current=3   "find every reference to widget-co"
  jaccard=0.43  captured=14  current=8   "show me everything tagged for review"
  jaccard=0.50  captured=8   current=4   "what did alice say about the spec"
  ...
```

Three numbers tell you whether the change is safe to land:

| Metric | What it means | Healthy range |
|---|---|---|
| **Mean Jaccard@k** | Average overlap between captured retrieved slugs and current run's slugs. 1.0 = identical sets. | ≥0.85 for "neutral" changes. <0.7 means major retrieval shift. |
| **Top-1 stability** | Fraction of queries whose #1 result didn't change. | ≥85% for tuning passes. <70% means top-of-funnel broke. |
| **Mean latency Δ** | Current minus captured. Positive = slower now. | Within ±50ms of captured. >2× anywhere = regression alarm. |

## What it actually does

`gbrain eval replay` reads your NDJSON snapshot and, for each row:

1. Re-executes the same op (`searchKeyword` for `tool_name='search'`,
   `hybridSearch` for `tool_name='query'`) with the captured `detail` and
   `expand_enabled` values threaded back in.
2. Captures the current `retrieved_slugs` (deduped, in result order).
3. Computes set-Jaccard between captured and current slug sets.
4. Records top-1 match (was the #1 result the same slug?).
5. Records latency delta vs captured `latency_ms`.

It does NOT compute MRR or nDCG — those need ground-truth relevance labels,
not a baseline comparison. For metric-against-truth eval, use
`gbrain eval --qrels <path>` (the legacy IR-eval path, still supported). The
replay tool answers a different question: "did my code change move
retrieval, and which queries did it move most?"

## Best-effort by design

Replay is not pure. Three things can drift between capture and replay:

1. **Brain state** — your brain probably has more pages now than when the
   snapshot was taken. Unless you explicitly seed a fixed corpus, mean
   Jaccard will drop simply because new pages are eligible.
2. **Embedding source** — if you changed `OPENAI_API_KEY` between capture
   and replay (or the embedding model rotated), vector-path results drift
   even with identical code.
3. **Capture cap** — captured `retrieved_slugs` is a deduped set; it doesn't
   preserve internal ranking metadata. Two tools can return the same slug
   set with different scores — Jaccard will say 1.0, but a downstream
   consumer that orders by score may behave differently.

The metrics are **regression alarms on real queries**, not a hash check.
Pair them with manual inspection of the top regressions.

## Cost

Every `query` row in the snapshot embeds the query string via OpenAI to run
the vector half of `hybridSearch`. Cost is identical to a normal `gbrain
query` invocation — text-embedding-3-large at OpenAI list price, batched
inside a single replay row.

If you're iterating locally and don't want to pay per change, use
`--limit 50` to cap rows replayed. The 50 most recent rows are usually
enough to catch direction; expand for the final pre-merge run.

```bash
# Iteration mode — 50 most recent queries
gbrain eval replay --against baseline.ndjson --limit 50

# Pre-merge — full snapshot
gbrain eval replay --against baseline.ndjson --top-regressions 20
```

## CI integration

```bash
gbrain eval replay --against baseline.ndjson --json > replay.json
jq -e '.summary.mean_jaccard >= 0.85' replay.json || exit 1
jq -e '.summary.top1_stability_rate >= 0.85' replay.json || exit 1
```

Stable JSON shape (schema_version: 1):

```json
{
  "schema_version": 1,
  "summary": {
    "rows_total": 247,
    "rows_replayed": 247,
    "rows_skipped": 0,
    "rows_errored": 0,
    "mean_jaccard": 0.927,
    "top1_stability_rate": 0.915,
    "mean_latency_delta_ms": 14,
    "rows_over_2x_latency": 0
  }
}
```

`--verbose` adds a `results: [...]` array with one entry per replayed row
(useful for piping into jq or a notebook for deeper analysis).

## When to run this

Before merging anything that touches:

- `src/core/search/hybrid.ts` (RRF, fusion, dedup, two-pass retrieval)
- `src/core/search/source-boost.ts` / `sql-ranking.ts` (per-source ranking)
- `src/core/search/intent.ts` (auto-detail classification)
- `src/core/search/expansion.ts` (Haiku query expansion)
- `src/core/search/dedup.ts` (cross-page result collapse)
- `src/core/embedding.ts` or any embedding model swap
- `src/core/operations.ts` `query` or `search` op handlers (capture surface)
- `src/core/postgres-engine.ts` / `pglite-engine.ts` `searchKeyword` /
  `searchVector` SQL

Skip for: schema-only migrations, doc changes, tests-only PRs, CLI ergonomics
that don't touch retrieval.

## Building your own corpus

If you don't have captured traffic yet (fresh install, can't dogfood for a
week before merging), you can hand-author an NDJSON file:

```jsonl
{"schema_version":1,"id":1,"tool_name":"query","query":"who is alice","retrieved_slugs":["people/alice","people/alice-bio"],"expand_enabled":false,"detail":null,"latency_ms":0,"remote":false}
{"schema_version":1,"id":2,"tool_name":"search","query":"acme deal","retrieved_slugs":["deals/acme-seed","companies/acme"],"latency_ms":0,"remote":false}
```

Then run `gbrain eval replay --against handcrafted.ndjson` to confirm the
authoritative slugs come back. This is the seam between the BrainBench-Real
pipeline (replay against live captures) and the BrainBench fixed-fixture
pipeline (`gbrain eval --qrels` with the sibling
[gbrain-evals](https://github.com/garrytan/gbrain-evals) corpus).

## Off-switch

Two ways to disable capture:

```bash
unset GBRAIN_CONTRIBUTOR_MODE             # easy: just unset the env var
```

Or force off regardless of the env var via `~/.gbrain/config.json`:

```json
{"eval": {"capture": false}}
```

Existing `eval_candidates` rows stay until you `gbrain eval prune
--older-than 0d` (or just drop the table).

## Failure modes

| What you see | What it means |
|---|---|
| `Mean Jaccard@k: 0.4`, top regressions all in one source dir | Source boost or hard-exclude regression on that prefix |
| `Top-1 stability: 30%`, mean Jaccard still high | RRF tuning shifted the rank order without changing the set — re-tune `rrfK` |
| `Mean latency Δ: +500ms`, jaccard high | Vector path got slower; check embedding API or HNSW probes |
| `rows_errored > 0` | One or more queries threw. Inspect first 3 in human output, or `--json` to see all `error_message` fields |
| Many `skipped: empty query` | Capture ran on rows where someone passed empty `query` — check why those were captured |
