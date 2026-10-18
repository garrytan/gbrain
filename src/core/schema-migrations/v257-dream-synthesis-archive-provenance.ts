import type { Migration } from './types.ts';

// Forward-only. Neither current source metadata nor completed_at can prove
// submission identity for an already pruned job: do NOT backfill old rows.
export const v257: Migration = {
  version: 257,
  name: 'dream_synthesis_archive_provenance',
  idempotent: true,
  sql: `
    ALTER TABLE dream_synthesis_completions ADD COLUMN IF NOT EXISTS job_id INTEGER;
    ALTER TABLE dream_synthesis_completions ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
    ALTER TABLE dream_synthesis_completions ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ;
    ALTER TABLE dream_synthesis_completions ADD COLUMN IF NOT EXISTS source_incarnation UUID;
  `,
  verify: async (engine) => {
    const [row] = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'dream_synthesis_completions'
          AND column_name IN ('job_id', 'submitted_at', 'source_created_at', 'source_incarnation')`,
    );
    return row?.count === '4';
  },
};
