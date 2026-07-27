# Incident Report: LSD Brainstorm 53× Cost Overrun

**Date:** 2026-05-20
**Severity:** High (financial — $50.71 actual vs $0.96 estimated)
**Component:** `gbrain lsd` / `gbrain brainstorm`
**Brain size:** 13,690 pages, 16,314 links, ~2,000 unique directory prefixes
**Version:** v0.37.1.0 (first release of brainstorm/lsd)

## What Happened

A user ran `gbrain lsd "what story should Garry's List write next" --yes` on a 13,690-page brain. The command:

1. **Estimated cost: $0.96** (2×12 = 24 crosses × 4 ideas + judge)
2. **Actual cost: $50.71** — 53× over estimate
3. **Token usage:** 4,906,011 input + 2,399,239 output = 7.3M total tokens
4. **Far set pulled 1,985 pages** instead of the configured 12
5. **Generated 15,868 raw ideas** across the crosses (vs expected ~96)
6. **Judge phase failed:** 2,989,338 tokens exceeded Claude Sonnet's 1M context limit
7. **Zero ideas surfaced to the user** — complete failure

A retry with `--limit 12` explicit:
- Far set correctly returned 12 pages, cost was $0.39
- But judge still failed: `parseJudgeJSON: no strategy produced valid JSON`
- Again, 0 ideas survived to output (96 generated, 0 scored)

## Root Causes

### RC1: Far Set Explosion (caused the $50 bill)

**File:** `src/core/brainstorm/domain-bank.ts` → `fetchFar()` → `listPrefixSampledPages()`

The domain bank samples pages by directory prefix to get diversity. `listPrefixSampledPages` returns **one page per prefix passed in**. On a 13K-page brain with ~2,000 unique prefixes (books/, civic/bundles/, civic/gl-article-*, people/, concepts/, etc.), passing all prefixes produces ~2,000 rows — not the configured `m=12`.

The cost estimator uses `m` (12) to predict crosses and cost. But the actual cross phase receives 1,985 far-set pages, producing `2 × 1985 = 3,970` crosses at 4 ideas each = 15,868 ideas.

**The estimate formula is correct for the intended behavior; the far set selection is what diverged.**

### RC2: No Cost Circuit Breaker

There is no mechanism to:
- Abort if estimated cost exceeds a threshold
- Abort mid-run if actual spend diverges from estimate
- Cap the far set size regardless of prefix count
- Warn the user that a run will be expensive before proceeding

The `--yes` flag skips the 10-second cost preview wait, removing even the manual inspection opportunity.

### RC3: Judge Context Overflow

The judge receives ALL ideas in a single prompt. With 15,868 ideas at ~350 tokens each, that's ~5.5M tokens — well beyond any model's context window.

Even on the retry with only 96 ideas, the judge failed with JSON parsing errors, suggesting the judge prompt/response format is fragile.

### RC4: Unpaired UTF-16 Surrogates in Page Content

Two crosses failed with: `The request body is not valid JSON: no low surrogate in string`

Some pages (likely OCR imports or web scrapes) contain unpaired UTF-16 surrogates. When these get serialized into the JSON request body for the LLM API, the JSON encoder produces invalid JSON.

### RC5: No Timeout on Individual Crosses

One cross timed out with no specific timeout configured. The default HTTP timeout allowed it to hang for an extended period before failing, consuming tokens on the API side.

## Observed Token Flow

```
Configured:  2 close × 12 far = 24 crosses × 4 ideas = 96 ideas + 1 judge call
Actual:      2 close × 1985 far = 3970 crosses × 4 ideas = 15,868 ideas + 1 judge call (failed)

Per-cross tokens (estimated): ~1,200 in + 600 out
Actual total:                  4,906,011 in + 2,399,239 out

The judge call alone would have been:
  15,868 ideas × ~350 tokens = ~5.5M tokens (prompt)
  Model limit:                  1M tokens (Sonnet)
  Overflow:                     5.5× context limit
```

## Proposed Fixes

### P1: Far Set Cap (Critical — prevents cost explosion)

`fetchFar()` must cap the number of prefixes BEFORE calling `listPrefixSampledPages`. The cap should be `max(m * 4, 50)` to allow some diversity headroom while preventing runaway growth. Final selection trimmed to `m` by distance score.

**Status:** Implemented in `dc080ac2`.

### P2: Cost Guardrails (Critical — defense in depth)

New flags for `brainstorm` and `lsd` commands:
- `--max-cost <usd>` (default $5): hard-abort if pre-run estimate exceeds
- `--strict-budget`: abort mid-run if running cost exceeds 5× estimate
- `--max-far-set <n>` (default 50): explicit far set size cap

