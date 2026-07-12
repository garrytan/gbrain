---
name: project-development
description: "This skill should be used for project-level decisions about LLM-powered systems: whether an LLM is the right primitive for the task at hand, the shape of a multi-stage batch or agent pipeline, token and cost estimation, choosing between single-agent and multi-agent at the project level, structured output design for downstream parsing, and structuring agent-assisted iteration. Use this when the unit of work is a whole project or a multi-stage pipeline. Route individual tool design to tool-design and individual skill-loading or context-budget tactics to context-optimization."
---

# Project Development Methodology

This skill covers the principles for identifying tasks suited to LLM processing, designing effective project architectures, and iterating rapidly using agent-assisted development. The methodology applies whether building a batch processing pipeline, a multi-agent research system, or an interactive agent application.

The unit of work for this skill is the whole project or a multi-stage pipeline. Individual tool design (descriptions, schemas, error messages) belongs to `tool-design`. Per-skill activation routing belongs to the corresponding skill plus the corpus index. This skill owns the project-level questions: should you build this with an LLM at all, what shape should the pipeline take, what does it cost, how should it be iterated.

## When to Activate

Activate this skill when the unit of work is a whole project or pipeline:

- Deciding whether an LLM is the right primitive for a task at all (task-model fit before any code).
- Shaping a multi-stage batch or agent pipeline (acquire / prepare / process / parse / render).
- Estimating tokens, dollar cost, and timelines for an LLM-heavy project.
- Choosing between single-agent and multi-agent at the project level.
- Structuring agent-assisted iteration (where the agent helps build the project itself).
- Designing structured output at the pipeline contract level (cross-stage handoff format).

Do not activate this skill for adjacent work owned by other skills:

- Per-tool description, schema, naming, response format, error message: `tool-design`.
- Per-trajectory token-efficiency tactics (masking, partitioning, caching): `context-optimization`.
- Deciding to split work across sub-agents at the agent topology level: `multi-agent-patterns`.
- Designing the autonomous control loop (locked metrics, novelty gates, human approval boundaries): `harness-engineering`.

## Core Concepts

### Task-Model Fit Recognition

Evaluate task-model fit before writing any code, because building automation on a fundamentally mismatched task wastes days of effort. Run every proposed task through these two tables to decide proceed-or-stop.

**Proceed when the task has these characteristics:**

| Characteristic | Rationale |
|----------------|-----------|
| Synthesis across sources | LLMs combine information from multiple inputs better than rule-based alternatives |
| Subjective judgment with rubrics | Grading, evaluation, and classification with criteria map naturally to language reasoning |
| Natural language output | When the goal is human-readable text, LLMs deliver it natively |
| Error tolerance | Individual failures do not break the overall system, so LLM non-determinism is acceptable |
| Batch processing | No conversational state required between items, which keeps context clean |
| Domain knowledge in training | The model already has relevant context, reducing prompt engineering overhead |

**Stop when the task has these characteristics:**

| Characteristic | Rationale |
|----------------|-----------|
| Precise computation | Math, counting, and exact algorithms are unreliable in language models |
| Real-time requirements | LLM latency is too high for sub-second responses |
| Perfect accuracy requirements | Hallucination risk makes 100% accuracy impossible |
| Proprietary data dependence | The model lacks necessary context and cannot acquire it from prompts alone |
| Sequential dependencies | Each step depends heavily on the previous result, compounding errors |
| Deterministic output requirements | Same input must produce identical output, which LLMs cannot guarantee |

### The Manual Prototype Step

Always validate task-model fit with a manual test before investing in automation. Copy one representative input into the model interface, evaluate the output quality, and use the result to answer these questions:

- Does the model have the knowledge required for this task?
- Can the model produce output in the format needed?
- What level of quality should be expected at scale?
- Are there obvious failure modes to address?

Do this because a failed manual prototype predicts a failed automated system, while a successful one provides both a quality baseline and a prompt-design template. The test takes minutes and prevents hours of wasted development.

