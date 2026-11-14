/**
 * Guest notes (GBRA-504): the stored form of a guest write's attribution and the guest-source check, kept free of
 * runtime imports so the engine SQL layer and the persistence pipeline can read them without import cycles.
 */
import type { BrainEngine } from '../engine.ts';

export interface GuestAttribution { sender_label: string; group: string }
/** The intent key publication reads; a caller can never set it (preparePageAdmission strips it). */
export const GUEST_NOTE_INTENT_KEY = 'guest_note';

/** The guest note a stored write intent carries, or null (publication and preparation read only this). */
export function storedGuestNote(intent: Record<string, unknown> | null | undefined): GuestAttribution | null {
  const note = intent?.[GUEST_NOTE_INTENT_KEY] as Record<string, unknown> | null | undefined;
  return note && typeof note === 'object' && typeof note.sender_label === 'string' && typeof note.group === 'string'
    ? { sender_label: note.sender_label, group: note.group } : null;
}

/**
 * SQL true when a source is a guest source: its config says `guest: true` or guest_sources lists it. Either record is
 * enough, so a source that lost one of them (a config edit, a restored database) still counts as a guest source. Reads
 * (guests/marker.ts) and every derived producer (guests/derived.ts) use this one test. `config` and `id` are the SQL
 * expressions for the source's config and id.
 */
export const guestSourceSql = (config: string, id: string) =>
  `(COALESCE(${config}->>'guest' = 'true', false) OR EXISTS (SELECT 1 FROM guest_sources gs WHERE gs.source_id = ${id}))`;

/** The guest sources among `sourceIds`, by guestSourceSql. Throws when the lookup fails (a schema behind the guest-notes migration included). */
export async function readGuestSourceIds(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds: readonly string[]): Promise<Set<string>> {
  if (sourceIds.length === 0) return new Set();
  const rows = await engine.executeRaw<{ id: string }>(`SELECT s.id FROM sources s WHERE s.id = ANY($1::text[]) AND ${guestSourceSql('s.config', 's.id')}`, [[...new Set(sourceIds)]]);
  return new Set(rows.map(row => row.id));
}

/** For a derived producer: true when `sourceId` is a guest source, or when that cannot be told (the lookup failed). */
export async function isGuestSource(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<boolean> {
  try { return (await readGuestSourceIds(engine, [sourceId])).has(sourceId); } catch { return true; }
}
