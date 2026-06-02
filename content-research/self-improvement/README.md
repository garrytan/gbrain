# Self-Improvement

## Purpose

This directory captures **agent self-improvement notes** — a feedback loop that makes the content research system smarter over time. Agents analyze their own performance, compare predictions to outcomes, and log learnings that refine future behavior.

## What Data Lives Here

- `log.md` — The master self-improvement log
- Entries include:
  - Prediction accuracy (did scored ideas perform as expected?)
  - Scoring calibration (are composite scores correlating with real outcomes?)
  - Process improvements (what slowed agents down? what could be automated?)
  - Schema change proposals (should SCHEMA.md fields be added, removed, or modified?)

## Log Entry Format

```markdown
## YYYY-MM-DD — <Entry Title>

**Type:** calibration | process | schema-change | finding
**Agent:** <agent-name or id>

### What Happened
Brief description of the observation or event.

### Analysis
Why it happened and what it means.

### Proposed Action
Specific change to make (update scoring, modify schema, adjust workflow, etc.)

### Status: pending | applied | rejected
```

## How Agents Use This Directory

- **Self-improvement agents** write entries after analyzing published content performance
- **All agents** read recent entries before starting work to incorporate latest learnings
- **Schema agents** propose changes to `../SCHEMA.md` based on accumulated findings
- **Calibration agents** use log data to adjust scoring weights over time

## Principles

1. **Be specific** — vague observations don't lead to actionable improvements
2. **Propose changes** — every entry should include a concrete proposed action
3. **Track outcomes** — mark entries as `applied` or `rejected` with reasoning
4. **Review regularly** — read the last 10 entries before any research session
