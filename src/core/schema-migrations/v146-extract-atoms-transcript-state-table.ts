import type { Migration } from './types.ts';

export const v146: Migration = {
  version: 146,
  name: 'extract_atoms_transcript_state_table',
  // #4148 follow-on: extend the failure-count / tombstone machinery to
  // TRANSCRIPT items. Pre-fix `recordPageFailureCount` returned null for
  // `kind !== 'page'`, so a transcript that deterministically produced
  // malformed output — or that honestly yielded zero atoms — re-entered
  // discovery and re-spent LLM budget on EVERY cycle, forever. Pages avoid
  // this via frontmatter (`atoms_fail_count` / `atoms_fail_hash` /
  // `atoms_scan_hash`); transcripts are files, not pages, so they have no
  // frontmatter to carry it and need their own store.
  //
  // Precedent: dream_verdicts (v30), the other transcript-keyed cache, whose
  // comment already establishes why this cannot live in raw_data — "Distinct
  // from raw_data (page-scoped); transcripts aren't pages" (raw_data.page_id
  // is NOT NULL REFERENCES pages(id)). It also must NOT be columns on
  // dream_verdicts itself: that table is documented as rebuildable via
  // `gbrain dream retriage --force`, which clears it wholesale, and atom
  // extraction state would be swept away as collateral.
  //
  // KEYED (source_id, file_path, content_hash), which adds source_id to the
  // dream_verdicts shape. dream_verdicts can be source-free because it caches
  // a content-level judgment ("is this transcript worth processing"), which is
  // genuinely source-independent. A failure streak and a tombstone GATE
  // EXTRACTION, and extraction is source-scoped throughout this phase — the
  // discovery SQL, the NOT EXISTS idempotency subquery, and every putPage all
  // take sourceId. This file's own header records what happens when that is
  // forgotten here: "Pre-fix the putPage call was missing the sourceId arg —
  // atoms always wrote to 'default' regardless of source, which made the NOT
  // EXISTS guard ineffective on federated brains." An unscoped tombstone would
  // let one source permanently suppress another source's extraction of the
  // same file.
  //
  // content_hash holds the 16-char prefix, matching `atoms.frontmatter
  // ->>'source_hash'` and the page-side `atoms_fail_hash`, so every hash
  // comparison in this phase is on the same unit. Including it in the PK is
  // what makes "a content edit resets the streak" fall out for free: an edited
  // transcript is simply a different row, mirroring the page-side hash-keyed
  // reset.
  //
  // RLS: covered by the v35 auto_rls_on_create_table event trigger on
  // Postgres, same as v126's session_context_state — no explicit ALTER here.
  // Keep in sync with src/schema.sql and src/core/pglite-schema.ts
  // (test/schema-bootstrap-coverage.test.ts enforces the PGLite parity).
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS extract_atoms_transcript_state (
        source_id    TEXT        NOT NULL DEFAULT 'default',
        file_path    TEXT        NOT NULL,
        content_hash TEXT        NOT NULL,
        fail_count   INTEGER     NOT NULL DEFAULT 0,
        tombstoned   BOOLEAN     NOT NULL DEFAULT FALSE,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (source_id, file_path, content_hash)
      );
      DROP INDEX IF EXISTS extract_atoms_transcript_state_live_idx;
      CREATE INDEX IF NOT EXISTS extract_atoms_transcript_state_tombstoned_idx
        ON extract_atoms_transcript_state (source_id, content_hash)
        WHERE tombstoned;
    `,
};
