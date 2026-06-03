---
name: explainer-breaker
version: 0.1.0
description: |
  Build the strongest brain-grounded explanation for an idea, thesis, plan,
  or claim, then break it by surfacing load-bearing assumptions, missing
  evidence, contradictions, stale sources, counterexamples, and a safer
  claim boundary. Use for practical explanation audits, not generic red-team
  prose.
triggers:
  - "explain and break this"
  - "idea breaker"
  - "audit this idea"
  - "stress test this thesis"
  - "load-bearing assumptions"
  - "safer claim boundary"
  - "explanation audit"
  - "strongest case against this"
tools:
  - search
  - query
  - get_page
  - get_timeline
  - traverse_graph
mutating: false
---

# explainer-breaker - Brain-Grounded Explanation Audit

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)
> for the lookup chain. This skill checks the brain before external sources
> and treats web/current-source research as an evidence-gap fill, not the
> default starting point.
>
> **Convention:** see [conventions/quality.md](../conventions/quality.md)
> for citation rules. Every substantive support, contradiction, or gap must
> point to the brain page, take row, timeline entry, trajectory, or external
> source that produced it.

## What this is

explainer-breaker is a thinking skill for claims that need rigor before
they become plans, memos, bets, public statements, or decisions. It runs
two passes in order:

1. **Explainer:** build the strongest version of the idea from the brain.
2. **Breaker:** identify exactly what would make that explanation fail.

The output is an explanation audit: a practical map of support, uncertainty,
contradictions, and a safer claim boundary. The goal is not to dunk on the
idea. The goal is to keep strong ideas strong by finding the parts that are
not yet earned.

## When to use this

- "Explain and break this thesis before I write it up."
- "What are the load-bearing assumptions in this plan?"
- "Audit this idea against my brain."
- "Build the strongest case, then tell me what evidence would change it."
- "Where is the safer claim boundary?"
- "What is the strongest case against this?"

Use `query` for ordinary lookups, `concept-synthesis` for corpus-wide concept
maps, `academic-verify` for citation-level research verification, and
`perplexity-research` for open-ended current-state web deltas. This skill may
chain to those workflows, but its product is the audit shape.

## Contract

This skill guarantees:

- The user's exact claim, thesis, idea, or plan is preserved before any
  reframing.
- The strongest explanation is built before the breakage pass.
- Brain evidence is gathered first through `search`, `query`, `get_page`,
  `get_timeline`, or graph traversal.
- Evidence layers are labeled separately: compiled truth, timeline, facts,
  takes, trajectory, contradiction findings, and external sources are not
  collapsed into one truth bucket.
- Conflicting sources are surfaced with both sides cited.
- Missing evidence is named as missing evidence, not converted into a verdict.
- The final answer includes a safer claim boundary: what can be said, what
  cannot be said yet, and what evidence would update the boundary.
- No brain pages, takes, facts, contradiction resolutions, or schema are
  written by this skill.

## Phases

### Phase 1: Pin the Claim

Restate the user's claim verbatim in a short `Claim under audit` field.
Then identify:

- **Claim type:** idea, thesis, plan, prediction, explanation, public claim,
  decision rationale, or ambiguous.
- **Scope:** what the claim is about, who or what it applies to, and the
  time window if one is implied.
- **Operational version:** the strongest checkable version of the claim,
  without adding facts the user did not assert.

If the input is too vague to audit, convert it into 2-4 candidate checkable
claims and audit the most central one. Say that the boundary is weak because
the original claim is underspecified.

### Phase 2: Gather Brain Evidence

Use the brain-first lookup chain:

1. `gbrain search` / search for exact terms, entities, dates, and distinctive
   phrases from the claim.
2. `gbrain query` / query for semantic neighbors and related ideas.
3. `gbrain get <slug>` / get_page for the top pages whose excerpts matter.
4. `get_timeline` or graph traversal when the claim depends on chronology,
   relationships, or entity history.

Gather no more than the evidence needed to make the audit useful. Prefer
high-signal pages and exact cited takes over broad dumps.

### Phase 3: Build the Strongest Explanation

Write the best version of the explanation using only evidence you can cite.
This section should be charitable and concrete:

- Name the mechanism or causal story.
- Identify the best supporting pages, takes, facts, timeline entries, or
  trajectories.
- Mark evidence strength: strong, partial, weak, stale, or missing.
- State where the explanation is an inference rather than a stored fact.

If the brain has little support, say so plainly and build only a minimal
explanation from the available evidence.

### Phase 4: Break the Explanation

Run the breaker checklist. Include only items that materially affect the
claim.

