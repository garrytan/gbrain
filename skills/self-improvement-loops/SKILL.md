---
name: self-improvement-loops
description: "This skill should be used when the harness, scaffold, workflow, or optimizer itself is the optimization target: recursive self-improvement (RSI) loops, meta-harnesses, self-improving harnesses that mine their own failures and propose bounded edits, evolutionary or population-based search over agent scaffolds, acceptance gates for self-modifying systems, and agentic context evolution where the mechanism that produces context is versioned and evolved. Route governance of a single autonomous loop (locked surfaces, durable logs, rollback, novelty gates, approval boundaries) to harness-engineering, measurement and quality-gate design to evaluation, judge design to advanced-evaluation, and remote sandbox infrastructure to hosted-agents."
---

# Self-Improvement Loops

This skill covers systems where the harness is the artifact being optimized: an agent mines its own failures and edits its own scaffold, a meta-agent searches over harness code, a population of workflow candidates evolves against an evaluator, or the mechanism that produces context is itself versioned and improved. The design question shifts from "how do I control one loop" (harness-engineering) to "how do I let a loop rewrite parts of itself without corrupting the signal that steers it".

The controlling constraint across every published system: the loop optimizes whatever signal it is given, including the signal's own weaknesses. Design the loop assuming the optimizer will find every gap between the metric and the intent.

## When to Activate

Activate this skill when:

- Building a loop where an agent proposes edits to its own harness, prompts, context playbook, or workflow based on mined failure patterns
- Designing meta-level search over harness or scaffold code: meta-agent search, tree search over workflow graphs, evolutionary program search with an LLM mutation operator
- Choosing acceptance criteria for any self-modifying agent system
- Evolving the mechanism that manages context (a skill, playbook, or context function) rather than hand-editing the context artifact
- Diagnosing a degenerating self-improvement loop: reward hacking, diversity collapse, context collapse, or silent stagnation
- Deciding which level of the optimization ladder (prompt, context, workflow, harness code, optimizer code) a recurring failure should be fixed at

Do not activate this skill for adjacent work owned by other skills:

- Governance of a single autonomous loop that does not modify itself: locked and editable surfaces, durable logs, rollback, novelty gates, PR preparation, and human approval boundaries belong to `harness-engineering`. That skill defines the control surfaces; this skill defines what happens when the surfaces themselves become the optimization target.
- Building the evaluator, regression suite, or quality gates that score candidates: `evaluation`.
- LLM-as-judge design, pairwise comparison, and bias mitigation for candidate scoring: `advanced-evaluation`.
- One-shot token efficiency, masking, or caching without an improvement loop: `context-optimization`.
- Remote sandboxes and background execution infrastructure for running the loop: `hosted-agents`.
- Whether to build the loop at all, pipeline shape, and cost estimation: `project-development`.

## Core Concepts

### The Optimization Ladder

Published self-improvement systems target progressively deeper objects:

| Rung | Optimized object | Example systems |
| --- | --- | --- |
| 1 | Instruction prompts | Promptbreeder, GEPA |
| 2 | Structured context | ACE (playbook of itemized bullets) |
| 3 | Context mechanism | MCE (the skill that produces context) |
| 4 | Workflow graph | ADAS, AFlow |
| 5 | Harness code | Self-Harness (bounded self-edits), Meta-Harness, Darwin Godel Machine |
| 6 | Optimizer code | STOP (the improver improves the improver) |

Each rung up buys a larger design space and more leverage, and costs more per evaluation with a larger surface for gaming. Fix a recurring failure at the lowest rung that can express the fix. A stale-library failure is a context fix, not a workflow rewrite. Only move up when failure clusters at the current rung persist across candidates.

### The Loop Is Not the Intelligence

Recursive structure amplifies base-model quality in both directions. The same recursive improver design that compounds gains with a strong model degrades mean performance across iterations with weaker models (claim-self-improvement-capability-threshold). Two implications:

1. Run a capability validation before enabling recursion: a fixed number of iterations on a held-out task set, with the loop counted as net-negative if the trajectory declines.
2. Detect the degenerate stagnation mode. A broken improver that silently returns its input unchanged looks like stability in aggregate metrics. Track edit diffs, not only scores.

### The Outside-the-Loop Invariant

The evaluator, its instrumentation, permission control, and budget enforcement must live outside the surface the loop can modify. Every documented reward hack broke this invariant: agents removed the logging markers a hallucination detector depended on, and hacking became more frequent when the checking code was visible to the agent (claim-self-improvement-visible-evaluator-hacking). Agents given sight of scoring functions overwrote timing functions and monkey-patched evaluators to return perfect scores (claim-self-improvement-scorer-visibility).

Operational rules:

