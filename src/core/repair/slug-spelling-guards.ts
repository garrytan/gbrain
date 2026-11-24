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
 * Every table the carry reads must be fully visible to the running role: row-level security can show it fewer rows (or
 * none), which would copy too little and let the move commit with a guard left behind. No policy check proves a policy
 * shows every row, so `assertGuardTablesReadable` refuses whenever row security applies to a guard table for the role.
 *
 * The caller runs the carry inside the page's maintenance transaction, under both page locks.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
/** The guard tables: the carry reads every tombstone of the page in them and writes the copies. */
const GUARD_TABLES = ['fact_purges', 'take_purges'] as const;

/**
 * Refuses (`writer_coordinator_required`, nothing written) when row-level security applies to any guard table for the
 * running role. A policy's existence does not prove it shows every row (a `USING (false)` policy hides them all), and a
 * tombstone the role cannot see is not copied, so only a role row security does not apply to (the table owner without
 * FORCE ROW LEVEL SECURITY, or a BYPASSRLS role) may move a page.
 */
export async function assertGuardTablesReadable(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<void> {
  const hidden = (await tx.executeRaw<{ unreadable: string }>(
    'SELECT t AS unreadable FROM unnest($1::text[]) AS t WHERE pg_catalog.row_security_active(t) ORDER BY t', [[...GUARD_TABLES]])).map(row => row.unreadable);
  if (!hidden.length) return;
  const error = new OperationError('writer_coordinator_required',
    `Pages of source ${sourceId} were not moved: row-level security applies to ${hidden.join(', ')} for this database role, so the repair cannot prove it sees every purge tombstone of a page and could leave one on the old spelling; nothing was written.`,
    `Run the repair as the owner of ${hidden.join(', ')} (with FORCE ROW LEVEL SECURITY off) or as a role with BYPASSRLS; then preview again.`,
    'docs/guides/repair.md#slug-spelling');
  error.fix = { consent: [], actor: 'user', why: 'Row-level security can hide purge tombstones from the running role, and a tombstone the move cannot see stays on the old spelling, so a purged claim could be saved again under the normal name.',
    user_message: `Run gbrain repair slug-spelling as the owner of ${hidden.join(', ')} or as a database role with BYPASSRLS.`, requires_exclusive: false };
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