| Breaker | What to look for |
|---------|------------------|
| Load-bearing assumptions | Premises that must hold for the explanation to work |
| Missing evidence | Data the brain does not have, or evidence the sources do not provide |
| Contradictions | Takes, facts, pages, or trajectory points that conflict or supersede |
| Counterexamples | Cases in the brain or public evidence where the mechanism fails |
| Stale sources | Evidence whose date, validity window, or currentness is load-bearing |
| Ambiguous terms | Words whose meaning changes the answer |
| Unfalsifiable parts | Claims that cannot yet be checked against an outcome |
| Alternative explanations | Simpler or better-supported stories that fit the same evidence |

For contradictions, preserve the temporal distinction:

- `contradiction`: claims conflict in the same time window.
- `temporal_supersession`: newer evidence replaces older evidence.
- `temporal_evolution`: both were true at different times.
- `temporal_regression`: a metric or status moved backward.
- `negation_artifact`: one side is an explicit negation or parsing artifact.

Do not resolve these automatically. Report what the audit sees and what a
human would need to inspect.

### Phase 5: Set the Safer Claim Boundary

End with the boundary:

- **Can say:** the strongest claim supported by current evidence.
- **Cannot say yet:** claims that would overreach the evidence.
- **Would update if:** evidence that would strengthen, weaken, or flip the
  claim.
- **Next evidence:** 3-7 concrete checks, searches, source requests, or
  measurements.

Keep the boundary practical. "Do more research" is not a useful next step;
"find a dated revenue update after the quoted meeting" is.

## Evidence Layer Rules

Keep these layers distinct:

- **Compiled truth:** synthesized brain understanding. Stronger than raw
  snippets, but still cite the page and underlying sources when available.
- **Timeline:** dated evidence. Use it for evolution and staleness.
- **Facts:** hot personal memory from the brain owner. Do not treat facts as
  other people's attributed beliefs.
- **Takes:** attributed epistemic claims. A take can be a belief, prediction,
  hunch, or claimed fact. It is not automatically world truth.
- **Trajectory:** chronological typed claims or events. Use for regressions,
  changes, and supersession.
- **Contradiction findings:** probe output. Treat as evidence for review, not
  as a mutation instruction.
- **External sources:** lowest precedence unless the question is about
  current public state or academic/source verification.

## Output Format

```markdown
## Claim Under Audit

> [Exact user claim]

Operational version: [checkable version]

## Strongest Explanation

[Best brain-grounded explanation with citations. Mark inferences clearly.]

## Evidence Map

| Layer | Support | Limits |
|-------|---------|--------|
| Compiled truth | [cited support] | [gap/staleness] |
| Facts | [cited support] | [gap/staleness] |
| Takes | [cited support] | [conflict/holder/weight] |
| Timeline / trajectory | [dated support] | [missing dates/regressions] |
| External sources | [only if used] | [citation/currentness limits] |

## Breakers

1. **[Breaker name]** - why it matters, what evidence supports it, and what
   would resolve it.

## Safer Claim Boundary

Can say:
- [Supported claim]

Cannot say yet:
- [Unsupported overreach]

Would update if:
- [Evidence that changes the boundary]

Next evidence:
- [Concrete check]
```

Omit empty rows, but never omit a material gap. When evidence is thin, the
answer should feel thinner, not more confident.

## Quality Bar

- The explanation should be stronger than the user's first draft.
- The breakage pass should name specific assumptions and evidence gaps, not
  generic objections.
- The safer boundary should be directly reusable in a memo or decision note.
- Every substantive support or conflict should cite a brain slug, take row,
  timeline entry, trajectory block, or external source.
- The answer should distinguish "unsupported", "contradicted", "stale", and
  "not yet checked".

## Anti-Patterns

- Starting with objections before building the strongest explanation.
- Producing generic red-team prose with no cited evidence.
- Treating takes as world facts or facts as attributed takes.
- Silently resolving contradictions or temporal supersession.
- Calling something false when the real issue is missing evidence.
- Using external search before checking the brain.
- Writing or updating pages, takes, facts, schemas, or contradiction
  resolutions from the audit.
- Collapsing a safer claim boundary into a vague "needs more research."

## Related skills

- `skills/query/SKILL.md` - brain-grounded answers with citations and gaps.
- `skills/concept-synthesis/SKILL.md` - corpus-wide idea evolution and
  counter-positions.
- `skills/academic-verify/SKILL.md` - citation-level verification for
  academic or research claims.
- `skills/perplexity-research/SKILL.md` - current-source web deltas after
  brain context is gathered.
- `skills/cross-modal-review/SKILL.md` - second-opinion quality review of
  a completed artifact.
