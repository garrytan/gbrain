/**
 * `gbrain repair request-indexes` (#5762, #6511): create a missing online-built
 * request index (the managed sync checkpoint pair, the purge slug index), or
 * drop an INVALID one (an interrupted concurrent build) and rebuild it, on a
 * brain whose schema version is already current, where the v179 and slug-index
 * migrations never run again. Postgres builds CONCURRENTLY, one index at
 * a time; PGLite builds inline. An index another session is still building is
 * reported, never dropped. Brain-wide; no journal admission and no user data
 * changes, so `--all` and doctor remediation include it.
 */
import { PERSISTENCE_REQUEST_ONLINE_INDEXES } from '../persistence/schema.ts';
import { readRequestIndexStates } from '../persistence/checkpoint-validation.ts';
import { buildIndexOnline } from '../schema-migrations/helpers.ts';
import type { RepairHandler, RepairItem } from './core.ts';

export const requestIndexesRepair: RepairHandler = {
  kind: 'request-indexes',
  publication: 'projection',
  embeds: false,
  // Building is idempotent, so every run plans what is still missing (the cursor never skips an index).
  async plan(engine) {
    const states = await readRequestIndexStates(engine);
    const items: RepairItem[] = states.flatMap((index, position) => index.state === 'missing' || index.state === 'invalid'
      ? [{ cursor: { phase: 0, id: position + 1 }, source_id: '(brain)', slug: index.name, chars: 0,
        action: index.state === 'invalid' ? 'drop_invalid_and_rebuild' : 'build' }] : []);
    return { items, residuals: { building: states.filter(index => index.state === 'building').length } };
  },
  async apply(ctx, item) {
    const index = PERSISTENCE_REQUEST_ONLINE_INDEXES.find(candidate => candidate.name === item.slug);
    if (!index) return false;
    const outcome = await buildIndexOnline(ctx.engine, 0, { table: 'persistence_requests', ...index }, { notice: line => ctx.logger.info(line.trimEnd()) });
    return outcome === 'created' || outcome === 'rebuilt';
  },
};
