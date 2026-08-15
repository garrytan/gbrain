# ADR-004: Closed claim lifecycle

- Status: Accepted
- Date: 2026-08-04

## Context

Implicit status changes make imported, contradicted, or retracted assertions appear trustworthy.

## Decision

Claims use a closed status set and an explicit adjacency map. New claims begin in `draft`,
`quarantined`, or `needs_review`; trusted status is reached only through verification. Rejected,
superseded, and retracted states remain visible. Every accepted change produces an append-only
lifecycle event with actor, reason, scope, and payload hash.

Legacy imports are quarantined from trusted states until evaluated under a current policy.

## Consequences

- Unlisted and self-transitions fail with `invalid_transition`.
- Retraction does not delete provenance.
- Projection code must apply transitions atomically with its event cursor.
