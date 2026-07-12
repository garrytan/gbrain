---
name: context-compression
description: "This skill should be used when long-running agent sessions need context compression, structured summarization, compaction, token-per-task optimization, or durable handoff summaries that preserve decisions, files, risks, and next actions."
---

# Context Compression Strategies

When agent sessions generate millions of tokens of conversation history, compression becomes mandatory. The naive approach is aggressive compression to minimize tokens per request. The correct optimization target is tokens per task: total tokens consumed to complete a task, including re-fetching costs when compression loses critical information.

## When to Activate

Activate this skill when:
- Agent sessions exceed context window limits
- Codebases exceed context windows (5M+ token systems)
- Designing conversation summarization strategies
- Debugging cases where agents "forget" what files they modified
- Building evaluation frameworks for compression quality
- Creating durable handoff summaries that preserve decisions, files, risks, and next actions

Do not activate this skill for adjacent work owned by other skills:
- General token-efficiency tactics such as masking, prefix caching, or partitioning: `context-optimization`.
- Diagnosing why a long context is failing before choosing a mitigation: `context-degradation`.
- Writing raw outputs, logs, or plans to files without summarizing them: `filesystem-context`.
- Designing long-term semantic memory across sessions: `memory-systems`.

## Core Concepts

Context compression trades token savings against information loss. Select from three production-ready approaches based on session characteristics:

1. **Anchored Iterative Summarization**: Implement this for long-running sessions where file tracking matters. Maintain structured, persistent summaries with explicit sections for session intent, file modifications, decisions, and next steps. When compression triggers, summarize only the newly-truncated span and merge with the existing summary rather than regenerating from scratch. This prevents drift that accumulates when summaries are regenerated wholesale — each regeneration risks losing details the model considers low-priority but the task requires. Structure forces preservation because dedicated sections act as checklists the summarizer must populate, catching silent information loss.

2. **Opaque Compression**: Reserve this for short sessions where re-fetching costs are low and maximum token savings are required. It produces compressed representations optimized for reconstruction fidelity, achieving 99%+ compression ratios but sacrificing interpretability entirely. The tradeoff matters: there is no way to verify what was preserved without running probe-based evaluation, so never use this when debugging or artifact tracking is critical.

3. **Regenerative Full Summary**: Use this when summary readability is critical and sessions have clear phase boundaries. It generates detailed structured summaries on each compression trigger. The weakness is cumulative detail loss across repeated cycles — each full regeneration is a fresh pass that may deprioritize details preserved in earlier summaries.

## Detailed Topics

### Optimize for Tokens-Per-Task, Not Tokens-Per-Request

Measure total tokens consumed from task start to completion, not tokens per individual request. When compression drops file paths, error messages, or decision rationale, the agent must re-explore, re-read files, and re-derive conclusions — wasting far more tokens than the compression saved. A strategy saving 0.5% more tokens per request but causing 20% more re-fetching costs more overall. Track re-fetching frequency as the primary quality signal: if the agent repeatedly asks to re-read files it already processed, compression is too aggressive.

### Solve the Artifact Trail Problem First

Artifact trail integrity is often the weakest dimension in compression evaluations (claim-context-compression-factory-benchmark). Address this proactively because general summarization cannot reliably maintain it.

Preserve these categories explicitly in every compression cycle:
- Which files were created (full paths)
- Which files were modified and what changed (include function names, not just file names)
- Which files were read but not changed
- Specific identifiers: function names, variable names, error messages, error codes

Implement a separate artifact index or explicit file-state tracking in agent scaffolding rather than relying on the summarizer to capture these details. Even structured summarization with dedicated file sections struggles with completeness over long sessions.

### Structure Summaries with Mandatory Sections

Build structured summaries with explicit sections that prevent silent information loss. Each section acts as a checklist the summarizer must populate, making omissions visible rather than silent.

```markdown
## Session Intent
[What the user is trying to accomplish]

## Files Modified
- auth.controller.ts: Fixed JWT token generation
- config/redis.ts: Updated connection pooling
- tests/auth.test.ts: Added mock setup for new config

## Decisions Made
- Using Redis connection pool instead of per-request connections
- Retry logic with exponential backoff for transient failures

## Current State
- 14 tests passing, 2 failing
- Remaining: mock setup for session service tests

## Next Steps
1. Fix remaining test failures
2. Run full test suite
3. Update documentation
```

Adapt sections to the agent's domain. A debugging agent needs "Root Cause" and "Error Messages"; a migration agent needs "Source Schema" and "Target Schema." The structure matters more than the specific sections — any explicit schema outperforms freeform summarization.

### Choose Compression Triggers Strategically

When to trigger compression matters as much as how to compress. Select a trigger strategy based on session predictability:

| Strategy | Trigger Point | Trade-off |
|----------|---------------|-----------|
| Fixed threshold | 70-80% context utilization | Simple but may compress too early |
| Sliding window | Keep last N turns + summary | Predictable context size |
| Importance-based | Compress low-relevance sections first | Complex but preserves signal |
| Task-boundary | Compress at logical task completions | Clean summaries but unpredictable timing |

