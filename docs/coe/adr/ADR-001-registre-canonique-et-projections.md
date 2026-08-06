# ADR-001: Canonical registry and projections

- Status: Accepted
- Date: 2026-08-04

## Context

CoE records need immutable provenance while gbrain needs efficient transactional and retrieval
views. Treating both stores as authoritative would make divergence resolution ambiguous.

## Decision

The canonical registry is an immutable, content-addressed artifact registry behind a filesystem
or object-storage abstraction. PostgreSQL and PGLite contain rebuildable projections and indexes;
they are not the authority for CoE identity or history.

Canonical artifacts are written before projection events become visible. A projection records the
canonical identifier and integrity hash. Reconciliation compares those values and rebuilds or
quarantines a projection rather than rewriting canonical history.

## Consequences

- Backup and retention policy must cover canonical artifacts and append-only events.
- Projection loss is recoverable from canonical records.
- Canonical loss is not recoverable from a projection alone.
- Phase 1 defines this boundary but implements no registry or projection storage.
