/**
 * Group 5 facts members, recall's candidate-pool reads (src/core/engine-sql/facts-recall.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/recall.rs). A member not exported here refuses with `engine_capability_missing`.
 *
 * Served: `listSlotRows`, which search/slot-ends.ts reads to end a slot value a later one replaced. It reads under the
 * pool's read policy, which `poolArgs` (fact-pool.ts) resolves as it does for `listFactsForRelevance`: the store answers
 * it exactly when the visibility and privacy policies are ones it serves; anything else refuses. The other five pool reads
 * (`readFactsEmbeddingColumn`, `listNearestFacts`, `listPoolUnbackedKeys`, `listCallOffCueFacts`, `listPoolEntityPairs`)
 * are served on rust-5a and refuse here.
 */
import type { BrainEngine } from '../../engine.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';
import { poolArgs } from './fact-pool.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type Row = Record<string, unknown>;

const POOL_DATES = ['valid_from', 'valid_until', 'created_at'] as const;

export const listSlotRows: Member<'listSlotRows'> = async (brain, scope, slots) => {
  const member = 'listSlotRows';
  const pool = poolArgs(member, scope, { includeExpired: true });
  const found: Row[] = await storeCall({ member }, () => brain.listSlotRows({
    pool,
    slots: slots.map(s => ({ sourceId: s.source_id, entitySlug: s.entity_slug, dimension: s.dimension })),
  }));
  return found.map(row => withDates(row, POOL_DATES)) as unknown as Awaited<ReturnType<BrainEngine['listSlotRows']>>;
};
