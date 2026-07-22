# Running real-world eval benchmarks against your gbrain changes

Audience: gbrain maintainers and contributors. If you're touching retrieval
(search, ranking, embeddings, intent classification, query expansion, source
boost, hybrid fusion), this is the doc.

For the **NDJSON wire format** consumed by gbrain-evals, see
[`eval-capture.md`](./eval-capture.md). This doc is the human dev loop
that lives on top of that format.

## v0.41 update — the LOOP is now real

Before v0.41, you could capture eval rows and replay them but nothing
stitched them into a gate. `gbrain bench publish` + `gbrain eval gate`
close the loop. Two gates:

- **Regression gate** (`--baseline X.baseline.ndjson`): replays a baseline
  you captured against your current brain. Catches: "did my refactor break
  search?" Compares jaccard / top-1 stability / latency multiplier.
- **Correctness gate** (`--qrels Y.qrels.json`): runs known-right queries
  against your current brain via bare `hybridSearch`. Catches: "is my
  retrieval actually any good?" Computes recall@K, first-relevant-hit-rate,
  expected_top1-hit-rate.

Both can be passed together; both must pass for verdict `pass`. At least
one is required.

### The full LOOP for your own brain

```bash
# 1. Capture (one-time; uses queries already in eval_candidates)
gbrain eval export --limit 200 --tool query > /tmp/captured.ndjson

# 2. Publish a baseline
mkdir -p ~/.gbrain/baselines
gbrain bench publish --from /tmp/captured.ndjson --to ~/.gbrain/baselines/personal.baseline.ndjson --label "personal-$(date +%Y%m%d)"

# 3. Gate against it
gbrain eval gate --baseline ~/.gbrain/baselines/personal.baseline.ndjson
```

### Privacy posture (D9)

**Public baselines in `gbrain-evals` are hermetic-synthetic ONLY.** Real
user captures stay local in `~/.gbrain/baselines/`. The boundary is
enforced at the file source, not by post-hoc scrubbing. If you publish a
baseline to `gbrain-evals`, generate it from a fixture-seeded test brain
(placeholder names like `alice-example`, `widget-co-example`) — never
from a real user's `eval_candidates` table.

### Deterministic-pipeline disclosure

`gbrain eval gate --qrels` uses bare `hybridSearch` (not the production
`query` op handler). This is deliberate: gates need to be deterministic in
CI. Production retrieval differs via the query cache, salience freshness,
expansion, etc. The gate measures retrieval quality with a fixed pipeline;
your users may see different results when the cache is warm.

### `.qrels.json` shape

Two equivalent representations per entry:

```json
{
  "schema_version": 1,
  "queries": [
    {
      "query_id": "q1",
      "query": "fintech founder",
      "relevant_slugs": ["people/alice-example"],
      "first_relevant_slug": "people/alice-example"
    }
  ]
}
```

For federated / multi-source brains, use the explicit shape (no defaults
to `source_id='default'`):

```json
{
  "query_id": "q2",
  "query": "anything",
  "relevant": [
    {"source_id": "host", "slug": "people/alice"},
    {"source_id": "team-a", "slug": "people/alice"}
  ],
  "expected_top1": {"source_id": "host", "slug": "people/alice"}
}
```

Without `source_id`, a hit from the wrong source could false-pass the
gate. The compare everywhere is `${source_id}::${slug}` strings.

### Example GitHub Actions workflow

```yaml
name: gbrain-eval-gate
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: |
          # Run both gates; CI fails on any breach.
          gbrain eval gate \
            --baseline gbrain-evals/baselines/v0.41-launch.baseline.ndjson \
            --qrels gbrain-evals/qrels/v0.41-launch.qrels.json \
            --json | tee /tmp/gate.json
```

---

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

For a third evaluation axis — public benchmark, ground-truth labels, full
question-answer pipeline (not just retrieval) — `gbrain eval longmemeval
<dataset.jsonl>` (v0.28.8) runs the LongMemEval benchmark against gbrain's
hybrid retrieval. Each question gets a clean in-memory PGLite, its haystack
imported, the question asked, the hypothesis emitted as JSONL — exactly the
shape LongMemEval's `evaluate_qa.py` consumes. Your `~/.gbrain` brain is
never opened. See `## Public benchmarks: LongMemEval` below.

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

