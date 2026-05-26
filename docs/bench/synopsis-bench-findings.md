# Synopsis Generation Bench — Findings + Recommendations

Generated: 2026-05-26 (session lost final report; reconstructed from decisions)
Hardware: Apple M5 Max, 128 GB unified memory
Inference backend tested: LM Studio (openai-compat endpoint)
Judge model: anthropic:claude-opus-4-7
Total Opus spend: ~$13

## TL;DR — Headline Findings

🚨 **Batching with full-doc-per-call LOSES on real corpus.** Stratified 30-page test (4 size buckets, 3 sources, 581 chunks) showed B=16 vs B=1:

- **Speed: 0.70x-1.02x** (no gain or slower) because corpus is 80% xs/s pages
- **Quality: -18pp to -48pp concerning-pair rate** at B=16 across all models
- **Retrieval rank: 0.06-0.58 places worse** at B=16

**Trading 18-48pp quality regression for ~zero speedup at corpus scale.** Codex's pre-eng-review prediction (cloud-cookbook pattern misfit on local SLMs) holds — but the FIX is hierarchical context (TODO 1), not batching.

## Methodology

- **30-page stratified sample** across:
  - Sizes: xs (1-5ch) ×8, s (6-15ch) ×8, m (16-40ch) ×8, l (41-100ch) ×6
  - Sources: chats-chatgpt, default (transcripts/projects), codex-archive
- 581 total text chunks
- Tested 3 top models × B=1 + B=16 = 180 bench runs
- 3 quality dimensions:
  1. **Speed bench** (`scripts/bench-batched-synopsis.ts`) — wall time, parse-OK, token usage, entity-grounding
  2. **LLM judge** (`scripts/judge-synopsis-quality.ts`) — Opus 4.7 scores 1-5 on accuracy, specificity, retrieval-utility
  3. **Retrieval rank** (`scripts/judge-retrieval-rank.ts`) — Opus-generated queries + OpenAI text-embedding-3-large; mean rank of target chunk

## Composite leaderboard

### Stratified 30-page speed (summed wall time)

| Model | B=1 wall | B=16 wall | Speedup B=16 vs B=1 |
|---|---|---|---|
| **qwen3-coder-30b** | **660s** | 741s | 0.89x (slower) |
| qwen3-omni-30b-a3b@q4_k_m | 1110s | 1578s | 0.70x (slower) |
| devstral-small-2-2512 | 1700s | 1664s | 1.02x (no gain) |

### Quality — LLM judge (Opus 4.7, 1-5 scale, 1325 pairs)

| Model | B | Acc | Spec | Util | Concerning <3 |
|---|---|---|---|---|---|
| **qwen3-omni B=1** | 1 | **4.36** ⭐ | **3.62** | **3.63** | **14.5%** ⭐ |
| devstral B=1 | 1 | 4.25 | 3.52 | 3.51 | 22.2% |
| qwen3-coder B=1 | 1 | 4.12 | 3.17 | 3.28 | 28.5% |
| devstral B=16 | 16 | 3.62 | 3.15 | 3.00 | 40.3% |
| qwen3-omni B=16 | 16 | 3.14 | 2.60 | 2.51 | 62.4% |
| qwen3-coder B=16 | 16 | 3.35 | 2.46 | 2.45 | 62.4% |

### Quality degradation per model (B=1 → B=16)

| Model | Acc drop | Spec drop | Util drop | Concerning gain |
|---|---|---|---|---|
| **devstral** | 0.63 | 0.37 | 0.51 | **+18pp** (smallest) |
| qwen3-omni | 1.22 | 1.02 | 1.12 | +48pp (worst) |
| qwen3-coder | 0.77 | 0.71 | 0.83 | +34pp |

### Retrieval rank (Opus queries + production embedder)

| Model | B | Mean rank | rank=1 % | rank≤3 % | rank≤10 % |
|---|---|---|---|---|---|
| **devstral B=1** | 1 | **2.43** | **62%** | **85%** | 98% |
| qwen3-coder B=1 | 1 | 2.64 | 62% | 83% | 97% |
| qwen3-omni B=1 | 1 | 2.71 | 61% | 84% | 96% |
| qwen3-omni B=16 | 16 | 2.77 | 54% | 78% | 98% |
| devstral B=16 | 16 | 2.84 | 56% | 78% | 97% |
| qwen3-coder B=16 | 16 | 3.22 | 53% | 79% | 95% |

## Key insights

### 1. Earlier narrow tests were misleading
A single xl-page test (65 chunks) initially showed B=16 hitting 3-4x speedup. **At stratified corpus scale, batching ~zero speedup** because:
- 80% of corpus is xs/s pages (≤15 chunks)
- On xs pages, B=16 = single batched call ≈ time of ~3 per-chunk calls
- Larger prompt overhead per batched call offsets fewer calls
- Long-tail pages (xl 100+ chunks) are <0.5% of corpus
- Weighted speedup at corpus scale ≈ 1x

### 2. qwen3-omni B=1 vs B=16 anomaly
Retrieval rank nearly unchanged (2.71 → 2.77) but judge quality collapses (acc 4.36 → 3.14). Batched output is lexically similar (embeds similarly) but factually wrong. Embedder doesn't catch the semantic shift; judge does. **Bigger risk than the rank metric shows.**

### 3. Reasoning models failed batched
gemma-4-26b-a4b, qwen3.6-35b-a3b, qwen3-omni-mlx variants, GLM 4.7 Flash, Magistral all produce empty content because they spend output budget on reasoning tokens. Only non-reasoning instruct models work for batched output.

### 4. Production gemma-4-e2b is BELOW all 3 stratified winners
Earlier narrow test had gemma-4-e2b at acc 3.53, spec 2.22, util 2.27. **All 1342 existing synopses are sub-quality.** Reprocessing required.

