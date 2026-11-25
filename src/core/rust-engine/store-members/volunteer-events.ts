/**
 * Context-volunteer event members (BrainEngine insertVolunteerEventRows, listVolunteerUsage, deleteVolunteerEventsOlderThan).
 * The store keeps the `context_volunteer_events` rows and removes
 * them with their page or source (rust/docs/store/volunteer-events.md); the channel listing is in doctor-acc.ts. Counts cross
 * the binding as numbers or text and come back as the engine-sql rows read.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const insertVolunteerEventRows: Member<'insertVolunteerEventRows'> = async (brain, rows) => {
  if (!rows.length) return;
  await storeCall({ member: 'insertVolunteerEventRows' }, () => brain.insertVolunteerEventRows(
    rows.map(r => ({ ...r, session_id: r.session_id ?? null, turn: r.turn ?? null }))));
};

export const listVolunteerUsage: Member<'listVolunteerUsage'> = (brain, sourceIds, days) =>
  storeCall({ member: 'listVolunteerUsage' }, () => brain.listVolunteerUsage([...sourceIds], days));

export const deleteVolunteerEventsOlderThan: Member<'deleteVolunteerEventsOlderThan'> = (brain, ttlDays) =>
  storeCall({ member: 'deleteVolunteerEventsOlderThan' }, () => brain.deleteVolunteerEventsOlderThan(ttlDays));
