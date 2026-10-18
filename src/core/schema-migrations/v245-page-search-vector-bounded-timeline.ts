import type { Migration } from './types.ts';
import { checkpointKey } from '../backfill-base.ts';
import { getFtsLanguage, PAGE_TIMELINE_FTS_MAX_CHARS, pageSearchVectorTriggerFnSql } from '../fts-language.ts';
import { backfillPageVectors } from '../search-vector-backfill.ts';
import { migrationNotice } from './helpers.ts';

const BOUNDED_TIMELINE_CHECKPOINT = 'page_vector_bounded_timeline';

// Large pages: the page keyword vector indexed the whole timeline, and a
// diverse timeline past about 1 MB overflowed the tsvector lexeme cap, which
// failed the page write. The vector now indexes the first
// PAGE_TIMELINE_FTS_MAX_CHARS characters of the timeline and
// PAGE_TIMELINE_ENTRIES_FTS_MAX_CHARS of the joined timeline entries (in id
// order). Recreates the pages trigger function under the configured language,
// then rebuilds the vectors of pages whose timeline is longer than the
// smaller cap, with the seal's own expression; shorter timelines index
// byte-identically and are not touched. Handler-only: the language must be a
// literal (getFtsLanguage() validates it). Batches run outside a transaction
// with a per-batch keyset checkpoint, so an interrupted run resumes; re-running
// is safe (the rebuild is idempotent).
export const v245: Migration = {
  version: 245,
  name: 'page_search_vector_bounded_timeline',
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    const lang = getFtsLanguage();
    await engine.executeRaw(pageSearchVectorTriggerFnSql(lang));
    const pages = await backfillPageVectors(engine, {
      lang, checkpoint: BOUNDED_TIMELINE_CHECKPOINT, where: `char_length(timeline) > ${PAGE_TIMELINE_FTS_MAX_CHARS / 2}`,
    });
    await engine.unsetConfig(checkpointKey(BOUNDED_TIMELINE_CHECKPOINT));
    migrationNotice(`  page_search_vector_bounded_timeline: page keyword vectors index the first ${PAGE_TIMELINE_FTS_MAX_CHARS} timeline characters; rebuilt ${pages} page(s) with longer timelines\n`);
  },
};
