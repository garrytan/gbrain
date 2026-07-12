---
name: context-degradation
description: "This skill should be used for diagnosing and mitigating context degradation: lost-in-middle failures, context poisoning, context clash, context confusion, attention-pattern issues, and agent performance degradation caused by accumulated or conflicting context."
---

# Context Degradation Patterns

Diagnose and fix context failures before they cascade. Context degradation is not binary — it is a continuum that manifests through five distinct, predictable patterns: lost-in-middle, poisoning, distraction, confusion, and clash. Each pattern has specific detection signals and mitigation strategies. Treat degradation as an engineering problem with measurable thresholds, not an unpredictable failure mode.

## When to Activate

Activate this skill when:
- Agent performance degrades unexpectedly during long conversations
- Debugging cases where agents produce incorrect or irrelevant outputs
- Designing systems that must handle large contexts reliably
- Evaluating context engineering choices for production systems
- Investigating "lost in middle" phenomena in agent outputs
- Analyzing context-related failures in agent behavior

Do not activate this skill for adjacent work owned by other skills:
- Explaining foundational context mechanics without an active failure: `context-fundamentals`.
- Applying token-efficiency tactics after the failure pattern is known: `context-optimization`.
- Designing a compression or handoff summary strategy: `context-compression`.
- Persisting large outputs, logs, or scratch state outside the prompt: `filesystem-context`.

## Core Concepts

Structure context placement around the attention U-curve: beginning and end positions receive reliable attention, while middle positions suffer materially reduced recall accuracy in long-context experiments (claim-context-degradation-lost-middle-ruler). This is not a model bug but a consequence of attention mechanics — the first token (often BOS) acts as an "attention sink" that absorbs disproportionate attention budget, leaving middle tokens under-attended as context grows.

Treat context poisoning as a circuit breaker problem. Once a hallucination, tool error, or incorrect retrieved fact enters context, it compounds through repeated self-reference. A poisoned goals section causes every downstream decision to reinforce incorrect assumptions. Detection requires tracking claim provenance; recovery requires truncating to before the poisoning point or restarting with verified-only context.

Filter aggressively before loading context — even a single irrelevant document measurably degrades performance on relevant tasks. Models cannot "skip" irrelevant context; they must attend to everything provided, creating attention competition between relevant and irrelevant content. Move information that might be needed but is not immediately relevant behind tool calls instead of pre-loading it.

Isolate task contexts to prevent confusion. When context contains multiple task types or switches between objectives, models incorporate constraints from the wrong task, call tools appropriate for a different context, or blend requirements from multiple sources. Explicit task segmentation with separate context windows eliminates cross-contamination.

Resolve context clash through priority rules, not accumulation. When multiple correct-but-contradictory sources appear in context (version conflicts, perspective conflicts, multi-source retrieval), models cannot determine which applies. Mark contradictions explicitly, establish source precedence, and filter outdated versions before they enter context.

## Detailed Topics

### Lost-in-Middle: Detection and Placement Strategy

Place critical information at the beginning and end of context, never in the middle. The U-shaped attention curve means middle-positioned information suffers 10-40% reduced recall accuracy. For contexts over 4K tokens, this effect becomes significant.

Use summary structures that surface key findings at attention-favored positions. Add explicit section headers and structural markers — these help models navigate long contexts by creating attention anchors. When a document must be included in full, prepend a summary of its key points and append the critical conclusions.

Monitor for lost-in-middle symptoms: correct information exists in context but the model ignores it, responses contradict provided data, or the model "forgets" instructions given earlier in a long prompt.

### Context Poisoning: Prevention and Recovery

Validate all external inputs before they enter context. Tool outputs, retrieved documents, and model-generated summaries are the three primary poisoning vectors. Each introduces unverified claims that subsequent reasoning treats as ground truth.

Detect poisoning through these signals: degraded output quality on previously-successful tasks, tool misalignment (wrong tools or parameters), and hallucinations that persist despite explicit correction. When these cluster, suspect poisoning rather than model capability issues.

Recover by removing poisoned content, not by adding corrections on top. Truncate to before the poisoning point, restart with clean context preserving only verified information, or explicitly mark the poisoned section and request re-evaluation from scratch. Layering corrections over poisoned context rarely works — the original errors retain attention weight.

### Context Distraction: Curation Over Accumulation

Curate what enters context rather than relying on models to ignore irrelevant content. Research shows even a single distractor document triggers measurable performance degradation — the effect follows a step function, not a linear curve. Multiple distractors compound the problem.

Apply relevance filtering before loading retrieved documents. Use namespacing and structural organization to make section boundaries clear. Prefer tool-call-based access over pre-loading: store reference material behind retrieval tools so it enters context only when directly relevant to the current reasoning step.

### Context Confusion: Task Isolation

Segment different tasks into separate context windows. Context confusion is distinct from distraction — it concerns the model applying wrong-context constraints to the current task, not just attention dilution. Signs include responses addressing the wrong aspect of a query, tool calls appropriate for a different task, and outputs mixing requirements from multiple sources.

