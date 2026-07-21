---
name: memory-systems
description: "This skill should be used for persistent semantic memory in agent systems: cross-session knowledge retention, entity tracking, temporal validity, graph or vector retrieval, memory consolidation, and memory benchmark selection. Route file-backed scratchpads to filesystem-context, handoff summaries to context-compression, and token-efficiency tactics to context-optimization."
---

# Memory System Design

Memory provides the persistence layer that allows agents to maintain continuity across sessions and reason over accumulated knowledge. Simple agents rely entirely on context for memory, losing all state when sessions end. Sophisticated agents implement layered memory architectures that balance immediate context needs with long-term knowledge retention. The evolution from vector stores to knowledge graphs to temporal knowledge graphs represents increasing investment in structured memory for improved retrieval and reasoning.

## When to Activate

Activate this skill when:
- Building agents that must persist knowledge across sessions
- Choosing between memory frameworks (Mem0, Zep/Graphiti, Letta, LangMem, Cognee)
- Needing to maintain entity consistency across conversations
- Implementing reasoning over accumulated knowledge
- Designing memory architectures that scale in production
- Evaluating memory systems against benchmarks (LoCoMo, LongMemEval, DMR)
- Building dynamic memory with automatic entity/relationship extraction and self-improving memory (Cognee)

Do not activate this skill for adjacent work owned by other skills:
- File-backed scratchpads, run logs, and tool-output offloading: `filesystem-context`.
- Conversation compaction or human-readable handoff summaries: `context-compression`.
- Masking, prefix caching, token budgets, or retrieval scoping inside one trajectory: `context-optimization`.
- Formal belief/desire/intention models over RDF state: `bdi-mental-states`.

## Core Concepts

Think of memory as a spectrum from volatile context window to persistent storage. Default to the simplest layer that meets retrieval needs, because benchmark evidence suggests tool complexity matters less than reliable retrieval for some memory workloads (claim-memory-locomo-filesystem-baseline). Add structure (graphs, temporal validity) only when retrieval quality degrades or the agent needs multi-hop reasoning, relationship traversal, or time-travel queries.

## Detailed Topics

### Production Framework Landscape

Select a framework based on the dominant retrieval pattern the agent requires. Use this table to narrow the shortlist, then validate with the benchmark data below.

| Framework | Architecture | Best For | Trade-off |
|-----------|-------------|----------|-----------|
| **Mem0** | Vector store + graph memory, pluggable backends | Multi-tenant systems, broad integrations | Less specialized for multi-agent |
| **Zep/Graphiti** | Temporal knowledge graph, bi-temporal model | Enterprise requiring relationship modeling + temporal reasoning | Advanced features cloud-locked |
| **Letta** | Self-editing memory with tiered storage (in-context/core/archival) | Full agent introspection, stateful services | Complexity for simple use cases |
| **Cognee** | Multi-layer semantic graph via customizable ECL pipeline with customizable Tasks | Evolving agent memory that adapts and learns; multi-hop reasoning | Heavier ingest-time processing |
| **LangMem** | Memory tools for LangGraph workflows | Teams already on LangGraph | Tightly coupled to LangGraph |
| **File-system** | Plain files with naming conventions | Simple agents, prototyping | No semantic search, no relationships |

Choose Zep/Graphiti when the agent needs bi-temporal modeling (tracking both when events occurred and when they were ingested) because its three-tier knowledge graph (episode, semantic entity, community subgraphs) excels at temporal queries. Choose Mem0 when the priority is fast time-to-production with managed infrastructure. Choose Letta when the agent needs deep self-introspection through its Agent Development Environment. Choose Cognee when the agent must build dense multi-layer semantic graphs — it layers text chunks and entity types as nodes with detailed relationship edges, and every core piece (ingestion, entity extraction, post-processing, retrieval) is customizable.

**Benchmark Performance Comparison**

Consult these benchmarks to set expectations, but treat them as source-specific signals for retrieval dimensions rather than absolute rankings. No single benchmark is definitive.

| System | DMR Accuracy | LoCoMo | HotPotQA (multi-hop) | Latency |
|--------|-------------|--------|---------------------|---------|
| Cognee | — | — | Published high score | Variable |
| Zep (Temporal KG) | Published high score | — | Mid-range across metrics | Low-latency reported |
| Letta (filesystem) | — | Published filesystem baseline | — | — |
| Mem0 | — | Published specialized-tool baseline | Lower in one comparison | — |
| MemGPT | Published high score | — | — | Variable |
| GraphRAG | Published mid/high range | — | — | Variable |
| Vector RAG baseline | Published lower range | — | — | Fast |

Key takeaway: compare memory systems by retrieval shape, not brand. Use benchmark numbers as dated evidence that must be rechecked before making product claims; the stable design rule is to start shallow, measure retrieval quality, then add semantic or graph structure only when a simpler layer fails.

### Memory Layers (Decision Points)

