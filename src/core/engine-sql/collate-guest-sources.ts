/**
 * The guest_sources statements `gbrain guests init` and `promote_guest_note` ran through `executeRaw`, each with the
 * statement text and parameters its caller used; only its home moved (guests/sources.ts `initGuestSource`,
 * guests/promote.ts `guestNote`). Both order or merge by byte (`COLLATE "C"`), so the writers a source keeps and the
 * note a promotion names are the same on every engine whatever the database locale is
 * (test/engine-parity/collate-*.test.ts). The text of each is pinned in test/engine-sql-caller-raw-sql-pins.test.ts.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** One guest_sources row as the guest commands read it. */
export interface GuestSourceRow { source_id: string; writers: string[]; trust_ceiling: string }

/**
 * Writes the source's guest row, or merges `writers` into the row it has (each distinct, in byte order; the row keeps its
 * trust ceiling), and answers the row. `writers` are what the caller passes: sorted and without repeats.
 */
export async function upsertGuestSource(raw: EngineRawRead, sourceId: string, writers: readonly string[], trustCeiling: string): Promise<GuestSourceRow> {
  const [row] = await raw<GuestSourceRow>(`INSERT INTO guest_sources (source_id, writers, trust_ceiling) VALUES ($1, $2::text[], $3)
      ON CONFLICT (source_id) DO UPDATE SET writers = ARRAY(SELECT DISTINCT w COLLATE "C" FROM unnest(guest_sources.writers || EXCLUDED.writers) AS w ORDER BY w COLLATE "C")
      RETURNING source_id, writers, trust_ceiling`, [sourceId, [...writers], trustCeiling]);
  return row!;
}

/** The live page at `slug` in each guest source (only `guestSource` when given), by source id in byte order. */
export async function listGuestNotes(raw: EngineRawRead, slug: string, guestSource?: string): Promise<Array<{ id: number; source_id: string }>> {
  return guestSource
    ? raw<{ id: number; source_id: string }>(
      'SELECT p.id, p.source_id FROM pages p JOIN guest_sources g ON g.source_id = p.source_id WHERE p.slug = $1 AND p.deleted_at IS NULL AND p.source_id = $2 ORDER BY p.source_id COLLATE "C"',
      [slug, guestSource])
    : raw<{ id: number; source_id: string }>(
      'SELECT p.id, p.source_id FROM pages p JOIN guest_sources g ON g.source_id = p.source_id WHERE p.slug = $1 AND p.deleted_at IS NULL ORDER BY p.source_id COLLATE "C"',
      [slug]);
}
