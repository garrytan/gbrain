import type { Migration } from './types.ts';

export const v178: Migration = {
  // Writer-version stamps: each request records the binary version and host
  // that admitted it and the ones that published it, so doctor's
  // writer_version advisory can name an older writer still on the brain.
  // Nullable and never backfilled (a past writer cannot be proven). The
  // cutoff is the database clock at migration time: only requests admitted
  // or published after it are expected to carry stamps. persistence_requests
  // and persistence_brain are migration-created on PGLite and no index
  // references these columns (bootstrap-coverage: column-only exemptions).
  version: 178,
  name: 'persistence_writer_version_stamps',
  idempotent: true,
  sql: `
      ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS admitter_version text;
      ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS admitter_host_id uuid;
      ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS consumer_version text;
      ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS consumer_host_id uuid;
      ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS published_at timestamptz;
      ALTER TABLE persistence_brain ADD COLUMN IF NOT EXISTS writer_version_cutoff timestamptz;
      UPDATE persistence_brain SET writer_version_cutoff=now() WHERE writer_version_cutoff IS NULL;
    `,
};
