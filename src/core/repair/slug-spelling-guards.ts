/**
 * The guards that name a page by its slug, and what the move of a page from an older spelling to its normal slug
 * (`gbrain repair slug-spelling`, repair/slug-spelling.ts) does with each. `updateSlug` does not move them, and each one is
 * compared with the page's exact current slug, so left behind it would stop protecting the page:
 *  - `fact_purges.subject` and `take_purges.subject`: the tombstones that refuse a purged fact or take saved again, and that
 *    an import drops from a file. They are copied to the normal slug (the old rows stay, so the old spelling keeps its
 *    own protection); a tombstone the normal slug already holds is kept as it is, so nothing is overwritten or lost.
 *
 * Quarantine holds (`write_gate_holds`) are not guards of this kind and need nothing here: a hold bound to the page
 * follows its page id, and an unbound hold under the old spelling still reaches the page through the rename record that
 * `updateSlug` writes (`holdAppliesToPageSql`, write-gate-binding.ts), so a held write stays out of the moved page's
 * text, including one a writer records under the old spelling while or after the move runs.
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

/** What each guard table needs of the running role: the carry reads it and writes the tombstones it copies. */
const GUARD_TABLE_NEEDS: ReadonlyArray<readonly [string, readonly PolicyCommand[]]> = [
  ['fact_purges', ['SELECT', 'INSERT']], ['take_purges', ['SELECT', 'INSERT']],
];

/** Refuses (`writer_coordinator_required`, nothing written) when row-level security keeps the running role from any guard table. */
export async function assertGuardTablesReadable(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<void> {
  const hidden = (await tx.executeRaw<{ unreadable: string }>(unreadableTablesSql(GUARD_TABLE_NEEDS))).map(row => row.unreadable);
  if (!hidden.length) return;
  const error = new OperationError('writer_coordinator_required',
    `Pages of source ${sourceId} were not moved: this database role cannot fully read ${hidden.join(', ')} (row-level security applies to it and no policy of the role covers the table), so the purge tombstones of a page could not be carried to its normal name; nothing was written.`,
    `Give the role a policy on ${hidden.join(', ')} allowing select and insert on the rows of the sources it writes (docs/ENGINES.md#purge-and-withdrawal-guards), or run the repair as the table owner; then preview again.`,
    'docs/guides/repair.md#slug-spelling');
  error.fix = { consent: [], actor: 'user', why: 'A role that row-level security keeps from the purge tables reads them as empty, so a move would leave their guards on the old spelling.',
    user_message: `Run gbrain repair slug-spelling as a database role that owns or fully reads ${hidden.join(', ')}.`, requires_exclusive: false };
  throw error;
}

/** Copies the purge tombstones of page `from` of `sourceId` to `to`. Returns how many tombstones of each kind were copied. */
export async function carryGuards(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, from: string, to: string): Promise<{ fact_purges: number; take_purges: number }> {
  const facts = await tx.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash, request_id, actor, reason, purged_at)
    SELECT source_id, visibility, $3, fact_hash, request_id, actor, reason, purged_at FROM fact_purges WHERE source_id = $1 AND subject = $2
    ON CONFLICT DO NOTHING RETURNING fact_hash`, [sourceId, from, to]);
  const takes = await tx.executeRaw(`INSERT INTO take_purges (source_id, subject, claim_hash, request_id, purged_at)
    SELECT source_id, $3, claim_hash, request_id, purged_at FROM take_purges WHERE source_id = $1 AND subject = $2
    ON CONFLICT DO NOTHING RETURNING claim_hash`, [sourceId, from, to]);
  return { fact_purges: facts.length, take_purges: takes.length };
}
