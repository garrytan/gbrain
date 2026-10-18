import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Large pages (Wave A read contract): each prose chunk records where it sits in
// the projected text it was cut from, so `get_page { around_chunk_id }` and
// evidence delivery center a window on the exact chunk instead of searching
// the page for its text (which mis-anchors repeated conversation lines).
//
// Coordinates: UTF-8 byte offsets, end exclusive, into the chunk_source's
// projected text, credentialSafeProjection(sanitizeRemoteBody(<fence-overlaid
// compiled_truth or timeline>)), the same text the chunker cuts from and every
// windowed read is a slice of (src/core/page-window/document.ts). Not the
// raw stored column: the projection drops protected fences, so raw offsets
// would point a window into private text. Not start_line/end_line: those carry
// code-chunk line numbers inside a fence, and a line range cannot address a
// chunk that starts mid-line (word and character splits).
//
// NULL for code, image and low-tier fence chunks and for chunks written before
// this migration; readers fall back to locating the chunk text, and verify a
// stored span against the chunk text before trusting it (a span recorded for
// an older body can be stale). BIGINT: Wave B pages pass 2^31 bytes.
// Not in schema.sql's CREATE TABLE: added on every install, after the
// migration-added content_chunks columns, so fresh and upgraded brains share
// column ordinals (the v180 / v221 pattern). Metadata-only ADD COLUMNs; nothing
// to backfill.
export const v244: Migration = {
  version: 244,
  name: 'chunk_projected_spans',
  idempotent: true,
  sql: `
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS projected_byte_start BIGINT;
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS projected_byte_end BIGINT;
  `,
};
