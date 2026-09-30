import type { Migration } from './types.ts';

export const v081: Migration = {
  version: 81,
  name: 'pages_provenance_columns',
  // v0.38 ingestion cathedral (eng review E4):
  // Adds four nullable provenance columns to `pages` so every ingested
  // page carries a record of WHERE it came from. The columns are
  // populated by the ingest_capture Minion handler (via the put_page
  // write-through path landing in a sibling commit). NULL is the
  // historical-page default — pre-v0.38 pages never had provenance.
  //
  //   - ingested_via    TEXT  — source kind taxonomy
  //                             (file-watcher | inbox-folder | webhook |
  //                              cron-scheduler | capture-cli |
  //                              <skillpack-kind>)
  //   - ingested_at     TIMESTAMPTZ — UTC time the ingestion daemon
  //                                   accepted the event
  //   - source_uri      TEXT  — original URI/path/message-id the event
  //                             carried (file path, mail message-id, URL)
  //   - source_kind     TEXT  — duplicates ingested_via for indexed
  //                             filtering convenience (one column for
  //                             "type of source", one for richer label
  //                             — kept narrow + indexable separately)
  //
  // ADD COLUMN with NULL default is metadata-only on Postgres 11+ and
  // PGLite 17.5 — instant on tables of any size.
  //
  // No index: provenance queries are admin-surface only.
  //
  // Forward-reference bootstrap: every brain that upgrades through this
  // version needs the columns visible to the embedded SCHEMA_SQL replay
  // BEFORE migrations run. applyForwardReferenceBootstrap on both
  // engines covers this; REQUIRED_BOOTSTRAP_COVERAGE pins the contract.
  //
  // Renumbered v80→v81 during master merge with v0.37.2.0's
  // takes_unresolvable_quality hotfix.
  idempotent: true,
  sql: `
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS ingested_via TEXT NULL;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ NULL;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_uri TEXT NULL;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_kind TEXT NULL;
    `,
};
