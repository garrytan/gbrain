# CoE Lite migration constraints

Phase 1 introduces no DDL, data migration, backfill, dual write, or projection cursor. The files in
`schemas/coe/v1` are contract artifacts, not database schemas. Phases 2 and 3 add migrations 67 and
68 for rebuildable snapshot and evidence projections; the content-addressed filesystem remains the
system of record.

All storage work must satisfy these constraints:

- canonical artifacts are backed up before any projection or backfill mutation;
- PostgreSQL and PGLite changes are additive until parity and rollback tests pass;
- projectors reject unsupported schema versions, integrity mismatches, cursor gaps, and scope
  widening before writing derived state;
- a backfill is idempotent and restartable from an explicit event cursor;
- rollback removes or abandons only derived projections and never rewrites canonical history;
- legacy records enter as `imported_legacy` in `quarantined` or `needs_review`, not as verified;
- hard deletion requires a separate retention/erasure design and approval.

Migration 68 adds `coe_normalized_documents`, `coe_document_sections`,
`coe_normalized_mappings`, and `coe_evidence_items`. Its foreign keys use `ON DELETE RESTRICT`, its
projector validates a complete canonical bundle before opening a transaction, and PostgreSQL RLS is
enabled fail-closed when the migration role has the required privilege.

The v1 contract has no predecessor. A future v2 migration must ship a deterministic v1-to-v2
upgrader with valid, invalid, and round-trip fixtures before its reader is enabled.
