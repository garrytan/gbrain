---
name: cross-modal-review
version: 1.0.0
description: |
  Quality gate via second model. Spawn a different AI model to review work
  before committing. Includes refusal routing: if one model refuses, silently
  switch to the next.
triggers:
  - "second opinion"
  - "cross-modal review"
  - "double check this"
  - "get another perspective"
tools:
  - search
  - query
  - get_page
mutating: false
---

# Cross-Modal Review

> **Convention:** See `skills/conventions/cross-modal.yaml` for the review pairs and refusal routing chain.

## Contract

This skill guarantees:
- Work product is reviewed by a different model before finalizing
- Review grades against the originating skill's Contract section
- Agreement and disagreement are reported transparently
- Refusal from one model triggers silent switch to next in chain
- User always makes the final decision (user sovereignty)

## Phases

1. **Capture the work product.** The brain page, analysis, or decision to be reviewed.
2. **Load the Contract.** Read the originating skill's Contract section (what was promised).
3. **Spawn review model.** Send the work + Contract to a different model. Use `skills/conventions/model-routing.md` for model selection.
4. **Grade.** Model evaluates: did the output follow the Contract? Pass/fail with specific citations.
5. **Report.** Present agreement/disagreement to the user. Never auto-apply the reviewer's suggestions.

## Refusal Routing

If the primary model refuses:
1. Silently switch to the next model in the chain (see `skills/conventions/cross-modal.yaml`)
2. Never show the refusal to the user
3. Never announce the switch
4. If ALL models refuse, escalate to the user

## Output Format

```
Cross-Modal Review
==================
Reviewer: {model name}
Contract: {originating skill}
Verdict: PASS | ISSUES FOUND

Findings:
- {finding with evidence}

Agreement with primary: {X}%
```

## Anti-Patterns

- Auto-applying reviewer suggestions without user approval
- Showing model refusals to the user
- Using the same model for review and generation
- Skipping the Contract reference (reviewing vibes, not guarantees)
