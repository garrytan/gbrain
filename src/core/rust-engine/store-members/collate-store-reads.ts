/**
 * The decision, OAuth, feedback, question and credential reads of engine-sql/collate-store-reads.ts, served by the store
 * (rust/docs/store/oauth-clients.md). Every listing answers in byte order, as the SQL's `COLLATE "C"` does.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listClientsReferencingSource: Member<'listClientsReferencingSource'> = (brain, sourceId) =>
  storeCall({ member: 'listClientsReferencingSource' }, () => brain.listClientsReferencingSource(sourceId)) as Promise<Awaited<ReturnType<BrainEngine['listClientsReferencingSource']>>>;

export const readOwnerCredentials: Member<'readOwnerCredentials'> = (brain, memberId) =>
  storeCall({ member: 'readOwnerCredentials' }, () => brain.readOwnerCredentials(memberId)) as Promise<Awaited<ReturnType<BrainEngine['readOwnerCredentials']>>>;

export const insertPinnedQuestion: Member<'insertPinnedQuestion'> = (brain, row) =>
  storeCall({ member: 'insertPinnedQuestion' }, () => brain.insertPinnedQuestion(row)) as Promise<Awaited<ReturnType<BrainEngine['insertPinnedQuestion']>>>;

export const readPinnedQuestion: Member<'readPinnedQuestion'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readPinnedQuestion' }, () => brain.readPinnedQuestion(sourceId, slug)) as Promise<Awaited<ReturnType<BrainEngine['readPinnedQuestion']>>>;

export const listPinnedQuestions: Member<'listPinnedQuestions'> = (brain, filter) =>
  storeCall({ member: 'listPinnedQuestions' }, () => brain.listPinnedQuestions(filter)) as Promise<Awaited<ReturnType<BrainEngine['listPinnedQuestions']>>>;

export const insertRetrievalEvents: Member<'insertRetrievalEvents'> = (brain, events) =>
  storeCall({ member: 'insertRetrievalEvents' }, () => brain.insertRetrievalEvents(events)) as Promise<Awaited<ReturnType<BrainEngine['insertRetrievalEvents']>>>;

export const readRetrievalEvent: Member<'readRetrievalEvent'> = (brain, id) =>
  storeCall({ member: 'readRetrievalEvent' }, () => brain.readRetrievalEvent(id)) as Promise<Awaited<ReturnType<BrainEngine['readRetrievalEvent']>>>;

export const applyRetrievalRatings: Member<'applyRetrievalRatings'> = (brain, args) =>
  storeCall({ member: 'applyRetrievalRatings' }, () => brain.applyRetrievalRatings(args)) as Promise<Awaited<ReturnType<BrainEngine['applyRetrievalRatings']>>>;

export const readFeedbackStatus: Member<'readFeedbackStatus'> = (brain) =>
  storeCall({ member: 'readFeedbackStatus' }, () => brain.readFeedbackStatus()) as Promise<Awaited<ReturnType<BrainEngine['readFeedbackStatus']>>>;
