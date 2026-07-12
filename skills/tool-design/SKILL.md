---
name: tool-design
description: "This skill should be used for the tool-interface layer of an agent system specifically: writing tool descriptions agents can route on, designing tool schemas and response formats, naming conventions, actionable error recovery messages, MCP server design, tool-set consolidation, and deciding when to add or remove an individual tool. Use this when the unit of work is a single tool or a set of tools. Route project-shape, pipeline architecture, and task-model-fit decisions to project-development; route deciding whether to introduce sub-agents to multi-agent-patterns."
---

# Tool Design for Agents

Design every tool as a contract between a deterministic system and a non-deterministic agent. Unlike human-facing APIs, agent-facing tools must make the contract unambiguous through the description alone: agents infer intent from descriptions and generate calls that must match expected formats. Every ambiguity becomes a potential failure mode that no amount of prompt engineering can fix.

The unit of work for this skill is a single tool or a tool catalog. Project-shape, pipeline architecture, task-model-fit, and cost-at-the-project-level decisions belong to `project-development`. Deciding whether to introduce sub-agents belongs to `multi-agent-patterns`. This skill owns the interface layer that connects deterministic code to the agent.

## When to Activate

Activate this skill when the unit of work is a tool:

- Writing a new tool description, schema, or response format.
- Debugging cases where the agent picked the wrong tool or generated malformed calls.
- Consolidating an overlapping tool catalog (the classic "we have 17 tools, the agent picks wrong half the time" case).
- Designing actionable error messages so the agent can self-correct.
- Naming tools and parameters consistently across a catalog (MCP namespacing, verb-noun naming).
- Evaluating a third-party tool against the consolidation principle before adding it.

Do not activate this skill for adjacent work owned by other skills:

- Deciding whether the project should use LLMs at all, or what the pipeline stages should be: `project-development`.
- Deciding whether to split work across sub-agents or run a single agent with more tools: `multi-agent-patterns`.
- Reducing the token weight of tool outputs at the trajectory level (observation masking, format-option choice at scale): `context-optimization`.

## Core Concepts

Design tools around the consolidation principle: if a human engineer cannot definitively say which tool should be used in a given situation, an agent cannot be expected to do better. Reduce the tool set until each tool has one unambiguous purpose, because agents select tools by comparing descriptions and any overlap introduces selection errors.

Treat every tool description as prompt engineering that shapes agent behavior. The description is not documentation for humans -- it is injected into the agent's context and directly steers reasoning. Write descriptions that answer what the tool does, when to use it, and what it returns, because these three questions are exactly what agents evaluate during tool selection.

## Detailed Topics

### The Tool-Agent Interface

**Tools as Contracts**
Design each tool as a self-contained contract. When humans call APIs, they read docs, understand conventions, and make appropriate requests. Agents must infer the entire contract from a single description block. Make the contract unambiguous by including format examples, expected patterns, and explicit constraints. Omit nothing that a caller needs to know, because agents cannot ask clarifying questions before making a call.

**Tool Description as Prompt**
Write tool descriptions knowing they load directly into agent context and collectively steer behavior. A vague description like "Search the database" with cryptic parameter names forces the agent to guess -- and guessing produces incorrect calls. Instead, include usage context, parameter format examples, and sensible defaults. Every word in the description either helps or hurts tool selection accuracy.

**Namespacing and Organization**
Namespace tools under common prefixes as the collection grows, because agents benefit from hierarchical grouping. When an agent needs database operations, it routes to the `db_*` namespace; when it needs web interactions, it routes to `web_*`. Without namespacing, agents must evaluate every tool in a flat list, which degrades selection accuracy as the count grows.

### The Consolidation Principle

**Single Comprehensive Tools**
Build single comprehensive tools instead of multiple narrow tools that overlap. Rather than implementing `list_users`, `list_events`, and `create_event` separately, implement `schedule_event` that finds availability and schedules in one call. The comprehensive tool handles the full workflow internally, removing the agent's burden of chaining calls in the correct order.