### Pipeline Architecture

Structure LLM projects as staged pipelines because separation of deterministic and non-deterministic stages enables fast iteration and cost control. Design each stage to be:

- **Discrete**: Clear boundaries between stages so each can be debugged independently
- **Idempotent**: Re-running produces the same result, preventing duplicate work
- **Cacheable**: Intermediate results persist to disk, avoiding expensive re-computation
- **Independent**: Each stage can run separately, enabling selective re-execution

**Use this canonical pipeline structure:**

```
acquire -> prepare -> process -> parse -> render
```

1. **Acquire**: Fetch raw data from sources (APIs, files, databases)
2. **Prepare**: Transform data into prompt format
3. **Process**: Execute LLM calls (the expensive, non-deterministic step)
4. **Parse**: Extract structured data from LLM outputs
5. **Render**: Generate final outputs (reports, files, visualizations)

Stages 1, 2, 4, and 5 are deterministic. Stage 3 is non-deterministic and expensive. Maintain this separation because it allows re-running the expensive LLM stage only when necessary, while iterating quickly on parsing and rendering.

### File System as State Machine

Use the file system to track pipeline state rather than databases or in-memory structures, because file existence provides natural idempotency and human-readable debugging.

```
data/{id}/
  raw.json         # acquire stage complete
  prompt.md        # prepare stage complete
  response.md      # process stage complete
  parsed.json      # parse stage complete
```

Check if an item needs processing by checking whether the output file exists. Re-run a stage by deleting its output file and downstream files. Debug by reading the intermediate files directly. This pattern works because each directory is independent, enabling simple parallelization and trivial caching.

### Structured Output Design

Design prompts for structured, parseable outputs because prompt design directly determines parsing reliability. Include these elements in every structured prompt:

1. **Section markers**: Explicit headers or prefixes that parsers can match on
2. **Format examples**: Show exactly what output should look like
3. **Rationale disclosure**: State "I will be parsing this programmatically" so the model prioritizes format compliance
4. **Constrained values**: Enumerated options, score ranges, and fixed formats

Build parsers that handle LLM output variations gracefully, because LLMs do not follow instructions perfectly. Use regex patterns flexible enough for minor formatting variations, provide sensible defaults when sections are missing, and log parsing failures for review rather than crashing.

### Agent-Assisted Development

Use agent-capable models to accelerate development through rapid iteration: describe the project goal and constraints, let the agent generate initial implementation, test and iterate on specific failures, then refine prompts and architecture based on results.

Adopt these practices because they keep agent output focused and high-quality:
- Provide clear, specific requirements upfront to reduce revision cycles
- Break large projects into discrete components so each can be validated independently
- Test each component before moving to the next to catch failures early
- Keep the agent focused on one task at a time to prevent context degradation

### Cost and Scale Estimation

Estimate LLM processing costs before starting, because token costs compound quickly at scale and late discovery of budget overruns forces costly rework. Use this formula:

```
Total cost = (items x tokens_per_item x price_per_token) + API overhead
```

For batch processing, estimate input tokens per item (prompt + context), estimate output tokens per item (typical response length), multiply by item count, and add 20-30% buffer for retries and failures.

Track actual costs during development. If costs exceed estimates significantly, reduce context length through truncation, use smaller models for simpler items, cache and reuse partial results, or add parallel processing to reduce wall-clock time.

## Detailed Topics

### Choosing Single vs Multi-Agent Architecture

Default to single-agent pipelines for batch processing with independent items, because they are simpler to manage, cheaper to run, and easier to debug. Escalate to multi-agent architectures only when one of these conditions holds:

- Parallel exploration of different aspects is required
- The task exceeds single context window capacity
- Specialized sub-agents demonstrably improve quality on benchmarks

Choose multi-agent for context isolation, not role anthropomorphization. Sub-agents get fresh context windows for focused subtasks, which prevents context degradation on long-running tasks.

