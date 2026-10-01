import type { Migration } from './types.ts';

export const v168: Migration = {
  // The only record that a transcript was synthesized was its completed
  // subagent job row, which `jobs prune` deletes after 30 days; the next
  // cycle then paid to synthesize it again. Prune archives the keys here.
  version: 168,
  name: 'dream_synthesis_completions',
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS dream_synthesis_completions (
        source_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (source_id, idempotency_key)
      );
    `,
};