Implement clear transitions between task contexts. Use state management that isolates objectives, constraints, and tool definitions per task. When task-switching within a single session is unavoidable, use explicit "context reset" markers that signal which constraints apply to the current segment.

### Context Clash: Conflict Resolution Protocols

Establish source priority rules before conflicts arise. Context clash differs from poisoning — multiple pieces of information are individually correct but mutually contradictory (version conflicts, perspective differences, multi-source retrieval with divergent facts).

Implement version filtering to exclude outdated information before it enters context. When contradictions are unavoidable, mark them explicitly with structured conflict annotations: state what conflicts, which source each claim comes from, and which source takes precedence. Without explicit priority rules, models resolve contradictions unpredictably.

### Empirical Benchmarks and Thresholds

Use these benchmarks to set design constraints — not as universal truths. RULER-style evidence shows advertised long-context support does not guarantee satisfactory task performance at that length (claim-context-degradation-lost-middle-ruler). Near-perfect needle-in-haystack scores do not predict real-world long-context performance.

**Model-Specific Degradation Thresholds**

Degradation onset varies significantly by model family and task type. As a general rule, expect degradation to begin at 60-70% of the advertised context window for complex retrieval tasks (RULER benchmark found only 50% of models claiming 32K+ context maintain satisfactory performance at that length). Key patterns:

- **Models with extended thinking** reduce hallucination through step-by-step verification but at higher latency and token cost
- **Models optimized for agents/coding** tend to have better attention management for tool-output-heavy contexts
- **Models with very large context windows (1M+)** handle more raw context but still follow U-shaped degradation curves — bigger windows do not eliminate the problem, they delay it

Always benchmark degradation thresholds with your specific workload rather than relying on published benchmarks. Model-specific thresholds go stale with each model update (see Gotcha 2).

### Counterintuitive Findings

Account for these research-backed surprises when designing context strategies:

**Shuffled context can outperform coherent context.** Studies found incoherent (shuffled) haystacks can outperform logically ordered ones for some retrieval tasks (claim-context-degradation-distractor-shuffled). Coherent context may create false associations that confuse retrieval; incoherent context can force exact matching. Do not assume that better-organized context always yields better results — test both arrangements.

**Single distractors have outsized impact.** The performance hit from one irrelevant document is disproportionately large compared to adding more distractors after the first. Treat distractor prevention as binary: either keep context clean or accept significant degradation.

**Low needle-question similarity accelerates degradation.** Tasks requiring inference across dissimilar content degrade faster with context length than tasks with high surface-level similarity. Design retrieval to maximize semantic overlap between queries and retrieved content.

### When Larger Contexts Hurt

Do not assume larger context windows improve performance. Performance remains stable up to a model-specific threshold, then degrades rapidly — the curve is non-linear with a cliff edge, not a gentle slope. For many models, meaningful degradation begins at 8K-16K tokens even when windows support much larger sizes.

Factor in cost: processing a 400K token context costs exponentially more than 200K in both time and compute, not linearly more. For many applications, this makes large-context processing economically impractical.

Recognize the cognitive bottleneck: even with infinite context, asking a single model to maintain quality across dozens of independent tasks creates degradation that more context cannot solve. Split tasks across sub-agents instead of expanding context.

## Practical Guidance

### The Four-Bucket Mitigation Framework

Apply these four strategies based on which degradation pattern is active:

**Write** — Save context outside the window using scratchpads, file systems, or external storage. Use when context utilization exceeds 70% of the window. This keeps active context lean while preserving information access through tool calls.

**Select** — Pull only relevant context into the window through retrieval, filtering, and prioritization. Use when distraction or confusion symptoms appear. Apply relevance scoring before loading; exclude anything below threshold rather than including everything available.

**Compress** — Reduce tokens while preserving information through summarization, abstraction, and observation masking. Use when context is growing but all content is relevant. Replace verbose tool outputs with compact structured summaries; abstract repeated patterns into single references.

**Isolate** — Split context across sub-agents or sessions to prevent any single context from growing past its degradation threshold. Use when confusion or clash symptoms appear, or when tasks are independent. This is the most aggressive strategy but often the most effective for complex multi-task systems.

### Architectural Patterns for Resilience

Implement just-in-time context loading: retrieve information only when the current reasoning step needs it, not preemptively. Use observation masking to replace verbose tool outputs with compact references after processing. Deploy sub-agent architectures where each agent holds only task-relevant context. Trigger compaction before context exceeds the model-specific degradation onset threshold — not after symptoms appear.

## Examples

**Example 1: Detecting Degradation**
```yaml
# Context grows during long conversation
turn_1: 1000 tokens
turn_5: 8000 tokens
turn_10: 25000 tokens
turn_20: 60000 tokens (degradation begins)
turn_30: 90000 tokens (significant degradation)
```

**Example 2: Mitigating Lost-in-Middle**
```markdown
# Organize context with critical info at edges

[CURRENT TASK]                      # At start
- Goal: Generate quarterly report
- Deadline: End of week

[DETAILED CONTEXT]                  # Middle (less attention)
- 50 pages of data
- Multiple analysis sections
- Supporting evidence

[KEY FINDINGS]                     # At end
- Revenue up 15%
- Costs down 8%
- Growth in Region A
```

