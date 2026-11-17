import type { Migration } from './types.ts';
import { migrationNotice } from './helpers.ts';
import { buildOriginIndexIfClean, originTwinsRepairCommand } from '../persistence/origin-index.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #6948: one live page per recorded origin. The partial unique index
// pages_live_origin_key (source_id, source_path) over live pages that record a
// file makes a second live claim on an origin fail inside the writer's own
// transaction, so a duplicate-origin twin can no longer be written. It is
// built online (CONCURRENTLY on Postgres, inline on PGLite) only when the
// brain holds no live twins. With twins, nothing is written or repaired here
// (repairs are preview-first operator steps, never upgrade steps): the
// migration prints `gbrain repair origin-twins --source <id>` for each source
// and succeeds; that repair builds the index once the last group is resolved,
// and doctor's origin_twins check reports "index pending" until then. Not in
// schema.sql: the schema replay on every initSchema would fail on a brain with
// twins. Fresh installs run this migration and get the index.
export const v257: Migration = {
  version: 257,
  name: 'pages_live_origin_key',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    const outcome = await buildOriginIndexIfClean(engine, 257, migrationNotice);
    if (outcome.state !== 'pending') return;
    migrationNotice(`  pages_live_origin_key deferred: ${outcome.sources.map(s => `source ${s.source_id} has ${s.groups} duplicate-origin group(s)`).join(', ')}. `
      + `Nothing was changed. Preview the fix with ${outcome.sources.map(s => originTwinsRepairCommand(s.source_id)).join(' ; ')} (writes nothing); its apply builds the index.\n`);
  },
};
