import type { Migration } from './types.ts';

export const v137: Migration = {
  version: 137,
  name: 'entity_identities',
  // #4224 — cross-source entity identity groups (federation v1).
  //
  // The identity KEY for a page is (source_id, slug): the same real-world
  // entity can exist as `people/alice` in the `wiki` source AND
  // `people/alice-chen` in a mounted team source, and NOTHING today says
  // they are the same entity. This table groups member pages (by page_id,
  // resolved from (source_id, slug) at link time) under an opaque
  // `entity_id` handle.
  //
  // v1 is MANUAL-ONLY: rows are created exclusively by the
  // entity_identity_link op (localOnly write) — no auto-matching, no
  // similarity heuristics. `established_by` records the linking actor
  // ('manual' for v1; a future auto-matcher would stamp its own tag and
  // a sub-1.0 confidence).
  //
  // Shape invariants:
  //   - UNIQUE (source_id, page_id): a page belongs to at most ONE
  //     identity group (re-linking moves it — explicit manual intent).
  //   - At most one canonical member per identity (partial unique index):
  //     the canonical member is the identity's display/primary page.
  //   - page_id FK ON DELETE CASCADE: deleting a page dissolves its
  //     membership, never dangles.
  //
  // Consumed by src/core/entity-identity.ts (helpers + the flag-gated
  // retrieval union) and the entity_identity_* ops. Same DDL on both
  // engines via this shared migration.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS entity_identities (
        id             BIGSERIAL PRIMARY KEY,
        entity_id      TEXT NOT NULL,
        source_id      TEXT NOT NULL,
        page_id        INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        confidence     DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        established_by TEXT NOT NULL DEFAULT 'manual',
        established_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        canonical      BOOLEAN NOT NULL DEFAULT false,
        CONSTRAINT entity_identities_page_uniq UNIQUE (source_id, page_id)
      );
      CREATE INDEX IF NOT EXISTS entity_identities_entity_idx
        ON entity_identities (entity_id);
      CREATE UNIQUE INDEX IF NOT EXISTS entity_identities_canonical_uniq
        ON entity_identities (entity_id) WHERE canonical;
    `,
};
