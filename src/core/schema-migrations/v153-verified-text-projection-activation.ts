import type { Migration } from './types.ts';
import { PAGE_PROJECTION_ACTIVATION_SQL, PAGE_PROJECTION_SCHEMA_SQL } from '../page-state/projection-schema.ts';
import { migrationNotice } from './helpers.ts';

export const v153: Migration = {
  version: 153, name: 'verified_text_projection_activation', idempotent: true, sql: PAGE_PROJECTION_SCHEMA_SQL + PAGE_PROJECTION_ACTIVATION_SQL,
  // #9192: the activation takes every page out of the search index until the drain rebuilds it, so say so once.
  handler: async engine => {
    const [row] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM page_projection_jobs WHERE reason = 'protocol_activation'");
    const n = Number(row?.n ?? 0);
    if (n > 0) migrationNotice(`  [153] ${n} page(s) queued for a search index rebuild; search and query results stay partial and say so until it finishes. Progress: gbrain doctor --only text_projection_readiness\n`);
  },
};
