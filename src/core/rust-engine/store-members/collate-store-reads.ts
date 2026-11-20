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

export const insertVolunteerEvents: Member<'insertVolunteerEvents'> = (brain, rows) =>
  storeCall({ member: 'insertVolunteerEvents' }, () => brain.insertVolunteerEvents(rows)) as Promise<Awaited<ReturnType<BrainEngine['insertVolunteerEvents']>>>;

export const readVolunteerUsage: Member<'readVolunteerUsage'> = (brain, sourceIds, days) =>
  storeCall({ member: 'readVolunteerUsage' }, () => brain.readVolunteerUsage(sourceIds, days)) as Promise<Awaited<ReturnType<BrainEngine['readVolunteerUsage']>>>;

export const upsertChronicleRow: Member<'upsertChronicleRow'> = (brain, w) =>
  storeCall({ member: 'upsertChronicleRow' }, () => brain.upsertChronicleRow(w)) as Promise<Awaited<ReturnType<BrainEngine['upsertChronicleRow']>>>;

export const reserveChronicleJudgeSlot: Member<'reserveChronicleJudgeSlot'> = (brain, limit, key) =>
  storeCall({ member: 'reserveChronicleJudgeSlot' }, () => brain.reserveChronicleJudgeSlot(limit, key)) as Promise<Awaited<ReturnType<BrainEngine['reserveChronicleJudgeSlot']>>>;

export const readChronicleLedger: Member<'readChronicleLedger'> = (brain) =>
  storeCall({ member: 'readChronicleLedger' }, () => brain.readChronicleLedger()) as Promise<Awaited<ReturnType<BrainEngine['readChronicleLedger']>>>;

export const listSharedSkillMigrationRows: Member<'listSharedSkillMigrationRows'> = (brain, sourceId) =>
  storeCall({ member: 'listSharedSkillMigrationRows' }, () => brain.listSharedSkillMigrationRows(sourceId)) as Promise<Awaited<ReturnType<BrainEngine['listSharedSkillMigrationRows']>>>;

export const normalizeDerivationClaims: Member<'normalizeDerivationClaims'> = (brain, claims) =>
  storeCall({ member: 'normalizeDerivationClaims' }, () => brain.normalizeDerivationClaims(claims)) as Promise<Awaited<ReturnType<BrainEngine['normalizeDerivationClaims']>>>;
