---
name: context-fundamentals
description: "This skill should be used to explain or reason about the foundational concepts of context engineering: what context is, the anatomy of a context window, how attention mechanics work, the U-shaped attention curve, why context quality matters more than quantity, and the mental models needed to interpret every other context-engineering decision. Use this for conceptual explanation, onboarding, and background reading. Route operational work to the specialized skills: debugging attention failures goes to context-degradation, token-efficiency work goes to context-optimization, conversation summarization goes to context-compression, and project-shape decisions go to project-development."
---

# Context Engineering Fundamentals

Context is the complete state available to a language model at inference time: system instructions, tool definitions, retrieved documents, message history, and tool outputs. Context engineering is the discipline of curating the smallest high-signal token set that maximizes the likelihood of desired outcomes.

This skill is the conceptual foundation that every other skill in the collection builds on. It explains what context is, how attention mechanics work, why context quality matters more than quantity, and the mental models needed to interpret every other context-engineering decision. It does not own operational work: debugging attention failures belongs to `context-degradation`, token-efficiency tactics belong to `context-optimization`, conversation summarization belongs to `context-compression`, file-based offloading belongs to `filesystem-context`, and project-shape decisions belong to `project-development`.

## When to Activate

Activate this skill when the work is conceptual:

- Explaining what context is and how attention mechanics constrain agent behavior.
- Onboarding new contributors who need the mental models before diving into operational skills.
- Reasoning about a context-related design decision from first principles (what does this constraint mean, why does this trade-off exist) before picking a specific tactic.
- Writing or reviewing documentation that needs to ground operational guidance in the underlying mechanics.

Do not activate this skill for operational work. The specialized skills handle the doing:

- Diagnosing lost-in-middle, context poisoning, or attention failures: `context-degradation`.
- Reducing token cost via masking, partitioning, prefix caching, budgets: `context-optimization`.
- Compressing a long session into a handoff summary: `context-compression`.
- Offloading large tool outputs or maintaining a durable scratchpad: `filesystem-context`.
- Deciding the shape of an LLM project or pipeline: `project-development`.

## Core Concepts

Treat context as a finite attention budget, not a storage bin. Every token added competes for the model's attention and depletes a budget that cannot be refilled mid-inference. The engineering problem is maximizing utility per token against three constraints: the hard token limit, the softer effective-capacity ceiling, and the U-shaped attention curve that penalizes information placed in the middle of context (claim-context-degradation-lost-middle-ruler).

Apply four principles when assembling context:

1. **Informativity over exhaustiveness** — include only what matters for the current decision; design systems that can retrieve additional information on demand.
2. **Position-aware placement** — place critical constraints at the beginning and end of context because long-context evaluations show middle-position information is less reliably recovered than edge-position information (claim-context-degradation-lost-middle-ruler).
3. **Progressive disclosure** — load skill names and summaries at startup; load full content only when a skill activates for a specific task.
4. **Iterative curation** — context engineering is not a one-time prompt-writing exercise but an ongoing discipline applied every time content is passed to the model.

## Detailed Topics

### The Anatomy of Context

**System Prompts**
Organize system prompts into distinct sections using XML tags or Markdown headers (background, instructions, tool guidance, output format). System prompts persist throughout the conversation, so place the most critical constraints at the beginning and end where attention is strongest.

Calibrate instruction altitude to balance two failure modes. Too-low altitude hardcodes brittle logic that breaks when conditions shift. Too-high altitude provides vague guidance that fails to give concrete signals for desired behavior. Aim for heuristic-driven instructions: specific enough to guide behavior, flexible enough to generalize — for example, numbered steps with room for judgment at each step.

Start minimal, then add instructions reactively based on observed failure modes rather than preemptively stuffing edge cases. Curate diverse, canonical few-shot examples that portray expected behavior instead of listing every possible scenario.

**Tool Definitions**
Write tool descriptions that answer three questions: what the tool does, when to use it, and what it returns. Include usage context, parameter defaults, and error cases — agents cannot disambiguate tools that a human engineer cannot disambiguate either.

Keep the tool set minimal. Consolidate overlapping tools because bloated tool sets create ambiguous decision points and consume disproportionate context after JSON serialization (tool schemas typically inflate 2-3x compared to equivalent plain-text descriptions).

**Retrieved Documents**
Maintain lightweight identifiers (file paths, stored queries, web links) and load data into context dynamically using just-in-time retrieval. This mirrors human cognition — maintain an index, not a copy. Strong identifiers (e.g., `customer_pricing_rates.json`) let agents locate relevant files even without search tools; weak identifiers (e.g., `data/file1.json`) force unnecessary loads.