### 5. Codex's eureka holds
For local SLMs (small language models), Anthropic's contextual-retrieval cookbook pattern (per-chunk-with-full-doc) is structurally inefficient. Cookbook optimizes for cloud-LLM economics (output tokens > input). Local inference inverts this: input encoding dominates. **Fix isn't batching — it's hierarchical context.**

## Recommendations

### Production pick at B=1 per-chunk (no batching)

| Use case | Pick | Rationale |
|---|---|---|
| **Best quality + acceptable speed** | qwen3-omni-30b-a3b-instruct@q4_k_m | Best acc 4.36, lowest concerning 14.5%. ~1110s on 581 chunks = 31 chunks/min |
| Best speed, decent quality | qwen3-coder-30b | Fastest 660s (53 chunks/min). Acc 4.12. |
| Best retrieval rank | devstral-small-2-2512 | Mean rank 2.43. Acc 4.25. 1700s. |

### Concurrent inference (the real production lever)

LM Studio 0.4.0 added `Max Concurrent Predictions` (default 4). On M5 Max with 128 GB:
- Bump to 8 in model load settings
- Refactor `src/core/contextual-retrieval-service.ts:tryBuildPhase1` to fire chunks within page concurrently via `Promise.all` (~50 LOC)
- Expected ~4x throughput multiplier on single-stream wall time

**At qwen3-omni B=1 + 8 concurrent: ~120 chunks/min = 10K chunks in 1.4h. 100K chunks in 14h.**

### Production rollout

1. Bump LM Studio `Max Concurrent Predictions` = 8 on chosen model
2. Refactor service for within-page concurrent inference
3. Set `GBRAIN_SYNOPSIS_MODEL` to chosen model (probably qwen3-omni for quality)
4. Reprocess 1342 existing gemma-4-e2b synopses (~3-4h at expected throughput)
5. Bump `SYNOPSIS_PROMPT_VERSION` to invalidate old cache
6. Monitor doctor for batched-vs-fallback ratio

### v0.42+ TODO — hierarchical context (the real architectural fix)

- Generate ONE page-level synopsis per page (1 call, ~500 input tokens)
- Per-chunk synopsis with `page_title + doc_summary + chunk` (~200-500 input tokens vs current 7K)
- Smaller input = faster inference AND higher quality (model anchored on clean summary)
- Estimated 5-10x speedup + quality improvement vs current full-doc-per-call
- Works on any model with 4K+ context — opens cheaper/faster model options
- ~1 week design + build

### Untested models worth Phase A extension ($10, ~3h)

| Model | Why test |
|---|---|
| **Mistral-Nemo-Instruct-2407** (12B Apache 2.0, 128K ctx) | Half qwen3-omni params, Mistral "succinct output" tuning. MLX variant ready. |
| Phi-4 (14B MIT) | Microsoft's dense instruction model. Smaller than qwen3-omni. |
| Qwen2.5-7B-Instruct (Apache 2.0) | Older qwen, deterministic non-reasoning, 4x faster. |

If Mistral-Nemo matches qwen3-omni quality at 2x speed → saves ~30h compute on 470K-chunk corpus.

## Models tested (full list)

### Viable (stratified-tested or narrow-tested)

| Model | Notes |
|---|---|
| qwen3-omni-30b-a3b-instruct@q4_k_m | Best quality B=1, 14.5% concerning |
| devstral-small-2-2512 | Best retrieval rank, smallest B-degradation |
| qwen3-coder-30b | Fastest absolute B=1 |
| cryptogemma-4b-v1 | Surprisingly strong on narrow test (100% entity-ground) |
| google/gemma-4-e2b (production) | Below all of above; needs replacement |
| mistralai/devstral-small-2-2512 | Same as devstral |
| openai/gpt-oss-20b | Disqualified — B=16 quality collapse (68% concerning) |

### Failed (RAM / reasoning / config)

| Model | Why |
|---|---|
| llama-4-scout-17b-16e-instruct | Insufficient RAM |
| qwen3-omni-30b-a3b-instruct-mlx | Failed to load |
| qwen3.6-35b-a3b | Reasoning model, empty content |
| qwen3-1.7b | Reasoning |
| gemma-4-26b-a4b | Reasoning, empty content even at max_tokens=600 |
| gemma-4-31b | Reasoning (suspected) |
| zai-org/glm-4.7-flash | Reasoning |
| mistralai/magistral-small-2509 | Reasoning (Magistral = reasoning variant) |
| minimax-m2.7 | Insufficient RAM |
| qwen/qwen3-coder-next | Insufficient RAM |

## Critical incident note

During this session, `/Users/benjamin/gbrain/` source tree was deleted by an
external process (cause unknown — investigated, no smoking gun). The
`local/local-cli-default-source-union` branch with ~8 commits was lost since
it was never pushed. Bench scripts (this directory) were rewritten from memory
+ /tmp output structure. /tmp then cleared on subsequent reboot, taking the
180 bench output files + 1325 judge pairs + retrieval rank data with it.

**Mitigations applied:**
- Scripts now committed to repo (`scripts/bench-*.ts`, `scripts/judge-*.ts`, `scripts/bench-stratified-30.sh`)
- This findings doc committed
- Future work-in-flight branches should be pushed to fork early and often
- Future bench output should be written under `~/.gstack/` or repo `.bench/` (gitignored), not `/tmp`

## Cost summary

| Spend | Cost |
|---|---|
| Local LM Studio inference | $0 |
| Opus 4.7 judge (1325 pairs) | ~$11 |
| Opus 4.7 query-gen + OpenAI embed (retrieval rank) | ~$2 |
| **Total** | **~$13** |