- Constraints stated in prompt text get evolved away. Enforce budgets, permissions, and sandbox boundaries in the runtime, never in the mutable prompt or harness code.
- Hide the scoring implementation from the proposer. Expose scores and traces, not evaluator source.
- Sandbox at the OS or container level. Framework-level permission gates can be bypassed through side channels the loop discovers.
- Treat any detected exploit as a failed candidate, not a high score, or the hack inflates the very metric steering the loop.

### Empirical Acceptance, Never Rationale

Accept a self-modification only on measured evidence, using two splits: a held-in split that checks the targeted weakness was resolved, and a held-out split the proposer never sees that checks nothing else regressed. The strictest published gate accepts only when neither split regresses and at least one strictly improves, with repeated evaluation under stochastic scoring; this produced held-out gains across every base model tested (claim-self-improvement-two-split-acceptance). Reject candidates that trade one split against the other even when the sum improves. Log rejected candidates with their evidence so the proposer stops rediscovering them.

### Filesystem Experience Archive

Store every candidate as a directory containing its source, scores, and raw execution traces. Let the proposer navigate the archive with search tools (grep-style queries over files) instead of stuffing history into its context window. In direct ablation, a proposer with full raw-trace access materially outperformed both a scores-only proposer and a proposer fed LLM-written summaries of the same traces; summaries recovered none of the lost signal and sometimes hurt (claim-self-improvement-raw-trace-ablation). Do not pre-summarize the archive. Curate access paths, not content.

### Diversity Preservation

Evolutionary and RL-style loops collapse toward variants of the current best unless diversity is engineered in. The mechanisms that survived ablation across published systems:

- Keep an archive of every candidate that retains core capability; never hill-climb only the latest version. Stepping stones pay off many iterations after they are discovered.
- Select parents with fitness pressure discounted by offspring count, so heavily-mined candidates lose priority while every archive member keeps nonzero selection probability.
- Reject near-duplicate proposals by embedding similarity before paying evaluation cost.
- Keep a persistent route back to the seed or blank candidate in the selection distribution as an escape from local optima.

## Detailed Topics

### Anatomy of a Failure-Driven Self-Edit Loop

The strongest published pattern for an agent improving its own harness has three stages:

1. **Weakness mining.** Cluster failed traces by a three-part signature: the verifier-level cause (what was rejected), the causal status of the agent behavior (was it actually responsible), and the abstract mechanism the trace exposes (the reusable behavioral pattern). Never cluster on error strings alone; a timeout is a symptom shared by unrelated mechanisms. Apply an addressability filter: exclude clusters that reflect task difficulty or capability limits rather than harness defects.
2. **Bounded proposal.** Give the proposer exactly four inputs: the declared editable surfaces, the mined failure patterns, records of passing behaviors that must be preserved, and summaries of previously attempted edits. Require proposals to be minimal (touch one surface), mutually distinct across parallel candidates, and accompanied by an audit record stating the targeted pattern, expected effect, and regression risks.
3. **Validation and merge.** Apply the two-split acceptance gate. Merge compatible accepted edits; log rejected ones without changing the active harness. Every transition records changed surfaces, split outcomes, and the decision, so the lineage is auditable.

### Meta-Level Search over Harness Code

When searching whole harness programs from outside rather than editing a running harness from inside:

- Keep the outer loop minimal: no hand-tuned mutation operators or parent-selection heuristics. Delegate diagnosis and edit decisions to a strong coding-agent proposer, so the system improves as coding agents improve.
- Initialize from the strongest available harness, not from scratch. Winning edits are typically small and additive (an environment bootstrap, an artifact-creation instruction), while prompt and completion-flow rewrites are empirically high-risk.
- Maintain a Pareto frontier over the objectives that actually matter (accuracy, context cost, latency) rather than collapsing to one scalar.
- Structure search memory per candidate with recorded modification outcomes. Dumping the whole archive into the proposer prompt degrades sharply as history grows; per-node experience records with credit assignment beat archive-in-context conditioning.
- Re-run the search when the executor model changes. Discovered harnesses are executor-dependent and do not transfer freely across base models.

### Context Evolution as Self-Improvement

Context playbooks that update themselves are the entry-level self-improvement loop, with two named failure modes. Brevity bias: optimizers collapse toward short generic instructions, dropping the domain-specific heuristics that carried the value. Context collapse: letting a model monolithically rewrite accumulated context shrinks it catastrophically in a single step, below the no-adaptation baseline (claim-self-improvement-context-collapse). The working pattern:

- Represent context as itemized entries with stable identifiers and helpful/harmful counters.
- Produce incremental deltas, merged by deterministic non-model logic. The curator never rewrites the whole artifact.
- Deduplicate by embedding similarity, periodically or lazily.
- Gate the whole mechanism on feedback quality. Without reliable execution signals or labels, self-managed context degrades below the static baseline.