When chunking large documents, split at natural semantic boundaries (section headers, paragraph breaks) rather than arbitrary character limits that sever mid-concept.

**Message History**
Message history serves as the agent's scratchpad memory for tracking progress, maintaining task state, and preserving reasoning across turns. For long-running tasks, it can grow to dominate context usage — monitor and apply compaction before it crowds out active instructions.

Cyclically refine history: once a tool has been called deep in the conversation, the raw result rarely needs to remain verbatim. Replace stale tool outputs with compact summaries or references to reduce low-signal bulk.

**Tool Outputs**
Tool outputs often dominate context in agent trajectories (claim-context-optimization-tool-output-dominance). Apply observation masking: replace verbose outputs with compact references once the agent has processed the result. Retain only the most recently relevant file contents; compress or evict older ones.

### Context Windows and Attention Mechanics

**The Attention Budget**
For n tokens, the attention mechanism computes n-squared pairwise relationships. As context grows, the model's ability to maintain these relationships degrades — not as a hard cliff but as a performance gradient. Models trained predominantly on shorter sequences have fewer specialized parameters for context-wide dependencies, creating an effective ceiling well below the nominal window size.

Design for this gradient: assume effective capacity is materially below the advertised window until measured on the target workload. Large nominal context windows do not remove the need for task-specific degradation tests (claim-context-degradation-lost-middle-ruler).

**Position Encoding Limits**
Position encoding interpolation extends sequence handling beyond training lengths but introduces degradation in positional precision. Expect reduced accuracy for information retrieval and long-range reasoning at extended contexts compared to performance on shorter inputs.

**Progressive Disclosure in Practice**
Implement progressive disclosure at three levels:

1. **Skill selection** — load only names and descriptions at startup; activate full skill content on demand.
2. **Document loading** — load summaries first; fetch detail sections only when the task requires them.
3. **Tool result retention** — keep recent results in full; compress or evict older results.

Keep the boundary crisp: if a skill or document is activated, load it fully rather than partially — partial loads create confusing gaps that degrade reasoning quality.

### Context Quality Versus Quantity

Reject the assumption that larger context windows solve memory problems. Processing cost grows disproportionately with context length — not just linear cost scaling, but degraded model performance beyond effective capacity thresholds. Long inputs remain expensive even with prefix caching.

Apply the signal-density test: for each piece of context, ask whether removing it would change the model's output. If not, remove it. Redundant content does not merely waste tokens — it actively dilutes attention from high-signal content.

## Practical Guidance

This section provides conceptual application advice. Pointers to operational skills are explicit.

### Reasoning About a Context Decision

When a context-related design decision needs to be made, separate the conceptual question from the operational one. The conceptual question is "what does this mean and why does it matter"; the operational question is "what specific technique do we apply." Use this skill to answer the first; route to the specialized skill that owns the second.

For example, deciding whether to summarize a long agent session has two parts: (1) why summarization is needed at all (attention budget is finite, U-shaped curve degrades middle content, signal density matters more than volume - this skill) and (2) what compression strategy preserves the right state and at what utilization threshold to trigger it (`context-compression`).

### Reading Order For New Contributors

A contributor coming to context engineering for the first time should read:

1. This skill, to internalize the attention-budget framing and the U-shaped curve.
2. `context-degradation`, to see what context failures look like in practice and how to diagnose them.
3. Two or three of `context-optimization`, `context-compression`, `filesystem-context`, `memory-systems` depending on which operational concern is most relevant to their project.

Skipping step 1 produces operators who apply techniques without understanding why; skipping the operational skills produces theorists who do not know which technique fits which failure mode.

## Examples

**Example 1: Organizing System Prompts**

Illustrates the conceptual point that critical constraints belong at attention-favored positions (beginning and end), and that explicit section boundaries help the model parse the prompt:

```markdown
<BACKGROUND_INFORMATION>
You are a Python expert helping a development team.
Current project: Data processing pipeline in Python 3.9+
</BACKGROUND_INFORMATION>

<INSTRUCTIONS>
- Write clean, idiomatic Python code
- Include type hints for function signatures
- Add docstrings for public functions
- Follow PEP 8 style guidelines
</INSTRUCTIONS>

<OUTPUT_DESCRIPTION>
Provide code blocks with syntax highlighting.
Explain non-obvious decisions in comments.
</OUTPUT_DESCRIPTION>
```

**Example 2: The Attention Budget As A Mental Model**

