/**
 * The guards that name a page by its slug and stay in force after the page moves from an older spelling to its normal
 * slug (`gbrain repair slug-spelling`, repair/slug-spelling.ts). `updateSlug` does not move them, and each one is
 * compared with the page's exact current slug, so left behind it would stop protecting the page:
 *  - `fact_purges.subject` and `take_purges.subject`: the tombstones that refuse a purged fact or take saved again, and that
 *    an import drops from a file. They are copied to the normal slug (the old rows stay, so the old spelling keeps its
 *    own protection); a tombstone the normal slug already holds is kept as it is, so nothing is overwritten or lost.
 *  - `write_gate_holds`: a held write (a quarantined fence row) is omitted from every delivered text while its hold is
 *    `held` and names the page's slug. Each active hold is re-keyed to the normal slug, with the slug its payload carries.
 *    When the normal slug already holds the same row (same fingerprint and detector version, in any status), that hold is
 *    made `held` again and counts both sightings, and the old one becomes a decided record (`dropped`, by this repair), so
 *    one hold stays active, never zero. Released and dropped holds are decided records and stay where they are.
 *
 * The caller runs this inside the page's maintenance transaction, under both page locks.
 */
import type { BrainEngine } from '../engine.ts';

/** Payload keys that name the page a held write was meant for. */
const PAYLOAD_SLUG_KEYS = ['entity_slug', 'source_markdown_slug', 'page_slug', 'slug'] as const;

interface HoldRow { id: number | string; fingerprint: string; detector_version: number; payload: unknown; seen_count: number }

/** The payload with every page-naming key that holds `from` rewritten to `to`; the same object when none does. */
export function rekeyedPayload(payload: unknown, from: string, to: string): Record<string, unknown> {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) as unknown : payload;
  const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, (PAYLOAD_SLUG_KEYS as readonly string[]).includes(key) && value === from ? to : value]));
}

/** Copies the purge tombstones and re-keys the active holds of page `from` of `sourceId` to `to`; returns how many of each. */
export async function carryGuards(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, from: string, to: string): Promise<{ fact_purges: number; take_purges: number; holds: number }> {
  const facts = await tx.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash, request_id, actor, reason, purged_at)
    SELECT source_id, visibility, $3, fact_hash, request_id, actor, reason, purged_at FROM fact_purges WHERE source_id = $1 AND subject = $2
    ON CONFLICT DO NOTHING RETURNING fact_hash`, [sourceId, from, to]);
  const takes = await tx.executeRaw(`INSERT INTO take_purges (source_id, subject, claim_hash, request_id, purged_at)
    SELECT source_id, $3, claim_hash, request_id, purged_at FROM take_purges WHERE source_id = $1 AND subject = $2
    ON CONFLICT DO NOTHING RETURNING claim_hash`, [sourceId, from, to]);
  const held = await tx.executeRaw<HoldRow>(`SELECT id, fingerprint, detector_version, payload, seen_count FROM write_gate_holds
    WHERE source_id = $1 AND slug = $2 AND status = 'held' ORDER BY id`, [sourceId, from]);
  for (const hold of held) {
    const [other] = await tx.executeRaw<{ id: number | string }>('SELECT id FROM write_gate_holds WHERE source_id = $1 AND slug = $2 AND fingerprint = $3 AND detector_version = $4', [sourceId, to, hold.fingerprint, hold.detector_version]);
    if (other) {
      await tx.executeRaw(`UPDATE write_gate_holds SET status = 'held', decided_at = NULL, decided_by = NULL, last_seen_at = now(), seen_count = seen_count + $2 WHERE id = $1`, [other.id, hold.seen_count]);
      await tx.executeRaw(`UPDATE write_gate_holds SET status = 'dropped', decided_at = now(), decided_by = 'repair:slug-spelling' WHERE id = $1`, [hold.id]);
    } else {
      await tx.executeRaw('UPDATE write_gate_holds SET slug = $2, payload = $3::text::jsonb WHERE id = $1', [hold.id, to, JSON.stringify(rekeyedPayload(hold.payload, from, to))]);
    }
  }
  return { fact_purges: facts.length, take_purges: takes.length, holds: held.length };
}
