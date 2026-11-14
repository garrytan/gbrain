/**
 * Guest sources (GBRA-504): the reads and writes behind `gbrain guests init` and
 * `gbrain sources writers`. guest_sources is the authority the trust trigger
 * reads (guests/schema.ts); sources.config carries `guest: true` and
 * `trust_ceiling` for people and `gbrain sources list`, and `federated: true`
 * so owner reads that widen to federated sources include it.
 */
import type { BrainEngine } from '../engine.ts';
import type { Principal } from '../persistence/model.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { addSource } from '../sources-ops.ts';
import type { TrustTier } from '../trust/tier.ts';

export const GUEST_TRUST_CEILING: TrustTier = 'external_untrusted';
const PRINCIPAL_KINDS: readonly Principal['kind'][] = ['oauth_client', 'legacy_token', 'local_cli', 'local_stdio', 'application'];
/** How a writer is named: the persistence attribution principal, `<kind>:<id>`. */
export const GUEST_WRITER_FORMAT = `<${PRINCIPAL_KINDS.join('|')}>:<id>`;

/** True when `value` names a principal the way the trust trigger compares it. */
export function isGuestWriter(value: string): boolean {
  const at = value.indexOf(':');
  return at > 0 && (PRINCIPAL_KINDS as readonly string[]).includes(value.slice(0, at)) && /^[\x21-\x7e]{1,200}$/.test(value.slice(at + 1));
}

export interface GuestSource { source_id: string; writers: string[]; trust_ceiling: string }

export async function readGuestSource(engine: BrainEngine, sourceId: string): Promise<GuestSource | null> {
  const [row] = await engine.executeRaw<GuestSource>('SELECT source_id, writers, trust_ceiling FROM guest_sources WHERE source_id = $1', [sourceId]);
  return row ?? null;
}

export interface GuestSourcePlan { sourceId: string; exists: boolean; localPath: string | null; guest: GuestSource | null; writers: string[] }

/** What `guests init` would do, read without writing. `writers` is the list after the run (existing ones kept). */
export async function planGuestSource(engine: BrainEngine, sourceId: string, writers: readonly string[]): Promise<GuestSourcePlan> {
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [sourceId]);
  const guest = source ? await readGuestSource(engine, sourceId) : null;
  return { sourceId, exists: !!source, localPath: source?.local_path ?? null, guest, writers: [...new Set([...(guest?.writers ?? []), ...writers])].sort() };
}

/**
 * Makes `sourceId` a guest source: creates it database-only and federated when
 * missing, sets its guest config and writes its guest_sources row, in one
 * transaction (a managed brain creates the source through its lifecycle first).
 * The database refuses a source with a local_path (guest_source_database_only).
 */
export async function initGuestSource(engine: BrainEngine, sourceId: string, writers: readonly string[]): Promise<GuestSource> {
  const managed = await managedPersistenceEnabled(engine);
  if (managed && !(await planGuestSource(engine, sourceId, [])).exists) await addSource(engine, { id: sourceId, federated: true });
  return engine.transaction(async tx => {
    const [source] = await tx.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = $1 FOR UPDATE', [sourceId]);
    if (!source) await addSource(tx, { id: sourceId, federated: true });
    await tx.executeRaw(`UPDATE sources SET config = config || jsonb_build_object('federated', true, 'guest', true, 'trust_ceiling', $2::text) WHERE id = $1`,
      [sourceId, GUEST_TRUST_CEILING]);
    const [row] = await tx.executeRaw<GuestSource>(`INSERT INTO guest_sources (source_id, writers, trust_ceiling) VALUES ($1, $2::text[], $3)
      ON CONFLICT (source_id) DO UPDATE SET writers = ARRAY(SELECT DISTINCT w FROM unnest(guest_sources.writers || EXCLUDED.writers) AS w ORDER BY w)
      RETURNING source_id, writers, trust_ceiling`, [sourceId, [...new Set(writers)].sort(), GUEST_TRUST_CEILING]);
    return row!;
  });
}

export type WritersChange = { clear?: boolean; add?: readonly string[]; remove?: readonly string[] };

/** Applies a writer-list change (clear first, then removals, then additions); null when the source is not a guest source. */
export async function changeGuestWriters(engine: BrainEngine, sourceId: string, change: WritersChange): Promise<GuestSource | null> {
  return engine.transaction(async tx => {
    const [row] = await tx.executeRaw<GuestSource>('SELECT source_id, writers, trust_ceiling FROM guest_sources WHERE source_id = $1 FOR UPDATE', [sourceId]);
    if (!row) return null;
    const removed = new Set(change.remove ?? []);
    const writers = [...new Set([...(change.clear ? [] : row.writers.filter(w => !removed.has(w))), ...(change.add ?? [])])].sort();
    const [updated] = await tx.executeRaw<GuestSource>('UPDATE guest_sources SET writers = $2::text[] WHERE source_id = $1 RETURNING source_id, writers, trust_ceiling',
      [sourceId, writers]);
    return updated!;
  });
}