**Why Consolidation Works**
Apply consolidation because agents have limited context and attention. Each tool in the collection competes for attention during tool selection, each description consumes context budget tokens, and overlapping functionality creates ambiguity. Consolidation eliminates redundant descriptions, removes selection ambiguity, and shrinks the effective tool set. Vercel's d0 case study is a concrete example of reducing specialized tools into a smaller primitive tool set with better measured outcomes (claim-tool-design-vercel-d0-reduction).

**When Not to Consolidate**
Keep tools separate when they have fundamentally different behaviors, serve different contexts, or must be callable independently. Over-consolidation creates a different problem: a single tool with too many parameters and modes becomes hard for agents to parameterize correctly.

### Architectural Reduction

Push the consolidation principle to its logical extreme by removing most specialized tools in favor of primitive, general-purpose capabilities. Production evidence shows this approach can outperform sophisticated multi-tool architectures.

**The File System Agent Pattern**
Provide direct file system access through a single command execution tool instead of building custom tools for data exploration, schema lookup, and query validation. The agent uses standard Unix utilities (grep, cat, find, ls) to explore and operate on the system. This works because file systems are a proven abstraction that models understand deeply, standard tools have predictable behavior, agents can chain primitives flexibly rather than being constrained to predefined workflows, and good documentation in files replaces summarization tools.

**When Reduction Outperforms Complexity**
Choose reduction when the data layer is well-documented and consistently structured, the model has sufficient reasoning capability, specialized tools were constraining rather than enabling the model, or more time is spent maintaining scaffolding than improving outcomes. Avoid reduction when underlying data is messy or poorly documented, the domain requires specialized knowledge the model lacks, safety constraints must limit agent actions, or operations genuinely benefit from structured workflows.

**Build for Future Models**
Design minimal architectures that benefit from model improvements rather than sophisticated architectures that lock in current limitations. Ask whether each tool enables new capabilities or constrains reasoning the model could handle on its own -- tools built as "guardrails" often become liabilities as models improve.

See [Architectural Reduction Case Study](./references/architectural_reduction.md) for production evidence.

### Tool Description Engineering

**Description Structure**
Structure every tool description to answer four questions:

1. What does the tool do? State exactly what the tool accomplishes -- avoid vague language like "helps with" or "can be used for."
2. When should it be used? Specify direct triggers ("User asks about pricing") and indirect signals ("Need current market rates").
3. What inputs does it accept? Describe each parameter with types, constraints, defaults, and format examples.
4. What does it return? Document the output format, structure, successful response examples, and error conditions.

**Default Parameter Selection**
Set defaults to reflect common use cases. Defaults reduce agent burden by eliminating unnecessary parameter specification and prevent errors from omitted parameters. Choose defaults that produce useful results without requiring the agent to understand every option.

### Response Format Optimization

Offer response format options (concise vs. detailed) because tool response size significantly impacts context usage. Concise format returns essential fields only, suitable for confirmations. Detailed format returns complete objects, suitable when full context drives decisions. Document when to use each format in the tool description so agents learn to select appropriately.

### Error Message Design

Design error messages for two audiences: developers debugging issues and agents recovering from failures. For agents, every error message must be actionable -- it must state what went wrong and how to correct it. Include retry guidance for retryable errors, corrected format examples for input errors, and specific missing fields for incomplete requests. An error that says only "failed" provides zero recovery signal.

### Tool Definition Schema

Establish a consistent schema across all tools. Use verb-noun pattern for tool names (`get_customer`, `create_order`), consistent parameter names across tools (always `customer_id`, never sometimes `id` and sometimes `identifier`), and consistent return field names. Consistency reduces the cognitive load on agents and improves cross-tool generalization.

### Tool Collection Design

Limit tool collections to the smallest set with non-overlapping purposes, because description overlap causes model confusion and more tools do not always lead to better outcomes. When more tools are genuinely needed, use namespacing to create logical groupings. Implement selection mechanisms: tool grouping by domain, example-based selection hints, and umbrella tools that route to specialized sub-tools.

### MCP Tool Naming Requirements

Always use fully qualified tool names with MCP (Model Context Protocol) to avoid "tool not found" errors.

Format: `ServerName:tool_name`

