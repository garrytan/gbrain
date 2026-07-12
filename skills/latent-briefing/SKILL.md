---
name: latent-briefing
description: "This skill should be used when the user asks to \"share memory between agents\", \"KV cache compaction for multi-agent\", \"orchestrator worker context\", \"latent briefing\", \"reduce worker tokens\", \"cross-agent memory without summarization\", or discusses Attention Matching compaction, recursive language models with workers, or token explosion in hierarchical agents."
---

# Latent Briefing and KV Cache Memory Sharing

Hierarchical multi-agent systems often pay for the same context twice. The orchestrator accumulates a long reasoning trajectory, but each worker usually receives only a narrow text handoff such as a subtask prompt plus raw document slices. Passing the full trajectory fixes coverage but drives token cost up on every worker call. Summarization introduces latency and information loss. Retrieval helps with document access but does not preserve the orchestrator's evolving reasoning state.

Latent Briefing addresses this by sharing memory at the **representation level** rather than the text level. The core idea is to compact the orchestrator trajectory in the worker model's KV cache, keeping positions that are most relevant to the **current worker task**. The method builds on **Attention Matching (AM)** KV cache compaction and adapts it for inference-time multi-agent handoff with task-guided queries, a shared token mask across heads, and robust thresholding.

## When to Activate

Activate this skill when:

- Designing orchestrator-worker or supervisor-specialist systems where workers need access to prior orchestrator state without replaying the full trajectory as text
- Evaluating alternatives to LLM summarization or RAG for cross-agent state transfer
- Implementing or studying **KV cache compaction** as a first-class inference primitive, not only prefix caching of identical prompts
- Debugging token explosion in recursive, hierarchical, or tool-heavy agent graphs
- Interpreting benchmarks that report worker-token savings, total-token savings, compaction overhead, and accuracy together

Do not activate this skill for adjacent work owned by other skills:
- API-only stacks where internal KV tensors are inaccessible: use `context-compression`, `memory-systems`, or `multi-agent-patterns`.
- Ordinary persistent memory, entity tracking, or graph retrieval: `memory-systems`.
- General multi-agent topology without representation-level state sharing: `multi-agent-patterns`.
- Prefix caching, masking, or budget policy that does not transform KV state: `context-optimization`.

## Core Concepts

**The token explosion pattern.** In recursive or REPL-style systems, the orchestrator repeatedly calls a worker to inspect evidence, verify hypotheses, or answer subquestions. The orchestrator's trajectory grows with partial conclusions, dead ends, tool output, and prior worker responses. If that trajectory is passed in full on every worker call, cost compounds quickly.

**Representation-level sharing.** Instead of summarizing the trajectory into natural language, the system operates on the worker model's **KV cache**. It retains the positions that the worker would attend to for the current task and drops the rest. This is more specific than ordinary prefix caching: prefix caching reuses identical prefixes, while Latent Briefing also performs **task-conditioned selective retention** inside the reused trajectory.

**Attention Matching as the compaction engine.** AM seeks a smaller cache whose attention outputs approximate the full cache. Latent Briefing adapts AM for multi-agent inference by changing the scoring signal and batching strategy:

1. Use **task-guided query vectors** derived from the current worker prompt.
2. Aggregate scores into a **shared global mask** instead of per-head independent subsets.
3. Use a robust threshold such as `median + tau * MAD` rather than fixed top-k per head.

**Reference result shape.** The public write-up reports substantial worker-token reduction, material total-token savings, and low-single-digit-second compaction overhead on long-document QA workloads (claim-latent-briefing-public-results). Treat these numbers as workload-specific evidence, not a general guarantee.

## Detailed Topics

### Why Text-Only Mitigations Fall Short

| Approach | Primary weakness |
|----------|------------------|
| LLM summarization | High latency, lossy abstraction, and no guarantee the summary preserves what the next subtask needs |
| Retrieval / RAG | Depends on chunking and embeddings; can miss cross-chunk or cross-step dependencies |
| Pass full trajectory | Cost scales with every worker call and irrelevant context can degrade worker quality |

Latent Briefing is useful when the bottleneck is not document retrieval itself, but **how to transfer orchestrator state into a worker efficiently and precisely**.

### Recursive Orchestrator-Worker Shape

Frameworks such as **Recursive Language Models** treat long context as an environment and recurse over it: an orchestrator decomposes work and delegates to workers. Latent Briefing fits the gap where the orchestrator has already built task-specific state that should inform the worker, but re-serializing that state as text is too expensive or noisy.

In the ideal setup, the worker maintains a persistent KV state for the orchestrator trajectory. New trajectory tokens extend that state, then compaction runs just before generation for the current subtask.

### Three Inference-Time Modifications

1. **Task-guided query vectors.** Use queries from the current worker task prompt, not generic samples from the context. Forward-pass the trajectory plus current task through the worker model, then score trajectory positions by how strongly the task attends to them.

2. **Shared token selection.** Aggregate scores across layers and heads into one per-position score. One shared mask enables batched operations and avoids hundreds of incompatible per-head solves.

3. **MAD thresholding.** Keep positions above a robust outlier threshold such as `median + tau * MAD`. Higher `tau` is more aggressive. Optimal settings depend on task regime, trajectory quality, and document length.

### Infrastructure Preconditions

Latent Briefing is only practical when the system **controls the worker inference runtime** closely enough to inspect or transform KV state. It is a poor default for API-only stacks where internal KV tensors are inaccessible. It also assumes the orchestrator trajectory can be represented in the worker's model space. If orchestrator and worker differ materially in tokenizer, architecture, or attention layout, direct representation sharing may not be viable.

