import type { Migration } from './types.ts';

export const v138: Migration = {
  version: 138,
  name: 'timeline_dedup_md5_summary',
  // #3737 — idx_timeline_dedup keyed the RAW summary, so any incompressible
  // summary over the btree v4 row cap ("index row size N exceeds btree
  // version 4 maximum 2704") aborted the whole timeline insert — long
  // transcript-derived summaries broke timeline writes brain-wide. Re-key
  // the dedup tuple on md5(summary): fixed 32-char datum, same dedup
  // semantics (md5-equal ⟺ summary-equal modulo negligible collisions).
  // Both insert sites infer ON CONFLICT (page_id, date, md5(summary),
  // source) against this expression index. Existing rows were unique on
  // the raw tuple, so the md5 tuple is unique too — no pre-dedupe needed.
  // The #2038 shape self-heal (timeline-dedup-repair.ts) expects the SAME
  // md5 shape, so it converges drifted brains instead of reverting this.
  idempotent: true,
  sql: `
      DROP INDEX IF EXISTS idx_timeline_dedup;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup
        ON timeline_entries(page_id, date, md5(summary), source);
    `,
};