Pick the shallowest memory layer that satisfies the persistence requirement. Each deeper layer adds infrastructure cost and operational complexity, so only escalate when the shallower layer cannot meet the retrieval or durability need.

| Layer | Persistence | Implementation | When to Use |
|-------|------------|----------------|-------------|
| **Working** | Context window only | Scratchpad in system prompt | Always — optimize with attention-favored positions |
| **Short-term** | Session-scoped | File-system, in-memory cache | Intermediate tool results, conversation state |
| **Long-term** | Cross-session | Key-value store → graph DB | User preferences, domain knowledge, entity registries |
| **Entity** | Cross-session | Entity registry + properties | Maintaining identity ("John Doe" = same person across conversations) |
| **Temporal KG** | Cross-session + history | Graph with validity intervals | Facts that change over time, time-travel queries, preventing context clash |

### Retrieval Strategies

Match the retrieval strategy to the query shape. Semantic search handles direct factual lookups well but degrades on multi-hop reasoning; entity-based traversal handles "everything about X" queries but requires graph structure; temporal filtering handles changing facts but requires validity metadata. When accuracy is paramount and infrastructure budget allows, combine strategies into hybrid retrieval.

| Strategy | Use When | Limitation |
|----------|----------|------------|
| **Semantic** (embedding similarity) | Direct factual queries | Degrades on multi-hop reasoning |
| **Entity-based** (graph traversal) | "Tell me everything about X" | Requires graph structure |
| **Temporal** (validity filter) | Facts change over time | Requires validity metadata |
| **Hybrid** (semantic + keyword + graph) | Best overall accuracy | Most infrastructure |

Hybrid approaches reduce active context by retrieving only relevant subgraphs or memories. Cognee implements hybrid retrieval through multiple search modes across graph, vector, and relational stores, letting agents select the retrieval strategy that fits the query type rather than using a one-size-fits-all approach.

### Memory Consolidation

Run consolidation periodically to prevent unbounded growth, because unchecked memory accumulation degrades retrieval quality over time. **Invalidate but do not discard** — preserving history matters for temporal queries that need to reconstruct past states. Trigger consolidation on memory count thresholds, degraded retrieval quality, or scheduled intervals. See [Implementation Reference](./references/implementation.md) for working consolidation code.

## Practical Guidance

### Choosing a Memory Architecture

**Start with the simplest viable layer and add complexity only when retrieval quality degrades.** Most agents do not need a temporal knowledge graph on day one. Follow this escalation path:

1. **Prototype**: Use file-system memory. Store facts as structured JSON with timestamps. This validates agent behavior before committing to infrastructure.
2. **Scale**: Move to Mem0 or a vector store with metadata when the agent needs semantic search and multi-tenant isolation, because file-based lookup cannot handle similarity queries.
3. **Complex reasoning**: Add Zep/Graphiti when the agent needs relationship traversal, temporal validity, or cross-session synthesis. Graphiti uses structured ties with generic relations, keeping graphs simple and easy to reason about; Cognee builds denser multi-layer semantic graphs with detailed relationship edges — choose based on whether the agent needs temporal bi-modeling (Graphiti) or richer interconnected knowledge structures (Cognee).
4. **Full control**: Use Letta or Cognee when the agent must self-manage its own memory with deep introspection, because these frameworks expose memory operations as first-class agent actions.

### Integration with Context

Load memories just-in-time rather than preloading everything, because large context payloads are expensive and degrade attention quality. Place retrieved memories in attention-favored positions (beginning or end of context) to maximize their influence on generation.

### Error Recovery

Handle retrieval failures gracefully because memory systems are inherently noisy. Apply these recovery strategies in order:

- **Empty retrieval**: Fall back to broader search (remove entity filter, widen time range). If still empty, prompt user for clarification.
- **Stale results**: Check `valid_until` timestamps. If most results are expired, trigger consolidation before retrying.
- **Conflicting facts**: Prefer the fact with the most recent `valid_from`. Surface the conflict to the user if confidence is low.
- **Storage failure**: Queue writes for retry. Never block the agent's response on a memory write.

## Examples

**Example 1: Mem0 Integration**
```python
from mem0 import Memory

m = Memory()
m.add("User prefers dark mode and Python 3.12", user_id="alice")
m.add("User switched to light mode", user_id="alice")

# Retrieves current preference (light mode), not outdated one
results = m.search("What theme does the user prefer?", user_id="alice")
```

**Example 2: Temporal Query**
```python
# Track entity with validity periods
graph.create_temporal_relationship(
    source_id=user_node,
    rel_type="LIVES_AT",
    target_id=address_node,
    valid_from=datetime(2024, 1, 15),
    valid_until=datetime(2024, 9, 1),  # moved out
)

# Query: Where did user live on March 1, 2024?
results = graph.query_at_time(
    {"type": "LIVES_AT", "source_label": "User"},
    query_time=datetime(2024, 3, 1)
)
```