```python
# Correct: Fully qualified names
"Use the BigQuery:bigquery_schema tool to retrieve table schemas."
"Use the GitHub:create_issue tool to create issues."

# Incorrect: Unqualified names
"Use the bigquery_schema tool..."  # May fail with multiple servers
```

Without the server prefix, agents may fail to locate tools when multiple MCP servers are available. Establish naming conventions that include server context in all tool references.

### Using Agents to Optimize Tools

Feed observed tool failures back to an agent to diagnose issues and improve descriptions. Treat reported efficiency gains as workload-specific until reproduced on the target tool catalog.

**The Tool-Testing Agent Pattern**:

```python
def optimize_tool_description(tool_spec, failure_examples):
    """
    Use an agent to analyze tool failures and improve descriptions.

    Process:
    1. Agent attempts to use tool across diverse tasks
    2. Collect failure modes and friction points
    3. Agent analyzes failures and proposes improvements
    4. Test improved descriptions against same tasks
    """
    prompt = f"""
    Analyze this tool specification and the observed failures.

    Tool: {tool_spec}

    Failures observed:
    {failure_examples}

    Identify:
    1. Why agents are failing with this tool
    2. What information is missing from the description
    3. What ambiguities cause incorrect usage

    Propose an improved tool description that addresses these issues.
    """

    return get_agent_response(prompt)
```

This creates a feedback loop: agents using tools generate failure data, which agents then use to improve tool descriptions, which reduces future failures.

### Testing Tool Design

Evaluate tool designs against five criteria: unambiguity, completeness, recoverability, efficiency, and consistency. Test by presenting representative agent requests and evaluating the resulting tool calls against expected behavior.

## Practical Guidance

### Tool Selection Framework

When designing tool collections:
1. Identify distinct workflows agents must accomplish
2. Group related actions into comprehensive tools
3. Ensure each tool has a clear, unambiguous purpose
4. Document error cases and recovery paths
5. Test with actual agent interactions

### Tool Audit Checklist

Use this checklist for every tool before adding it to an agent:

1. **Name**: verb-noun, namespaced if the catalog has multiple domains.
2. **Description**: states what the tool does, when to use it, and what it returns.
3. **Schema**: every parameter has type, constraints, defaults, and example values.
4. **Return shape**: success and error payloads are documented and machine-readable.
5. **Recovery**: each error tells the agent what to change before retrying.
6. **Overlap**: no other tool has the same activation scenario.
7. **Consolidation decision**: adjacent narrow tools are merged unless independent calls are required.
8. **Token impact**: large responses support concise mode or file-reference mode.

## Examples

**Example 1: Well-Designed Tool**
```python
def get_customer(customer_id: str, format: str = "concise"):
    """
    Retrieve customer information by ID.

    Use when:
    - User asks about specific customer details
    - Need customer context for decision-making
    - Verifying customer identity

    Args:
        customer_id: Format "CUST-######" (e.g., "CUST-000001")
        format: "concise" for key fields, "detailed" for complete record

    Returns:
        Customer object with requested fields

    Errors:
        NOT_FOUND: Customer ID not found
        INVALID_FORMAT: ID must match CUST-###### pattern
    """
```

**Example 2: Poor Tool Design**

This example demonstrates several tool design anti-patterns:

```python
def search(query):
    """Search the database."""
    pass
```

**Problems with this design:**

1. **Vague name**: "search" is ambiguous - search what, for what purpose?
2. **Missing parameters**: What database? What format should query take?
3. **No return description**: What does this function return? A list? A string? Error handling?
4. **No usage context**: When should an agent use this versus other tools?
5. **No error handling**: What happens if the database is unavailable?

**Failure modes:**
- Agents may call this tool when they should use a more specific tool
- Agents cannot determine correct query format
- Agents cannot interpret results
- Agents cannot recover from failures

## Guidelines