See `multi-agent-patterns` skill for detailed architecture guidance.

### Architectural Reduction

Start with minimal architecture and add complexity only when production evidence proves it necessary, because over-engineered scaffolding often constrains rather than enables model performance.

Vercel's d0 case study reports improved success after reducing many specialized tools to two primitives: command execution and SQL (claim-project-development-vercel-d0-reduction). The file system agent pattern uses standard Unix utilities instead of custom exploration tools.

**Reduce when:**
- The data layer is well-documented and consistently structured
- The model has sufficient reasoning capability
- Specialized tools are constraining rather than enabling
- More time is spent maintaining scaffolding than improving outcomes

**Add complexity when:**
- The underlying data is messy, inconsistent, or poorly documented
- The domain requires specialized knowledge the model lacks
- Safety constraints require limiting agent capabilities
- Operations are truly complex and benefit from structured workflows

See `tool-design` skill for detailed tool architecture guidance.

### Iteration and Refactoring

Plan for multiple architectural iterations from the start, because production agent systems at scale always require refactoring. Manus refactored their agent framework five times since launch. The Bitter Lesson suggests that structures added for current model limitations become constraints as models improve.

Build for change by following these practices:
- Keep architecture simple and unopinionated so refactoring is cheap
- Test across model generations to verify the harness is not limiting performance
- Design systems that benefit from model improvements rather than locking in limitations

## Practical Guidance

### Project Planning Template

Follow this template in order, because each step validates assumptions before the next step invests effort.

1. **Task Analysis**
   - Define the input and desired output explicitly
   - Classify: synthesis, generation, classification, or analysis
   - Set an acceptable error rate based on business impact
   - Estimate the value per successful completion to justify costs

2. **Manual Validation**
   - Test one representative example with the target model
   - Evaluate output quality and format against requirements
   - Identify failure modes that need parser hardening or prompt revision
   - Estimate tokens per item for cost projection

3. **Architecture Selection**
   - Choose single pipeline vs multi-agent based on the criteria above
   - Identify required tools and data sources
   - Design storage and caching strategy using file-system state
   - Plan parallelization approach for the process stage

4. **Cost Estimation**
   - Calculate items x tokens x price with a 20-30% buffer
   - Estimate development time for each pipeline stage
   - Identify infrastructure requirements (API keys, storage, compute)
   - Project ongoing operational costs for production runs

5. **Development Plan**
   - Implement stage-by-stage, testing each before proceeding
   - Define a testing strategy per stage with expected outputs
   - Set iteration milestones tied to quality metrics
   - Plan deployment approach with rollback capability

## Examples

