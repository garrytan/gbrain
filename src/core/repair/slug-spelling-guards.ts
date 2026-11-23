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
 * A held write is merged into a hold the normal slug already has only when both would publish identically: the same payload
 * (visibility, attribution, entity, row number and every other field a release reads, after the slug rewrite), tier, gate
 * reasons, origin and request. The fingerprint ignores those fields, so a private held claim can match a world hold of
 * the same text; merging would publish the kept hold's fields at the owner's release. A pair that differs is a
 * `holdConflicts` finding: the preview lists the page as needs_human and the apply refuses, and nothing moves.
 *
 * Every table the carry reads or writes must be fully readable by the running role: row-level security without a
 * policy of the role shows a table empty, which would copy nothing and let the move commit with the guard left
 * behind. `assertGuardTablesReadable` refuses first, with the policy lookup the purge guards themselves run.
 *
 * The caller runs the carry inside the page's maintenance transaction, under both page locks.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { unreadableTablesSql, type PolicyCommand } from '../derived-state-maintainers.ts';

/** Payload keys that name the page a held write was meant for. */
const PAYLOAD_SLUG_KEYS = ['entity_slug', 'source_markdown_slug', 'page_slug', 'slug'] as const;

interface HoldRow { id: number | string; fingerprint: string; detector_version: number; payload: unknown; seen_count: number }
interface HoldDetail extends HoldRow {
  slug: string; status?: string; tier: string; reason_families: unknown; reasons: unknown; detector_error: boolean; write_origin: unknown; request_id: string | null;
}
const HOLD_DETAIL = 'id, slug, status, fingerprint, detector_version, tier, reason_families, reasons, detector_error, payload, write_origin, request_id, seen_count';

/** What each guard table needs of the running role: the carry reads it, and writes the rows it copies or re-keys. */
const GUARD_TABLE_NEEDS: ReadonlyArray<readonly [string, readonly PolicyCommand[]]> = [
  ['fact_purges', ['SELECT', 'INSERT']], ['take_purges', ['SELECT', 'INSERT']], ['write_gate_holds', ['SELECT', 'UPDATE']],
];

/** Refuses (`writer_coordinator_required`, nothing written) when row-level security keeps the running role from any guard table. */
export async function assertGuardTablesReadable(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<void> {
  const hidden = (await tx.executeRaw<{ unreadable: string }>(unreadableTablesSql(GUARD_TABLE_NEEDS))).map(row => row.unreadable);
  if (!hidden.length) return;
  const error = new OperationError('writer_coordinator_required',
    `Pages of source ${sourceId} were not moved: this database role cannot fully read ${hidden.join(', ')} (row-level security applies to it and no policy of the role covers the table), so the purge tombstones and held writes of a page could not be carried to its normal name; nothing was written.`,
    `Give the role a policy on ${hidden.join(', ')} allowing select, insert and update on the rows of the sources it writes (docs/ENGINES.md#purge-and-withdrawal-guards), or run the repair as the table owner; then preview again.`,
    'docs/guides/repair.md#slug-spelling');
  error.fix = { consent: [], actor: 'user', why: 'A role that row-level security keeps from the purge or hold tables reads them as empty, so a move would leave their guards on the old spelling.',
    user_message: `Run gbrain repair slug-spelling as a database role that owns or fully reads ${hidden.join(', ')}.`, requires_exclusive: false };
  throw error;
}

const canonical = (value: unknown): string => {
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown; } catch { return value; } })() : value;
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(parsed ?? null));
};

/** The fields a release reads, as one comparable text; `rekey` rewrites the page-naming payload keys of a moving hold first. */
const publication = (hold: HoldDetail, rekey?: { from: string; to: string }): string => canonical({
  payload: rekey ? rekeyedPayload(hold.payload, rekey.from, rekey.to) : typeof hold.payload === 'string' ? JSON.parse(hold.payload) : hold.payload,
  tier: hold.tier, reason_families: hold.reason_families, reasons: hold.reasons, detector_error: hold.detector_error, write_origin: hold.write_origin, request_id: hold.request_id,
});

/** A held write whose twin at the normal slug would publish differently. */
export interface HoldConflict { slug: string; hold_id: number; other_id: number }

/** Raised by `carryGuards` when, on the locked rows, a held write and its twin differ in what a release publishes. Nothing was moved: the transaction rolls back. */
export class HoldConflictError extends Error {
  constructor(readonly conflict: HoldConflict) { super(`held write h${conflict.hold_id} and held write h${conflict.other_id} would publish different fields`); this.name = 'HoldConflictError'; }
}

/** The first active hold of `from` whose twin at `to` (same fingerprint and detector version, any status) publishes differently, among `rows`. */
function conflictAmong(rows: readonly HoldDetail[], from: string, to: string): HoldConflict | null {
  for (const hold of rows) {
    if (hold.slug !== from || hold.status !== 'held') continue;
    const twin = rows.find(other => other.slug === to && other.fingerprint === hold.fingerprint && other.detector_version === hold.detector_version);
    if (twin && publication(hold, { from, to }) !== publication(twin)) return { slug: from, hold_id: Number(hold.id), other_id: Number(twin.id) };
  }
  return null;
}

