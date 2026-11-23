/**
 * The guards that name a page by its slug, and what the move of a page from an older spelling to its normal slug
 * (`gbrain repair slug-spelling`, repair/slug-spelling.ts) does with each. `updateSlug` does not move them, and each one is
 * compared with the page's exact current slug, so left behind it would stop protecting the page:
 *  - `fact_purges.subject` and `take_purges.subject`: the tombstones that refuse a purged fact or take saved again, and that
 *    an import drops from a file. They are copied to the normal slug (the old rows stay, so the old spelling keeps its
 *    own protection); a tombstone the normal slug already holds is kept as it is, so nothing is overwritten or lost.
 *  - `write_gate_holds`: a held write (a quarantined fact or take, `status = 'held'`) is omitted from every delivered text
 *    while it names the page's slug. The repair does not move, re-key or merge a held write: a page with any held write
 *    under either of its spellings in its source is not moved at all (`heldWrites`: the preview lists it as needs_human
 *    `slug_spelling_held_writes` and tells the owner to release or drop the holds with `gbrain trust release` / `gbrain trust drop`
 *    first). Released and dropped holds are decided records and stay where they are. The apply reads them again under
 *    the page locks (`carryGuards`), so a hold that appeared after the preview refuses the move.
 *
 * What stays open: the writer of a hold takes no page lock, and a hold row that does not exist yet has nothing to lock.
 * A new hold recorded for the old spelling by a transaction that commits while the move runs can still name the old
 * spelling after the move; neither `gbrain doctor` (`legacy_slug_spellings`) nor a rerun of the preview detects it, so
 * that held row no longer hides its content on the moved page.
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

/** An active hold row, as the checks read it. */
interface HoldRow { id: number | string; kind: string; slug: string }

/** What each guard table needs of the running role: the carry reads it and writes the tombstones it copies; the hold rows are read and locked (`FOR UPDATE` needs the update right), never changed. */
const GUARD_TABLE_NEEDS: ReadonlyArray<readonly [string, readonly PolicyCommand[]]> = [
  ['fact_purges', ['SELECT', 'INSERT']], ['take_purges', ['SELECT', 'INSERT']], ['write_gate_holds', ['SELECT', 'UPDATE']],
];

/** Refuses (`writer_coordinator_required`, nothing written) when row-level security keeps the running role from any guard table. */
export async function assertGuardTablesReadable(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<void> {
  const hidden = (await tx.executeRaw<{ unreadable: string }>(unreadableTablesSql(GUARD_TABLE_NEEDS))).map(row => row.unreadable);
  if (!hidden.length) return;
  const error = new OperationError('writer_coordinator_required',
    `Pages of source ${sourceId} were not moved: this database role cannot fully read ${hidden.join(', ')} (row-level security applies to it and no policy of the role covers the table), so the purge tombstones of a page could not be carried to its normal name and its held writes could not be checked; nothing was written.`,
    `Give the role a policy on ${hidden.join(', ')} allowing select, insert and update on the rows of the sources it writes (docs/ENGINES.md#purge-and-withdrawal-guards), or run the repair as the table owner; then preview again.`,
    'docs/guides/repair.md#slug-spelling');
  error.fix = { consent: [], actor: 'user', why: 'A role that row-level security keeps from the purge or hold tables reads them as empty, so a move would leave their guards on the old spelling or miss a held write.',
    user_message: `Run gbrain repair slug-spelling as a database role that owns or fully reads ${hidden.join(', ')}.`, requires_exclusive: false };
  throw error;
}

/** The active (held) writes of one page, under either spelling. */
export interface HeldWrites { slug: string; hold_ids: number[]; kinds: string[] }

/** Raised by `carryGuards` when, on the locked rows, a held write names the page. Nothing was moved: the transaction rolls back. */
export class HeldWritesError extends Error {
  constructor(readonly held: HeldWrites) { super(`held write ${held.hold_ids.map(id => `h${id}`).join(', ')} names the page`); this.name = 'HeldWritesError'; }
}

const summarize = (rows: readonly HoldRow[], slug: string): HeldWrites => ({ slug, hold_ids: rows.map(row => Number(row.id)), kinds: [...new Set(rows.map(row => row.kind))].sort() });

/**
 * For each page (`from` to `to`), the held writes that name either spelling; a page without one has no entry, keyed by `from`.
 * Unlocked: the preview's reading; the apply reads them again under `lockHolds`.
 */
export async function heldWrites(db: Pick<BrainEngine, 'executeRaw'>, sourceId: string, pages: ReadonlyArray<{ from: string; to: string }>): Promise<Map<string, HeldWrites>> {
  const found = new Map<string, HeldWrites>();
  if (!pages.length) return found;
  const rows = await db.executeRaw<HoldRow>("SELECT id, kind, slug FROM write_gate_holds WHERE source_id = $1 AND slug = ANY($2::text[]) AND status = 'held' ORDER BY id", [sourceId, pages.flatMap(p => [p.from, p.to])]);
  for (const { from, to } of pages) {
    const own = rows.filter(row => row.slug === from || row.slug === to);
    if (own.length) found.set(from, summarize(own, from));
  }
  return found;
}

/**
 * Locks every hold row of both slugs (any status, by id, so two movers cannot deadlock) and returns them. A writer that
 * re-sights a hold takes no page lock but upserts the same row, so it waits here until this transaction ends, and the
 * check made on these rows is on what that writer committed.
 */
export async function lockHolds(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, from: string, to: string): Promise<Array<HoldRow & { status: string }>> {
  return tx.executeRaw<HoldRow & { status: string }>('SELECT id, kind, slug, status FROM write_gate_holds WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY id FOR UPDATE', [sourceId, [from, to]]);
}

/**
 * Locks the holds of both slugs and refuses (`HeldWritesError`) when any is held; then copies the purge tombstones of page
 * `from` of `sourceId` to `to`, and reads the held writes once more so one that committed meanwhile is not missed. Returns
 * how many tombstones of each kind were copied. No hold is changed.
 */
export async function carryGuards(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, from: string, to: string): Promise<{ fact_purges: number; take_purges: number }> {
  const locked = (await lockHolds(tx, sourceId, from, to)).filter(hold => hold.status === 'held');
  if (locked.length) throw new HeldWritesError(summarize(locked, from));
  const facts = await tx.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash, request_id, actor, reason, purged_at)
    SELECT source_id, visibility, $3, fact_hash, request_id, actor, reason, purged_at FROM fact_purges WHERE source_id = $1 AND subject = $2
    ON CONFLICT DO NOTHING RETURNING fact_hash`, [sourceId, from, to]);
  const takes = await tx.executeRaw(`INSERT INTO take_purges (source_id, subject, claim_hash, request_id, purged_at)
    SELECT source_id, $3, claim_hash, request_id, purged_at FROM take_purges WHERE source_id = $1 AND subject = $2
    ON CONFLICT DO NOTHING RETURNING claim_hash`, [sourceId, from, to]);
  const late = await heldWrites(tx, sourceId, [{ from, to }]);
  if (late.has(from)) throw new HeldWritesError(late.get(from)!);
  return { fact_purges: facts.length, take_purges: takes.length };
}