**Example 3: Context poisoning circuit breaker**
```text
symptom: agent keeps citing an incorrect retrieved claim after correction
diagnosis: poisoned context, not a missing-instruction problem
action:
  1. identify first turn where the bad claim entered
  2. truncate or restart from before that point
  3. reload only verified sources
  4. record the rejected claim and source provenance
```

**Example 4: Context clash annotation**
```yaml
conflict:
  topic: billing API version
  source_a: docs/v1.md says endpoint is /charges
  source_b: docs/v2.md says endpoint is /payments
  precedence: docs/v2.md
  reason: current production version
```

## Guidelines

1. Monitor context length and performance correlation during development
2. Place critical information at beginning or end of context
3. Implement compaction triggers before degradation becomes severe
4. Validate retrieved documents for accuracy before adding to context
5. Use versioning to prevent outdated information from causing clash
6. Segment tasks to prevent context confusion across different objectives
7. Design for graceful degradation rather than assuming perfect conditions
8. Test with progressively larger contexts to find degradation thresholds

## Gotchas

1. **Normal variance looks like degradation**: Model output quality fluctuates naturally across runs. Do not diagnose degradation from a single drop in quality — establish a baseline over multiple runs and look for sustained, correlated decline tied to context growth. A 5-10% quality dip on one run is noise; the same dip consistently appearing after 40K tokens is signal.

2. **Model-specific thresholds go stale**: The degradation onset values in benchmark tables reflect specific model versions. Provider updates, fine-tuning changes, and infrastructure shifts can move thresholds by 20-50% in either direction. Re-benchmark quarterly and after any major model update rather than treating published thresholds as permanent.

3. **Needle-in-haystack scores create false confidence**: A model scoring 99% on needle-in-haystack does not mean it handles 128K tokens well in production. Needle tests measure single-fact retrieval from passive context — real workloads require multi-fact reasoning, instruction following, and synthesis across the full window. Use task-specific benchmarks that mirror actual workload patterns.

4. **Contradictory retrieved documents poison silently**: When a RAG pipeline retrieves two documents that disagree on a fact, the model may silently pick one without signaling the conflict. This looks like a correct response but is effectively random. Implement contradiction detection in the retrieval layer before documents enter context.

5. **Prompt quality problems masquerade as degradation**: Poor prompt structure (ambiguous instructions, missing constraints, unclear task framing) produces symptoms identical to context degradation — inconsistent outputs, ignored instructions, wrong tool usage. Before diagnosing degradation, verify the same prompt works correctly at low context lengths. If it fails at 2K tokens, the problem is the prompt, not the context.

6. **Degradation is non-linear with a cliff edge**: Performance does not degrade gradually — it holds steady until a model-specific threshold, then drops sharply. Systems designed for "graceful degradation" often miss this pattern because monitoring checks assume linear decline. Set compaction triggers well before the cliff (at 70% of known onset), not at the onset itself.

7. **Over-organizing context can backfire**: Intuitively, well-structured and coherent context should outperform disorganized content. Research shows shuffled haystacks sometimes outperform coherent ones for retrieval tasks because coherent context creates false associations. Test whether heavy structural formatting actually helps for the specific task — do not assume it does.

## Integration

This skill owns diagnosis and mitigation of active context failures. Adjacent skills own the implementation tactics once the failure is identified:

- `context-fundamentals`: conceptual explanation of attention and context windows before a failure exists.
- `context-optimization`: masking, caching, partitioning, and other token-efficiency tactics after diagnosis.
- `context-compression`: structured summaries and handoffs when accumulated context must be compacted.
- `filesystem-context`: offloading raw outputs, logs, and scratch state so poisoned or bulky context can be inspected without staying in the prompt.
- `multi-agent-patterns`: isolating tasks into separate contexts to prevent confusion and clash.
- `evaluation`: degradation tests and production monitoring.

## References

Internal reference:
- [Degradation Patterns Reference](./references/patterns.md) - Read when: debugging a specific degradation pattern and needing implementation-level detection code (attention analysis, poisoning tracking, relevance scoring, recovery procedures)

Related skills in this collection:
- context-fundamentals - Read when: lacking foundational understanding of context windows, token budgets, or placement mechanics
- context-optimization - Read when: degradation is diagnosed and specific mitigation techniques (compaction, compression, masking) are needed
- evaluation - Read when: setting up production monitoring to detect degradation before it impacts users

External resources:
- Liu et al., 2023 "Lost in the Middle" - Read when: needing primary research backing for U-shaped attention claims or designing position-aware context layouts
- RULER benchmark documentation - Read when: evaluating model claims about long-context support or comparing models for context-heavy workloads
- Production engineering guides from AI labs - Read when: implementing context management in production infrastructure

---

## Skill Metadata

**Created**: 2025-12-20
**Last Updated**: 2026-05-15
**Author**: Agent Skills for Context Engineering Contributors
**Version**: 2.1.0

## Contract
- Inputs: agent/system context
- Outputs: guidance

## Output Format
- Markdown guidance

## Anti-Patterns
- Stuffing context without signal; ignoring degradation