## Public benchmarks: LongMemEval (v0.28.8)

`gbrain eval longmemeval` runs the public [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval)
benchmark directly against gbrain's hybrid retrieval. Different evaluation
axis from `eval replay`: public dataset with ground-truth labels, end-to-end
question-answer pipeline, hermetic per-question brains.

```bash
# Download the dataset (visit the HF page in a browser; gated/manual download).
# Place longmemeval_oracle.json (or _s.json) somewhere local.

# Retrieval-only (no LLM answer-gen, fastest path, no Anthropic key needed):
gbrain eval longmemeval ./longmemeval_oracle.json --limit 50 --retrieval-only \
  > /tmp/hypothesis.jsonl

# Full pipeline (Anthropic key required for answer-gen):
gbrain eval longmemeval ./longmemeval_oracle.json --limit 50 \
  > /tmp/hypothesis.jsonl

# Score with LongMemEval's published evaluate_qa.py (not bundled — needs
# OpenAI gpt-4o per their spec):
python evaluate_qa.py /tmp/hypothesis.jsonl
```

### Architecture (read this if you're touching the harness)

- One in-memory PGLite per benchmark run via `createBenchmarkBrain` +
  `withBenchmarkBrain`. Your `~/.gbrain` is never opened.
- Between questions: `TRUNCATE` over runtime-enumerated `pg_tables`, NOT a
  hardcoded list — schema migrations don't silently leak data across
  questions. Infrastructure tables (`sources`, `config`,
  `gbrain_cycle_locks`, `subagent_rate_leases`) are preserved across resets.
- Sanitization parity: re-uses `INJECTION_PATTERNS` from
  `src/core/think/sanitize.ts` so adding a new injection pattern
  automatically covers takes AND benchmarks. One source of truth.
- Retrieved chat content is wrapped in `<chat_session id="..." date="...">`
  framing; the answer-gen system prompt declares the content UNTRUSTED.
  Same posture as `<take>` framing.
- LLM injection seam: `runEvalLongMemEval(args, {client?: ThinkLLMClient})`.
  Tests stub the client so the full pipeline runs hermetically without any
  API key.

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `--limit N` | run all | Cap question count (iterate fast) |
| `--retrieval-only` | off | Emit retrieved chunks; no LLM answer-gen |
| `--keyword-only` | off | Disable vector path (debug retrieval issues) |
| `--expansion` | **off** | Multi-query expansion. Off by default for determinism (no per-query Haiku call). Pass to opt in. |
| `--top-k K` | 10 | Retrieval depth |
| `--model M` | resolved | Default resolves through `resolveModel()` 6-tier chain (`models.eval.longmemeval` config key) |
| `--output FILE` | stdout | Write hypothesis JSONL to file instead of stdout |

### Numbers

p50 25.9ms / p99 30.3ms warm reset+import+search on Apple Silicon (per the
`test/eval-longmemeval.test.ts` perf gate). Per-question cost well under the
500ms speed gate. 500 questions = ~13s of overhead plus your retrieval and
LLM latency.

## Measuring brain consistency over time (v0.32.6)

`gbrain eval suspected-contradictions` is a complementary measurement
instrument: it samples retrieval results for unmarked semantic
contradictions (e.g., compiled_truth vs chat content, intra-page chunk
vs active take). Where LongMemEval measures retrieval correctness on a
fixed labeled set, the contradiction probe measures how often a real
brain surfaces conflicting answers.

### Recommended nightly cadence

```bash
# Once a day, against your top 50 most-frequent queries:
gbrain eval suspected-contradictions \
  --queries-file ~/.gbrain/queries.jsonl \
  --top-k 5 \
  --budget-usd 5 \
  --output ~/.gbrain/probe-runs/$(date +%Y-%m-%d).json
```

Persistent cache (`eval_contradictions_cache`) makes re-runs near-zero
cost until you bump `PROMPT_VERSION`. Trend-track via:

