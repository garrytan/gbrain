/**
 * `gbrain repair receipt-compaction` (#6696 A9): compact terminal write
 * receipts now instead of waiting for the idle maintenance tick, so a brain
 * at its receipt-bytes cap gets its reservations back. Thin over the same
 * per-receipt compaction the consumer runs (`compactReceipt`, journal.ts):
 * the intent and error message are dropped, the outcome, error code and
 * detail stay, and the reservation shrinks to what the row keeps.
 *
 * Explicit-only, preview-bound and destructive. `--older-than` (hours `72h`
 * or days `30d`, the `pages purge-deleted` grammar) is floored at the
 * configured retention (`persistence.receipt_retention_days`) unless
 * `--force`; committed receipts only unless `--include-failures`. A receipt
 * of a run whose managed-sync cursor is still open, and the newest committed
 * sync receipt of each worktree, are never compacted. The preview binds the
 * selection (an absolute cutoff and the newest sequence it saw); the apply
 * compacts only receipts of that set, rechecking each under its lock.
 * `publication: 'projection'`: no admission, so the preview charges no
 * capacity. Brain-wide.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { OLDER_THAN_RE } from '../../cli/strict-args.ts';
import { COMPACTABLE_STATES, compactReceipt, OPEN_SYNC_CURSOR_EXCLUSION } from '../persistence/journal.ts';
import { readReceiptRetentionDays, RECEIPT_RETENTION_KEY } from '../persistence/limits.ts';
import { clearApprovedSet, loadApprovedSet, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairPlan, type RepairPlanOptions, type RepairScope } from './core.ts';

interface Selection { cutoff: string; max_sequence: string; states: string[] }

/** `72h`, `72` (hours) or `30d` as hours; null when it does not parse. */
export function parseOlderThanHours(raw: string): number | null {
  if (!OLDER_THAN_RE.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return raw.endsWith('d') ? n * 24 : n;
}

function command(opts: RepairPlanOptions): string {
  return ['gbrain repair receipt-compaction', ...(opts.olderThan ? ['--older-than', opts.olderThan] : []),
    ...(opts.includeFailures ? ['--include-failures'] : []), ...(opts.force ? ['--force'] : [])].join(' ');
}

async function selection(engine: BrainEngine, opts: RepairPlanOptions): Promise<Selection> {
  const retentionDays = await readReceiptRetentionDays(engine);
  const hours = opts.olderThan === undefined ? retentionDays * 24 : parseOlderThanHours(opts.olderThan);
  if (hours === null) throw new OperationError('invalid_params', `--older-than takes hours (72 or 72h) or days (30d) (got "${opts.olderThan}").`,
    `Pass the age in days, e.g. --older-than ${retentionDays}d; preview: gbrain repair receipt-compaction --older-than ${retentionDays}d --json`);
  if (hours < retentionDays * 24 && !opts.force) {
    throw Object.assign(new OperationError('invalid_params', `--older-than ${opts.olderThan} is inside the receipt retention window (${retentionDays} days, ${RECEIPT_RETENTION_KEY}), so nothing was compacted.`,
      `A retained receipt is how a caller replays a request id and reads its outcome in full. Preview the window's edge: gbrain repair receipt-compaction --older-than ${retentionDays}d --json. `
      + 'Compacting younger receipts drops their intent early; only with the user\'s agreement add --force.'), {
      fix: { argv: ['gbrain', 'repair', 'receipt-compaction', '--older-than', `${retentionDays}d`, '--json'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Previews compaction at the configured retention; it writes nothing.' } });
  }
  const [row] = await engine.executeRaw<{ cutoff: string; max_sequence: string | null }>(`SELECT to_char((now()-($1::double precision*interval '1 hour')) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff,(SELECT max(sequence)::text FROM persistence_requests) AS max_sequence`, [hours]);
  return { cutoff: row!.cutoff, max_sequence: row!.max_sequence ?? '0', states: opts.includeFailures ? [...COMPACTABLE_STATES] : ['committed'] };
}

async function candidates(engine: BrainEngine, sel: Selection) {
  return engine.executeRaw<{ id: string; request_id: string; sequence: string; source_id: string | null; principal_kind: string; principal_id: string;
    state: string; terminal_reservation: string }>(`SELECT r.id,r.request_id,r.sequence::text,r.source_id,r.principal_kind,r.principal_id,r.state,r.terminal_reservation::text
    FROM persistence_requests r
    WHERE r.state=ANY($1::text[]) AND r.recovery IS NULL AND NOT r.compacted AND r.completed_at < $2::timestamptz AND r.sequence <= $3::bigint
      AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state<>'committed')
      ${OPEN_SYNC_CURSOR_EXCLUSION('r')}
      AND r.id NOT IN (SELECT DISTINCT ON (worktree_id) id FROM persistence_requests WHERE state='committed' AND worktree_id IS NOT NULL
        AND COALESCE(intent->>'kind','') LIKE 'managed_sync_%' ORDER BY worktree_id,completed_at DESC,sequence DESC)
    ORDER BY r.sequence`, [sel.states, sel.cutoff, sel.max_sequence]);
}

const toItem = (sel: Selection) => (row: Awaited<ReturnType<typeof candidates>>[number]): RepairItem => ({ cursor: { phase: 0, id: Number(row.sequence) },
  source_id: row.source_id ?? 'brain', slug: `receipt:${row.request_id}`, chars: 0, action: `compact_${row.state}`,
  change: { from: JSON.stringify({ id: row.id, principal_kind: row.principal_kind, principal_id: row.principal_id, states: sel.states, cutoff: sel.cutoff }), to: 'compacted' } });

const hashOf = (scope: RepairScope, sel: Selection) => previewHash({ kind: 'receipt-compaction-v1', brain_id: scope.brain_id, selection: sel });

export const receiptCompactionRepair: RepairHandler = {
  kind: 'receipt-compaction',
  publication: 'projection',
  embeds: false,
  outcomeItemsLimit: 0,
  async plan(engine, scope, after, opts = { apply: false }): Promise<RepairPlan> {
    const preview = command(opts);
    if (opts.apply) {
      if (!opts.expect) throw new OperationError('invalid_params', 'gbrain repair receipt-compaction --apply needs the preview hash.',
        `Preview first: ${preview} — then run the apply command it prints: ${preview} --apply --expect <preview-hash> --yes`, 'docs/guides/repair.md#receipt-compaction');
      const [sel] = (await loadApprovedSet<Selection>(engine, { command: 'receipt-compaction', hash: opts.expect, previewCommand: preview })).items;
      const items = (await candidates(engine, sel!)).map(toItem(sel!)).filter(item => afterCursor(item.cursor, after));
      if (!items.length) await clearApprovedSet(engine, { command: 'receipt-compaction', hash: opts.expect });
      return { items, preview_hash: opts.expect, residuals: {} };
    }
    const sel = await selection(engine, opts);
    const rows = await candidates(engine, sel);
    const hash = hashOf(scope, sel);
    await saveApprovedSet<Selection>(engine, { command: 'receipt-compaction', hash }, [sel]);
    const [failures] = opts.includeFailures ? [] : await engine.executeRaw<{ n: string }>(`SELECT count(*)::text AS n FROM persistence_requests
      WHERE state IN ('conflict','failed','cancelled') AND recovery IS NULL AND NOT compacted AND completed_at < $1::timestamptz`, [sel.cutoff]);
    return { items: rows.map(toItem(sel)), preview_hash: hash, residuals: Number(failures?.n ?? 0) ? { failures_kept: Number(failures!.n) } : {},
      details: { cutoff: sel.cutoff, states: sel.states, reserved_bytes: rows.reduce((n, row) => n + Number(row.terminal_reservation), 0) } };
  },
  async apply(ctx, item) {
    const row = JSON.parse(item.change!.from!) as { id: string; principal_kind: WriteRequest['principal_kind']; principal_id: string; states: string[]; cutoff: string };
    const done = await compactReceipt(ctx.engine, row, { states: row.states, completedBefore: row.cutoff });
    return 'skipped' in done ? { applied: false, outcome: done.skipped } : { applied: true, outcome: 'compacted', detail: { freed_bytes: done.freed_bytes } };
  },
  render(details) {
    const d = details as { cutoff?: string; states?: string[]; reserved_bytes?: number };
    return [`  receipts completed before ${d.cutoff} (${d.states?.join(', ')}); they reserve ${d.reserved_bytes ?? 0} bytes now and keep their outcome, error code and detail`];
  },
};