/**
 * For each page (`from` to `to`), the first active hold of `from` whose twin at `to` differs in what a release publishes.
 * Keyed by `from`; a page without a conflict has no entry. Unlocked: the preview's reading; the apply re-checks under `lockHolds`.
 */
export async function holdConflicts(db: Pick<BrainEngine, 'executeRaw'>, sourceId: string, pages: ReadonlyArray<{ from: string; to: string }>): Promise<Map<string, HoldConflict>> {
  const found = new Map<string, HoldConflict>();
  if (!pages.length) return found;
  const rows = await db.executeRaw<HoldDetail>(`SELECT ${HOLD_DETAIL} FROM write_gate_holds WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY id`, [sourceId, pages.flatMap(p => [p.from, p.to])]);
  for (const { from, to } of pages) { const conflict = conflictAmong(rows, from, to); if (conflict) found.set(from, conflict); }
  return found;
}

/**
 * Locks every hold row of both slugs (any status, by id, so two movers cannot deadlock) and returns them. A writer that
 * re-sights a hold takes no page lock but upserts the same row, so it waits here until this transaction ends, and a
 * comparison made on these rows is the one the merge acts on.
 */
export async function lockHolds(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, from: string, to: string): Promise<HoldDetail[]> {
  return tx.executeRaw<HoldDetail>(`SELECT ${HOLD_DETAIL} FROM write_gate_holds WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY id FOR UPDATE`, [sourceId, [from, to]]);
}

/** The payload with every page-naming key that holds `from` rewritten to `to`; the same object when none does. */
export function rekeyedPayload(payload: unknown, from: string, to: string): Record<string, unknown> {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) as unknown : payload;
  const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, (PAYLOAD_SLUG_KEYS as readonly string[]).includes(key) && value === from ? to : value]));
}

/**
 * Copies the purge tombstones and re-keys the active holds of page `from` of `sourceId` to `to`; returns how many of each.
 * Both slugs' holds are locked first and compared again on the locked rows (`HoldConflictError` when they differ), the
 * merge and re-key act on those rows, and a last read refuses when any held write still names `from`.
 */
export async function carryGuards(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, from: string, to: string): Promise<{ fact_purges: number; take_purges: number; holds: number }> {
  const locked = await lockHolds(tx, sourceId, from, to);
  const conflict = conflictAmong(locked, from, to);
  if (conflict) throw new HoldConflictError(conflict);
  const facts = await tx.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash, request_id, actor, reason, purged_at)
    SELECT source_id, visibility, $3, fact_hash, request_id, actor, reason, purged_at FROM fact_purges WHERE source_id = $1 AND subject = $2
    ON CONFLICT DO NOTHING RETURNING fact_hash`, [sourceId, from, to]);
  const takes = await tx.executeRaw(`INSERT INTO take_purges (source_id, subject, claim_hash, request_id, purged_at)
    SELECT source_id, $3, claim_hash, request_id, purged_at FROM take_purges WHERE source_id = $1 AND subject = $2
    ON CONFLICT DO NOTHING RETURNING claim_hash`, [sourceId, from, to]);
  const held = locked.filter(hold => hold.slug === from && hold.status === 'held');
  for (const hold of held) {
    const other = locked.find(twin => twin.slug === to && twin.fingerprint === hold.fingerprint && twin.detector_version === hold.detector_version);
    if (other) {
      await tx.executeRaw(`UPDATE write_gate_holds SET status = 'held', decided_at = NULL, decided_by = NULL, last_seen_at = now(), seen_count = seen_count + $2 WHERE id = $1`, [other.id, hold.seen_count]);
      await tx.executeRaw(`UPDATE write_gate_holds SET status = 'dropped', decided_at = now(), decided_by = 'repair:slug-spelling' WHERE id = $1`, [hold.id]);
    } else {
      await tx.executeRaw('UPDATE write_gate_holds SET slug = $2, payload = $3::text::jsonb WHERE id = $1', [hold.id, to, JSON.stringify(rekeyedPayload(hold.payload, from, to))]);
    }
  }
  // A hold row added for the old spelling after the lock (an insert has no row to wait on) is never left behind unseen.
  const left = await tx.executeRaw<{ id: number | string }>("SELECT id FROM write_gate_holds WHERE source_id = $1 AND slug = $2 AND status = 'held' AND NOT (id = ANY($3::bigint[]))", [sourceId, from, held.map(h => Number(h.id))]);
  if (left.length) throw new HoldConflictError({ slug: from, hold_id: Number(left[0]!.id), other_id: Number(left[0]!.id) });
  return { fact_purges: facts.length, take_purges: takes.length, holds: held.length };
}
