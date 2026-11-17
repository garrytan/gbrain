import type { Migration } from './types.ts';

export const v079: Migration = {
  version: 79,
  name: 'pages_last_retrieved_at',
  // v0.37.1.0 brainstorm/lsd wave (D15 + D11 + D12):
  // Originally planned as v77 but v77 + v78 were claimed by the v0.37.0.0
  // skillpack-registry + cross-modal waves landing on master first.
  //
  // Adds `pages.last_retrieved_at TIMESTAMPTZ NULL` — the real stale-page
  // signal for `gbrain lsd`'s "your brain at 3am noticing what it forgot"
  // mode. Bumped by op-layer write-back inside the `search` / `query` /
  // `get_page` op handlers AFTER results return (NOT inside the engine
  // methods — internal callers like sync / migrations / tests must not
  // pollute the signal per codex round 2 #3).
  //
  // Full index, no partial WHERE per D12 + codex round 2 #6: LSD's primary
  // query is `WHERE last_retrieved_at IS NULL OR last_retrieved_at < NOW()
  // - INTERVAL '90 days'`. Postgres B-tree indexes handle NULL (sorted to
  // one end), so one index supports both branches. A partial `WHERE NOT
  // NULL` would miss LSD's prioritized never-retrieved branch.
  //
  // ADD COLUMN with no DEFAULT (NULL) is metadata-only on Postgres 11+
  // and PGLite 17.5; instant on tables of any size.
  idempotent: true,
  sql: `
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS last_retrieved_at TIMESTAMPTZ NULL;
      CREATE INDEX IF NOT EXISTS pages_last_retrieved_at_idx
        ON pages (last_retrieved_at);
    `,
};
