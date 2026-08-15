# ADR-008: Preserve contradictions and versions

- Status: Accepted
- Date: 2026-08-04

## Context

Sources can disagree, and newer evidence does not always make older statements false.

## Decision

Contradictions are first-class records between distinct claims. Resolution distinguishes
supersession, coexistence, source error, and claim error. Updating a claim creates a new claim and
links it with `supersedes_claim_id`; it never mutates the assertion in place.

Open or confirmed contradictions block fail-closed release when policy requires it.

## Consequences

- Consumers can inspect disagreement instead of receiving a silently chosen winner.
- Historical answers remain explainable against the versions available at release time.
- Resolution requires verification evidence and remains reversible through later events.
