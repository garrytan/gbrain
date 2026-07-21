---
name: harness-engineering
description: "This skill should be used when designing autonomous agent harnesses: research loops, evaluation scaffolds, locked and editable surfaces, durable logs, novelty gates, pruning, rollback, PR preparation, and human approval boundaries."
---

# Harness Engineering

Harness engineering designs the control system around an agent: what it may edit, how it receives feedback, where it writes state, how failures recover, and who can approve irreversible actions. The harness is the difference between a helpful agent session and an autonomous loop that can run for days without corrupting its objective.

## When to Activate

Activate this skill when:

- Building autonomous research or experimentation loops
- Designing an agent environment with locked metrics and editable code or content
- Creating PR-producing or background agents
- Evaluating whether an agent can safely run without frequent human prompts
- Adding novelty, ablation, pruning, rollback, or durable logging to an agent workflow
- Preventing agents from gaming benchmarks, weakening rubrics, or losing state across compaction

Do not activate this skill for adjacent work owned by other skills:
- General quality gates, regression suites, or outcome metrics without autonomous control surfaces: `evaluation`.
- Tool schemas, response formats, and recovery errors for harness tools: `tool-design`.
- Project-level task-model fit, pipeline shape, and cost planning: `project-development`.
- Remote sandbox, warm-pool, and hosted session infrastructure: `hosted-agents`.

## Core Concepts

### Harness Boundary

Separate the agent from the environment it operates inside. The agent proposes actions; the harness defines allowed surfaces, feedback, persistence, and promotion rules.

Use four surface classes:

| Surface | Examples | Rule |
| --- | --- | --- |
| Locked | Eval metric, rubric, validation script, merge policy | Agent may read and propose changes, but cannot score itself with modified rules |
| Editable | Skill draft, experiment file, prompt, config under test | Agent may mutate during the loop |
| Append-only | Results log, research thread, rejected ideas | Agent may append, not rewrite |
| Human-controlled | Merge, production deploy, credentials, destructive operations | Requires explicit human approval |

### Tight Feedback Loops

Autonomy works when feedback is fast, unambiguous, and hard to game. Karpathy's `autoresearch` is the minimal pattern: one editable file, one locked evaluation file, fixed wall-clock budget, one scalar metric, git rollback, and a durable results log. The lesson is not that every harness needs one metric; it is that ambiguous feedback creates ambiguous autonomy.

For open-ended research-to-skill work, replace the scalar metric with locked rubrics, deterministic structure checks, source traceability, and human review thresholds.

### Durable State

Long-running agents must externalize state. Store plans, source queues, results, failures, and handoffs in files so future agents can resume without relying on chat history. Prime Intellect's autonomous nanoGPT work showed the value of durable scratchpads and `THREAD.md`-style logs for recovery, monitoring, and audit.

Use append-only logs for:

- What was tried
- What improved or failed
- Why a candidate was kept, discarded, or routed to review
- Which upstream sources were checked
- What the next agent should do

### Search Discipline

Agents tend to exploit the nearest surface, stack complexity, and under-run pruning. Add explicit search rules:

1. Refresh upstream sources on a schedule.
2. Require novelty checks before spending large budgets.
3. Preserve rejected attempts to avoid rediscovery.
4. Run leave-one-out pruning when a stack has multiple additions.
5. Reward simplification when quality is equal.
6. Use separate verification before promotion.

### Mechanism Registry

For research-to-skill systems, track accepted mechanisms separately from prose. A mechanism record should include a stable `mechanism_id`, `owning_skill`, `status`, activation scenario, behavior change, evidence, and failure modes. Novelty gates should compare against this registry before using broader corpus overlap, because keyword overlap catches stale phrasing while mechanism comparison catches real duplication.

### Governance

Autonomous agents may prepare PRs, but governance must be explicit. They can draft changes, run checks, and write PR summaries. They should not merge, deploy, or push without human approval unless the user has explicitly granted that permission for the specific action.

## Detailed Topics

### Autoresearch-Style Loop

Use this pattern when optimizing an artifact against a stable evaluator:

```text
read locked context -> choose hypothesis -> edit allowed surface -> commit/checkpoint
-> run evaluator -> log result -> keep if better -> discard or rollback if worse
-> repeat
```

Required properties:

- The evaluator is outside the editable surface.
- The feedback cadence is fixed enough to compare attempts.
- Failed attempts leave an audit trail.
- Rollback is cheap.
- The agent has a policy for crashes and timeouts.

### Research-To-Skill Loop

Use this pattern when sources become skill changes:

```text
discover -> retrieve -> gate -> score -> extract mechanism
-> map to existing or new skill -> draft proposal -> validate structure
-> prepare PR -> human review
```

The locked evaluator is a combination of source rubrics, skill-change rubrics, structure checks, and reviewer approval. The editable artifact is the proposed skill delta.

### Metric Gaming Resistance

Assume an optimizing agent will learn the harness. Guard against:

- Editing evaluation code or rubrics and then using the new version for self-approval
- Adding verbose content that pleases a judge but harms skill activation
- Citing unretrieved sources
- Optimizing aggregate scores while failing a critical dimension
- Avoiding failed results in the log

