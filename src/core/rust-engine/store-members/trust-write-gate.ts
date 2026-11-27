/**
 * Trust: the write gate's stale-receipt clear (BrainEngine deleteStalePageWriteGateReceipts), over
 * `rust/crates/gbrain-store/src/trust/write_gate.rs`. A page rewrite the gate assessed again drops the page's receipts
 * for any other content hash (rust/docs/store/trust.md).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const deleteStalePageWriteGateReceipts: Member<'deleteStalePageWriteGateReceipts'> = async (brain, sourceId, slug, contentHash) => {
  await storeCall({ member: 'deleteStalePageWriteGateReceipts', sourceId, slug },
    () => brain.deleteStalePageWriteGateReceipts(sourceId, slug, contentHash ?? null));
};
