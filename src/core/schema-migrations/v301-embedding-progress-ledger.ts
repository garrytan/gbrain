import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); the fresh-install
// copy in src/schema.sql carries the same tables. Provisional number: the real
// one is taken at the merge slot.
//
// Wave C 1F (embedding at scale, src/core/embedding-ledger.ts):
// - page_embedding_progress: one derived row per segmented page, the embed-page
//   job's cursor (newest first by chunk_index, or document order by manifest
//   seq and local ordinal), counts, spend and state. Deleting it costs one
//   rescan, never money: a NULL vector is the truth for what is left.
// - embedding_batches: each provider call's identity and row set (chunk index,
//   text md5, recorded input hashes), written before the call; the returned
//   vectors are stored on it before the install, and the install deletes it,
//   so a crash between the response and the install replays the install from
//   the stored vectors. A batch whose call never answered is `uncertain`.
// - embedding_spend: the 24-hour spend ledger per source, one row per batch
//   (`reserved` before the call, `settled` once answered, `uncertain` when
//   the caller died during the call, `released` when the provider refused).
// - page_embedding_budget.approval_id: the approval that last raised the
//   page's cap (an embed job's identity), so a retried job raises it once.
// No page text is stored (a returned batch holds vectors until its install
// deletes it; a page delete cascades). DDL only, nothing to backfill.
export const v301: Migration = {
  version: 301,
  name: 'embedding_progress_ledger',
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS page_embedding_progress (
      page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
      generation BIGINT NOT NULL,
      embed_order TEXT NOT NULL CHECK (embed_order IN ('newest','document')),
      cursor_seq INTEGER,
      cursor_ordinal INTEGER,
      cursor_chunk_index INTEGER,
      embedded_rows BIGINT NOT NULL DEFAULT 0 CHECK (embedded_rows >= 0),
      live_rows BIGINT NOT NULL DEFAULT 0 CHECK (live_rows >= 0),
      spent_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
      state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','complete','capped','held','source_capped','uncertain','busy')),
      junk_generation BIGINT,
      next_run_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS embedding_batches (
      batch_id TEXT PRIMARY KEY,
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      generation BIGINT NOT NULL,
      column_name TEXT NOT NULL,
      signature TEXT,
      context TEXT NOT NULL,
      rows JSONB NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('calling','returned','uncertain')),
      usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (usd >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS embedding_batches_page ON embedding_batches (page_id, state);
    CREATE TABLE IF NOT EXISTS embedding_spend (
      batch_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      page_id INTEGER,
      kind TEXT NOT NULL CHECK (kind IN ('page','tail','job')),
      usd DOUBLE PRECISION NOT NULL CHECK (usd >= 0),
      state TEXT NOT NULL CHECK (state IN ('reserved','settled','uncertain','released')),
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS embedding_spend_window ON embedding_spend (source_id, at);
    CREATE INDEX IF NOT EXISTS embedding_spend_page ON embedding_spend (page_id, at) WHERE kind = 'tail';
    ALTER TABLE page_embedding_budget ADD COLUMN IF NOT EXISTS approval_id TEXT;
  `,
};
