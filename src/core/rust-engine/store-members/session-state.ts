/**
 * Session state members (BrainEngine readSessionContextState, readDeltaSessionRow, readCheckpointManifest,
 * upsertSessionContextRow, writeCheckpointManifest, gcSessionContextRows; SQL in engine-sql/session-state.ts). The
 * store keeps one row per `(source_id, client_id, session_id)` under key tag `x` (rust/docs/store/session_state.md).
 * Timestamps cross as ISO text at microsecond precision, as the SQL projects them; jsonb columns cross as JSON.
 */
import type { DeltaSessionRow, SessionContextStateRow, SessionContextWrite, SessionStateKey } from '../../engine-sql/session-state.ts';
import { storeCall, type StoreMember } from './common.ts';

type StoreRow = Record<string, unknown>;

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** The context pack's read of one session row; null with no row. */
export const readSessionContextState: StoreMember<[key: SessionStateKey], SessionContextStateRow | null> = async (brain, key) => {
  const r: StoreRow | null = await storeCall({ member: 'readSessionContextState', sourceId: key.sourceId },
    () => brain.readSessionContextState(key.sourceId, key.clientId, key.sessionId));
  return r ? { standing_entities: r.standing_entities, surfaced_slugs: r.surfaced_slugs, last_wake_at: text(r.last_wake_at) } : null;
};

/** delta's read of one session row; null with no row. */
export const readDeltaSessionRow: StoreMember<[key: SessionStateKey], DeltaSessionRow | null> = async (brain, key) => {
  const r: StoreRow | null = await storeCall({ member: 'readDeltaSessionRow', sourceId: key.sourceId },
    () => brain.readDeltaSessionRow(key.sourceId, key.clientId, key.sessionId));
  if (!r) return null;
  return {
    surfaced_slugs: r.surfaced_slugs,
    last_wake_at: text(r.last_wake_at),
    facts_cursor_at: text(r.facts_cursor_at),
    facts_cursor_id: r.facts_cursor_id === null || r.facts_cursor_id === undefined ? null : Number(r.facts_cursor_id),
    degraded_wakes: Number(r.degraded_wakes ?? 0),
  };
};

/** The session's checkpoint manifest; null with no row. */
export const readCheckpointManifest: StoreMember<[key: SessionStateKey], { checkpoint_manifest: unknown } | null> = async (brain, key) => {
  const r: StoreRow | null = await storeCall({ member: 'readCheckpointManifest', sourceId: key.sourceId },
    () => brain.readCheckpointManifest(key.sourceId, key.clientId, key.sessionId));
  return r ? { checkpoint_manifest: r.checkpoint_manifest } : null;
};

/** Upserts the session cursor; resolves the stored incomplete-wake counter. */
export const upsertSessionContextRow: StoreMember<[key: SessionStateKey, write: SessionContextWrite], number> = async (brain, key, w) => {
  const wakes = await storeCall({ member: 'upsertSessionContextRow', sourceId: key.sourceId }, () => brain.upsertSessionContextRow(
    key.sourceId, key.clientId, key.sessionId, {
      standing_entities: w.standingEntities, cursor_slug: w.cursorSlug, last_wake_at: w.lastWakeAt,
      facts_cursor_at: w.factsCursorAt, facts_cursor_id: w.factsCursorId, degraded_wakes: w.degradedWakes,
    }));
  return Number(wakes);
};

/** Replaces the session's checkpoint manifest, creating the row when there is none. */
export const writeCheckpointManifest: StoreMember<[key: SessionStateKey, manifest: readonly unknown[]], void> = async (brain, key, manifest) => {
  // A JSON round trip, as the SQL binds JSON.stringify text: undefined fields drop and Dates become ISO text.
  await storeCall({ member: 'writeCheckpointManifest', sourceId: key.sourceId },
    () => brain.writeCheckpointManifest(key.sourceId, key.clientId, key.sessionId, JSON.parse(JSON.stringify(manifest))));
};

/** Deletes the rows not updated in `olderThanDays` days, then the oldest rows past the per-client cap. */
export const gcSessionContextRows: StoreMember<[olderThanDays: number, maxRowsPerClient: number], void> = async (brain, days, cap) => {
  await storeCall({ member: 'gcSessionContextRows' }, () => brain.gcSessionContextRows(Number(days), Number(cap)));
};