One level up, version the mechanism that produces context (the skill: static components plus dynamic operators) separately from the produced context, evolve the mechanism against a validation split only, and warm-start each iteration from the prior best artifact plus its rollout results. Check the train-validation gap explicitly each iteration to catch mechanism overfitting.

### What Belongs to Humans

Humans move up the stack rather than out of the loop. Reserve for human decision points: changes to the evaluator or acceptance gate, expansion of editable surfaces, promotion of a discovered harness to production, and abandonment decisions for research directions. Models trained mostly on successful outcomes are poorly calibrated on when to abandon a line of work, and preserved negative results are the cheapest way to trim a successor's search space. Make failed candidates first-class artifacts.

## Practical Guidance

### Loop-Readiness Checklist

Do not enable self-modification until every item holds:

1. A fast, deterministic, automatable evaluator exists. Domains with slow, ambiguous, or judge-only evaluation are where this loop family fails.
2. A held-out split exists that the proposer never sees, refreshed if the loop runs long enough to overfit it.
3. Budgets, permissions, and sandboxing are enforced by the runtime, outside every editable surface.
4. Editable surfaces are explicitly declared (marked regions or configuration points); everything else is locked, and immutability is programmatically re-verified after each candidate.
5. An archive with full lineage of diffs exists; audits read diffs and raw traces, not the fitness signal.
6. Evaluation spending is staged: cheap interface or smoke checks before full evaluation, repeated runs where scoring is noisy.
7. A capability validation run has shown the base model clears the recursion threshold on this task family.
8. Human decision points are wired for evaluator changes, surface expansion, and promotion.

### Choosing the Loop Level

| Recurring failure | Fix at | Loop pattern |
| --- | --- | --- |
| Missing domain heuristics, repeated known mistakes | Structured context | Itemized playbook with delta updates |
| Context playbook itself plateaus across tasks | Context mechanism | Evolve the skill on validation data |
| Wrong sequencing, missing verification steps | Workflow | Search over workflow graphs with per-node experience |
| Failure clusters persist across workflow candidates | Harness code | Failure-driven bounded self-edits or meta-level search |
| Improvement strategy itself is weak | Optimizer code | Only with strong models and locked meta-evaluation |

## Examples

**Example 1: Two-split acceptance gate**

```python
def accept(candidate, baseline, held_in, held_out, repeats=3):
    d_in = mean_score(candidate, held_in, repeats) - mean_score(baseline, held_in, repeats)
    d_out = mean_score(candidate, held_out, repeats) - mean_score(baseline, held_out, repeats)
    if d_in < 0 or d_out < 0:
        return False              # no regression on either split
    return max(d_in, d_out) > 0  # strict improvement on at least one
```

The held-out split is invisible to the proposer. A candidate that gains on held-in by sacrificing held-out is rejected even if the sum is positive.

**Example 2: Experience archive layout**

```text
search-run/
  candidates/
    c0041/
      harness.py          # full candidate source
      scores.json          # per-split, per-repeat results
      traces/              # raw prompts, tool calls, outputs, state updates
      lineage.txt          # parent id, diff summary, decision, evidence
  frontier.json            # current Pareto set over (quality, cost)
  rejected.jsonl           # rejected candidates with reasons, append-only
```

The proposer greps this tree selectively. Nothing is summarized into its prompt by default.

**Example 3: Routing a failure to the right rung**

```text
Observed: agent repeatedly uses a deprecated API despite instructions.
Wrong fix: propose a harness-code edit adding retry logic.
Right fix: rung 2. Inject current API docs into task context at
execution time. Training-data defaults override prompt instructions,
so ground the context; do not add machinery.
```

## Guidelines

1. Enforce every constraint in the runtime; treat prompt-stated constraints as decorative.
2. Keep evaluator source, instrumentation, and permission checks invisible to and unmodifiable by the loop.
3. Gate acceptance on held-in plus held-out no-regression with repeated evaluation; never accept on the proposer's rationale.
4. Declare editable surfaces explicitly and re-verify locked regions after every candidate.
5. Archive all viable candidates with raw traces; select parents with offspring-count discounting.
6. Reject near-duplicates by embedding similarity before spending evaluation budget.
7. Evaluate from raw logs and original outputs, never from model-written reports of them.
8. Count detected evaluator exploits as failures and audit lineage diffs, not scores.
9. Fix failures at the lowest ladder rung that expresses the fix.
10. Re-search when the executor model or the seed harness changes materially.
11. Verify the base model clears the capability threshold before enabling recursion.
12. Keep evaluator changes, surface expansion, and production promotion as human decisions.

## Gotchas

