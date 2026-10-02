import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v041: Migration = {
  version: 41,
  name: 'pages_recency_columns',
  sql: '',
  // v0.29.1 — Salience-and-Recency, additive opt-in.
  //
  // Four new pages columns (all nullable, additive only, no behavior change
  // in the default search path; only consulted when a caller opts into
  // `salience='on'` / `recency='on'` or the new `since`/`until` filter):
  //
  //   effective_date         — content date (event_date / date / published /
  //                            filename-date / fallback). Read by the new
  //                            recency boost and date-filter paths only.
  //                            Auto-link doesn't touch it (immune to
  //                            updated_at churn).
  //   effective_date_source  — sentinel for the doctor's effective_date_health
  //                            check ('event_date' | 'date' | 'published' |
  //                            'filename' | 'fallback'). The 'fallback' value
  //                            is what surfaces "page that fell back to
  //                            updated_at when frontmatter was unparseable".
  //   import_filename        — basename without extension, captured at import.
  //                            computeEffectiveDate uses it for filename-date
  //                            precedence (daily/, meetings/ prefixes). Older
  //                            rows leave it NULL; backfill falls through.
  //   salience_touched_at    — bumped by recompute_emotional_weight when
  //                            emotional_weight changes. Salience window
  //                            uses GREATEST(updated_at, salience_touched_at)
  //                            so newly-salient old pages enter the recent
  //                            salience query.
  //
  // Plus an expression index used by since/until filters that read
  // COALESCE(effective_date, updated_at). Partial-index claim from earlier
  // plan iterations was wrong (codex pass-2 #15) — the planner won't use a
  // partial index for the negative side of a COALESCE; expression index does.
  //
  // CONCURRENTLY + pre-drop guard (mirror of v34) on Postgres; plain CREATE
  // INDEX on PGLite via the handler branching on engine.kind.
  handler: async (engine) => {
    // 1. ADD COLUMN x4. ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent.
    //    No defaults, all nullable, all metadata-only on PG 11+ and PGLite.
    await engine.runMigration(38, `
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS effective_date        TIMESTAMPTZ;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS effective_date_source TEXT;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS import_filename       TEXT;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS salience_touched_at   TIMESTAMPTZ;
      `);

    // 2. Expression index for since/until date-range filters.
    if (engine.kind === 'postgres') {
      await dropInvalidConcurrentIndex(engine, 38, 'pages_coalesce_date_idx');
      await engine.runMigration(38, `
          CREATE INDEX CONCURRENTLY IF NOT EXISTS pages_coalesce_date_idx
            ON pages ((COALESCE(effective_date, updated_at)));
        `);
    } else {
      await engine.runMigration(38, `
          CREATE INDEX IF NOT EXISTS pages_coalesce_date_idx
            ON pages ((COALESCE(effective_date, updated_at)));
        `);
    }
  },
  // CONCURRENTLY on Postgres requires no surrounding transaction.
  transaction: false,
};