**Status:** Implemented in `dc080ac2`.

### P3: Judge Chunking (Critical — prevents context overflow)

Split ideas into batches of ~100 before calling the judge LLM. Each batch is a separate API call; results concatenated. This bounds per-call token usage to ~35K regardless of total idea count.

**Status:** Implemented in `dc080ac2`.

### P4: Unicode Sanitization (Medium — prevents cross failures)

Strip unpaired UTF-16 surrogates from page content before building cross prompts. This is a general problem for any gbrain function that serializes user-generated page content into JSON for API calls.

**Status:** Implemented in `dc080ac2`.

### P5: Global Token & Time Budgets for All Analysis Functions (Proposed)

**This is the bigger architectural ask.** Every gbrain command that makes LLM calls should respect configurable budgets:

```yaml
# Proposed config additions to ~/.gbrain/config.json
budgets:
  # Global defaults
  default:
    max_input_tokens: 500_000    # per-command input token cap
    max_output_tokens: 200_000   # per-command output token cap  
    max_cost_usd: 5.00           # per-command dollar cap
    max_runtime_seconds: 300     # 5-minute wall-clock cap
    
  # Per-command overrides
  brainstorm:
    max_cost_usd: 2.00
    max_runtime_seconds: 120
  lsd:
    max_cost_usd: 5.00
    max_runtime_seconds: 300
  dream:
    max_cost_usd: 10.00
    max_runtime_seconds: 600
  extract:
    max_input_tokens: 1_000_000
    max_runtime_seconds: 900
  enrich:
    max_cost_usd: 3.00
    max_runtime_seconds: 180
```

**Commands affected:**
- `brainstorm` / `lsd` — bisociation crosses + judge (this incident)
- `dream` — dream cycle phases (enrichment, emotional weight, etc.)
- `extract all` — link + timeline extraction across all pages
- `enrich` — per-page deep enrichment with web research
- `eval` — evaluation runs (suspected-contradictions, retrieval drift)
- `integrity auto` — automated content repair
- `doctor --remediate` — autonomous self-healing via Minions

**Implementation approach:**
1. Add a `BudgetTracker` class that wraps LLM calls with token/cost/time accounting
2. Every analysis function receives a budget context
3. On budget exhaustion: save partial results, emit a structured warning, exit cleanly
4. CLI flags (`--max-cost`, `--max-tokens`, `--timeout`) override config defaults
5. `--no-budget` escape hatch for power users who know what they're doing

### P6: Diarization / Summarization for Oversized Payloads (Proposed)

When a judge or analysis phase receives more content than fits in context:

1. **Estimate tokens** before calling the LLM
2. If over budget, **diarize**: summarize/compress the content to fit
3. For the judge specifically: rank ideas by a cheap heuristic first (keyword overlap, novelty score), then send only top-N to the LLM judge
4. For other analysis: progressive summarization — chunk → summarize → merge summaries → final analysis

This is effectively a **token budget allocator** that decides how to spend a fixed token budget across variable-length inputs.

```
Example: 15,868 ideas need judging, context limit 900K tokens
  Step 1: Cheap pre-filter (keyword dedup, obvious duplicates) → 8,000 unique ideas
  Step 2: Batch into 80 chunks of 100 ideas each
  Step 3: Judge each chunk → 80 calls × ~35K tokens = 2.8M total (spread across calls)
  Step 4: Merge top ideas from each chunk → final ranking
  Total cost: ~$2-3 instead of $50
```

### P7: Structured Error Recovery (Proposed)

