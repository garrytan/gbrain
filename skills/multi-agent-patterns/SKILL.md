---
name: multi-agent-patterns
description: "This skill should be used when designing multi-agent systems that need context isolation, supervisor or swarm coordination, explicit handoffs, parallel execution, or a decision on whether multiple agents are justified."
---

# Multi-Agent Architecture Patterns

Multi-agent architectures distribute work across multiple language model instances, each with its own context window. When designed well, this distribution enables capabilities beyond single-agent limits. When designed poorly, it introduces coordination overhead that negates benefits. The critical insight is that sub-agents exist primarily to isolate context, not to anthropomorphize role division.

## When to Activate

Activate this skill when:
- Single-agent context limits constrain task complexity
- Tasks decompose naturally into parallel subtasks
- Different subtasks require different tool sets or system prompts
- Building systems that must handle multiple domains simultaneously
- Scaling agent capabilities beyond single-context limits
- Designing production agent systems with multiple specialized components

Do not activate this skill for adjacent work owned by other skills:
- Deciding task-model fit, pipeline shape, or project-level cost before topology is known: `project-development`.
- Designing hosted sandboxes, warm pools, remote sessions, or background runtime infrastructure: `hosted-agents`.
- Sharing orchestrator state through KV-cache compaction in controlled runtimes: `latent-briefing`.
- Designing the tools each agent exposes: `tool-design`.

## Core Concepts

Use multi-agent patterns when a single agent's context window cannot hold all task-relevant information. Context isolation is the primary benefit — each agent operates in a clean context without accumulated noise from other subtasks, preventing the telephone game problem where information degrades through repeated summarization.

Choose among three dominant patterns based on coordination needs, not organizational metaphor:

- **Supervisor/orchestrator** — Use for centralized control when tasks have clear decomposition and human oversight matters. A single coordinator delegates to specialists and synthesizes results.
- **Peer-to-peer/swarm** — Use for flexible exploration when rigid planning is counterproductive. Any agent can transfer control to any other through explicit handoff mechanisms.
- **Hierarchical** — Use for large-scale projects with layered abstraction (strategy, planning, execution). Each layer operates at a different level of detail with its own context structure.

Design every multi-agent system around explicit coordination protocols, consensus mechanisms that resist sycophancy, and failure handling that prevents error propagation cascades.

## Detailed Topics

### Why Multi-Agent Architectures

**The Context Bottleneck**
Reach for multi-agent architectures when a single agent's context fills with accumulated history, retrieved documents, and tool outputs to the point where performance degrades. Recognize three degradation signals: the lost-in-middle effect (attention weakens for mid-context content), attention scarcity (too many competing items), and context poisoning (irrelevant content displaces useful content).

Partition work across multiple context windows so each agent operates in a clean context focused on its subtask. Aggregate results at a coordination layer without any single context bearing the full burden.

**The Token Economics Reality**
Budget for substantially higher token costs. Production data shows multi-agent systems can cost far more tokens than single-agent chat (claim-multi-agent-token-multiplier):

| Architecture | Token Multiplier | Use Case |
|--------------|------------------|----------|
| Single agent chat | Baseline | Simple queries |
| Single agent with tools | Higher than baseline | Tool-using tasks |
| Multi-agent system | Much higher than baseline | Complex research/coordination |

Browsing-agent evaluation research suggests token usage, tool calls, and model choice dominate performance variance (claim-evaluation-browsecomp-variance). This supports measuring multi-agent setups against single-agent baselines instead of assuming extra agents help.

Prioritize model selection alongside architecture design — upgrading to better models often provides larger performance gains than doubling token budgets. BrowseComp data shows that model quality improvements frequently outperform raw token increases. Treat model selection and multi-agent architecture as complementary strategies.

**The Parallelization Argument**
Assign parallelizable subtasks to dedicated agents with fresh contexts rather than processing them sequentially in a single agent. A research task requiring searches across multiple independent sources, analysis of different documents, or comparison of competing approaches benefits from parallel execution. Total real-world time approaches the duration of the longest subtask rather than the sum of all subtasks.

**The Specialization Argument**
Configure each agent with only the system prompt, tools, and context it needs for its specific subtask. A general-purpose agent must carry all possible configurations in context, diluting attention. Specialized agents carry only what they need, operating with lean context optimized for their domain. Route from a coordinator to specialized agents to achieve specialization without combinatorial explosion.

### Architectural Patterns

**Pattern 1: Supervisor/Orchestrator**
Deploy a central agent that maintains global state and trajectory, decomposes user objectives into subtasks, and routes to appropriate workers.

```
User Query -> Supervisor -> [Specialist, Specialist, Specialist] -> Aggregation -> Final Output
```

Choose this pattern when: tasks have clear decomposition, coordination across domains is needed, or human oversight is important.

Expect these trade-offs: strict workflow control and easier human-in-the-loop interventions, but the supervisor context becomes a bottleneck, supervisor failures cascade to all workers, and the "telephone game" problem emerges where supervisors paraphrase sub-agent responses incorrectly.