**Example 1: Batch Analysis Pipeline (Karpathy's HN Time Capsule)**

Task: Analyze 930 HN discussions from 10 years ago with hindsight grading.

Architecture:
- 5-stage pipeline: fetch -> prompt -> analyze -> parse -> render
- File system state: data/{date}/{item_id}/ with stage output files
- Structured output: 6 sections with explicit format requirements
- Parallel execution: 15 workers for LLM calls

Results: $58 total cost, ~1 hour execution, static HTML output.

**Example 2: Architectural Reduction (Vercel d0)**

Task: Text-to-SQL agent for internal analytics.

Before: many specialized tools with lower measured success and longer average execution.

After: two tools (bash + SQL) with higher measured success and shorter average execution (claim-project-development-vercel-d0-reduction).

Key insight: The semantic layer was already good documentation. Claude just needed access to read files directly.

See [Case Studies](./references/case-studies.md) for detailed analysis.

## Guidelines

1. Validate task-model fit with manual prototyping before building automation
2. Structure pipelines as discrete, idempotent, cacheable stages
3. Use the file system for state management and debugging
4. Design prompts for structured, parseable outputs with explicit format examples
5. Start with minimal architecture; add complexity only when proven necessary
6. Estimate costs early and track throughout development
7. Build robust parsers that handle LLM output variations
8. Expect and plan for multiple architectural iterations
9. Test whether scaffolding helps or constrains model performance
10. Use agent-assisted development for rapid iteration on implementation

## Gotchas

1. **Skipping manual validation**: Building automation before verifying the model can do the task wastes significant time when the approach is fundamentally flawed. Always run one representative example through the model interface first.
2. **Monolithic pipelines**: Combining all stages into one script makes debugging and iteration difficult. Separate stages with persistent intermediate outputs so each can be re-run independently.
3. **Over-constraining the model**: Adding guardrails, pre-filtering, and validation logic that the model could handle on its own reduces performance. Test whether scaffolding helps or hurts before keeping it.
4. **Ignoring costs until production**: Token costs compound quickly at scale. Estimate and track from the beginning to avoid budget surprises that force architectural rework.
5. **Perfect parsing requirements**: Expecting LLMs to follow format instructions perfectly leads to brittle systems. Build robust parsers that handle variations and log failures for review.
6. **Premature optimization**: Adding caching, parallelization, and optimization before the basic pipeline works correctly wastes effort on code that may be discarded during iteration.
7. **Model version lock-in**: Building pipelines that only work with one specific model version creates fragile systems. Test across model generations and abstract the LLM call layer so models can be swapped without rewriting pipeline logic.
8. **Evaluation-less deployment**: Shipping agent pipelines without measuring output quality means regressions go undetected. Define quality metrics during development and run evaluation checks before and after every model or prompt change.
9. **Provenance drift**: Raw inputs, intermediate outputs, and final proposals separated across ad hoc folders become impossible to audit. Keep each pipeline run in a single directory with source evidence, transformations, validation reports, and decisions.

## Integration

This skill owns project-shape and pipeline decisions. Adjacent decisions are owned elsewhere:

- `tool-design`: the per-tool interface layer (descriptions, schemas, response formats, error messages, MCP namespacing, individual tool consolidation). If the question is "what should this specific tool look like" rather than "what should the pipeline look like," route there.
- `multi-agent-patterns`: agent topology decisions (supervisor vs swarm vs hierarchical, handoff protocols, context isolation across agents). This skill picks single-vs-multi at the project level; the topology details belong to multi-agent-patterns.
- `harness-engineering`: the autonomous control loop around the project (locked metrics, novelty gates, run state machine, human approval boundaries). If the question is "how do we make this run unattended for days," route there.
- `context-fundamentals`: the conceptual frame for context constraints that inform prompt design at every stage.
- `evaluation`: outcome measurement and quality gates for pipeline runs.
- `context-compression`: when long-running pipeline stages produce trajectories that need summarization.

## References

Internal references:
- [Case Studies](./references/case-studies.md) - Read when: evaluating architecture tradeoffs or reviewing real-world pipeline implementations (Karpathy HN Capsule, Vercel d0, Manus patterns)
- [Pipeline Patterns](./references/pipeline-patterns.md) - Read when: designing a new pipeline stage layout, choosing caching strategies, or debugging stage boundaries

Related skills in this collection:
- tool-design - Tool architecture and reduction patterns
- multi-agent-patterns - When to use multi-agent architectures
- evaluation - Output evaluation frameworks

External resources:
- Karpathy's HN Time Capsule project: https://github.com/karpathy/hn-time-capsule
- Vercel d0 architectural reduction: https://vercel.com/blog/we-removed-80-percent-of-our-agents-tools
- Manus context engineering: Peak Ji's blog on context engineering lessons
- Anthropic multi-agent research: How we built our multi-agent research system

---

## Skill Metadata

**Created**: 2025-12-25
**Last Updated**: 2026-05-15
**Author**: Agent Skills for Context Engineering Contributors
**Version**: 1.3.0

## Contract
- Inputs: agent context/system
- Outputs: guidance

## Output Format
- Markdown guidance

## Anti-Patterns
- Context bloat without signal
