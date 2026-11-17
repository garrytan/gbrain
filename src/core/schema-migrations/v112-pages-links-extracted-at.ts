import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v112: Migration = {
  version: 112,
  name: 'pages_links_extracted_at',
  // v0.42.7 (#1696) — link-extraction freshness watermark.
  //
  // Closes the "imported ≠ curated" root cause: extraction is the silent third
  // leg of `sync → extract → embed`, and a brain with autopilot off (the common
  // CLI / external-cron case) accumulated 0% typed-edge coverage with nothing
  // surfacing it. This column lets `gbrain extract --stale` sweep the historical
  // backlog incrementally and the `links_extraction_lag` doctor check warn when
  // extraction has fallen behind.
  //
  // A page is stale for extraction when:
  //   links_extracted_at IS NULL                      (never extracted)
  //   OR links_extracted_at < LINK_EXTRACTOR_VERSION_TS (extractor logic bumped)
  //   OR updated_at > links_extracted_at              (edited since last extract —
  //                                                    MCP put_page / sync --no-extract)
  //
  // GRANDFATHER: no backfill. After this migration every existing page has NULL
  // links_extracted_at, so the first `gbrain doctor` correctly surfaces the real
  // backlog (the whole point). The doctor check is warn-only by default; it only
  // hard-fails if GBRAIN_EXTRACTION_LAG_FAIL_PCT is set — so the upgrade never
  // breaks a CI/cron pipeline that gates on `gbrain doctor` exit code.
  //
  // Composite index (source_id, links_extracted_at) backs the source-scoped
  // staleness scans. Postgres path uses CREATE INDEX CONCURRENTLY (+ invalid-
  // remnant pre-drop, mirroring v97); PGLite uses plain CREATE INDEX. ADD COLUMN
  // with no DEFAULT (NULL) is metadata-only on Postgres 11+ / PGLite 17.5.
  //
  // Mirror lives in src/schema.sql + pglite-schema.ts (fresh-install column +
  // index) and the applyForwardReferenceBootstrap probe set in both engines.
  sql: '',
  transaction: false,
  handler: async (engine) => {
    await engine.runMigration(
      112,
      `ALTER TABLE pages ADD COLUMN IF NOT EXISTS links_extracted_at TIMESTAMPTZ;`
    );
    if (engine.kind === 'postgres') {
      await dropInvalidConcurrentIndex(engine, 112, 'pages_links_extracted_at_idx');
      await engine.runMigration(
        112,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS pages_links_extracted_at_idx
             ON pages (source_id, links_extracted_at);`
      );
    } else {
      await engine.runMigration(
        112,
        `CREATE INDEX IF NOT EXISTS pages_links_extracted_at_idx
             ON pages (source_id, links_extracted_at);`
      );
    }
  },
};