**Example 3: Cognee Memory Ingestion and Search**
```python
import cognee
from cognee.modules.search.types import SearchType

# Ingest and build knowledge graph
await cognee.add("./docs/")
await cognee.add("any data")
await cognee.cognify()

# Enrich memory
await cognee.memify()

# Agent retrieves relationship-aware context
results = await cognee.search(
    query_text="Any query for your memory",
    query_type=SearchType.GRAPH_COMPLETION,
)
```

## Guidelines

1. Start with file-system memory; add complexity only when retrieval quality demands it
2. Track temporal validity for any fact that can change over time
3. Use hybrid retrieval (semantic + keyword + graph) for best accuracy
4. Consolidate memories periodically — invalidate but don't discard
5. Design for retrieval failure: always have a fallback when memory lookup returns nothing
6. Consider privacy implications of persistent memory (retention policies, deletion rights)
7. Benchmark your memory system against LoCoMo or LongMemEval before and after changes
8. Monitor memory growth and retrieval latency in production

## Gotchas

1. **Stuffing everything into context**: Loading all available memories into the prompt is expensive and degrades attention quality. Use just-in-time retrieval with relevance filtering instead.
2. **Ignoring temporal validity**: Facts go stale. Without validity tracking, outdated information poisons the context and the agent acts on wrong assumptions.
3. **Over-engineering early**: Simple filesystem-backed memory can outperform more specialized tooling on some benchmarks (claim-memory-locomo-filesystem-baseline). Add sophistication only when simple approaches demonstrably fail.
4. **No consolidation strategy**: Unbounded memory growth degrades retrieval quality over time. Set memory count thresholds or scheduled intervals to trigger consolidation.
5. **Embedding model mismatch**: Writing memories with one embedding model and reading with another produces poor retrieval because vector spaces are not interchangeable. Pin a single embedding model for each memory store and re-embed all entries if the model changes.
6. **Graph schema rigidity**: Over-structured graph schemas (rigid node types, fixed relationship labels) break when the domain evolves. Prefer generic relation types and flexible property bags so new entity kinds do not require schema migrations.
7. **Stale memory poisoning**: Old memories that contradict the current state corrupt agent behavior silently. Implement expiry policies or confidence decay so the agent deprioritizes aged facts, and surface contradictions explicitly when detected.
8. **Memory-context mismatch**: Retrieving memories that are topically related but contextually wrong (e.g., a memory about "Python" the snake when the agent is discussing Python the language). Mitigate by including session or domain metadata in memory entries and filtering on it during retrieval.

## Integration

This skill owns persistent semantic memory. Adjacent skills own scratch storage, compaction, and context tactics:

- `filesystem-context`: file-backed scratchpads, logs, and simple run state before semantic retrieval is needed.
- `context-compression`: summaries and handoffs that preserve session state in prose.
- `context-optimization`: just-in-time memory loading and retrieval scoping inside active context budgets.
- `context-degradation`: stale or conflicting memories as context poisoning or clash.
- `bdi-mental-states`: formal mental-state modeling when beliefs, desires, intentions, and provenance chains matter.
- `multi-agent-patterns`: shared memory across agents.
- `evaluation`: memory quality, retrieval correctness, and benchmark selection.

## References

Internal references:
- [Implementation Reference](./references/implementation.md) - Read when: implementing vector stores, property graphs, temporal queries, or memory consolidation logic from scratch

Related skills in this collection:
- context-fundamentals - Read when: designing the context layer that memory feeds into
- multi-agent-patterns - Read when: multiple agents need to share or coordinate memory state

External resources:
- Zep temporal knowledge graph paper (arXiv:2501.13956) - Read when: evaluating bi-temporal modeling or Graphiti's architecture
- Mem0 production architecture paper (arXiv:2504.19413) - Read when: assessing managed memory infrastructure trade-offs
- Cognee optimized knowledge graph + LLM reasoning paper (arXiv:2505.24478) - Read when: comparing multi-layer semantic graph approaches
- LoCoMo benchmark (Snap Research) - Read when: evaluating long-conversation memory retention
- MemBench evaluation framework (ACL 2025) - Read when: designing memory evaluation suites
- Graphiti open-source temporal KG engine (github.com/getzep/graphiti) - Read when: implementing temporal knowledge graphs
- Cognee open-source knowledge graph memory (github.com/topoteretes/cognee) - Read when: building customizable ECL pipelines for memory
- [Cognee comparison: Form vs Function](https://www.cognee.ai/blog/deep-dives/competition-comparison-form-vs-function) - Read when: comparing graph structures across Mem0, Graphiti, LightRAG, Cognee

---

## Skill Metadata

**Created**: 2025-12-20
**Last Updated**: 2026-05-15
**Author**: Agent Skills for Context Engineering Contributors
**Version**: 4.1.0

## Contract
- Inputs: agent/system context
- Outputs: guidance

## Output Format
- Markdown guidance

## Anti-Patterns
- Stuffing context without signal; ignoring degradation