```bash
gbrain eval suspected-contradictions trend --days 30
```

The ASCII bar chart shows total flagged per day. Headline % surfaces in
`gbrain doctor`'s `contradictions` check with paste-ready resolution
commands per high-severity finding.

### See also

- `docs/contradictions.md` — architecture, severity rubric, action criteria.
- CHANGELOG `## [0.32.6]` — full release notes including the bigger-swing
  decision criteria gated on Wilson CI lower-bound.

## v0.40.1.0 Track D — Eval infrastructure

Three eval surfaces grew non-trivial capabilities in v0.40.1.0. This section
covers the dev loop that uses them and the gates they enforce.

### `gbrain eval longmemeval --by-type` — per-question-type R@k breakdown

LongMemEval has always computed per-question-type recall internally; v0.40.1.0
surfaces it in machine-readable form. Two additive changes:

1. Every per-question JSONL row now includes a `question: string` field so the
   `gbrain eval cross-modal --batch` consumer (below) can read it without
   joining back against the source dataset.
2. New `--by-type` flag emits a final aggregate line keyed by `question_type`:

```json
{"schema_version": 1, "kind": "by_type_summary",
 "recall_by_type": {"single-session-user": {"hit": 18, "total": 19, "rate": 0.947}},
 "aggregate": {"hit": 110, "total": 120, "rate": 0.917}}
```

**Resume-safe.** When `--resume-from` is the same path as `--output`, the
summary is rebuilt from the file (each per-row includes `question_type` and
`recall_hit`) so the final aggregate covers all resumed questions, not just
this run's slice. The prior summary at the file tail is replaced, not
appended — a brain that resumes 5 times across a 500-question run ends with
exactly ONE summary at the tail.

**Optional gate.** `--by-type-floor 0.85` exits non-zero when any
`question_type`'s rate falls below 0.85. Default: informational only.

```bash
# Diagnose per-type ranking quality after a search-touching change.
gbrain eval longmemeval ~/datasets/longmemeval_s.jsonl \
  --by-type --output /tmp/run.jsonl
tail -1 /tmp/run.jsonl | jq .   # summary line

# Strict gate in a CI script.
gbrain eval longmemeval test/fixtures/longmemeval-mini.jsonl \
  --by-type --by-type-floor 0.80 --output /tmp/run.jsonl
echo "exit=$?"  # 1 if any type fell below 0.80
```

### Hermetic retrieval gate — `test/eval-replay-gate.test.ts`

The v0.40.1.0 Track D structural fix for "PRs touching `src/core/search/`
silently regress retrieval." Replaces the original "replay against captured
eval_candidates" design (which Codex caught as non-functional in CI — see
the `v0.41+: contributor-mode CI capture` TODO in `TODOS.md` for the deferred
real-query version).

How it works:
- Hand-curated qrels fixture at `test/fixtures/eval-baselines/qrels-search.json`
  with PLACEHOLDER names only (no real people / companies per CLAUDE.md privacy
  rule).
- The test seeds a PGLite engine with synthetic pages whose embeddings are
  basis vectors (the same `basisEmbedding(idx)` pattern as
  `test/e2e/search-quality.test.ts`). No API keys, no DATABASE_URL.
- For each qrels query, calls `engine.searchVector(basisEmbedding(dim))` and
  computes `top1_match_rate` and `recall@10`. Asserts both meet floors
  (`>= 0.80` and `>= 0.85` by default).
- Lives in the unit-shard test matrix (`.github/workflows/test.yml`) so it
  runs on every PR via `bun test`, NOT in the E2E fixed-file workflow.

#### Refreshing the qrels fixture (the `Why:` discipline, D4)

When CI fails because a legitimate ranking change moved expected slugs, the
fix is to edit `qrels-search.json` directly. **Always include a `Why:` line
in the commit body** so future maintainers can read the audit trail. Without
the `Why:`, the gate degrades to a rubber stamp within months. The convention
is informational (not a commit-hook block), but enforce it in PR review.

Example commit body:

```
chore(eval): refresh qrels for new source-boost ordering

Why: v0.40.x source-boost now weights originals/ over concepts/, so
q12 (founder-mode) now correctly surfaces originals/founder-mode-example
top-1. Manual verification: ran the production query; new ranking is
clearly better-aligned with the query intent.
```

