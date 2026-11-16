import type { Migration } from './types.ts';
import { PAGE_PROJECTION_ACTIVATION_SQL, PAGE_PROJECTION_SCHEMA_SQL } from '../page-state/projection-schema.ts';
import { ACTIVATION_SERVED_REVISION } from '../search/safe-chunks.ts';
import { measuredRoundTripMs, textRebuildDuration } from '../page-state/rebuild-estimate.ts';
import { migrationNotice } from './helpers.ts';

export const v153: Migration = {
  version: 153, name: 'verified_text_projection_activation', idempotent: true, sql: PAGE_PROJECTION_SCHEMA_SQL + PAGE_PROJECTION_ACTIVATION_SQL,
  // #9192: say once what search keeps serving, what waits for the rebuild, and how long it takes on this database.
  handler: async engine => {
    const [row] = await engine.executeRaw<{ n: number; served: number }>(`SELECT count(*)::int AS n,
        count(*) FILTER (WHERE p.text_projection_revision = '${ACTIVATION_SERVED_REVISION}'::uuid)::int AS served
      FROM page_projection_jobs j JOIN sources s ON s.incarnation = j.source_incarnation JOIN pages p ON p.source_id = s.id AND p.slug = j.slug
      WHERE j.reason = 'protocol_activation'`);
    const n = Number(row?.n ?? 0), served = Number(row?.served ?? 0);
    if (n === 0) return;
    const rtt = await measuredRoundTripMs(engine);
    const waiting = n - served ? `; ${n - served} (images, pages indexed before the safe-chunk fence, and pages with a facts or takes fence, private-key text or a quarantine marker) stay out of search until rebuilt` : '';
    migrationNotice(`  [153] ${n} page(s) queued for a keyless search index rebuild (no embedding calls). Search keeps answering from the index ${served} of them already had${waiting}. ` +
      `At the ${rtt} ms round trip measured to this database the rebuild takes about ${textRebuildDuration(n, rtt)}: gbrain projections drain. Progress: gbrain doctor --only text_projection_readiness\n`);
  },
};
