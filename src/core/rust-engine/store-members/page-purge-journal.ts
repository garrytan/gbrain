/**
 * The journal statements of a page purge's sweep and intent redaction (BrainEngine listRequestsForSlugs, readJournalCeiling,
 * sweepJournalChunk, readEffectBytes, redactWriteRequestRow and releaseTerminalBytes; SQL in
 * engine-sql/page-purge-journal.ts), served from the store's request, effect and counter records (gbrain-store
 * `persistence/journal_redaction.rs`; rust/docs/store/persistence.md, "The page purge's journal statements").
 *
 * Each member sends the arguments of its BrainEngine member; the store call keeps its own name (snake case in the store).
 * The purge's request lock is `lockWriteRequestsById` (persistence.ts), which takes no row lock: the store admits one write
 * transaction at a time, so the transaction a purge opens already serializes its writers. Every statement reads or writes what the store keeps, so none answers without a store call.
 */
import type { BrainEngine } from '../../engine.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import { requestRow } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listRequestsForSlugs: Member<'listRequestsForSlugs'> = (brain, sourceId, slugs, limit, after) =>
  storeCall({ member: 'listRequestsForSlugs', sourceId }, () => brain.listRequestsForSlugs(sourceId, [...slugs], limit, after));

export const readJournalCeiling: Member<'readJournalCeiling'> = async (brain, sourceId) =>
  (await storeCall({ member: 'readJournalCeiling', sourceId }, () => brain.readJournalCeiling(sourceId))) ?? null;

export const sweepJournalChunk: Member<'sweepJournalChunk'> = (brain, q) =>
  storeCall({ member: 'sweepJournalChunk', sourceId: q.sourceId }, () => brain.sweepJournalChunk({
    sourceId: q.sourceId, needles: [...q.needles], after: q.after, ceiling: q.ceiling, limit: q.limit, ids: q.ids ? [...q.ids] : null, exclude: q.exclude,
  }));

export const readEffectBytes: Member<'readEffectBytes'> = async (brain, requestId) =>
  Number(await storeCall({ member: 'readEffectBytes' }, () => brain.readEffectBytes(requestId)));

export const redactWriteRequestRow: Member<'redactWriteRequestRow'> = async (brain, redaction) => {
  const text = (value: unknown) => value == null ? null : JSON.stringify(value);
  await storeCall({ member: 'redactWriteRequestRow' }, () => brain.redactWriteRequestRow({
    id: redaction.id, terminalReservation: redaction.terminalReservation, outcome: text(redaction.outcome), errorDetail: text(redaction.errorDetail),
  }));
};

export const releaseTerminalBytes: Member<'releaseTerminalBytes'> = async (brain, key, bytes) => {
  await storeCall({ member: 'releaseTerminalBytes' }, () => brain.releaseTerminalBytes(key, bytes));
};
