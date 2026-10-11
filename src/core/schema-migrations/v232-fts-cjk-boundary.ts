import type { Migration } from './types.ts';
import { checkpointKey } from '../backfill-base.ts';
import {
  chunkSearchVectorTriggerFnSql,
  FTS_CJK_BOUNDARY_REGEX,
  FTS_INPUT_FUNCTION_SQL,
  getFtsLanguage,
  pageSearchVectorTriggerFnSql,
} from '../fts-language.ts';
import { backfillChunkVectors, backfillPageVectors } from '../search-vector-backfill.ts';
import { migrationNotice } from './helpers.ts';

const CHECKPOINT = { pages: 'fts_cjk_pages', chunks: 'fts_cjk_content_chunks' } as const;

// #6370: Latin/digit tokens glued to CJK text (`升级PostgreSQL17后查询Redis7`)
// were one lexeme, so keyword search for `Redis7` missed them. Creates
// gbrain_fts_input(), recreates both search_vector trigger functions on top of
// it under the configured language, then rebuilds only the rows whose text
// holds a CJK/ASCII-alnum boundary; every other row's vector is byte-identical
// under the helper and is not touched. Handler-only: the language must be a
// literal (getFtsLanguage() validates it). Batches run outside a transaction
// with a per-batch keyset checkpoint, so an interrupted run resumes where it
// stopped; re-running is safe (the rebuild is idempotent).
export const v232: Migration = {
  version: 232,
  name: 'fts_cjk_boundary',
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    const lang = getFtsLanguage();
    await engine.executeRaw(FTS_INPUT_FUNCTION_SQL);
    await engine.executeRaw(pageSearchVectorTriggerFnSql(lang));
    await engine.executeRaw(chunkSearchVectorTriggerFnSql(lang));
    const re = `'${FTS_CJK_BOUNDARY_REGEX}'`;
    const pages = await backfillPageVectors(engine, {
      lang, checkpoint: CHECKPOINT.pages, where: `title ~ ${re} OR timeline ~ ${re}`,
    });
    const chunks = await backfillChunkVectors(engine, {
      lang, checkpoint: CHECKPOINT.chunks,
      where: `chunk_text ~ ${re} OR doc_comment ~ ${re} OR symbol_name_qualified ~ ${re}`,
    });
    await engine.unsetConfig(checkpointKey(CHECKPOINT.pages));
    await engine.unsetConfig(checkpointKey(CHECKPOINT.chunks));
    migrationNotice(`  fts_cjk_boundary: keyword index splits CJK/Latin boundaries; rebuilt ${pages} page(s) and ${chunks} chunk(s) with CJK text (#6370)\n`);
  },
};
