import type { Migration } from './types.ts';

export const v093: Migration = {
  version: 93,
  name: 'minions_v0_41_audit_and_budget',
  // v0.41 minions cathedral — three audit tables + three new columns on
  // minion_jobs. Single migration because the audit tables and budget
  // columns are jointly designed and consumed:
  //
  //   - minion_lease_pressure_log     ← Bug 2 (releaseLeaseFullJob writes here)
  //   - minion_budget_log             ← D5 (reservation / refund / halt / lost events)
  //   - minion_self_fix_log           ← E6 (classifier-gated auto-resubmit chain)
  //   - minion_jobs.budget_remaining_cents  ← D5 (parent spendable balance)
  //   - minion_jobs.budget_owner_job_id     ← Eng D7 (immutable budget owner; FK SET NULL)
  //   - minion_jobs.budget_root_owner_id    ← Eng D10 (denormalized historical
  //     owner, NO FK — persists past owner deletion so children can
  //     disambiguate "never had a budget" from "owner deleted, halt cleanly").
  //
  // Audit table FKs are ON DELETE SET NULL (codex pass-2 #5) so audit rows
  // survive `gbrain jobs prune`. Each audit table denormalizes context
  // (queue_name, model, owner_id, event_type, etc.) at write time so
  // post-NULL rows still carry forensic value — without denormalization
  // they'd be timestamp-only residue (codex pass-3 #7).
  //
  // The retention sweep that bounds audit-table growth (Eng D8) lives in
  // the autopilot cycle's `purge` phase, not here. This migration just
  // creates the schema; the sweep ships in the same wave but is its own
  // code path.
  sql: `
      CREATE TABLE IF NOT EXISTS minion_lease_pressure_log (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT NULL REFERENCES minion_jobs(id) ON DELETE SET NULL,
        lease_key TEXT NOT NULL,
        active_at_bounce INTEGER NOT NULL,
        max_concurrent INTEGER NOT NULL,
        bounced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        queue_name TEXT NULL,
        job_name TEXT NULL,
        model TEXT NULL,
        provider TEXT NULL,
        root_owner_id BIGINT NULL
      );
      CREATE INDEX IF NOT EXISTS minion_lease_pressure_log_recent_idx
        ON minion_lease_pressure_log (bounced_at DESC);
      CREATE INDEX IF NOT EXISTS minion_lease_pressure_log_job_idx
        ON minion_lease_pressure_log (job_id);

      CREATE TABLE IF NOT EXISTS minion_budget_log (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT NULL REFERENCES minion_jobs(id) ON DELETE SET NULL,
        owner_id BIGINT NULL,
        event_type TEXT NOT NULL,
        cents_delta INTEGER NOT NULL,
        turn_index INTEGER NULL,
        model TEXT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS minion_budget_log_owner_idx
        ON minion_budget_log (owner_id);
      CREATE INDEX IF NOT EXISTS minion_budget_log_recent_idx
        ON minion_budget_log (occurred_at DESC);

      CREATE TABLE IF NOT EXISTS minion_self_fix_log (
        id BIGSERIAL PRIMARY KEY,
        parent_id BIGINT NULL REFERENCES minion_jobs(id) ON DELETE SET NULL,
        child_id BIGINT NULL REFERENCES minion_jobs(id) ON DELETE SET NULL,
        classifier_bucket TEXT NOT NULL,
        chain_depth INTEGER NOT NULL,
        policy_applied TEXT NULL,
        outcome TEXT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS minion_self_fix_log_parent_idx
        ON minion_self_fix_log (parent_id);
      CREATE INDEX IF NOT EXISTS minion_self_fix_log_recent_idx
        ON minion_self_fix_log (occurred_at DESC);

      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS budget_remaining_cents INTEGER NULL;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS budget_owner_job_id BIGINT NULL
        REFERENCES minion_jobs(id) ON DELETE SET NULL;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS budget_root_owner_id BIGINT NULL;
      CREATE INDEX IF NOT EXISTS minion_jobs_budget_owner_idx
        ON minion_jobs (budget_owner_job_id)
        WHERE budget_owner_job_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS minion_jobs_budget_root_owner_idx
        ON minion_jobs (budget_root_owner_id)
        WHERE budget_root_owner_id IS NOT NULL;
    `,
};