Mitigation: lock rubrics per run, report per-dimension scores, require source retrieval evidence, preserve rejected attempts, and route governance changes to human review.

### Monitoring Agents

Use monitoring agents for long runs, but restrict them to read-only reporting unless explicitly tasked otherwise. Monitoring output should report:

- Best current candidate
- Active jobs or drafts
- Last upstream refresh
- Failed or stale loops
- Disagreements between logs and claimed state
- Next action and blocker

## Practical Guidance

### Harness Design Checklist

1. Define the objective in one sentence.
2. Identify locked, editable, append-only, and human-controlled surfaces.
3. Choose the feedback mechanism: scalar metric, rubric, deterministic tests, human review, or combination.
4. Define keep, discard, crash, timeout, and review states.
5. Create a durable thread log before the loop starts.
6. Add source refresh, mechanism-registry novelty, and pruning rules for long-running loops.
7. Define what the agent may do without asking and what requires approval.
8. Validate the harness on one known good and one known bad artifact.

### File Layout

```text
research-run/
  THREAD.md
  sources/
    queue.md
    evaluations/
  proposals/
  logs/
    results.tsv
    rejected.md
  drafts/
```

Use TSV or JSONL for append-only machine-readable logs. Use Markdown for handoffs and reviewer-facing summaries.

## Examples

**Example 1: Locked metric**

An agent optimizes `train.py`, but `prepare.py` owns data loading and evaluation. The agent can edit the model but cannot change the metric. Failed experiments are logged and rolled back.

**Example 2: Locked rubric**

An agent evaluates a new Anthropic or OpenAI engineering post, but the source curation rubric is locked for the run. If the source passes, the agent drafts a skill proposal. It cannot lower the rubric threshold to admit the source.

**Example 3: Auto-PR without auto-merge**

An agent prepares a branch and PR body after passing source, skill, and structure checks. The PR states unresolved risks and waits for human merge approval.

## Guidelines

1. Lock evaluators before starting the loop.
2. Keep editable surfaces narrow enough for reliable diffs.
3. Write durable logs before context compaction can erase state.
4. Report per-dimension scores instead of only aggregate scores.
5. Require source retrieval before citation.
6. Add novelty gates for broad search and pruning gates for complex stacks.
7. Prefer simplification when quality is equal.
8. Separate PR preparation from merge authority.
9. Revalidate harness changes with old and new evaluators.
10. Treat stopped autonomous loops as harness failures, not agent personality quirks.

## Gotchas

1. **Mutable evaluator**: If the agent can edit the metric, it may optimize the benchmark instead of the task. Keep rubrics and eval code locked during the run.
2. **Chat-only memory**: Long runs fail after compaction when plans live only in conversation history. Write thread logs and result files from the start.
3. **No discard record**: Without rejected-attempt logs, agents repeat failed ideas. Preserve failures with enough detail to avoid rediscovery.
4. **Complexity accretion**: Agents stack changes and rarely remove them. Require pruning rounds and reward equal-quality simplification.
5. **Premature novelty claims**: Agents label recombinations as novel. Compare against existing repo skills, source queue, and rejected logs before claiming novelty.
6. **Monitor misreporting**: Monitoring agents can summarize stale or inconsistent state. Require them to cite the files or logs behind claims.
7. **Human approval ambiguity**: "Prepare a PR" is not "merge a PR." Make approval boundaries explicit in the harness.
8. **Volatile source drift**: Fast-moving lab claims age quickly. Put dated evidence in references and schedule revalidation.

## Integration

This skill connects to:

- evaluation - Rubrics and quality gates provide the locked feedback surface
- advanced-evaluation - Pairwise comparison and bias mitigation improve proposal review
- filesystem-context - Durable logs, scratchpads, and thread files preserve state
- multi-agent-patterns - Researcher, verifier, monitor, and writer agents need isolated contexts
- tool-design - Harness tools must expose clear contracts and recovery errors
- project-development - File-based pipelines and task-model fit analysis keep loops simple
- hosted-agents - Background execution needs sandbox, snapshot, and approval boundaries

## References

Internal references:
- `researcher/README.md` - Read when implementing the repo-native research-to-skill operating system
- `researcher/rubrics/harness-change.md` - Read when evaluating changes to an agent harness
- `researcher/runbooks/autonomous-research-loop.md` - Read when running a source-to-skill loop

External resources:
- Karpathy `autoresearch` - Constrained autonomous experiment loop with locked evaluation
- Prime Intellect autonomous nanoGPT speedrun - Durable scratchpads, handoffs, monitoring, and autonomy failure modes
- AlphaEvolve and FunSearch - LLM-generated candidates paired with systematic evaluators
- HELM and LM Evaluation Harness - Transparent, reproducible evaluation infrastructure

---

## Skill Metadata

**Created**: 2026-05-14
**Last Updated**: 2026-05-15
**Author**: Agent Skills for Context Engineering Contributors
**Version**: 1.1.0

## Contract
- Inputs: agent/system context
- Outputs: guidance

## Output Format
- Markdown guidance

## Anti-Patterns
- Stuffing context without signal; ignoring degradation
