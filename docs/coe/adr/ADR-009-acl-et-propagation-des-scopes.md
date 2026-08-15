# ADR-009: Access scope propagates by intersection

- Status: Accepted
- Date: 2026-08-04

## Context

Derived evidence, claims, retrieval results, and answers can combine material with different access
boundaries. Copying the broadest scope would disclose restricted material.

## Decision

Derived scope is the intersection of all parent scopes. Brain and owner remain stable; visibility
can only narrow; named-reader and source lists can only become subsets. Every record has a source
anchor, while an empty reader list grants no additional named reader. Deliberate re-ACL is not a
derivation and requires its own authorized event. Scope checks occur before projection, retrieval
selection, and release.

## Consequences

- Scope widening fails with `scope_widening`.
- A released answer inherits the narrowest evidence boundary.
- Projections carry scope fields needed to filter before ranking, not after rendering.
