# ADR-007: gbrain stores rebuildable CoE projections

- Status: Accepted
- Date: 2026-08-04

## Context

gbrain supplies search and local knowledge operations across PostgreSQL and PGLite, but CoE
canonical records require storage-independent identity.

## Decision

Each backend receives projections from versioned canonical events. A projection row carries the
canonical identifier, schema version, integrity hash, scope, lifecycle status, and event cursor.
Backend-specific search fields are derived data. Projectors are idempotent and reject cursor gaps,
hash mismatches, unsupported versions, or scope widening.

## Consequences

- PostgreSQL and PGLite parity is tested at the contract boundary.
- Search ranking changes do not rewrite canonical artifacts.
- Backfill and DDL are deferred to a later gate.
