import type { Migration } from './types.ts';

export const v126: Migration = {
  version: 126,
  name: 'session_context_state',
  // v0.45.7 (issue #1) ambient recall — per-session cursor + boundary-tie
  // dedup for the `delta` verb and the heartbeat runtime. Key is
  // (source_id, client_id, session_id): client_id defaults to the 'local'
  // sentinel for the CLI/hook path; REMOTE callers pass their auth client id
  // so two harnesses in one source can't stomp/read each other's cursor
  // (eng 1B). ONE key shape — no split key, no NULL branch. surfaced_slugs
  // holds the boundary set: page slugs delivered AT the cursor timestamp,
  // REPLACED on every advance (bounded by the delta fetch limit). jsonb
  // columns default to '[]'::jsonb (a DDL LITERAL default — the ::jsonb
  // param double-encode trap only bites INSERT/UPDATE binds, not DDL
  // defaults; writes bind via executeRaw + $N::text::jsonb, guarded by
  // scripts/check-jsonb-params.mjs). Created empty; plain CREATE INDEX
  // is instant — no CONCURRENTLY. RLS: covered by the v35
  // auto_rls_on_create_table event trigger on Postgres. Keep in sync with
  // src/schema.sql, src/core/pglite-schema.ts, src/core/schema-embedded.ts.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS session_context_state (
        source_id         TEXT NOT NULL,
        client_id         TEXT NOT NULL DEFAULT 'local',
        session_id        TEXT NOT NULL,
        standing_entities JSONB NOT NULL DEFAULT '[]'::jsonb,
        surfaced_slugs    JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_wake_at      TIMESTAMPTZ,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (source_id, client_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS session_context_state_updated_idx
        ON session_context_state (updated_at);
    `,
};