When a cross or judge call fails:
- Save the partial results immediately (don't wait for the full run)
- Emit a machine-readable error event (not just a log warning)
- Support `--retry-failed` to re-run only the failed crosses without repeating successful ones
- Checkpoint progress to disk so interrupted runs can resume

## Impact

- **Financial:** $50.71 wasted on a single failed run
- **User trust:** Zero ideas delivered despite ~7M tokens processed
- **Time:** ~15 minutes of compute time, plus overnight delay in reporting results

## Lessons

1. **First run of any new feature on a large brain should be dry-run or capped.** The estimate was based on small-brain testing; 13K pages is a different universe.
2. **Cost estimators must account for actual data cardinality, not just configured parameters.** The estimate used `m=12` but the real far set was `|prefixes|`.
3. **Every LLM-calling function needs a budget.** This isn't just a brainstorm problem — it's an architectural gap in any system that makes variable numbers of LLM calls based on data size.
4. **JSON serialization of user content is a landmine.** Any page could contain invalid Unicode. Sanitize at the serialization boundary, not per-feature.

## Shipped in v0.37.x (the budget cathedral wave)

P1-P4 already shipped via PR #1234 (the first fix wave). P5-P7 plus a few
architectural rounds shipped in the budget-cathedral wave that followed:

- **P1 (far set cap):** `fetchFar()` in `src/core/brainstorm/domain-bank.ts`
  caps prefix sampling to `max(m*4, 50)` and trims final pages to `m` by
  distance. The 2K-prefix explosion class is closed.
- **P2 (cost guardrails):** `--max-cost`, `--max-far-set`, `--strict-budget`,
  `--judge-model`, `--max-ideas-per-judge-call` flags on brainstorm + lsd.
  Pre-flight estimate refusal, mid-run cost-ceiling abort.
- **P3 (judge chunking):** `runJudge` in `src/core/brainstorm/judges.ts`
  auto-chunks at 100 ideas/call. Context-window overflow is structurally
  prevented.
- **P4 (unicode sanitization):** `ensureWellFormed` (in `src/core/text-safe.ts`,
  used by `src/core/brainstorm/orchestrator.ts`) replaces unpaired surrogates
  with U+FFFD before serialization. (Consolidated from the original hand-rolled
  `sanitizeUnicode` in v0.42.40.0 / #2011.)
- **P5 (BudgetTracker at the gateway layer):** new
  `src/core/budget/budget-tracker.ts` is the canonical primitive. The
  gateway's `withBudgetTracker(tracker, fn)` composes via
  `AsyncLocalStorage<BudgetTracker>` so every gateway-routed LLM call
  inside the scope auto-records. `BudgetExhausted` is a typed error with
  `reason: 'cost' | 'runtime' | 'no_pricing'`. `record()` throws when
  cumulative spend exceeds the cap (TX1). `reserve()` hard-fails on
  `no_pricing` when the cap is set + model missing from pricing maps (TX2).
- **P6 (payload-fitter):** `src/core/diarize/payload-fitter.ts` with
  `'batch'` and `'summarize'` strategies. Summarize embed-clusters
  (k=ceil(items/4)), Haiku-summarizes each cluster in parallel via
  `Promise.allSettled` at parallelism=4. Surfaces `degraded: true` flag
  when success ratio < 0.75 so callers decide whether to surface a partial
  result or abort.
- **P7 (brainstorm checkpoint + --resume):**
  `src/core/brainstorm/checkpoint.ts` persists FULL idea bodies (not just
  counts — TX3 load-bearing). One `--resume <run_id>` flag covers both
  failed and never-attempted crosses (TX4). `run_id` formula uses NO
  embedding bits so the identity is stable across embedding-model swaps
  (A5 amended). 7-day mtime-based GC wired into the cycle purge phase.
  `--list-runs` lists saved checkpoints. `--force-resume` bypasses the 7d
  staleness gate.

Also shipped alongside the wave (folded inline):

- **doctor --remediate --resume:** A4 amended. The mid-run cap is now a
  real ceiling; `--max-cost` is an alias for `--max-usd`. On
  BudgetExhausted, the orchestrator persists a checkpoint at
  `~/.gbrain/remediation/<plan_hash>.json` and tells the user the exact
  `gbrain doctor --remediate --resume` command. The resumed run skips
  already-completed steps.
- **Audit-week-file consolidation (Q1):** four call sites
  (shell-jobs / phantoms / slug-fallback / dream-budget) now share one
  ISO-week filename helper. Year-boundary correctness pinned by tests.
- **eval-contradictions tracker telemetry:** the existing CostTracker
  stays for the report shape; the runner additionally installs a
  withBudgetTracker scope for the gateway-layer telemetry path.

What did NOT make this wave (filed in TODOS for a follow-up):

- The schema fix for `page_links` on PGLite. The brainstorm domain-bank
  queries reference `page_links` but the embedded schema only defines
  `links`; the E2E works around this with a view in test setup, but
  real PGLite users currently can't run `gbrain brainstorm`. Schema fix
  needed.
- `--max-cost` flag on `extract`, `enrich`, `integrity auto`. The
  gateway-layer enforcement covers them when wrapped at the entrypoint,
  but the CLI flag wiring is deferred.
- Async-batched audit writes. Sync `appendFileSync` is fine at typical
  volumes; revisit if profiling shows it dominates.
- Multi-day brainstorm resume (>7d). The `--force-resume` flag is the
  operator escape hatch for now.
