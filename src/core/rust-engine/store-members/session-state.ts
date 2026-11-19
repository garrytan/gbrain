/**
 * Session state members (BrainEngine upsertSessionState and the session_context_state reads, writes and garbage
 * collection context/session-state.ts runs; rust/docs/store/session_state.md).
 */
import type { SessionCursorRow, SessionStateWrite } from '../../engine-sql/session-state.ts';
import { wellFormedJson } from '../../text-safe.ts';
import { storeCall, type StoreMember } from './common.ts';

type Key = [sourceId: string, clientId: string, sessionId: string];

export const upsertSessionState: StoreMember<[...Key, write: SessionStateWrite], number> = (brain, sourceId, clientId, sessionId, write) =>
  storeCall({ member: 'upsertSessionState' }, () => brain.upsertSessionState(sourceId, clientId, sessionId, wellFormedJson(write)));

export const readSessionCursor: StoreMember<Key, SessionCursorRow | null> = (brain, sourceId, clientId, sessionId) =>
  storeCall({ member: 'readSessionCursor' }, () => brain.readSessionCursor(sourceId, clientId, sessionId));