A large-context model does not have an equally attended context. Effective capacity is workload-specific, and the U-shaped curve penalizes information placed in the middle. When deciding how much of an upstream knowledge base to load, this is the mental model: do not ask "will it fit," ask "will the model still attend to the parts that matter."

The corresponding operational question (which technique should reduce the load) belongs to `context-optimization`.

## Guidelines

1. Treat context as a finite resource with diminishing returns
2. Place critical information at attention-favored positions (beginning and end)
3. Use progressive disclosure to defer loading until needed
4. Organize system prompts with clear section boundaries
5. Monitor context usage during development
6. Implement compaction triggers at 70-80% utilization
7. Design for context degradation rather than hoping to avoid it
8. Prefer smaller high-signal context over larger low-signal context

## Gotchas

1. **Nominal window is not effective capacity**: A model advertising a large context window may degrade well before that limit on complex retrieval or reasoning tasks. Budget below the nominal window until your own degradation tests prove otherwise.

2. **Character-based token estimates silently drift**: The ~4 characters/token heuristic for English prose breaks down for code (2-3 chars/token), URLs and file paths (each slash, dot, and colon is a separate token), and non-English text (often 1-2 chars/token). Use the provider's actual tokenizer (e.g., tiktoken for OpenAI models, Anthropic's token counting API) for any budget-critical calculation.

3. **Tool schemas inflate 2-3x after JSON serialization**: A tool definition that looks compact in source code expands significantly when serialized — brackets, quotes, colons, and commas each consume tokens. Ten tools with moderate schemas can consume 5,000-8,000 tokens before a single message is sent. Audit serialized tool token counts, not source-code line counts.

4. **Message history balloons silently in agentic loops**: Each tool call adds both the request and the full response to history. After 20-30 iterations, history can consume 70-80% of the window while the agent shows no visible symptoms until reasoning quality collapses. Set a hard token ceiling on history and trigger compaction proactively.

5. **Critical instructions in the middle get lost**: The U-shaped attention curve means the middle of context receives 10-40% less recall accuracy than the beginning and end. Never place safety constraints, output format requirements, or behavioral guardrails in the middle of a long system prompt — anchor them at the top or bottom.

6. **Progressive disclosure that loads too eagerly defeats its purpose**: Loading every "potentially relevant" skill or document at the first hint of relevance recreates the context-stuffing problem. Set strict activation thresholds — a skill should load only when the task explicitly matches its trigger conditions, not when the topic is merely adjacent.

7. **Mixing instruction altitudes causes inconsistent behavior**: Combining hyper-specific rules ("always use exactly 3 bullet points") with vague directives ("be helpful") in the same prompt creates conflicting signals. Group instructions by altitude level and keep each section internally consistent — either heuristic-driven or prescriptive, not both interleaved.

## Integration

This skill is the conceptual foundation. It does not own operational work; it provides the mental models the operational skills assume.

Routing map for operational work:

- `context-degradation`: diagnosing attention failures, lost-in-middle, poisoning, distraction.
- `context-optimization`: token-efficiency tactics (masking, partitioning, caching, budgets).
- `context-compression`: compacting long sessions while preserving decisions, files, risks.
- `filesystem-context`: offloading large outputs and using files as a durable scratchpad.
- `memory-systems`: cross-session memory architectures with entity tracking.
- `multi-agent-patterns`: when to split work across agents for context isolation.
- `tool-design`: writing tool descriptions and schemas that route correctly.
- `project-development`: deciding LLM fit and shaping multi-stage pipelines.

Read this skill first to build the mental models; read the operational skill that fits the task when actually doing the work.

## References

Internal reference:
- [Context Components Reference](./references/context-components.md) - Read when: debugging a specific context component (system prompts, tool definitions, message history, tool outputs) or implementing chunking, observation masking, or budget allocation tables

Related skills in this collection:
- context-degradation - Read when: agent performance drops as conversations grow or context fills beyond 60% capacity
- context-optimization - Read when: token costs are too high or compaction/compression strategies are needed

External resources:
- Anthropic's "Effective Context Engineering for AI Agents" — production patterns for compaction, sub-agents, and hybrid retrieval
- Research on transformer attention mechanisms and the lost-in-the-middle effect
- Tokenomics research on agentic software engineering token distribution

---

## Skill Metadata

**Created**: 2025-12-20
**Last Updated**: 2026-05-15
**Author**: Agent Skills for Context Engineering Contributors
**Version**: 2.2.0

## Contract
- Inputs: agent/system context
- Outputs: guidance

## Output Format
- Markdown guidance

## Anti-Patterns
- Stuffing context without signal; ignoring degradation