**The Telephone Game Problem and Solution**
Anticipate that supervisor architectures initially perform approximately 50% worse than optimized versions due to the telephone game problem (LangGraph benchmarks). Supervisors paraphrase sub-agent responses, losing fidelity with each pass.

Fix this by implementing a `forward_message` tool that allows sub-agents to pass responses directly to users:

```python
def forward_message(message: str, to_user: bool = True):
    """
    Forward sub-agent response directly to user without supervisor synthesis.

    Use when:
    - Sub-agent response is final and complete
    - Supervisor synthesis would lose important details
    - Response format must be preserved exactly
    """
    if to_user:
        return {"type": "direct_response", "content": message}
    return {"type": "supervisor_input", "content": message}
```

Prefer swarm architectures over supervisors when sub-agents can respond directly to users, as this eliminates translation errors entirely.

**Pattern 2: Peer-to-Peer/Swarm**
Remove central control and allow agents to communicate directly based on predefined protocols. Any agent transfers control to any other through explicit handoff mechanisms.

```python
def transfer_to_agent_b():
    return agent_b  # Handoff via function return

agent_a = Agent(
    name="Agent A",
    functions=[transfer_to_agent_b]
)
```

Choose this pattern when: tasks require flexible exploration, rigid planning is counterproductive, or requirements emerge dynamically and defy upfront decomposition.

Expect these trade-offs: no single point of failure and effective breadth-first scaling, but coordination complexity increases with agent count, divergence risk rises without a central state keeper, and robust convergence constraints become essential.

Define explicit handoff protocols with state passing. Ensure agents communicate their context needs to receiving agents.

**Pattern 3: Hierarchical**
Organize agents into layers of abstraction: strategy (goal definition), planning (task decomposition), and execution (atomic tasks).

```
Strategy Layer (Goal Definition) -> Planning Layer (Task Decomposition) -> Execution Layer (Atomic Tasks)
```

Choose this pattern when: projects have clear hierarchical structure, workflows involve management layers, or tasks require both high-level planning and detailed execution.

Expect these trade-offs: clear separation of concerns and support for different context structures at different levels, but coordination overhead between layers, potential strategy-execution misalignment, and complex error propagation paths.

### Context Isolation as Design Principle

Treat context isolation as the primary purpose of multi-agent architectures. Each sub-agent should operate in a clean context window focused on its subtask without carrying accumulated context from other subtasks.

**Isolation Mechanisms**
Select the right isolation mechanism for each subtask:

- **Full context delegation** — Share the planner's entire context with the sub-agent. Use for complex tasks where the sub-agent needs complete understanding. The sub-agent has its own tools and instructions but receives full context for its decisions. Note: this partially defeats the purpose of context isolation.
- **Instruction passing** — Create instructions via function call; the sub-agent receives only what it needs. Use for simple, well-defined subtasks. Maintains isolation but limits sub-agent flexibility.
- **File system memory** — Agents read and write to persistent storage. Use for complex tasks requiring shared state. The file system serves as the coordination mechanism, avoiding context bloat from shared state passing. Introduces latency and consistency challenges but scales better than message-passing.

Choose based on task complexity, coordination needs, and acceptable latency. Default to instruction passing and escalate to file system memory when shared state is needed. Avoid full context delegation unless the subtask genuinely requires it.

### Consensus and Coordination

**The Voting Problem**
Avoid simple majority voting — it treats hallucinations from weak models as equal to reasoning from strong models. Without intervention, multi-agent discussions devolve into consensus on false premises due to inherent bias toward agreement.

**Weighted Voting**
Weight agent votes by confidence or expertise. Agents with higher confidence or domain expertise should carry more weight in final decisions.

**Debate Protocols**
Structure agents to critique each other's outputs over multiple rounds. Adversarial critique often yields higher accuracy on complex reasoning than collaborative consensus. Guard against sycophantic convergence where agents agree to be agreeable rather than correct.

**Trigger-Based Intervention**
Monitor multi-agent interactions for behavioral markers. Activate stall triggers when discussions make no progress. Detect sycophancy triggers when agents mimic each other's answers without unique reasoning.

### Framework Considerations

Different frameworks implement these patterns with different philosophies. LangGraph uses graph-based state machines with explicit nodes and edges. AutoGen uses conversational/event-driven patterns with GroupChat. CrewAI uses role-based process flows with hierarchical crew structures.

## Practical Guidance

### Failure Modes and Mitigations

**Failure: Supervisor Bottleneck**
The supervisor accumulates context from all workers, becoming susceptible to saturation and degradation.

Mitigate by constraining worker output schemas so workers return only distilled summaries. Use checkpointing to persist supervisor state without carrying full history in context.

**Failure: Coordination Overhead**
Agent communication consumes tokens and introduces latency. Complex coordination can negate parallelization benefits.

Mitigate by minimizing communication through clear handoff protocols. Batch results where possible. Use asynchronous communication patterns. Measure whether multi-agent coordination actually saves time versus a single agent with a longer context.

**Failure: Divergence**
Agents pursuing different goals without central coordination drift from intended objectives.

