import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); the fresh-install
// copy in src/schema.sql carries the same table.
export const v246: Migration = {
  version: 246,
  name: 'page_embedding_budget',
  // Large pages (above pages.inline_max_bytes): the durable per-page embedding
  // spend ledger behind embed.max_usd_per_page (page-embedding-budget.ts).
  // `held` pages wait for the user's approval (the oversized-page upgrade
  // backfill, a sampled junk hit); `capped` pages reached their cap and stay
  // partially embedded until it rises. Spend counts per embedding signature.
  // DDL only: a new table, nothing to backfill.
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS page_embedding_budget (
      page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'held', 'capped')),
      reason TEXT,
      embedding_signature TEXT,
      spent_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
      reserved_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
      reserved_at TIMESTAMPTZ,
      unpriced_calls INTEGER NOT NULL DEFAULT 0 CHECK (unpriced_calls >= 0),
      cap_usd DOUBLE PRECISION CHECK (cap_usd IS NULL OR cap_usd >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS page_embedding_budget_state_idx ON page_embedding_budget (state) WHERE state <> 'open';
  `,
};
