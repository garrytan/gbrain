/**
 * Session state members (BrainEngine upsertSessionState and the session_context_state reads, writes and garbage
 * collection context/session-state.ts runs; rust/docs/store/session_state.md).
 */
import type { DeltaSessionRow, SessionCursorRow, SessionStateWrite } from '../../engine-sql/session-state.ts';
import { wellFormedJson } from '../../text-safe.ts';
import { storeCall, type StoreMember } from './common.ts';

type Key = [sourceId: string, clientId: string, sessionId: string];

export const upsertSessionState: StoreMember<[...Key, write: SessionStateWrite], number> = (brain, sourceId, clientId, sessionId, write) =>
  storeCall({ member: 'upsertSessionState' }, () => brain.upsertSessionState(sourceId, clientId, sessionId, wellFormedJson(write)));

export const readSessionCursor: StoreMember<Key, SessionCursorRow | null> = (brain, sourceId, clientId, sessionId) =>
  storeCall({ member: 'readSessionCursor' }, () => brain.readSessionCursor(sourceId, clientId, sessionId));

export const readDeltaSessionRow: StoreMember<Key, DeltaSessionRow | null> = (brain, sourceId, clientId, sessionId) =>
  storeCall({ member: 'readDeltaSessionRow' }, () => brain.readDeltaSessionRow(sourceId, clientId, sessionId));

export const readCheckpointManifestRow: StoreMember<Key, { checkpoint_manifest: unknown } | null> = (brain, sourceId, clientId, sessionId) =>
  storeCall({ member: 'readCheckpointManifestRow' }, () => brain.readCheckpointManifestRow(sourceId, clientId, sessionId));

export const writeCheckpointManifest: StoreMember<[...Key, manifest: readonly unknown[]], void> = async (brain, sourceId, clientId, sessionId, manifest) => {
  await storeCall({ member: 'writeCheckpointManifest' }, () => brain.writeCheckpointManifest(sourceId, clientId, sessionId, wellFormedJson([...manifest])));
};

export const ageOutSessionState: StoreMember<[olderThanDays: number], void> = async (brain, olderThanDays) => {
  await storeCall({ member: 'ageOutSessionState' }, () => brain.ageOutSessionState(olderThanDays));
};

export const capSessionStatePerClient: StoreMember<[maxRowsPerClient: number], void> = async (brain, maxRowsPerClient) => {
  await storeCall({ member: 'capSessionStatePerClient' }, () => brain.capSessionStatePerClient(maxRowsPerClient));
};
