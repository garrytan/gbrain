/**
 * Loop mutes: the `loop_suppressions` members and the open-loop statements a mute, an unmute and the Gmail thread
 * verdict run (BrainEngine addLoopSuppression, removeLoopSuppression, listLoopSuppressions, listMuteRecheckThreads,
 * closeMutedLoops, requeueMutedLoops, closeThreadLoops, settleMuteRecheck; engine-sql/loop-mutes.ts), over
 * `rust/crates/gbrain-store/src/facts/loops/mutes.rs`. loops-store.ts lower-cases mute values before they reach a
 * member, on every engine.
 *
 * Text compares on the store are byte compares, as `COLLATE "C"`; a thread mute matches the loop's thread id lowered
 * one code point at a time, as Postgres `lower()` does (rust/docs/store/facts.md).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const addLoopSuppression: Member<'addLoopSuppression'> = async (brain, sourceId, kind, value) => {
  await storeCall({ member: 'addLoopSuppression', sourceId }, () => brain.addLoopSuppression(sourceId, kind, value));
};

export const removeLoopSuppression: Member<'removeLoopSuppression'> = (brain, sourceId, kind, value) =>
  storeCall({ member: 'removeLoopSuppression', sourceId }, () => brain.removeLoopSuppression(sourceId, kind, value));

export const listLoopSuppressions: Member<'listLoopSuppressions'> = (brain, sourceId) =>
  storeCall({ member: 'listLoopSuppressions', sourceId }, () => brain.listLoopSuppressions(sourceId));

export const listMuteRecheckThreads: Member<'listMuteRecheckThreads'> = (brain, sourceId) =>
  storeCall({ member: 'listMuteRecheckThreads', sourceId }, () => brain.listMuteRecheckThreads(sourceId));

export const closeMutedLoops: Member<'closeMutedLoops'> = (brain, sourceId, kind, value, apply) =>
  storeCall({ member: 'closeMutedLoops', sourceId }, () => brain.closeMutedLoops(sourceId, kind, value, apply));

export const requeueMutedLoops: Member<'requeueMutedLoops'> = (brain, sourceId, kind, value, apply) =>
  storeCall({ member: 'requeueMutedLoops', sourceId }, () => brain.requeueMutedLoops(sourceId, kind, value, apply));

/** An empty `only` reads as null, as the SQL engines bind it. */
export const closeThreadLoops: Member<'closeThreadLoops'> = (brain, sourceId, threadId, closedBy, only) => {
  const types = only && only.length > 0 ? [...only] : null;
  return storeCall({ member: 'closeThreadLoops', sourceId }, () => brain.closeThreadLoops(sourceId, threadId, closedBy, types));
};

export const settleMuteRecheck: Member<'settleMuteRecheck'> = (brain, sourceId, threadId) =>
  storeCall({ member: 'settleMuteRecheck', sourceId }, () => brain.settleMuteRecheck(sourceId, threadId));
