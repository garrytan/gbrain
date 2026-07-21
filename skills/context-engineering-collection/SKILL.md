---
name: context-engineering-collection
description: "A comprehensive collection of Agent Skills for context engineering, harness engineering, multi-agent architectures, and production agent systems. Use when building, optimizing, evaluating, or debugging agent systems that require effective context management and reliable operating loops."
---

# Agent Skills for Context Engineering

This collection provides structured guidance for building production-grade AI agent systems through effective context engineering.

## When to Activate

Activate these skills when:
- Building new agent systems from scratch
- Optimizing existing agent performance
- Debugging context-related failures
- Designing multi-agent architectures
- Creating or evaluating tools for agents
- Implementing memory and persistence layers
- Designing autonomous research or evaluation harnesses

## Skill Map

### Foundational Context Engineering

**Understanding Context Fundamentals**
Context is not just prompt text—it is the complete state available to the language model at inference time, including system instructions, tool definitions, retrieved documents, message history, and tool outputs. Effective context engineering means understanding what information truly matters for the task at hand and curating that information for maximum signal-to-noise ratio.

**Recognizing Context Degradation**
Language models exhibit predictable degradation patterns as context grows: the "lost-in-middle" phenomenon where information in the center of context receives less attention; U-shaped attention curves that prioritize beginning and end; context poisoning when errors compound; and context distraction when irrelevant information overwhelms relevant content.

### Architectural Patterns

**Multi-Agent Coordination**
Production multi-agent systems converge on three dominant patterns: supervisor/orchestrator architectures with centralized control, peer-to-peer swarm architectures for flexible handoffs, and hierarchical structures for complex task decomposition. The critical insight is that sub-agents exist primarily to isolate context rather than to simulate organizational roles.

**Long-Horizon Prompting**
Long-running autonomous agents and parallel orchestrations succeed or fail on the launch prompt. Pseudo-formal task briefs specify success predicates, non-counting outcomes, persistence rules with audit-gated return conditions, effort floors, diversity policies for parallel portfolios, and contamination guards, applying the discipline of formal verification linguistically to problems with no machine-checkable success condition.

**Memory System Design**
Memory architectures range from simple scratchpads to sophisticated temporal knowledge graphs. Vector RAG provides semantic retrieval but loses relationship information. Knowledge graphs preserve structure but require more engineering investment. The file-system-as-memory pattern enables just-in-time context loading without stuffing context windows.

**Filesystem-Based Context**
The filesystem provides a single interface for storing, retrieving, and updating effectively unlimited context. Key patterns include scratch pads for tool output offloading, plan persistence for long-horizon tasks, sub-agent communication via shared files, and dynamic skill loading. Agents use `ls`, `glob`, `grep`, and `read_file` for targeted context discovery, often outperforming semantic search for structural queries.

**Hosted Agent Infrastructure**
Background coding agents run in remote sandboxed environments rather than on local machines. Key patterns include pre-built environment images refreshed on regular cadence, warm sandbox pools for instant session starts, filesystem snapshots for session persistence, and multiplayer support for collaborative agent sessions. Critical optimizations include allowing file reads before git sync completes (blocking only writes), predictive sandbox warming when users start typing, and self-spawning agents for parallel task execution.

**Tool Design Principles**
Tools are contracts between deterministic systems and non-deterministic agents. Effective tool design follows the consolidation principle (prefer single comprehensive tools over multiple narrow ones), returns contextual information in errors, supports response format options for token efficiency, and uses clear namespacing.

### Operational Excellence

**Context Compression**
When agent sessions exhaust memory, compression becomes mandatory. The correct optimization target is tokens-per-task, not tokens-per-request. Structured summarization with explicit sections for files, decisions, and next steps preserves more useful information than aggressive compression. Artifact trail integrity remains the weakest dimension across all compression methods.

**Context Optimization**
Techniques include compaction (summarizing context near limits), observation masking (replacing verbose tool outputs with references), prefix caching (reusing KV blocks across requests), and strategic context partitioning (splitting work across sub-agents with isolated contexts).

**Latent Briefing (KV Memory Sharing)**
Orchestrator-worker systems can compound tokens when supervisors accumulate long trajectories but workers see only narrow text slices. Latent Briefing compacts the orchestrator trajectory in the worker model's KV cache using task-guided attention (Attention Matching-style compaction) so workers receive relevant latent state without full-text replay when the stack exposes worker KV state and the models are compatible.

