# ADR-005: Typed verification runs

- Status: Accepted
- Date: 2026-08-04

## Context

Different claim types require different evidence and checks. A single opaque score cannot show
whether a numeric result was recomputed or a citation was aligned.

## Decision

Verification is an immutable, typed run that names its verifier, method, policy version, inputs,
outputs, findings, and measurements. Exact measurements are decimal strings. Policies map claim
types to required verifiers and minimum direct support.

Deterministic checks run before heuristic checks. `inconclusive` and `error` never count as a pass.

## Consequences

- Results are reproducible and auditable by verifier type.
- Release logic consumes explicit statuses and policy rules, not a generic confidence value.
- Changing verifier semantics requires a new verifier or policy version.
