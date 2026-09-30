import type { Migration } from './types.ts';
import { repairLegacyTimelineSourceRows } from '../timeline-dedup-repair.ts';
import { migrationNotice } from './helpers.ts';

export const v139: Migration = {
  version: 139,
  name: 'timeline_legacy_source_split_repair',
  // #3957 follow-up — one-time legacy-row shape repair. The pre-#3957
  // DB-path parser wrote timeline rows with source='' and the UNSPLIT
  // `Source — Summary` bullet text as summary; the parser now emits the
  // split (source, summary) shape (source='markdown' / the parsed label),
  // so the (page_id, date, md5(summary), source) dedup index can never
  // collapse a re-extraction onto a legacy row — every re-extract would
  // duplicate it. Rewrite legacy rows to the shape the next re-extract
  // will emit, content-anchored per page (see
  // timeline-dedup-repair.ts:repairLegacyTimelineSourceRows). Rows whose
  // bullet no longer exists in content are left as-is (they can't
  // duplicate); rows whose new-shape duplicate already landed are deleted.
  // Idempotent: rewritten rows no longer match source=''. Handler-only
  // (runs outside a transaction; every statement is individually safe to
  // re-run). Both engines share one SQL text via executeRaw.
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    const r = await repairLegacyTimelineSourceRows(engine);
    if (r.rowsRewritten > 0 || r.rowsDeleted > 0) {
      migrationNotice(
        `  NOTICE: v139 rewrote ${r.rowsRewritten} legacy timeline row(s) to the split ` +
        `(source, summary) shape` +
        (r.rowsDeleted > 0 ? ` and removed ${r.rowsDeleted} already-duplicated row(s)` : '') +
        ` across ${r.pagesScanned} page(s), so re-extraction dedups instead of duplicating (#3957).\n`,
      );
    }
  },
};
