# Search Mode Evaluation Methodology

_How v0.32.3 measures the difference between `conservative`, `balanced`, and `tokenmax`. Written haters-immune: every claim is reproducible from the committed dataset + raw outputs._

## 1. What this measures and what it doesn't

**Measures:** retrieval quality and operational cost on fixed public datasets, under each named search mode, against the same brain content.

**Does NOT measure:**
- Your specific brain content (this is a benchmark, not your bill).
- Your specific query distribution.
- End-user satisfaction or downstream task success.
- Latency under concurrent load.
- Production cost (the cost numbers are model-pricing estimates × dataset size, not your actual API spend).

If you want to know how a mode behaves on YOUR brain, run `gbrain search stats --days 30` after a real usage window, then run `gbrain search tune` for actionable recommendations.

## 2. Datasets and sizes

- **LongMemEval** — public split, `n=500` questions. Downloaded from [Hugging Face](https://huggingface.co/datasets/xiaowu0162/longmemeval). The corpus + answer keys are pinned to a specific commit; recorded in every per-run record.
- **Replay captures** — NDJSON from the sibling `gbrain-evals` repo, `n=200` queries. Each query carries a `retrieved_slugs` baseline + a `latency_ms` measurement from the original production run.
- **BrainBench v1** — `n=1240` documents / `n=350` qrels (binary relevance judgments). Lives in the sibling [`gbrain-evals`](https://github.com/garrytan/gbrain-evals) repo, SHA-pinned at every run.

No private brain content is used in any reported result. The committed NDJSON dumps under `<repo>/.gbrain-evals/` contain only the LongMemEval question IDs + the rank-ordered retrieved session IDs.

## 3. Sample selection

- **Random seed:** `42` throughout. Set via `--seed N` on `gbrain eval run-all`; recorded in every per-run record.
- **No per-question curation.** Splits are taken whole; no question is filtered for reporting.
- **No mode-specific tuning.** The same dataset + same seed feeds every mode. The mode is the only independent variable.
- **Stability across re-runs:** with `--seed 42` and the same dataset SHA, two runs of the same (mode, suite) produce identical retrieval orderings (modulo the optional Haiku expansion call, which is non-deterministic). Persisted in `eval_results` so anyone can re-score from the committed dumps.

## 4. Run procedure

The command is the doc. Anyone can reproduce.

```bash
# Setup: in your gbrain working tree, with OPENAI_API_KEY + ANTHROPIC_API_KEY exported.
git rev-parse HEAD  # record the commit for the methodology footer

# Sweep all 3 modes × 2 retrieval-focused suites with seed 42.
gbrain eval run-all \
  --modes conservative,balanced,tokenmax \
  --suites longmemeval,replay \
  --seed 42 \
  --limit 500 \
  --budget-usd-retrieval 5 \
  --budget-usd-answer 20 \
  --output docs/eval/results/v0.32.3/

# Render the comparison.
gbrain eval compare --md > docs/eval/results/v0.32.3/README.md
gbrain eval compare --json > docs/eval/results/v0.32.3/comparison.json
```

The orchestrator writes per-run records to `<repo>/.gbrain-evals/eval-results.jsonl`. Every record carries: `run_id`, `ran_at`, `suite`, `mode`, `commit`, `seed`, `limit`, `params`, `status`, `duration_ms`. The dumps under `docs/eval/results/v0.32.3/` carry the raw question-level outputs so a reviewer can re-score with their own metric implementation.

## 5. Threats to validity

Honest list. We name what would let a critic dismiss the numbers.

- **LongMemEval skews English + technical.** The questions are software-engineering and consumer-product flavored. Performance on a brain rich in non-English / non-technical content (writing, art history, etc.) may differ.
- **BrainBench is small** (1240 docs) relative to a production brain (10K-100K pages). Absolute scores aren't predictive of your hit rate; the _delta_ between modes is.
- **char/4 token heuristic.** Token-budget enforcement and cost estimates use a character-count / 4 heuristic. Accurate within ~5-10% for English with the OpenAI tiktoken family; off worse for Voyage (we don't use Voyage in chat retrieval, so it doesn't bias the reported numbers, but if you do, your budget caps will be approximate).
- **Expansion's quality lift varies by query distribution.** The eval data shows ~97.6% relative quality with LLM expansion vs without (i.e., barely measurable lift) on the LongMemEval corpus. On rarer-entity / longer-tail queries, the lift can be larger. We report the corpus we measured; YMMV.
- **Paired bootstrap assumes question-level independence.** Multi-hop questions within the same conversation thread aren't independent; the bootstrap CI is slightly tighter than reality.
- **Single brain instance per benchmark.** The benchmark spins up an in-memory PGLite per question. Cache hit rate measured here doesn't reflect a long-running production brain's cache state.

## 6. Per-question raw outputs

Every reported metric is reproducible from the NDJSON dumps committed at `docs/eval/results/v0.32.3/`. The commit SHA in the methodology footer pins the code version.

**Examples per mode:** the auto-generated `README.md` next to the dumps includes both winning and losing examples per mode, chosen by the deterministic rule:

- **Wins:** the 3 questions where this mode's score exceeded the next-best mode by the largest margin.
- **Losses:** the 3 questions where this mode's score fell short of the next-best mode by the largest margin.

Picked by the score delta, NOT cherry-picked by hand. The README documents the rule so a critic can verify.

## 7. Pre-registered expectations

Before running, we expect:

1. **tokenmax wins Recall@10** by 5-15 percentage points over conservative. LLM expansion + 50-result ceiling helps rare-entity surface forms.
2. **conservative wins cost-per-query** by 5-15× over tokenmax. No Haiku expansion + tight 4K budget cap = single-digit-cent queries.
3. **balanced lands within 3pp of tokenmax** on Recall@10. Intent weighting (zero-LLM cost) closes most of the expansion gap on common queries.
4. **No mode breaks nDCG@10 ≥ 0.65** — the published "ship it" threshold for hybrid retrieval on technical corpora.

Then we publish whether the data agrees. **If a hypothesis fails, that's documented honestly** in the release README, not buried. Pre-registration is what makes the comparison defensible — without it, a "we expected X and got X" outcome is observation, not prediction.

## 8. Re-run cadence

This document + the eval results are regenerated on every release that touches retrieval-affecting code. The `gbrain doctor eval_drift` check surfaces changes to the curated watch-list in `src/core/eval/drift-watch.ts`:

- `src/core/search/**`
- `src/core/embedding.ts`
- `src/core/chunkers/**`
- `src/core/ai/recipes/anthropic.ts`
- `src/core/ai/recipes/openai.ts`
- `src/core/operations.ts`

Additions to the watch-list require a CHANGELOG line.

## Statistical-significance discipline

When `gbrain eval compare --md` reports a Δ between two modes, it computes:

- **Paired bootstrap** with 10,000 resamples per metric. Each resample draws _question-level_ pairs (same question, mode A vs mode B), so question-level variance is differenced out.
- **Bonferroni correction** across the 12 comparisons (3 modes × 4 metrics). The reported p-value is the comparison's raw p-value × 12 (clamped at 1.0).
- **95% confidence intervals** computed from the bootstrap distribution.

If the CI for a Δ includes 0 OR the Bonferroni-adjusted p-value exceeds 0.05, the difference is **not** statistically significant. The MD report says "not significant" verbatim.

## Glossary

Every metric the report prints has a plain-English entry in `docs/eval/METRIC_GLOSSARY.md`, auto-generated from `src/core/eval/metric-glossary.ts`. The CI guard at `scripts/check-eval-glossary-fresh.sh` regenerates and diffs against the committed file on every test run; a stale doc fails the build.

## Reproducibility footer

Every release that publishes eval numbers includes a footer with:

- Code commit SHA
- Dataset SHA (LongMemEval, BrainBench, Replay)
- `--seed N`
- Run commands verbatim
- API model identifiers used (Anthropic + OpenAI + judge model)

Without these, the numbers are unfalsifiable. With them, anyone with API keys can re-score.