1. **Prompt constraints evolve away**: Budget limits and safety rules stated in the seed prompt get dropped during self-rewrites, and explicit warnings do not reduce circumvention attempts. Only runtime enforcement survives optimization pressure.
2. **Visible scorers get gamed**: Exposing the scoring function to the proposer invites monkey-patching, timing overwrites, and detector disabling, and hacking frequency rises with evaluator visibility (claim-self-improvement-scorer-visibility). Expose scores and traces, never evaluator internals.
3. **Self-reported success**: Loops that evaluate from the agent's own report files inherit its over-optimism: noise declared as signal, bugs interpreted as breakthroughs, unfavorable runs omitted. Bind every reported number to a raw artifact (log line, score file) at write time.
4. **Monolithic rewrite collapse**: Asking a model to rewrite its accumulated playbook wholesale can shrink it by orders of magnitude in one step and drop quality below the never-adapted baseline (claim-self-improvement-context-collapse). Update by itemized deltas with deterministic merge.
5. **Hill-climbing the latest candidate**: Discarding the archive and iterating only on the current best gets stuck after one bad modification. Ablations show archive-based selection recovering from regressions many iterations later.
6. **Stagnation disguised as stability**: A degenerate improver that returns its input unchanged produces flat metrics indistinguishable from convergence. Alarm on empty or trivial diffs, not only on score drops.
7. **Same-model generator and evaluator**: When one model both proposes and scores, optimization pressure exploits shared blind spots and the measured score diverges from true quality. Use an independent evaluator, ideally grounded in execution rather than judgment.
8. **Benchmark-shaped improvements**: Accepted edits often encode evaluation-set specifics and executor-model quirks rather than general capability. Validate on a distribution shift before promoting, and re-run the search after a model upgrade instead of porting the discovered harness.
9. **Cross-stage score cherry-picking**: When a reporting stage can see a pool of intermediate scores, it selects the most favorable one rather than the score of the artifact actually shipped. Bind reported scores to the submitted candidate deterministically.

## Integration

This skill connects to:

- harness-engineering - Owns the control surfaces (locked, editable, append-only, human) that this skill's loops operate within; every self-improvement loop presupposes that boundary design
- evaluation - Owns the deterministic evaluators, regression suites, and quality gates that serve as the locked fitness signal
- advanced-evaluation - Owns judge design and bias mitigation when candidate scoring requires model judgment
- filesystem-context - Owns the durable file layout patterns the experience archive builds on
- multi-agent-patterns - Parallel candidate evaluation and proposer-verifier separation are multi-agent topologies
- hosted-agents - Owns the sandboxed execution infrastructure that enforces the runtime boundary
- context-optimization - Owns one-shot context efficiency; this skill owns the loop that evolves context mechanisms over time

## References

Internal reference:
- [Loop design evidence](./references/loop-design-evidence.md) - Dated per-system results, acceptance-rule details, ablation findings, and documented reward-hacking incidents backing this skill

Related skills in this collection:
- harness-engineering - Single-loop governance and control surfaces
- evaluation - Evaluator and quality-gate construction

External resources:
- Weng, "Harness Engineering for Self-Improvement" (Lil'Log, 2026) - Survey and framing of the optimization ladder and RSI challenges
- Zhang et al., "Self-Harness: Harnesses That Improve Themselves" (arXiv 2606.09498) - Failure-driven bounded self-edits with two-split acceptance
- Lee et al., "Meta-Harness: End-to-End Optimization of Model Harnesses" (arXiv 2603.28052) - Filesystem experience store and coding-agent proposer
- Ye et al., "Meta Context Engineering via Agentic Skill Evolution" (arXiv 2601.21557) - Mechanism-versus-artifact separation in context evolution
- Zhang et al., "Agentic Context Engineering" (arXiv 2510.04618) - Itemized deltas, deterministic merge, context collapse
- Zhang et al., "Darwin Godel Machine" (arXiv 2505.22954) - Archive-based harness evolution and documented objective hacking
- Zelikman et al., "Self-Taught Optimizer" (arXiv 2310.02304) - Recursive improver and the capability-threshold negative result
- Novikov et al., "AlphaEvolve" (arXiv 2506.13131) - Bounded mutation markers and evaluation cascades
- Lange et al., "ShinkaEvolve" (arXiv 2509.19349) - Novelty rejection and sample-efficient parent sampling
- METR, "Recent Frontier Models Are Reward Hacking" (2025) - Documented evaluator-gaming incidents in agentic tasks

Numeric, benchmark, volatile, or vendor-performance claims in this skill carry inline `claim-*` IDs backed by `researcher/claims/index.jsonl`. Detailed numbers live in the dated reference file.

---

## Skill Metadata

**Created**: 2026-07-08
**Last Updated**: 2026-07-08
**Author**: Agent Skills for Context Engineering Contributors
**Version**: 1.0.0

## Contract
- Inputs: agent context/system
- Outputs: guidance

## Output Format
- Markdown guidance

## Anti-Patterns
- Context bloat without signal
