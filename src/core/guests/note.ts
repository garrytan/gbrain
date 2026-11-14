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

export async function isGuestSource(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<boolean> {
  return (await engine.executeRaw('SELECT 1 FROM guest_sources WHERE source_id = $1', [sourceId])).length > 0;
}