1. Write descriptions that answer what, when, and what returns
2. Use consolidation to reduce ambiguity
3. Implement response format options for token efficiency
4. Design error messages for agent recovery
5. Establish and follow consistent naming conventions
6. Limit tool count and use namespacing for organization
7. Test tool designs with actual agent interactions
8. Iterate based on observed failure modes
9. Question whether each tool enables or constrains the model
10. Prefer primitive, general-purpose tools over specialized wrappers
11. Invest in documentation quality over tooling sophistication
12. Build minimal architectures that benefit from model improvements

## Gotchas

1. **Vague descriptions**: Descriptions like "Search the database for customer information" leave too many questions unanswered. State the exact database, query format, and return shape.
2. **Cryptic parameter names**: Parameters named `x`, `val`, or `param1` force agents to guess meaning. Use descriptive names that convey purpose without reading further documentation.
3. **Missing error recovery guidance**: Tools that fail with generic messages like "Error occurred" provide no recovery signal. Every error response must tell the agent what went wrong and what to try next.
4. **Inconsistent naming across tools**: Using `id` in one tool, `identifier` in another, and `customer_id` in a third creates confusion. Standardize parameter names across the entire tool collection.
5. **MCP namespace collisions**: When multiple MCP tool providers register tools with similar names (e.g., two servers both exposing `search`), agents cannot disambiguate. Always use fully qualified `ServerName:tool_name` format and audit for collisions when adding new providers.
6. **Tool description rot**: Descriptions become inaccurate as underlying APIs evolve -- parameters get added, return formats change, error codes shift. Treat descriptions as code: version them, review them during API changes, and test them against current behavior.
7. **Over-consolidation**: Making a single tool handle too many workflows produces parameter lists so large that agents struggle to select the right combination. If a tool requires more than 8-10 parameters or serves fundamentally different use cases, split it.
8. **Parameter explosion**: Too many optional parameters overwhelm agent decision-making. Each parameter the agent must evaluate adds cognitive load. Provide sensible defaults, group related options into format presets, and move rarely-used parameters into an `options` object.
9. **Missing error context**: Error messages that say only "failed" or "invalid input" without specifying which input, why it failed, or what a valid input looks like leave agents unable to self-correct. Include the invalid value, the expected format, and a concrete example in every error response.

## Integration

This skill owns the tool-interface layer. Adjacent decisions are owned elsewhere:

- `project-development`: shape of the project, choice of pipeline stages, task-model-fit, cost estimation at the project level. If the question is "what is the right pipeline architecture" rather than "what is the right tool API," route there.
- `multi-agent-patterns`: deciding whether one agent with more tools is better than two agents with smaller tool catalogs. If the question is "should this split into sub-agents," route there.
- `context-optimization`: trajectory-level token efficiency, observation masking, choosing response-format options across many tool calls. If the question is "how do we reduce token weight of accumulated tool outputs," route there.
- `context-fundamentals`: the conceptual question of how tool definitions consume the attention budget. If the question is "why does adding tools degrade routing accuracy," start there.
- `evaluation`: judging whether the tool set improved agent outcomes overall.

## References

Internal references:
- [Best Practices Reference](./references/best_practices.md) - Read when: designing a new tool from scratch or auditing an existing tool collection for quality gaps
- [Architectural Reduction Case Study](./references/architectural_reduction.md) - Read when: considering removing specialized tools in favor of primitives, or evaluating whether a complex tool architecture is justified

Related skills in this collection:
- context-fundamentals - Tool context interactions
- evaluation - Tool testing patterns

External resources:
- MCP (Model Context Protocol) documentation - Read when: implementing tools for multi-server agent environments or debugging tool routing failures
- Framework tool conventions - Read when: adopting a new agent framework and need to map tool design principles to framework-specific APIs
- API design best practices for agents - Read when: translating existing human-facing APIs into agent-facing tool interfaces
- Vercel d0 agent architecture case study - Read when: evaluating whether to consolidate tools or seeking production evidence for architectural reduction

---

## Skill Metadata

**Created**: 2025-12-20
**Last Updated**: 2026-05-15
**Author**: Agent Skills for Context Engineering Contributors
**Version**: 2.2.0

## Contract
- Inputs: agent context/system
- Outputs: guidance

## Output Format
- Markdown guidance

## Anti-Patterns
- Context bloat without signal