### Decision Framework

Choose the mechanism that matches the bottleneck:

| Need | Prefer | Why |
|------|--------|-----|
| Stable repeated prefix with minimal logic changes | Prefix caching | Cheapest optimization; no information loss |
| Human-readable and auditable cross-step state | Structured notes or summarization | Easy to inspect and store |
| Sparse lookup across a large external corpus | Retrieval / RAG | Finds documents efficiently |
| Worker needs task-specific slices of orchestrator state and runtime access exists | Latent Briefing | Transfers relevant latent state without replaying all text |

Latent Briefing is not a universal replacement for summarization or retrieval. It is a specialized optimization for systems that already run a controllable orchestrator-worker stack.

### Threshold Regimes

Reported long-document QA results suggest:

- **Longer documents:** lighter compaction can preserve broader evidence coverage while still saving tokens.
- **Harder questions:** more aggressive compaction can help when the orchestrator trajectory contains speculative or low-value branches.
- **Shorter, easier contexts:** moderate compaction may remove redundancy without dropping needed evidence.

These are tuning hypotheses, not portable laws. Re-measure on the target workload.

## Practical Guidance

- **Define the shared memory boundary first.** Decide exactly what enters the trajectory cache: prior worker replies, tool output, chain-of-thought, or only selected artifacts. Compaction quality depends on what is allowed into the cache in the first place.
- **Tune on validation data, not anecdotes.** Track task accuracy, worker tokens, total tokens, retention rate, and compaction overhead together.
- **Measure end-to-end latency.** Compaction only pays off if compaction plus generation beats the best text-layer alternative for the same quality target.
- **Use strong baselines.** Compare against prefix caching, structured notes, retrieval, and selective text handoff, not only "send everything."
- **Expect orchestrator variance.** If decomposition strategy changes run to run, average over enough trials to separate compaction effects from orchestrator noise.

## Examples

**Scenario: orchestrator trajectory grows across worker calls**

```text
Call 1: trajectory T1 -> worker answers subquestion A
Call 2: trajectory T2 = T1 + new reasoning + reply A
        compact KV(T2) using the task prompt for B
        worker answers subquestion B
```

The task prompt for B decides which parts of `T2` survive into the compacted worker state.

**Negative example: API-only worker**

If the worker runs behind a hosted text-generation API that does not expose KV tensors, Latent Briefing cannot be implemented directly. Use a structured text handoff from `context-compression` or retrieve state from `memory-systems` instead.

## Guidelines

1. Prefer Latent Briefing when the main waste comes from replaying orchestrator state into workers, not from retrieving source documents.
2. Prefer plain text handoff when auditability, portability, or closed-model APIs matter more than token efficiency.
3. Co-design compaction with **evaluation**. A small quality drop can erase large token savings.
4. Expose compaction aggressiveness as a controlled parameter, not a hidden constant.

## Gotchas

1. **Infrastructure access is the first gate.** If the runtime cannot inspect and rewrite worker KV state, Latent Briefing is a research idea, not a deployable technique.
2. **Shared model space matters.** KV compaction is defined in a specific model's attention space. Do not assume latent handoff works cleanly across unrelated model families.
3. **Threshold is workload-dependent.** One global `tau` rarely works across long vs short context and easy vs hard tasks. Expect accuracy cliffs when compaction becomes too aggressive.
4. **Benchmark scope is narrow.** Public results focus on long-document QA. Code generation, math, and multi-document synthesis may behave differently.
5. **Orchestrator variance can hide the signal.** A stochastic orchestrator can change the trajectory enough to swamp small compaction gains or losses.
6. **Weak baselines inflate the apparent win.** Compare against strong text-level alternatives before claiming a system-level advantage.

## Integration

- context-optimization - Prefix caching and observation masking remain the default first moves; Latent Briefing is a more specialized optimization for compatible orchestrator-worker stacks.
- multi-agent-patterns - Applies when multi-agent token cost is driven by supervisor trajectory replay, not only by coordination overhead.
- context-compression - Text-layer summaries remain preferable when human-readable state, portability, or audit logs matter.
- memory-systems - Helps decide when to keep cross-step state in external memory versus in the worker's latent state.
- tool-design - Worker call shapes and task prompts determine which tokens score highly during compaction.

## References

Internal reference:
- [Attention Matching formulation and task-guided scoring](./references/attention-matching-formulation.md) - Read when: needing the AM objective, how task-guided scoring changes the query source, or why a shared global mask matters for batching

Related skills in this collection:
- context-optimization - Read when: the main need is prefix caching, observation masking, or text-layer compaction rather than worker KV manipulation
- multi-agent-patterns - Read when: deciding whether the architecture should be orchestrator-worker at all
- context-compression - Read when: human-readable summaries may be a better fit than latent transfer
- memory-systems - Read when: comparing in-model latent state with external persistent memory

External resources:
- Ramp Labs announcement: [Latent Briefing: Efficient Memory Sharing for Multi-Agent Systems via KV Cache Compaction](https://x.com/RampLabs/status/2042660310851449223)
- Attention Matching (AM): [Fast KV Compaction via Attention Matching](https://arxiv.org/abs/2602.16284)
- Recursive Language Models: [Recursive Language Models](https://arxiv.org/abs/2512.24601)

---

## Skill Metadata

**Created**: 2026-04-14
**Last Updated**: 2026-05-15
**Author**: Agent Skills for Context Engineering Contributors; primary technical source Ramp Labs (public post)
**Version**: 1.2.0

## Contract
- Inputs: agent context/system
- Outputs: guidance

## Output Format
- Markdown guidance

## Anti-Patterns
- Context bloat without signal
