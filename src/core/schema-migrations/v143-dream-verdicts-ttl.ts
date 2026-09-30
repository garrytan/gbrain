import type { Migration } from './types.ts';

export const v143: Migration = {
  // Train port: renumbered 138 -> 142 -> 143 (wave-k pass 1 appended
  // v138-v141 on the branch, then master consumed v142 for the
  // takes-embedding resize above; LATEST_VERSION is Math.max so only the
  // duplicate id needed fixing). Guarded DDL below is idempotent, so a
  // brain that ran the branch's v142 spelling records v143 as a no-op.
  version: 143,
  name: 'dream_verdicts_ttl',
  // #4069 (reimplemented): 30-day TTL on the significance-verdict cache.
  // `triage_version`/`model` (v129) already invalidate rows semantically,
  // but nothing ever DELETED rows — verdicts for deleted or re-hashed
  // transcripts lived forever. Reads treat expired rows as misses (so
  // long-lived transcripts re-judge at a 30-day cadence, refreshing the
  // TTL) and runPhaseSynthesize sweeps expired rows best-effort. Backfill
  // derives expiry from judged_at so pre-TTL rows keep their original age
  // instead of gaining a fresh 30 days. The interval literal mirrors
  // DREAM_VERDICT_TTL_SECONDS (engine.ts) and the schema.sql default.
  idempotent: true,
  // Statement order matters (#4657 adversarial review): SET DEFAULT runs
  // BEFORE the backfill so a concurrent pre-v143 writer (e.g. an old
  // autopilot daemon judging transcripts mid-upgrade) inserts rows that
  // pick up the default instead of NULL — otherwise a NULL landing between
  // the backfill UPDATE and SET NOT NULL fails the migration on every
  // retry for as long as the legacy writer keeps writing. Safe to edit:
  // the ledger records no SQL checksum, recorded brains never re-run v143,
  // and the reordered form is idempotent for everyone else.
  sql: `
      ALTER TABLE dream_verdicts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
      ALTER TABLE dream_verdicts
        ALTER COLUMN expires_at SET DEFAULT (now() + interval '30 days');
      UPDATE dream_verdicts
        SET expires_at = judged_at + interval '30 days'
        WHERE expires_at IS NULL;
      ALTER TABLE dream_verdicts
        ALTER COLUMN expires_at SET NOT NULL;
      CREATE INDEX IF NOT EXISTS dream_verdicts_expires_idx
        ON dream_verdicts (expires_at);
    `,
};