Default to sliding window with structured summaries for coding agents — it provides the best balance of predictability and quality. Use task-boundary triggers when sessions have clear phase transitions (e.g., research then implementation then testing).

### Evaluate Compression with Probes, Not Metrics

Traditional metrics like ROUGE or embedding similarity fail to capture functional compression quality. A summary can score high on lexical overlap while missing the one file path the agent needs to continue.

Use probe-based evaluation: after compression, pose questions that test whether critical information survived. If the agent answers correctly, compression preserved the right information. If not, it guesses or hallucinates.

| Probe Type | What It Tests | Example Question |
|------------|---------------|------------------|
| Recall | Factual retention | "What was the original error message?" |
| Artifact | File tracking | "Which files have we modified?" |
| Continuation | Task planning | "What should we do next?" |
| Decision | Reasoning chain | "What did we decide about the Redis issue?" |

### Score Compression Across Six Dimensions

Evaluate compression quality for coding agents across these dimensions. Accuracy and artifact-trail preservation tend to separate methods more clearly than lexical similarity (claim-context-compression-factory-benchmark), so compression needs specialized handling beyond general summarization.

1. **Accuracy**: Are technical details correct — file paths, function names, error codes?
2. **Context Awareness**: Does the response reflect current conversation state?
3. **Artifact Trail**: Does the agent know which files were read or modified?
4. **Completeness**: Does the response address all parts of the question?
5. **Continuity**: Can work continue without re-fetching information?
6. **Instruction Following**: Does the response respect stated constraints?

## Practical Guidance

### Apply the Three-Phase Compression Workflow for Large Codebases

For codebases or agent systems exceeding context windows, compress through three sequential phases. Each phase narrows context so the next phase operates within budget.

1. **Research Phase**: Explore architecture diagrams, documentation, and key interfaces. Compress exploration into a structured analysis of components, dependencies, and boundaries. Output: a single research document that replaces raw exploration.

2. **Planning Phase**: Convert the research document into an implementation specification with function signatures, type definitions, and data flow. A 5M-token codebase compresses to approximately 2,000 words of specification at this stage.

3. **Implementation Phase**: Execute against the specification. Context stays focused on the spec plus active working files, not raw codebase exploration. This phase rarely needs further compression because the spec is already compact.

### Use Example Artifacts as Compression Seeds

When provided with a manual migration example or reference PR, use it as a template to understand the target pattern rather than exploring the codebase from scratch. The example reveals constraints static analysis cannot surface: which invariants must hold, which services break on changes, and what a clean implementation looks like.

This matters most when the agent cannot distinguish essential complexity (business requirements) from accidental complexity (legacy workarounds). The example artifact encodes that distinction implicitly, saving tokens that would otherwise go to trial-and-error exploration.

### Implement Anchored Iterative Summarization Step by Step

1. Define explicit summary sections matching the agent's domain (debugging, migration, feature development)
2. On first compression trigger, summarize the truncated history into those sections
3. On subsequent compressions, summarize only newly truncated content — do not re-summarize the existing summary
4. Merge new information into existing sections rather than regenerating them, deduplicating by file path and decision identity
5. Tag which information came from which compression cycle — this enables debugging when summaries drift

### Select the Right Approach for the Session Profile

**Use anchored iterative summarization when:**
- Sessions are long-running (100+ messages)
- File tracking matters (coding, debugging)
- Verification of preserved information is needed

**Use opaque compression when:**
- Maximum token savings are required
- Sessions are relatively short
- Re-fetching costs are low (e.g., no file system access needed)

**Use regenerative summaries when:**
- Summary interpretability is critical for human review
- Sessions have clear phase boundaries
- Full context review is acceptable on each compression trigger

### Calibrate Compression Ratios by Method

| Method | Compression Ratio | Quality Score | Trade-off |
|--------|-------------------|---------------|-----------|
| Anchored Iterative | 98.6% | 3.70 | Best quality, slightly less compression |
| Regenerative | 98.7% | 3.44 | Good quality, moderate compression |
| Opaque | 99.3% | 3.35 | Best compression, quality loss |

Use these as source-specific benchmark figures, not universal constants (claim-context-compression-factory-benchmark). For any task where re-fetching costs exist, this tradeoff generally favors structured approaches.

## Examples

**Example 1: Debugging Session Compression**

Original context (89,000 tokens, 178 messages):
- 401 error on /api/auth/login endpoint
- Traced through auth controller, middleware, session store
- Found stale Redis connection
- Fixed connection pooling, added retry logic
- 14 tests passing, 2 failing

Structured summary after compression:

