# ADR-006: LLM judges are advisory

- Status: Accepted
- Date: 2026-08-04

## Context

Model-based review can detect semantic issues but is non-deterministic and can share failure modes
with the content it evaluates.

## Decision

An LLM judge is a typed verification run that records provider-neutral model identity, prompt and
response hashes, and findings. It may request human review or block release. It cannot, by itself,
move a claim into a trusted state or release an answer. The v1 policy encodes `can_release: false`.

## Consequences

- Model review remains attributable and replayable where provider access permits.
- Deterministic and human gates retain authority.
- Missing invocation metadata invalidates the verification record.
