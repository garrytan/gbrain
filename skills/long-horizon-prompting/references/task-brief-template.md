# Pseudo-Formal Task Brief Template

A reusable template for launching long-running autonomous agents or parallel orchestrations on hard problems, plus the pre-launch evaluation rubric. Copy the template, delete blocks that do not apply, and fill the rest. Blocks marked (parallel runs) are only needed when an orchestrator manages concurrent workers.

## Template

```text
DEFINITIONS

<Define every load-bearing term an adversarial reader could interpret
two ways. Include degenerate and boundary cases explicitly: the empty
input, the trivial solution, the duplicate, the disconnected case,
the zero-measurement. In empirical domains: units, populations,
inclusion criteria, measurement procedure.>

TASK

<One statement of the success predicate: what must be true of the
returned artifact, with quantifiers and scope spelled out. Enumerate
the narrowing assumptions the solution is NOT allowed to make.>

<If a solution plausibly exists:> Assume for purposes of this task
that a complete solution exists.

<If existence is genuinely uncertain:> Either a complete solution or
a complete demonstration of impossibility counts; nothing in between
does.

DOES NOT COUNT

Partial progress does not count unless it implies exactly the
resolution above. In particular, the following are insufficient:
- results holding only for a narrowed scope or special case
- reductions of the problem to another unvalidated assumption,
  unproved statement, or unavailable dataset
- verification over any bounded subset of cases
- artifacts with a requirement satisfied approximately where exact
  satisfaction is specified
- candidate counterexamples or refutations without a complete
  certificate
- plans, surveys, status summaries, or explanations of difficulty
<Add the near misses specific to this problem. Predict what a capable
agent under pressure would return instead of a solution, and exclude
each by name.>

ORCHESTRATION (parallel runs)

Use concurrent agents aggressively and dynamically. Do not use fixed
assignments such as "N agents for strategy X". Manage the search with
these heuristics:
- Begin with a genuinely diverse portfolio of substantially different
  formulations and approaches: <list the known families for this
  domain>.
- Do not tell most agents the currently favored approach; preserve
  independence in early rounds.
- Maintain an explicit registry of approach families, grouped by the
  underlying idea rather than surface wording. Redirect agents away
  from crowded families toward underexplored ones.
- Do not let one approach dominate because it yields elegant
  reformulations. A route that ends at a subproblem as hard as the
  original goal is not progress unless it genuinely resolves that
  subproblem.
- When a route stalls at a goal-strength gap, mark it blocked and
  record why. Reassign agents to it only for a materially new
  mechanism, not for renewed enthusiasm.
- Keep several incompatible routes alive across rounds; cross-
  pollinate only after independent development has exposed each
  route's real strengths and gaps.
- The root agent repeatedly synthesizes, challenges, redirects, and
  launches new rounds. Do not stop after the first wave fails.

VERIFICATION

Use adversarial reviewer agents with fresh context throughout. Every
candidate must be checked against this list:
<Enumerate the domain-specific ways a candidate can look right and be
wrong: the known confounders, degenerate cases, circular arguments,
leakage paths, and too-good-to-be-true signatures of this field.
Always include the domain's version of circularity: satisfying the
goal by assuming something equivalent to it.>

Require workers to return concrete artifacts: <lemmas, constructions,
scripts, datasets, measurements, counterexamples appropriate to the
domain>. Reject status reports, vague optimism, and claims that an
unresolved step is "routine".

Structure the final artifact modularly so each part can be verified
in isolation, with its premises and conclusion stated locally.

RETURN CONDITION

Return only when a candidate satisfies the TASK predicate and
survives the adversarial audit above. Do not return a reduction,
partial result, isolated missing step, best-effort summary, or
explanation of why the problem is difficult.

If the externally enforced budget is exhausted first, return the
strongest rigorously verified derivation and its exact remaining gap,
clearly labeled as incomplete.

EFFORT

Spend at least <floor> before considering returning or giving up. Do
not return merely because current approaches fail; launch new rounds
and search for fresh formulations.

CONTAMINATION

External search may be used only for <ordinary background, standard
named results, documented APIs>. Do not search for a solution to this
exact problem or its benchmark. <If solvability framing is used:> Do
not conclude from external sources that the problem is unsolved, and
do not answer that it is open.
```

## Filling notes

- **The refusal-list method.** The fastest way to a good DOES NOT COUNT block: imagine a junior collaborator returning with each plausible partial result, and write down every one you would send back. That list, verbatim, is the block.
- **Solvability framing is a scalpel.** Use "assume a solution exists" only when existence is plausible (engineering problems, well-evidenced conjectures, questions with a definite answer). On genuinely open questions, use the two-sided form or the run will fabricate rather than conclude impossibility.
- **The fallback clause must be scoped.** Allow a partial-result return only on external budget exhaustion, never at the agent's discretion, or it becomes the escape hatch the rest of the brief closed.
- **Effort floors are permissions, not schedules.** The floor removes permission to quit early. Enforce real time and cost limits in the harness; a prompt cannot bound spend.
- **Keep hard constraints out of the brief.** Budgets, tool permissions, and sandbox boundaries stated in prompts are advisory under optimization pressure. State them in the runtime and mention them in the brief only for the agent's planning.
- **Per-spawn specs for workers.** The orchestrator should give every spawned worker four things: objective, output format, tool and source guidance, and task boundaries. Put this rule in the ORCHESTRATION block for orchestrations that write their own worker prompts.

## Pre-launch evaluation rubric

Score each dimension 0 (absent), 1 (present but gameable), or 2 (adversary-proof). Fix every 0 and 1 before launch; expensive runs deserve a passing brief.

| # | Dimension | 2 means |
| --- | --- | --- |
| 1 | Success predicate | An adversarial reader can decide unambiguously whether an artifact satisfies it; quantifiers and scope explicit |
| 2 | Definitions | Every load-bearing term defined, degenerate cases settled |
| 3 | Non-counting outcomes | The plausible near misses for this specific problem are excluded by name |
| 4 | Auditor checklist | Enumerated, domain-specific failure modes including the circularity analogue |
| 5 | Persistence-verification pairing | Every persistence instruction has a matching verification gate |
| 6 | Return condition | A predicate over the artifact; fallback scoped to external budget exhaustion only |
| 7 | Diversity policy (parallel) | Early independence, idea-keyed registry, blocked-route rules, late cross-pollination |
| 8 | Reporting contract | Concrete artifacts required; claims must trace to session evidence |
| 9 | Contamination guards | Retrieval scope stated wherever result independence matters |
| 10 | Harness separation | No hard constraint lives only in the prompt; budgets and permissions enforced outside |

Final red-team pass: give the brief to a fresh model instance with the single question "How could an agent satisfy the letter of this brief without solving the problem?" Patch every credible answer. Repeat until the answers stop being credible.