```markdown
## Session Intent
Debug 401 Unauthorized error on /api/auth/login despite valid credentials.

## Root Cause
Stale Redis connection in session store. JWT generated correctly but session could not be persisted.

## Files Modified
- auth.controller.ts: No changes (read only)
- middleware/cors.ts: No changes (examined)
- config/redis.ts: Fixed connection pooling configuration
- services/session.service.ts: Added retry logic for transient failures
- tests/auth.test.ts: Updated mock setup

## Test Status
14 passing, 2 failing (mock setup issues)

## Next Steps
1. Fix remaining test failures (mock session service)
2. Run full test suite
3. Deploy to staging
```

**Example 2: Probe Response Quality**

After compression, asking "What was the original error?":

Good response (structured summarization):
> "The original error was a 401 Unauthorized response from the /api/auth/login endpoint. Users received this error with valid credentials. Root cause was stale Redis connection in session store."

Poor response (aggressive compression):
> "We were debugging an authentication issue. The login was failing. We fixed some configuration problems."

The structured response preserves endpoint, error code, and root cause. The aggressive response loses all technical detail.

## Guidelines

1. Optimize for tokens-per-task, not tokens-per-request
2. Use structured summaries with explicit sections for file tracking
3. Trigger compression at 70-80% context utilization
4. Implement incremental merging rather than full regeneration
5. Test compression quality with probe-based evaluation
6. Track artifact trail separately if file tracking is critical
7. Accept slightly lower compression ratios for better quality retention
8. Monitor re-fetching frequency as a compression quality signal

## Gotchas

1. **Never compress tool definitions or schemas**: Compressing function call schemas, API specs, or tool definitions destroys agent functionality entirely. The agent cannot invoke tools whose parameter names or types have been summarized away. Treat tool definitions as immutable anchors that bypass compression.

2. **Compressed summaries hallucinate facts**: When an LLM summarizes conversation history, it may introduce plausible-sounding details that never appeared in the original. Always validate compressed output against source material before discarding originals — especially for file paths, error codes, and numeric values that the summarizer may "round" or fabricate.

3. **Compression breaks artifact references**: File paths, commit SHAs, variable names, and code snippets get paraphrased or dropped during compression. A summary saying "updated the config file" when the agent needs `config/redis.ts` causes re-exploration. Preserve identifiers verbatim in dedicated sections rather than embedding them in prose.

4. **Early turns contain irreplaceable constraints**: The first few turns of a session often contain task setup, user constraints, and architectural decisions that cannot be re-derived. Protect early turns from compression or extract their constraints into a persistent preamble that survives all compression cycles.

5. **Aggressive ratios compound across cycles**: A 95% compression ratio seems safe once, but applying it repeatedly compounds losses. After three cycles at 95%, only 0.0125% of original tokens remain. Calibrate ratios assuming multiple compression cycles, not a single pass.

6. **Code and prose need different compression**: Prose compresses well because natural language is redundant. Code does not — removing a single token from a function signature or import path can make it useless. Apply domain-specific compression strategies: summarize prose sections aggressively while preserving code blocks and structured data verbatim.

7. **Probe-based evaluation gives false confidence**: Probes can pass despite critical information being lost, because the probes test only what they ask about. A probe set that checks file names but not function signatures will miss signature loss. Design probes to cover all six evaluation dimensions, and rotate probe sets across evaluation runs to avoid blind spots.

## Integration

This skill connects to several others in the collection:

- context-degradation - Compression is a mitigation strategy for degradation
- context-optimization - Compression is one optimization technique among many
- evaluation - Probe-based evaluation applies to compression testing
- memory-systems - Compression relates to scratchpad and summary memory patterns

## References

Internal reference:
- [Evaluation Framework Reference](./references/evaluation-framework.md) - Read when: building or calibrating a probe-based evaluation pipeline, or when needing scoring rubrics and LLM judge configuration for compression quality assessment

Related skills in this collection:
- context-degradation - Read when: diagnosing why agent performance drops over long sessions, before applying compression as a mitigation
- context-optimization - Read when: compression alone is insufficient and broader optimization strategies (pruning, caching, routing) are needed
- evaluation - Read when: designing evaluation frameworks beyond compression-specific probes, including general LLM-as-judge methodology

External resources:
- Factory Research: Evaluating Context Compression for AI Agents (December 2025) - Read when: needing benchmark data on compression method comparisons or the 36,000-message evaluation dataset
- Research on LLM-as-judge evaluation methodology (Zheng et al., 2023) - Read when: implementing or validating LLM judge scoring to understand bias patterns and calibration
- Netflix Engineering: "The Infinite Software Crisis" - Three-phase workflow and context compression at scale (AI Summit 2025) - Read when: implementing the three-phase compression workflow for large codebases or understanding production-scale context management

---

## Skill Metadata

**Created**: 2025-12-22
**Last Updated**: 2026-05-15
**Author**: Agent Skills for Context Engineering Contributors
**Version**: 1.3.0

## Contract
- Inputs: agent/system context
- Outputs: guidance

## Output Format
- Markdown guidance

## Anti-Patterns
- Stuffing context without signal; ignoring degradation
