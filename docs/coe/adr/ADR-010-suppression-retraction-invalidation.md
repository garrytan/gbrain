# ADR-010: Deletion, retraction, and invalidation preserve auditability

- Status: Accepted
- Date: 2026-08-04

## Context

Compliance deletion and epistemic retraction have different meanings. Physically deleting every
trace can also make prior releases impossible to audit.

## Decision

Retraction changes lifecycle state and records a reason while preserving the canonical record.
Invalidation propagates to dependent evidence, claims, retrieval traces, and answers through
events. Supersession preserves both versions. Authorized hard deletion removes protected content
but leaves a minimal non-content tombstone containing identifier, deletion event, time, and policy
reason when policy permits.

## Consequences

- Retracted material is never eligible for new release.
- Existing releases can be located for withdrawal or regeneration.
- Hard-deletion implementation requires a separately reviewed retention and erasure design.
