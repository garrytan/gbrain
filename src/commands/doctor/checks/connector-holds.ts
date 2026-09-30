import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { readAllSourceHolds } from '../../../core/connectors/item-holds-store.ts';

/**
 * Fix wave 4 (#5752, #5740): connector items held after repeated item-scoped
 * failures, per source. A held item does not block freshness, so this is the
 * doctor surface that keeps it from being skipped silently. Counts and keys
 * only; `gbrain sources status <id>` lists sender, subject or title.
 */
export async function connectorHeldItemsCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const holds = await readAllSourceHolds(engine, sourceIds ? { sourceIds } : {});
    const sources = holds.map(entry => ({ source_id: entry.sourceId, kind: entry.kind, held: entry.held.length,
      retry: `gbrain sources retry-held ${entry.sourceId}`, status: `gbrain sources status ${entry.sourceId}` }));
    const held = sources.reduce((sum, source) => sum + source.held, 0);
    const details = { held, sources, docs: 'docs/guides/repair.md#connector-held-items' };
    if (!held) return { name: 'connector_held_items', status: 'ok', message: 'No connector items are held.', details };
    return { name: 'connector_held_items', status: 'warn', details,
      message: `${held} connector item(s) held after repeated failures: ${sources.map(s => `${s.source_id} ${s.held}`).join(', ')}. `
        + `Inspect with ${sources.map(s => s.status).join('; ')}; after fixing the cause re-attempt with ${sources.map(s => s.retry).join('; ')}.` };
  } catch (error) {
    return { name: 'connector_held_items', status: 'warn',
      message: `Connector holds could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { held: 0, health: 'unknown' } };
  }
}
