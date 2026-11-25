/**
 * `listFactProvenance` (src/core/engine-sql/facts-trust.ts), the stored provenance (`facts.source`) of the named facts
 * of one source that context_pack and delta attach to each fact they deliver, served from the facts store
 * (rust/crates/gbrain-store/src/facts/provenance.rs). Its SQL has no `ORDER BY`; the store answers in id order. An id
 * that is not a safe integer refuses rather than guess at the `bigint[]` cast.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listFactProvenance: Member<'listFactProvenance'> = async (brain, sourceId, ids) => {
  if (ids.some((id) => !Number.isSafeInteger(id))) refuseMember('listFactProvenance', 'an id that is not a safe integer');
  const rows: Array<{ id: number | string; source: string | null }> = await storeCall({ member: 'listFactProvenance' }, () => brain.listFactProvenance({ sourceId, ids: [...ids] }));
  return rows.map((r) => ({ id: Number(r.id), source: r.source }));
};