**Evaluation Frameworks**
Production agent evaluation requires deterministic checks and multi-dimensional rubrics covering factual accuracy, completeness, tool efficiency, and process quality. Use model judges only after structure, evidence, and rubric math are valid; route judge design, pairwise comparison, and bias mitigation to Advanced Evaluation.

**Harness Engineering**
Reliable autonomous agents need explicit operating loops around the model: locked metrics, editable surfaces, durable logs, novelty checks, rollback rules, and human approval boundaries. Harnesses prevent agents from weakening the evaluator, losing state across compaction, or turning ambiguous goals into unreviewable changes.

**Self-Improvement Loops**
When the harness itself becomes the optimization target, a different discipline applies: recursive self-improvement, meta-harness search, failure-driven bounded self-edits, evolutionary scaffold search, and context mechanism evolution. The controlling constraints are empirical two-split acceptance gates, filesystem experience archives with raw traces, runtime-enforced constraints outside every editable surface, and diversity preservation to prevent collapse.

### Development Methodology

**Project Development**
Effective LLM project development begins with task-model fit analysis: validating through manual prototyping that a task is well-suited for LLM processing before building automation. Production pipelines follow staged, idempotent architectures (acquire, prepare, process, parse, render) with file system state management for debugging and caching. Structured output design with explicit format specifications enables reliable parsing. Start with minimal architecture and add complexity only when proven necessary.

### Cognitive Architecture

**BDI Mental States**
Belief-desire-intention modeling provides a formal way to translate structured external context into agent mental states. Use it for rational agency, explainability, and systems that need auditable links between beliefs, goals, and chosen actions.

## Core Concepts

The collection is organized around four core themes. First, context fundamentals establish what context is, how attention mechanisms work, and why context quality matters more than quantity. Second, architectural patterns cover the structures and coordination mechanisms that enable effective agent systems. Third, operational excellence addresses optimization, evaluation, and harness reliability. Fourth, development methodology and cognitive architecture cover project execution and formal mental-state modeling.

## Practical Guidance

Each skill can be used independently or in combination. Start with fundamentals to establish context management mental models. Branch into architectural patterns based on your system requirements. Reference operational skills when optimizing production systems.

The skills are platform-agnostic and work with Claude Code, Cursor, or any agent framework that supports custom instructions or skill-like constructs.

## Integration

This collection integrates with itself—skills reference each other and build on shared concepts. The fundamentals skill provides context for all other skills. Architectural skills (multi-agent, memory, tools) can be combined for complex systems. Operational skills (optimization, evaluation) apply to any system built using the foundational and architectural skills.

## References

Internal skills in this collection:
- [context-fundamentals](skills/context-fundamentals/SKILL.md)
- [context-degradation](skills/context-degradation/SKILL.md)
- [context-compression](skills/context-compression/SKILL.md)
- [multi-agent-patterns](skills/multi-agent-patterns/SKILL.md)
- [long-horizon-prompting](skills/long-horizon-prompting/SKILL.md)
- [memory-systems](skills/memory-systems/SKILL.md)
- [tool-design](skills/tool-design/SKILL.md)
- [filesystem-context](skills/filesystem-context/SKILL.md)
- [hosted-agents](skills/hosted-agents/SKILL.md)
- [context-optimization](skills/context-optimization/SKILL.md)
- [latent-briefing](skills/latent-briefing/SKILL.md)
- [evaluation](skills/evaluation/SKILL.md)
- [advanced-evaluation](skills/advanced-evaluation/SKILL.md)
- [harness-engineering](skills/harness-engineering/SKILL.md)
- [self-improvement-loops](skills/self-improvement-loops/SKILL.md)
- [project-development](skills/project-development/SKILL.md)
- [bdi-mental-states](skills/bdi-mental-states/SKILL.md)

External resources on context engineering:
- Research on attention mechanisms and context window limitations
- Production experience from leading AI labs on agent system design
- Framework documentation for LangGraph, AutoGen, and CrewAI

---

## Skill Metadata

**Created**: 2025-12-20
**Last Updated**: 2026-07-11
**Author**: Agent Skills for Context Engineering Contributors
**Version**: 2.5.0

## Contract
- Inputs: agent context/system
- Outputs: guidance

## Output Format
- Markdown guidance

## Anti-Patterns
- Context bloat without signal
