import type { Migration } from './types.ts';

export const v117: Migration = {
  // Renumbered 116 -> 117 at merge: master's v0.42.41.0 triage wave
  // claimed v116 (code_edges_source_backfill_and_callee_index) first.
  version: 117,
  name: 'context_volunteer_events_table',
  // #2095 push-based context: feedback-loop log of every page the brain
  // VOLUNTEERED (via the volunteer_context op, the retrieval-reflex pointer
  // path, or `gbrain watch`). "Used" is derived later by joining
  // pages.last_retrieved_at > volunteered_at — no second write path.
  // session_id/turn are caller-supplied attribution (nullable). rationale is
  // a deterministic template string, NEVER raw conversation text. Rows are
  // pruned past 90 days by the dream cycle's purge phase
  // (purgeStaleVolunteerEvents). No ::jsonb anywhere. RLS: covered by the
  // v35 auto_rls_on_create_table event trigger on Postgres (same as
  // v110/v115 tables); pinned by the volunteer-context Postgres e2e.
  // Created empty; plain CREATE INDEX is instant — no CONCURRENTLY needed.
  // Keep in sync with src/schema.sql, src/core/pglite-schema.ts,
  // src/core/schema-embedded.generated.ts.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS context_volunteer_events (
        id             BIGSERIAL PRIMARY KEY,
        source_id      TEXT NOT NULL,
        slug           TEXT NOT NULL,
        confidence     DOUBLE PRECISION NOT NULL,
        match_arm      TEXT NOT NULL,
        rationale      TEXT NOT NULL DEFAULT '',
        channel        TEXT NOT NULL DEFAULT 'op',
        session_id     TEXT,
        turn           INTEGER,
        volunteered_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS context_volunteer_events_src_time_idx
        ON context_volunteer_events (source_id, volunteered_at DESC);
      CREATE INDEX IF NOT EXISTS context_volunteer_events_src_slug_idx
        ON context_volunteer_events (source_id, slug);
    `,
};