#### Env-overrides for floors

```bash
GBRAIN_REPLAY_GATE_TOP1_FLOOR=0.85 \
GBRAIN_REPLAY_GATE_RECALL_FLOOR=0.90 \
  bun test test/eval-replay-gate.test.ts
```

Use to tighten or loosen the gate as the qrels fixture matures.

### `gbrain eval cross-modal --batch` — batch quality scoring

Single-task cross-modal eval scores one (task, output) pair. Batch mode runs
the same scoring over an entire LongMemEval JSONL output, with cost guardrails.

```bash
# Step 1: produce LongMemEval hypotheses (real cost: depends on model + N).
gbrain eval longmemeval ~/datasets/longmemeval_s.jsonl \
  --limit 10 --output /tmp/run.jsonl

# Step 2: batch-score those hypotheses (real cost: ~$0.70 for 10 questions,
# 1 cycle, 3 model slots at default --max-usd 5 budget cap).
gbrain eval cross-modal --batch /tmp/run.jsonl \
  --limit 10 --cycles 1 --concurrent 3 --max-usd 5 --json
echo "exit=$?"  # 0=all-pass, 1=any-fail, 2=any-error-or-inconclusive
```

**Key behaviors:**
- Default `--cycles 1` in batch mode (single-task default is 3 in TTY) to bound
  cost. Pass `--cycles 3` to match single-task strictness.
- `--concurrent 3` runs up to 3 questions in parallel x 3 model slots each =
  9 simultaneous API calls. Below tier-1 rate limits for all three providers.
- `--max-usd FLOAT` refuses to start if the pre-flight cost estimate exceeds
  the cap, unless `--yes` bypasses (required for non-interactive cron / CI).
- Filters `kind: "by_type_summary"` rows automatically (the LongMemEval
  `--by-type` summary line is metadata, not a question).
- `--batch` is mutually exclusive with `--task`; fail-fast usage error if both
  are set.
- Exit precedence (fail-loud): ERROR > FAIL > INCONCLUSIVE > PASS.
- Per-question receipts land in a tempdir and are deleted at end of batch; the
  summary inlines per-question verdicts so the audit trail is self-contained.

### Nightly cross-modal quality probe (opt-in, autopilot)

`src/core/cycle/nightly-quality-probe.ts` ships a phase that runs the longmemeval
+ cross-modal pipeline once per 24h. **Disabled by default** to avoid surprise
API spend. Enable per-host:

```bash
gbrain config set autopilot.nightly_quality_probe.enabled true
gbrain config set autopilot.nightly_quality_probe.max_usd 5.00   # optional override
```

Note: `--phase nightly_quality_probe` wiring into the autopilot scheduler is
deferred to a v0.41+ follow-up (see TODOS.md). For now the phase is callable
in isolation; the test harness exercises it via DI stubs.

```bash
# Manual smoke (exercises the path via DI stubs, no real API spend).
bun test test/nightly-quality-probe.test.ts
```

Observability:
- `~/.gbrain/audit/quality-probe-YYYY-Www.jsonl` — one event per run with
  outcome (pass / fail / inconclusive / error / budget_exceeded /
  rate_limited / no_embedding_key), pass/fail/inconclusive/error counts,
  est_cost_usd, fixture_sha8. ISO-week rotation (mirrors slug-fallback
  audit).
- `gbrain doctor` surfaces `nightly_quality_probe_health`:
  - SKIPPED (disabled) — with paste-ready enable command.
  - OK (enabled, no events yet) — autopilot hasn't fired its first run.
  - OK (last 7d all PASS) — with timestamp of latest run.
  - WARN — any FAIL / ERROR / BUDGET_EXCEEDED in the window, with outcome
    counts and the latest run's reason.

Real expected cost: ~$0.35 per nightly run (5 questions x 3 slots x 1 cycle
x ~$0.02/call) ≈ $10.50/month. Worst-case under the default budget cap:
$150/month. Opt-in default prevents discovering this in your card statement.