Mitigate by defining clear objective boundaries for each agent. Implement convergence checks that verify progress toward shared goals. Set time-to-live limits on agent execution to prevent unbounded exploration.

**Failure: Error Propagation**
Errors in one agent's output propagate to downstream agents that consume that output, compounding into increasingly wrong results.

Mitigate by validating agent outputs before passing to consumers. Implement retry logic with circuit breakers. Use idempotent operations where possible. Consider adding a verification agent that cross-checks critical outputs before they enter the pipeline.

## Examples

**Example 1: Research Team Architecture**
```text
Supervisor
├── Researcher (web search, document retrieval)
├── Analyzer (data analysis, statistics)
├── Fact-checker (verification, validation)
└── Writer (report generation, formatting)
```

**Example 2: Handoff Protocol**
```python
def handle_customer_request(request):
    if request.type == "billing":
        return transfer_to(billing_agent)
    elif request.type == "technical":
        return transfer_to(technical_agent)
    elif request.type == "sales":
        return transfer_to(sales_agent)
    else:
        return handle_general(request)
```

## Guidelines

1. Design for context isolation as the primary benefit of multi-agent systems
2. Choose architecture pattern based on coordination needs, not organizational metaphor
3. Implement explicit handoff protocols with state passing
4. Use weighted voting or debate protocols for consensus
5. Monitor for supervisor bottlenecks and implement checkpointing
6. Validate outputs before passing between agents
7. Set time-to-live limits to prevent infinite loops
8. Test failure scenarios explicitly

## Gotchas

1. **Supervisor bottleneck scaling** — Supervisor context pressure grows non-linearly with worker count. At 5+ workers, the supervisor spends more tokens processing summaries than workers spend on actual tasks. Set a hard cap on workers per supervisor (3-5) and add a second supervisor tier rather than overloading one.
2. **Token cost underestimation** — Multi-agent runs cost approximately 15x baseline. Teams consistently underbudget because they estimate per-agent costs without accounting for coordination overhead, retries, and consensus rounds. Budget for 15x and treat anything less as a bonus.
3. **Sycophantic consensus** — Agents in debate patterns tend to converge on agreeable answers, not correct ones. LLMs have an inherent bias toward agreement. Counter this by assigning explicit adversarial roles and requiring agents to state disagreements before convergence is allowed.
4. **Agent sprawl** — Adding more agents past 3-5 shows diminishing returns and increases coordination overhead. Each additional agent adds communication channels quadratically. Start with the minimum viable number of agents and add only when a clear context isolation benefit exists.
5. **Telephone game in message-passing** — Information degrades through repeated summarization as it passes between agents. Each agent paraphrases and loses nuance. Use filesystem coordination instead of message-passing for state that multiple agents need to access faithfully.
6. **Error propagation cascades** — One agent's hallucination becomes another agent's "fact." Downstream agents have no way to distinguish upstream hallucinations from genuine information. Add validation checkpoints between agents and never trust upstream output without verification.
7. **Over-decomposition** — Splitting tasks too finely creates more coordination overhead than the task itself. A 10-step pipeline with 10 agents spends more tokens on handoffs than on actual work. Decompose only when subtasks genuinely benefit from separate contexts.
8. **Missing shared state** — Agents operating without a shared filesystem or state store duplicate work, produce inconsistent outputs, and lose track of what has already been accomplished. Establish shared persistent storage before building multi-agent workflows.

## Integration

This skill owns agent topology and coordination protocols. Adjacent skills own project shape, hosted runtime, and latent-state transfer:

- `project-development`: project-level single-vs-multi choice before topology details.
- `hosted-agents`: remote sandbox, session, warm-pool, and multiplayer infrastructure.
- `memory-systems`: shared persistent state across agents.
- `tool-design`: tool specialization and spawn/status tool contracts.
- `context-optimization`: partitioning as one token-efficiency tactic.
- `latent-briefing`: KV-cache trajectory handoff between orchestrator and worker when models align.
- `evaluation`: measuring whether multiple agents improve outcomes after coordination cost.

## References

Internal reference:
- [Frameworks Reference](./references/frameworks.md) - Read when: implementing a specific multi-agent pattern in LangGraph, AutoGen, or CrewAI and needing framework-specific code examples

Related skills in this collection:
- context-fundamentals - Read when: needing to understand context window mechanics before designing agent partitioning
- memory-systems - Read when: agents need to share state across context boundaries or persist information between runs
- context-optimization - Read when: individual agent contexts are too large and need partitioning or compression strategies

External resources:
- [LangGraph Documentation](https://langchain-ai.github.io/langgraph/) - Read when: building graph-based multi-agent workflows with explicit state machines
- [AutoGen Framework](https://microsoft.github.io/autogen/) - Read when: implementing conversational GroupChat patterns or event-driven agent coordination
- [CrewAI Documentation](https://docs.crewai.com/) - Read when: designing role-based hierarchical agent processes
- [Research on Multi-Agent Coordination](https://arxiv.org/abs/2308.00352) - Read when: needing academic grounding on multi-agent system theory and evaluation

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
