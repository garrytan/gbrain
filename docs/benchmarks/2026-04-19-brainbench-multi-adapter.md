# BrainBench — multi-adapter side-by-side (2026-04-19)

**Branch:** `garrytan/gbrain-evals`
**Commit:** `b81373d`
**Engine:** PGLite (in-memory)
**Corpus:** `eval/data/world-v1/` (240 rich-prose fictional pages, committed)
**Runner:** `bun run eval:run` (N=5, page-order shuffled per run, seeded LCG)
**Wall time:** ~11.5 min

## Headline

| Adapter          | Runs | Queries | P@5          | R@5          | Correct in top-5 (run 1) |
|------------------|------|---------|--------------|--------------|--------------------------|
| **gbrain-after** | 5    | 145     | **49.1%** ±0 | **97.9%** ±0 | **248 / 261**            |
| hybrid-nograph   | 5    | 145     | 17.8%        | 65.1%        | 129 / 261                |
| ripgrep-bm25     | 5    | 145     | 17.1%        | 62.4%        | 124 / 261                |
| vector-only      | 5    | 145     | 10.8%        | 40.7%        | 78 / 261                 |

Stddev = 0 across all adapters this run — every adapter is deterministic over
page ordering. That's the correct signal for the shipped code (non-zero would
surface an order-dependent tie-break bug).

### Deltas vs gbrain-after

- hybrid-nograph: P@5 **−31.4 pts**, R@5 **−32.9 pts**, correct-in-top-5 **−119**
- ripgrep-bm25:   P@5 **−32.0 pts**, R@5 **−35.5 pts**, correct-in-top-5 **−124**
- vector-only:    P@5 **−38.4 pts**, R@5 **−57.2 pts**, correct-in-top-5 **−170**

### Per-adapter wall time (5 runs)

| Adapter        | Time    | Per run | Notes                                    |
|----------------|---------|---------|------------------------------------------|
| gbrain-after   | 7.4s    | ~1.5s   | PGLite + extract (graph) + grep fallback |
| hybrid-nograph | 555.1s  | ~111s   | Re-embeds 240 pages every run            |
| ripgrep-bm25   | 0.1s    | ~20ms   | Pure in-memory term matching             |
| vector-only    | 131.8s  | ~26s    | Embeds once, cosine per query            |

## What this confirms

The graph layer is doing the work.

`hybrid-nograph` is gbrain's own hybrid retrieval stack with the graph disabled —
same embedder, same chunking, same RRF, same codebase. It lands at 17.8% P@5,
barely a point above classic BM25. Add typed-edge traversal back in and P@5
jumps to 49.1%. That's **+31.4 points from the graph alone**, holding everything
else constant.

Vector-only is the worst on these relational queries. Cosine similarity over
bio prose doesn't know that "Carol Wilson" appearing in a paragraph about
Anchor means she's employed there — it ranks by semantic neighborhood, which
puts other engineering people at other startups ahead of actual coworkers.
40.7% R@5 is the floor.

## Reproducibility

```sh
# From a clean checkout at commit b81373d
export OPENAI_API_KEY=sk-proj-...   # embedding-based adapters need this
bun install
bun run eval:run
```

Deterministic adapters (`gbrain-after`, `ripgrep-bm25`, `vector-only`) match
this scorecard byte-for-byte. `hybrid-nograph` matches within tolerance bands
(N=5 smooths embedding nondeterminism).

For faster iteration: `BRAINBENCH_N=1 bun run eval:run:dev` (one run per adapter,
~2 min total).

## Methodology

- **Corpus:** 240 Opus-generated fictional biographical pages — 80 people, 80
  companies, 50 meetings, 30 concepts. Committed at
  `eval/data/world-v1/`, zero private data, no regen needed.
- **Gold:** 145 relational queries derived from each page's `_facts` metadata
  — "Who attended X?", "Who works at X?", "Who invested in X?", "Who advises X?"
  No `_facts` ever cross the adapter boundary; adapters see raw prose only
  (enforced structurally in `Adapter.init`).
- **Metrics:** mean P@5 and R@5. Top-5 is what agents actually read in ranked
  results.
- **N=5 runs per adapter**, page ingestion order shuffled with a per-run seed
  (`shuffleSeeded`, LCG). Stddev surfaces order-dependent bugs. Zero stddev on
  deterministic adapters is the expected-correct signal.
- **Temporal queries** (none in this 145-query set) require explicit
  `as_of_date`, validated at query-authoring time.

## Notes

- This is a reproduction of the multi-adapter scorecard shipped with the
  eval harness at `b81373d`. Numbers match the README table exactly for
  `gbrain-after`, `ripgrep-bm25`, `vector-only` (deterministic) and are within
  tolerance for `hybrid-nograph` (embedder nondeterminism).
- `bun run eval:run` exits with code 99 at the very end despite printing the
  full scorecard cleanly. Tracked separately; the metrics above are all from
  the completed run.
- For the BEFORE/AFTER PR #188 evaluation (graph layer vs no graph layer on
  an earlier commit), see `2026-04-18-brainbench-v1.md`. This file is the
  neutrality scorecard — gbrain compared to external baselines anyone could
  reimplement.
