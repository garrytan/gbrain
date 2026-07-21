# Attention Matching (AM) and Task-Guided Scoring

This note expands the compact treatment in the main skill: the AM objective, what changes under Latent Briefing, and which assumptions matter in practice.

## AM Compaction Objective

Given a full KV cache of size `S`, Attention Matching seeks a smaller cache of size `t < S` whose attention outputs stay close to the original. Per attention head, compacted components `(C1, beta, C2)` satisfy:

```text
softmax(Q * C1^T + beta) * C2 ~= softmax(Q * K^T) * V
```

- **C1**: compacted keys, usually a subset of original key vectors selected for high attention mass
- **beta**: bias corrections so the softmax distribution over kept keys approximates the distribution over all keys
- **C2**: compacted values reconstructed so the attention output matches the original as closely as possible

The original AM procedure solves each `(layer, head)` independently:

1. Select tokens to keep
2. Solve `beta`
3. Reconstruct `C2`

This per-head independence helps quality but makes batching difficult because different heads keep different token subsets.

## What Latent Briefing Changes

Latent Briefing adapts AM for orchestrator-worker handoff:

1. **Query source changes.** Standard AM may score keys using queries sampled from the context itself. Latent Briefing instead uses queries derived from the **current worker task prompt**.
2. **Scoring becomes task-conditioned.** The trajectory is forward-passed through the worker model, and attention from task queries to trajectory keys defines which positions matter for this worker call.
3. **Selection becomes shared.** Scores are aggregated across layers and heads into one per-position score so the system can use a single keep/drop mask.

Conceptually:

```text
trajectory -> K, V
task prompt -> Q_task
score(position) = aggregate_attn(Q_task, K[position])
keep if score(position) exceeds threshold
```

## Why the Shared Mask Matters

Per-head masks maximize flexibility but force many incompatible small solves. A **shared global mask** makes the retained sequence layout identical across heads, which enables batched tensor operations and much lower latency.

That batching benefit is one of the main reasons Latent Briefing is interesting for inference systems rather than only for offline compression research.

## Thresholding vs Fixed Top-k

Instead of keeping a fixed number of tokens per head, Latent Briefing can threshold the aggregated per-position score distribution:

```text
keep position i if score[i] > median(score) + k * MAD(score)
```

This makes retention rate adaptive to the shape of the scores for the current task. Higher `k` means more aggressive compaction.

## Practical Assumptions

- The runtime can inspect and modify worker KV state
- The worker architecture is stable enough that attention-space retention is meaningful across calls
- The evaluation tracks both quality and cost, because lower token count alone is not sufficient
