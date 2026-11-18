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

/**
 * SQL true when row-level security keeps the current database role from reading guest_sources: it applies to the role
 * and no permissive SELECT policy covers it, the test the trust trigger's guest guard refuses on (trust/schema.ts,
 * derived-state-maintainers.ts requireMaintainerPoliciesSql). Such a role reads guest_sources empty, so every lookup
 * that reads it reads this too and refuses instead of treating a guest source as ordinary (follow-up 3 of #9354).
 */
export const GUEST_SOURCES_HIDDEN_SQL = `(pg_catalog.row_security_active('guest_sources') AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p`
  + ` WHERE p.polrelid = 'guest_sources'::regclass::oid AND p.polpermissive AND p.polcmd::text IN ('*', 'r')`
  + ` AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p.polroles) AS r(id) WHERE CASE WHEN r.id = 0::oid THEN true ELSE pg_catalog.pg_has_role(r.id, 'USAGE') END)))`;

/** The guest sources among `sourceIds`, by guestSourceSql. Throws when the lookup fails (a schema behind the guest-notes migration included). */
export async function readGuestSourceIds(engine: Pick<BrainEngine, 'listGuestSourceIds'>, sourceIds: readonly string[]): Promise<Set<string>> {
  if (sourceIds.length === 0) return new Set();
  return new Set(await engine.listGuestSourceIds(sourceIds));
}

/** Whether `sourceId` is a guest source; a lookup that failed answers guest, with its error, so a caller can say it failed. */
export async function guestSourceVerdict(engine: Pick<BrainEngine, 'listGuestSourceIds'>, sourceId: string): Promise<{ guest: boolean; lookupError?: string }> {
  try { return { guest: (await readGuestSourceIds(engine, [sourceId])).has(sourceId) }; } catch (e) {
    return { guest: true, lookupError: e instanceof Error ? e.message : String(e) };
  }
}

/** For a derived producer: true when `sourceId` is a guest source, or when that cannot be told (the lookup failed). */
export async function isGuestSource(engine: Pick<BrainEngine, 'listGuestSourceIds'>, sourceId: string): Promise<boolean> {
  return (await guestSourceVerdict(engine, sourceId)).guest;
}

/** The skip a cycle phase reports on `sourceId`: a guest source, or a guest lookup that failed, named as such. */
export function guestSkipDetails(sourceId: string, lookupError: string | undefined): { summary: string; details: Record<string, unknown> } {
  return lookupError === undefined
    ? { summary: 'a guest source feeds no derived rows', details: { reason: 'guest_source', source_id: sourceId } }
    : { summary: 'could not tell whether the source is a guest source (the lookup failed), so it was treated as one',
      details: { reason: 'guest_source_lookup_failed', source_id: sourceId, error: lookupError } };
}
