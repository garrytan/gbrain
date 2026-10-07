import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #6199: `chronicle-backfill --max-usd` stamps each queued ledger row with its
// campaign and the spend policy in force at queue time, so every executor (the
// chronicle phase, the chronicle_extract job) runs the row under those values,
// not current settings: campaign_id, the per-attempt cap, the maximum
// attempts, the pricing policy ('enforced') and the campaign's --max-usd.
// cost_attempts lists the attempts whose spend cost_usd already includes, so a
// replayed completion never adds the same attempt twice. All nullable or
// defaulted: metadata-only, no backfill; rows without a campaign keep today's
// behavior.
export const v216: Migration = {
  version: 216,
  name: 'chronicle_campaign_stamps',
  idempotent: true,
  sql: `
    ALTER TABLE chronicle_page_state ADD COLUMN IF NOT EXISTS campaign_id TEXT;
    ALTER TABLE chronicle_page_state ADD COLUMN IF NOT EXISTS attempt_cap_usd NUMERIC;
    ALTER TABLE chronicle_page_state ADD COLUMN IF NOT EXISTS max_attempts INTEGER CHECK (max_attempts > 0);
    ALTER TABLE chronicle_page_state ADD COLUMN IF NOT EXISTS pricing_policy TEXT;
    ALTER TABLE chronicle_page_state ADD COLUMN IF NOT EXISTS campaign_max_usd NUMERIC;
    ALTER TABLE chronicle_page_state ADD COLUMN IF NOT EXISTS cost_attempts INTEGER[] NOT NULL DEFAULT '{}';
  `,
};
