# Issue Tracker

This repo uses GitHub Issues as the iTradeAIMS issue tracker.

Repository:

```text
immy2good/gbrain
```

Use this tracker for gbrain fork maintenance, upstream-merge tracking, Fly deploy, semantic memory engine, source-graph, and agent-workflow issues owned by the gbrain repo.

## Publishing Rules

- Publish issues in dependency order.
- Do not close, edit, or relabel parent issues unless the owner explicitly asks.
- Use tracer-bullet vertical slices: each issue should be independently verifiable.
- Apply exactly one workflow-state label from `docs/agents/triage-labels.md`.
- Apply type/topic labels only when useful.
- Do not mark an issue `ready-for-agent` unless the owner approved that slice as AFK-ready.
- Do not use issues to claim production brain state, live recall accuracy, Fly deploy health, or upstream merge readiness unless the evidence exists and is cited.

## Issue Body Shape

Use this body shape for generated implementation issues:

```markdown
## Parent

<Parent issue or spec reference, if any>

## What to build

<Concise vertical-slice description.>

## Acceptance criteria

- [ ] <Criterion>
- [ ] <Criterion>
- [ ] <Criterion>

## Blocked by

<Issue references, or "None - can start immediately">
```

## Parent References

When slicing from a repo document rather than an existing GitHub issue, cite the source doc path and commit if known.

Example:

```text
docs/adr/0037-gbrain-maintained-fork-reintegration.md
```
