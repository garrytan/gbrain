import type { Migration } from './types.ts';

export const v114: Migration = {
  version: 114,
  name: 'links_link_source_check_kebab_regex',
  // Issue #1941: open link_source from a closed allowlist to a kebab-case
  // format gate so external derivers (e.g. 'citation-graph') stamp their own
  // provenance without a per-deriver gbrain migration. Format: lowercase
  // kebab `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` (rejects UPPER, leading digit/dash,
  // trailing/double dash, underscore, space) + char_length <= 64 cap on the
  // indexed free-text column. The five prior built-ins all satisfy the regex,
  // so existing rows pass `VALIDATE` and the constraint swap never fails.
  //
  // DELIBERATELY diverges from the v95/v113 plain DROP+ADD pattern: on real
  // Postgres a plain `ADD CONSTRAINT ... CHECK` takes ACCESS EXCLUSIVE + a
  // full-table validation scan, which can stall writes on a large `links`
  // table. The postgres branch instead does `ADD ... NOT VALID` (instant,
  // no scan) then `VALIDATE CONSTRAINT` (scans under SHARE UPDATE EXCLUSIVE,
  // does not block reads/writes). That two-phase form requires running
  // OUTSIDE a transaction → `transaction: false`. PGLite (single-writer WASM,
  // no lock concern) keeps the plain one-shot DROP+ADD, and is the branch the
  // schema-version hash reads (pglite-engine.ts).
  //
  // Idempotent via DROP ... IF EXISTS; no-ops on installs that never created
  // the constraint and safe to re-run.
  idempotent: true,
  transaction: false,
  sql: '', // engine-specific via sqlFor (postgres two-phase vs pglite one-shot)
  sqlFor: {
    postgres: `
        ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_source_check;
        ALTER TABLE links ADD CONSTRAINT links_link_source_check
          CHECK (link_source IS NULL OR (link_source ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(link_source) <= 64)) NOT VALID;
        ALTER TABLE links VALIDATE CONSTRAINT links_link_source_check;
      `,
    pglite: `
        ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_source_check;
        ALTER TABLE links ADD CONSTRAINT links_link_source_check
          CHECK (link_source IS NULL OR (link_source ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(link_source) <= 64));
      `,
  },
};
