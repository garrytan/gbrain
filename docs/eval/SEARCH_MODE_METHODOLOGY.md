# Search Mode Evaluation Methodology

_How gbrain measures the difference between `conservative`, `balanced`, and `tokenmax`. Written haters-immune: every claim is reproducible — pinned datasets, recorded seeds, and the exact run commands below._

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

- **LongMemEval** — public S split, cleaned September 2025 revision (`longmemeval_s_cleaned.json` from [Hugging Face `xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)). `n=500` questions, of which the 30 abstention (`_abs`) questions are excluded from every recall denominator as the official `print_retrieval_metrics.py` does, so `n=470` are scored. The corpus + answer keys are pinned to a specific commit; recorded in every per-run record.
- **Replay captures** — NDJSON from the sibling `gbrain-evals` repo, `n=200` queries. Each query carries a `retrieved_slugs` baseline + a `latency_ms` measurement from the original production run.
- **BrainBench v1** — `n=1240` documents / `n=350` qrels (binary relevance judgments). Lives in the sibling [`gbrain-evals`](https://github.com/garrytan/gbrain-evals) repo, SHA-pinned at every run.

No private brain content is used in any reported result. The NDJSON run records under `<repo>/.gbrain-evals/` contain only the LongMemEval question IDs + the rank-ordered retrieved session IDs.

## 3. Sample selection

- **Random seed:** `42` throughout. Set via `--seed N` on `gbrain eval run-all`; recorded in every per-run record.
- **No per-question curation.** Splits are taken whole; no question is filtered for reporting.
- **No mode-specific tuning.** The same dataset + same seed feeds every mode. The mode bundle is the only independent variable. A mode Δ therefore measures the joint effect of every knob the bundles differ on — today that's `tokenBudget`, `expansion`, `relationalRetrieval` (the typed-edge fourth recall arm, ON for balanced/tokenmax, OFF for conservative), and `searchLimit`; the canonical diff is `MODE_BUNDLES` in `src/core/search/mode.ts`.
- **Cache comparability across upgrades.** Semantic result-cache reads and writes are temporarily disabled in every mode, regardless of configuration. Every query uses fresh retrieval. The retained storage machinery still keys rows on `KNOBS_HASH_VERSION` and the active knobs + embedding column/provider; historical runs with result caching enabled are not directly comparable to current runs for latency or provider spend.
- **Dev slice vs decision set (ranker-wave discipline, LongMemEval).** Knob selection (which expansion budget, which autocut floor) happens on a 40-question dev slice sampled by seed 42 from the 470 scored questions (`evals/longmemeval/dev-slice-seed42.txt`, `--question-ids`); every pre-registered success rule is DECIDED on the 430 held-out questions, paired per question and per type, in integer question counts ("≥ baseline − 2 overall, no type loses more than 1 net"). The full-470 row is published alongside for comparability with earlier receipts and is labelled as including the dev slice. Split-half confirmation (seeded 235/235 or 215/215 of the decision set, `evals/longmemeval/splits-seed42.json`) is required before any non-default autocut floor or temporal mechanism ships.
- **Stability across re-runs:** with `--seed 42` and the same dataset SHA, two runs of the same (mode, suite) produce identical retrieval orderings (modulo the optional Haiku expansion call, which is non-deterministic). Persisted in `eval_results` so anyone can re-score from a run's `--output` dumps.

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
  --output docs/eval/results/<version>/

# Render the comparison.
gbrain eval compare --md > docs/eval/results/<version>/README.md
gbrain eval compare --json > docs/eval/results/<version>/comparison.json
```

The orchestrator writes per-run records to `<repo>/.gbrain-evals/eval-results.jsonl`. Every record carries: `run_id`, `ran_at`, `suite`, `mode`, `commit`, `seed`, `limit`, `params`, `status`, `duration_ms`. When a release publishes eval numbers, the `--output` dumps under `docs/eval/results/<version>/` carry the raw question-level outputs so a reviewer can re-score with their own metric implementation. **No dumps are committed in the repo right now** — reproduce by running the commands above; determinism (§3) means your re-run matches the reported orderings.

## 5. Threats to validity

Honest list. We name what would let a critic dismiss the numbers.

- **LongMemEval skews English + technical.** The questions are software-engineering and consumer-product flavored. Performance on a brain rich in non-English / non-technical content (writing, art history, etc.) may differ.
- **BrainBench is small** (1240 docs) relative to a production brain (10K-100K pages). Absolute scores aren't predictive of your hit rate; the _delta_ between modes is.
- **char/4 token heuristic.** Token-budget enforcement and cost estimates use a character-count / 4 heuristic. Accurate within ~5-10% for English with the OpenAI tiktoken family; off worse for Voyage (we don't use Voyage in chat retrieval, so it doesn't bias the reported numbers, but if you do, your budget caps will be approximate).
- **Expansion's quality lift varies by query distribution.** On LongMemEval-S (cleaned September 2025 revision, 470 scored, k=5, measured 2026-09-02 at gbrain v0.48.2.0 via the gbrain-evals runner) LLM multi-query expansion measures 54.89% `recall_all@5` against 93.19% without it, so expansion is off in `conservative`/`balanced`; the lift on rarer-entity / longer-tail queries is unmeasured here. We report the corpus we measured; YMMV.
- **The dev slice is inside the published 470.** Knob choices made on the 40 dev questions leak into the full-470 headline by construction; the 430-question decision set is the number a critic should read, and both are published side by side. Nothing is tuned on the frozen corpus beyond the pre-registered single mechanism per gap.
- **Expansion variants are non-deterministic.** Haiku multi-query variants differ run to run, so budget cells are compared only on RECORDED variants (`--expansion-replay`), which makes the budget the sole difference between cells but means the replayed cells share one draw of the variant lottery.
- **Reranker receipts depend on a hosted model.** `voyage:rerank-2.5` rows are reproducible only while that snapshot is served; the harness records the reranker model per run and fails a "reranker on" run that silently fell open.
- **Paired bootstrap assumes question-level independence.** Multi-hop questions within the same conversation thread aren't independent; the bootstrap CI is slightly tighter than reality.
- **Single brain instance per benchmark.** The benchmark spins up an in-memory PGLite per question. This does not reproduce a long-running production brain's state; current semantic result-cache hit rates are zero because result reuse is disabled.

## 6. Per-question raw outputs

Every reported metric is reproducible from the NDJSON dumps a run writes to its `--output` directory (`docs/eval/results/<version>/` when a release publishes numbers; none are committed right now — see §4). The commit SHA in the methodology footer pins the code version.

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

**Ranker wave (v0.48.4.0) pre-registrations** — one mechanism per gap, rule written before the run, decided on the 430:

5. **Expansion budget.** Budget-normalized weighted RRF (`search.expansion_variant_budget`): the balanced arm with recorded variants at the chosen budget scores ≥ plain hybrid − 2 questions and no type loses > 1; the tokenmax arm (reranker on) scores ≥ the shipped balanced default − 2. Bundles flip only if both hold. Outcome: the mechanism is real (255 → 394 of 470 across budgets on the same recorded variants) but the balanced arm failed its rule at every budget (0.25: −43 on the 430); the tokenmax row passed its literal rule only because both arms sat under autocut; bundles keep the legacy weighting.
6. **Temporal reasoning.** Diagnose first (vector / keyword / fused / reranked rank of every missed gold session on half A of the decision set); a mechanism is chosen only for a located class and confirmed on half B. Outcome: diagnose-only — the misses are the embedding ranking of near-duplicate sessions (fused rank = vector rank), no knob landed.
7. **Autocut floor (rule R2).** Replayed from the shipped default's captured post-rerank pool; keep 0.35 iff the shipped default scores ≥ the reranker-on/autocut-off arm − 2 with no type losing > 1, else the floor that maximizes the token-savings benefit metric under that guardrail on both halves of a seeded split.
8. **Balanced reranker (rule R1).** Stays on iff reranker on vs off shows 0 hit@1 and ≤ 1 hit@3 losses on NamedThingBench. Outcome: the entity core passed, the relational fixture collapsed; the pre-registered fix (`search.relational_rerank_pin`, default 3) restored 0 losses, balanced stays on.
9. **Conceptual recall (Cat 13).** E2 arm-confidence floor: held-out hybrid ≥ bare vector — FAILED (53.0 → 53.0), knob ships off. E3 metadata boost gate: held-out ≥ 57.0 — PASSED (57.8), flipped to `lexical` in every bundle; the stretch (bare vector 60.5) was not met.
10. **Judged answer accuracy.** Predicted ≥ 92% with the shipped retrieval, official judge prompts at temperature 0, gpt-4o judge, abstention instruction in the reader prompt; NO SOTA claim on this lane (protocols across systems are unmatched). Outcome: 86.6% (433/500, CI 83.6–89.6) — prediction missed; the reader converts 88.2% of evidence-complete questions, so the shortfall is the answering layer.

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

## Cost anchors

The mode-picker prompt at `gbrain init` and the CLAUDE.md `## Search Mode` table both surface these rough cost anchors. Working through the math so they're auditable:

**Variables:**
- `T` = avg tokens per search-result chunk. The recursive chunker targets 300 words / chunk → ~400 tokens (English, OpenAI tiktoken approx).
- `N` = chunks delivered per query (capped by the mode's `searchLimit`).
- `R` = downstream model input rate. Sonnet 4.6 = \$3/M. Opus 4.7 = \$5/M. Haiku 4.5 = \$1/M.
- `Q` = queries per month.

**Per-query input cost** (downstream agent reads the chunks):

    cost_per_query = T × N × R

| Mode | T (tokens) | N (chunks) | Sonnet (\$3/M) | Opus (\$5/M) | Haiku (\$1/M) |
|---|---|---|---|---|---|
| conservative (4K cap, 10 max) | ~400 | 10 (or fewer if budget hits) | \$0.012 | \$0.020 | \$0.004 |
| balanced (12K cap, 25 max) | ~400 | ~25 | \$0.030 | \$0.050 | \$0.010 |
| tokenmax (no cap, 50 max) | ~400 | ~50 | \$0.060 | \$0.100 | \$0.020 |

**Monthly cost** (Q × per-query):

| Mode @ Sonnet | 1K Q/mo | 10K Q/mo | 100K Q/mo |
|---|---|---|---|
| conservative | \$12 | \$120 | \$1,200 |
| balanced | \$30 | \$300 | \$3,000 |
| tokenmax | \$60 | \$600 | \$6,000 |

| Mode @ Opus | 1K Q/mo | 10K Q/mo | 100K Q/mo |
|---|---|---|---|
| conservative | \$20 | \$200 | \$2,000 |
| balanced | \$50 | \$500 | \$5,000 |
| tokenmax | \$100 | \$1,000 | \$10,000 |

**gbrain's own cost** on top:
- Query embedding (text-embedding-3-large @ \$0.13/M tokens): ~\$0.00001 per query. Negligible at every scale.
- Tokenmax Haiku expansion call (\$1/M input, \$5/M output, ~500 input + 200 output per call): ~\$0.0015 per query, or \$150/mo at 100K queries. Repeated queries still run expansion while semantic result caching is disabled.
- Per-page indexing (one-time): bounded by your import volume, not query volume. Not modeled here.

**Cache hit adjustment.** Apply no semantic result-cache discount to these estimates while result caching is disabled. Downstream prompt caching can independently reduce cached-input charges, but it does not skip GBrain retrieval. The prompt-cache assumptions in the agent-loop example below describe that separate mechanism.

**Why these numbers DRIFT from your actual bill:**
- Your agent's system prompt + reasoning tokens add input that gbrain doesn't see.
- Compaction reduces input over a long session.
- Most agents make 1-5 searches per turn; cost-per-turn is what bills you, not cost-per-query.
- The model price column drifts as providers reprice; pin the rate via `src/core/model-pricing.ts` (the canonical chat-pricing table) for a current snapshot.

The picker copy + CLAUDE.md table are the canonical user-facing source. Update them in lockstep when the underlying chunker size or default `searchLimit` changes.

## Mode × Model matrix (the 25x spread)

The per-query math above assumes Sonnet 4.6 downstream. In reality, the
downstream model tier is the BIGGER cost lever. Per-query cost at 10K
queries/month (typical single-user volume), search payload only (no cache
savings):

| Mode (search tokens) | Haiku 4.5 (\$1/M) | Sonnet 4.6 (\$3/M) | Opus 4.7 (\$5/M) |
|---|---|---|---|
| conservative (~4K) | **\$40/mo** | \$120/mo | \$200/mo |
| balanced (~10K) | \$100/mo | \$300/mo | \$500/mo |
| tokenmax (~20K) | \$200/mo | \$600/mo | **\$1,000/mo** |

Scales linearly: multiply by 10 for 100K/mo (heavy power user / multi-user
fleet); divide by 10 for 1K/mo (light usage).

**Natural pairings span ~4x** (cheap model + tight mode → frontier model + loose
mode). **Mismatches waste capacity:**

- `tokenmax + Haiku`: Haiku gets 20K of search results stuffed into its
  context per query. Haiku's reasoning is weaker; more chunks = more noise,
  not more signal. You pay Haiku rates but get sub-Haiku quality. Wrong
  direction.
- `conservative + Opus`: Opus has 200K context window and can synthesize
  across many chunks. Capping at 10 chunks / 4K tokens leaves Opus
  reasoning underfed. You pay Opus rates but get conservative-shape
  retrieval. Wasted spend.

**Right-sizing rule:** match the mode's `searchLimit` to the downstream
model's "useful context depth":

- Haiku struggles past ~5-10 chunks of cross-referenced content → conservative
- Sonnet handles ~25-40 chunks well → balanced
- Opus benefits from 50+ chunks for multi-hop reasoning → tokenmax

## Realistic-scale anchor (single power-user agent loop)

The per-query math above is honest but theoretical: it treats each search as an isolated billable event. Real agent loops amortize a lot of context across turns via Anthropic prompt caching. Here's what one heavy power-user loop actually looks like in production, anonymized + scaled so the numbers represent a representative power user rather than any specific deployment.

**Reference shape — tokenmax in production at a single-user scale:**

| Quantity | Approximate value |
|---|---|
| 30-day total agent spend | ~\$700/mo |
| 30-day total tokens billed | ~800M |
| Turns per month | ~860 (~29/day; one active agent loop) |
| Average tokens per turn | ~900K |
| Average cost per turn | ~\$0.85 |
| Anthropic prompt-cache hit rate | ~88% |

A "turn" here is one agent loop iteration: read user message, plan, execute tool calls (including gbrain searches), generate response. Each turn typically includes 2-4 gbrain searches.

**Per-mode scaling from the tokenmax anchor:**

The cost difference between modes is concentrated in the search-attributable fraction of per-turn cost. System prompt, tool definitions, conversation history, and reasoning tokens don't change with mode — only the chunks gbrain delivers do. Assume 3 searches per turn at the mode's `searchLimit`:

| Mode | Search tokens/turn | Search cost/turn (at \$3/M effective) | Search-attributable @ 860 turns | Δ vs tokenmax |
|---|---|---|---|---|
| tokenmax | ~60K (3 × 20K) | ~\$0.18 | ~\$155/mo | — |
| balanced | ~30K (3 × 10K) | ~\$0.09 | ~\$77/mo | -\$78 |
| conservative | ~12K (3 × 4K) | ~\$0.036 | ~\$31/mo | -\$124 |

**Implied total agent spend by NATURAL PAIRING** (mode + matched
downstream model). Per-turn cost scales with the downstream model's
per-token rate, since the cached prefix + uncached portion + reasoning
tokens all bill at that rate:

| Pairing | Per-turn cost | Total @ 860 turns/mo |
|---|---|---|
| tokenmax + Opus (frontier, max quality) | ~\$0.85 | ~\$700/mo |
| balanced + Sonnet (the sweet spot) | ~\$0.50 | ~\$430/mo |
| conservative + Haiku (cost-sensitive) | ~\$0.20 | ~\$170/mo |

**4x spread across natural pairings.** The model tier dominates because
the per-token rate applies to the WHOLE per-turn payload (system + tools
+ history + reasoning + search), not just gbrain's chunks. Mode choice
contributes ~10-20% on top of that base.

**Mismatched pairings push you off the curve:**

| Pairing | Per-turn estimate | Total @ 860 turns/mo | Compared to natural |
|---|---|---|---|
| tokenmax + Haiku | ~\$0.20 | ~\$170/mo | Same cost as conservative+Haiku, worse quality |
| conservative + Opus | ~\$0.75 | ~\$640/mo | 92% of tokenmax+Opus spend, conservative-shape retrieval |

The mismatch math says: a tokenmax+Haiku user pays the same as
conservative+Haiku but gets a noisier context (Haiku can't filter signal
from 50 chunks). A conservative+Opus user pays nearly the same as
tokenmax+Opus but starves Opus on retrieval depth. Both burn budget for
no improvement.

**What this anchor tells us that the per-query math doesn't:**

1. **At realistic agent-loop scale with disciplined prompt caching, mode choice saves 10-20% of total agent spend** — meaningful, but smaller than the per-query 5x ratio implies. Disciplined prompt-cache layouts blunt the mode delta because most of the per-turn cost is the cached prefix, not the search payload.

2. **Without that prompt-cache discipline, the per-query framing reasserts itself.** Setups that churn the prompt prefix on every turn (frequent system-prompt edits, untemplated tool defs, no prompt-cache structuring) see search payload contribute a much larger fraction of total cost. Those setups should care about mode choice more, not less.

3. **The cache hit rate quoted here (~88%) is achievable but not automatic.** It requires structuring the prompt so the cached prefix stays stable across turns: system prompt + tool defs first, history compacted but cache-aware, retrieved chunks appended LAST (where their volatility doesn't invalidate the prefix). Agents that interleave search results inside the cached region pay the prefix-rebuild tax on every turn.

**Caveats stacked here:**

- The anchor represents ONE power-user loop. Multi-user fleets aggregate proportionally; the per-user shape doesn't change.
- The "3 searches per turn" assumption varies wildly. A code-review agent might issue 10+ searches per turn; a chat-only loop might do 0.
- The 88% cache hit rate is the high end of what's achievable. Half that is closer to a default agent without cache-aware prompt layout.
- The "Δ vs tokenmax" math assumes the OTHER cost components (system, tools, history, reasoning) stay constant. In practice, conservative's smaller per-turn payload also leaves more room in the context window for history → which can change agent behavior in either direction.

This anchor + the per-query math both live in this doc on purpose. The per-query framing is what an isolated benchmark would measure (and what `gbrain eval run-all` will produce). The realistic-scale anchor is what an operator actually pays. Both are honest; neither is the whole truth.

## Reproducibility footer

Every release that publishes eval numbers includes a footer with:

- Code commit SHA
- Dataset SHA (LongMemEval, BrainBench, Replay). LongMemEval-S cleaned (`xiaowu0162/longmemeval-cleaned`, `longmemeval_s_cleaned.json`): `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, 500 questions, 30 abstention.
- `--seed N`
- Run commands verbatim
- API model identifiers used (Anthropic + OpenAI + judge model)

Without these, the numbers are unfalsifiable. With them, anyone with API keys can re-score.
