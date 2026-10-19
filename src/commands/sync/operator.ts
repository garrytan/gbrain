/**
 * #6340: `gbrain sync status` and `gbrain sync unblock`, the operator contract
 * for a managed catch-up (core in `src/core/persistence/sync-status.ts`,
 * decision table in `sync-fault-class.ts`, prose in
 * `docs/guides/sync-unblock-runbook.md`). Both speak the agent operator
 * protocol: `--json` prints one envelope with `next` rendered as a fix. Since
 * #6377 `unblock --apply` also runs the content-repair lane on the holds it
 * clears (`--no-llm`, `--no-repair`), and each repaired path prints its
 * location-only receipt.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { cliRenderContext, renderAction } from '../../core/agent-output.ts';
import { writeJsonDocument } from '../../core/cli-force-exit.ts';
import { opError } from '../../core/ops/contract.ts';
import { readSyncStatus, unblockSync, type SyncStatus } from '../../core/persistence/sync-status.ts';
import { HOLD_ATTEMPTS_NEEDS_HUMAN, HOLD_ESCALATE_MS } from '../../core/persistence/sync-fault-class.ts';
import { CONTENT_REPAIR_HOLD_KINDS } from '../../core/repair/content-lane.ts';
import { resolveSourceIdEngineFree } from '../../core/source-resolver.ts';

/** The hold codes the content-repair lane clears today, for the help text. */
const CONTENT_HOLD_CODES = Object.entries(CONTENT_REPAIR_HOLD_KINDS).filter(([, kind]) => kind).map(([code]) => code).join(', ');

export function printSyncStatusHelp(): void {
  console.log(`Usage: gbrain sync status --source <id> [--detail] [--json]

Where a managed catch-up stands and what to do next, for an operator agent:
the cursor (index/total, pinned target, last advance), pages committed in the
last 10 minutes, every held file and the last recorded failure, each with
  class         page | connection | systemic
  safe_actions  retry | retry_when_clean | repair | reconcile | upgrade | none
  needs_human   whether a person has to decide or act (human_reason says why)
and one \`next\` action, plus the source's state (synced | resumable |
blocked) and its reason, the oldest unfinished request and any recovery
record (bounded probes that need no cursor; a probe that times out makes the
state resumable/status_unknown, never synced).

The terminal-failure summary, the checkpoint blocker list and the live cursor
list are heavy reads: a plain status skips them (the fields keep their types,
empty or unknown) and says so in terminal_failures_read, checkpoint_blockers_read
and cursors_read (status not_read, with the --detail command as fix); --detail
runs them. Never read a skipped field as "none".

The loop: run this every few minutes; when committed_last_10m is 0 and
needs_human is false, run \`gbrain sync unblock --source <id> --apply\`, then
the sync it prints; when needs_human is true, page a person with the slug it
names; when a *_read field is not_read and you need it, run its fix.

Decision table: docs/guides/sync-unblock-runbook.md
`);
}

export function printSyncUnblockHelp(): void {
  console.log(`Usage: gbrain sync unblock --source <id> [--apply] [--no-llm] [--no-repair] [--json]

Performs the safe action for every held file of a managed source and refuses
the rest by name. Without --apply it previews. Idempotent; it writes only
hash-bound repairs (each with its receipt), never drops content and never
clears a hold except by repairing its file: refusing is the only way it
leaves a file out, and each refusal names the file, why, and its fix.

  worktree_dirty        re-screened when its working-tree bytes are committed
                        at HEAD now (still dirty: refused still_dirty)
  preparation_stalled   re-screened (the writer, not the file, stalled)
  concurrent_write      refused: a person reconciles the two versions
  file_drift            refused: a person picks the database or the file
                        (gbrain repair file-drift --prefer database|file)
  ${CONTENT_HOLD_CODES.padEnd(22)}repaired by the content-repair lane (gbrain repair content,
                        each file bound to the bytes its plan read, under the
                        fences.repair caps), then re-screened; per
                        path: repaired | held | needs_human | skipped with the reason,
                        the receipt and the next step. A hold whose stored state waits
                        on a person, the user's spend decision or the owner host is
                        listed, not retried.
  other repair holds    refused with the repair preview to run
  ${HOLD_ATTEMPTS_NEEDS_HUMAN} failed attempts     refused once also held ${HOLD_ESCALATE_MS / 3_600_000} h: the page keeps moving; needs a
                        person (never a file still being edited, never an image)

  --no-llm              repairs keep to their free tiers (model-tier files stay held)
  --no-repair           refuse every repair-class hold instead (the pre-#6377 behaviour)

Then run the sync \`next\` names (the cursor's own options).
Runbook: docs/guides/sync-unblock-runbook.md
`);
}

/**
 * #6803: the operator verb a `gbrain sync` argument vector asks for, shared by
 * the CLI's pre-connect preflight (no watchdog, no owner delegation) and
 * `runSyncInner`. `gbrain sync --status` is the status read, the same as
 * `gbrain sync status` (it used to run a full sync, because nothing read the
 * flag). `--preview` and `--check` are read by no sync path, so a sync that
 * would silently run past them is refused.
 */
export function syncOperatorVerb(args: readonly string[]): 'status' | 'unblock' | null {
  if (args[0] === 'status' || args[0] === 'unblock') return args[0];
  if (args[0] === 'trigger') return null;
  const unread = args.find(a => a === '--preview' || a === '--check' || a.startsWith('--preview=') || a.startsWith('--check='));
  if (unread) {
    const flag = unread.split('=')[0];
    throw opError('invalid_params', `gbrain sync does not read ${flag}; it would have run a full sync.`,
      'Preview a sync with --dry-run, or read where the source stands with gbrain sync status.',
      { fix: { argv: ['gbrain', 'sync', ...args.filter(a => a !== unread && a !== '--dry-run'), '--dry-run'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'The same sync with --dry-run reports what it would import and writes nothing.' } });
  }
  return args.includes('--status') ? 'status' : null;
}

/** `runSyncInner`'s operator route: `sync --status` prints one hint, then runs exactly `sync status`. */
export async function runSyncOperator(engine: BrainEngine, verb: 'status' | 'unblock', args: string[]): Promise<void> {
  if (args[0] === verb) return verb === 'status' ? runSyncStatus(engine, args.slice(1)) : runSyncUnblock(engine, args.slice(1));
  process.stderr.write('[gbrain] sync --status is the status read, the same as gbrain sync status (it never syncs).\n');
  return runSyncStatus(engine, args.filter(a => a !== '--status'));
}

function sourceOf(args: string[]): string {
  const explicit = args.find((a, i) => args[i - 1] === '--source') ?? null;
  const source = resolveSourceIdEngineFree(explicit, process.cwd());
  if (!source || source === '__all__') throw opError('invalid_params', 'sync status and sync unblock need one source.', 'Name one source with --source; the fix lists the ids.',
    { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists the source ids, read-only; then rerun with --source and one of them.' } });
  return source;
}

export async function runSyncStatus(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) return printSyncStatusHelp();
  const sourceId = sourceOf(args);
  const status = await readSyncStatus(engine, sourceId, { detail: args.includes('--detail') });
  const ctx = cliRenderContext();
  // #6696 (A4): the capacity picture rides every status read (unthrottled), from the 60 s snapshot.
  // #6803 C4: one bounded wait per status read, shared with its notices; a slow snapshot reads unknown for this call only.
  const { capacitySnapshotWithin, capacityNotices, CAPACITY_READ_WAIT_MS } = await import('../../core/persistence/capacity-snapshot.ts');
  const { renderNotice } = await import('../../core/agent-output.ts');
  const snapshot = await capacitySnapshotWithin(engine, Date.now() + CAPACITY_READ_WAIT_MS);
  const notices = (await capacityNotices(engine, { throttle: false, snapshot })).map(notice => renderNotice(notice, ctx));
  // #6858 ask 6: commit→searchable / commit→embedded latency over 24 h (null for a source with no managed binding).
  const { readSyncFreshness, formatSyncFreshness } = await import('../../core/persistence/sync-freshness.ts');
  const [freshness = null] = await readSyncFreshness(engine, { sourceIds: [sourceId] }).catch(() => []);
  const read = (r: typeof status.cursors_read) => r.status === 'read' ? r : { ...r, fix: renderAction(r.fix, ctx) };
  const rendered = { ...status, holds: status.holds.map(hold => ({ ...hold, fix: renderAction(hold.fix, ctx) })),
    git_push_holds: status.git_push_holds.map(hold => ({ ...hold, fix: renderAction(hold.fix, ctx) })), next: status.next ? renderAction(status.next, ctx) : null,
    checkpoint_blockers_read: read(status.checkpoint_blockers_read), cursors_read: read(status.cursors_read), terminal_failures_read: read(status.terminal_failures_read),
    capacity: { status: snapshot.status, pause_pct: snapshot.pause_pct, low: snapshot.low, paused: snapshot.paused }, freshness, ...(notices.length ? { notices } : {}) };
  if (args.includes('--json')) return writeJsonDocument(JSON.stringify(rendered, null, 2));
  const c = status.cursor;
  console.log(syncStatusHeadline(status));
  console.log(`  ${c ? c.done ? `last run finished at ${c.index}/${c.total} (pinned ${c.pinned_target?.slice(0, 8) ?? '?'})` : `cursor ${c.index}/${c.total} at pinned target ${c.pinned_target?.slice(0, 8) ?? '?'}`
    + `${c.last_advance_at ? `, last advance ${c.last_advance_at}` : ''}` : 'no managed cursor'}`);
  console.log(`  committed in the last 10 minutes: ${status.committed_last_10m}${status.rate_pages_per_min !== null ? `, ${status.rate_pages_per_min} pages/min` : ''}`);
  if (freshness) console.log(`  freshness: ${formatSyncFreshness(freshness)}`);
  console.log(`  holds: ${status.holds.length}${status.holds.length ? ` (${status.holds.filter(h => h.needs_human).length} need a person)` : ''}; last error: ${status.last_error ? `${status.last_error.code} [${status.last_error.class}]` : 'none'}`);
  for (const hold of status.holds) console.log(`    ${hold.path}${hold.slug ? ` (${hold.slug})` : ''}: ${hold.code} [${hold.class}] safe: ${hold.safe_actions.join(',')}${hold.needs_human ? ` NEEDS HUMAN: ${hold.human_reason}` : ''}${hold.attempts > 1 ? ` (held ${hold.attempts} times)` : ''}`);
  if (status.last_error) console.log(`    ${status.last_error.path ?? ''}: ${status.last_error.code} safe: ${status.last_error.safe_actions.join(',')}${status.last_error.needs_human ? ` NEEDS HUMAN: ${status.last_error.human_reason}` : ''}`);
  const ob = status.oldest_blocker;
  console.log(`  oldest unfinished request: ${ob.status === 'unknown' ? `unknown (${ob.reason})` : ob.request ? `${ob.request.request_id} (${ob.request.state}${ob.request.step ? `, step ${ob.request.step}` : ''}${ob.request.blocked_by ? `, blocked by ${ob.request.blocked_by.predicate}` : ''})` : 'none'}`
    + `; recovery records: ${status.recovery.status === 'unknown' ? `unknown (${status.recovery.reason})` : status.recovery.count}`);
  const t = status.terminal_failures;
  if (status.terminal_failures_read.status === 'not_read') console.log('  terminal write failures, checkpoint blockers and cursors: not read (run with --detail)');
  else if (t.status === 'unknown') console.log(`  terminal write failures: unknown (${t.reason})`);
  else {
    const oldest = t.unresolved.oldest_age_seconds === null ? '' : `, oldest ${Math.round(t.unresolved.oldest_age_seconds / 3600)} h`;
    console.log(`  terminal write failures (last ${t.window_days} d): ${t.active_blockers.length} active blocker(s), ${t.unresolved.rows} unresolved (${t.unresolved.distinct_slugs} page(s), `
      + `${t.unresolved.distinct_intents} intent(s)${oldest}), ${t.historical_rows} historical, ${t.new_last_24h} in the last 24 h${t.defects ? `, ${t.defects} gbrain-defect row(s)` : ''}`);
    for (const b of t.active_blockers) console.log(`    BLOCKING ${b.kind}: request ${b.request_id}${b.slug ? ` (${b.slug})` : ''} [${b.category}]`);
    if (t.active_blockers.length || t.unresolved.rows) console.log(`    drill down: ${t.drill_down.join(' ')}`);
  }
  for (const hold of status.git_push_holds) console.log(`  git backups not pushed: ${hold.retrying} retrying, ${hold.parked} parked (${hold.codes.join(', ')}) since ${hold.oldest_at}${hold.conflict ? `; CONFLICT in ${hold.conflict.paths.join(', ')} needs a person` : ''}`);
  const connector = status.connector_last_error;
  if (connector) console.log(`  connector: ${connector.stopped ? 'STOPPED, ' : ''}the last ${connector.consecutive} run(s) ended on ${connector.code}${connector.slug ? ` at ${connector.slug}` : ''}: ${connector.message}`);
  for (const notice of notices) console.log(`  [gbrain notice ${notice.code}] ${notice.why}`);
  if (rendered.next) console.log(`  Next: ${rendered.next.command ?? rendered.next.argv?.join(' ')}\n  Why: ${rendered.next.why}`);
  else console.log('  Next: nothing; the source is synced and holds nothing.');
}

/** #6712 PR 2 (L5): the one headline per state; the reason names why. */
export function syncStatusHeadline(status: Pick<SyncStatus, 'source_id' | 'state' | 'reason' | 'cursor' | 'run_id' | 'holds' | 'live_job_id'>): string {
  const c = status.cursor;
  switch (status.reason) {
    case 'nothing_pending': return `Source ${status.source_id} is synced${c?.done ? ` (last run ${status.run_id?.slice(0, 8) ?? '?'} finished at ${c.index}/${c.total})` : ''}.`;
    case 'held_by_design': return `Source ${status.source_id} is synced; ${status.holds.length} file(s) stay held by design.`;
    case 'live_job': return `Source ${status.source_id} is resumable: sync job #${status.live_job_id} is draining it.`;
    case 'cursor_unfinished': return `Source ${status.source_id} is resumable: run ${status.run_id?.slice(0, 8) ?? '?'} stands at ${c?.index ?? '?'}/${c?.total ?? '?'}; the next sync resumes it.`;
    case 'last_error': return `Source ${status.source_id} is resumable: the last run recorded a failure that a rerun holds or retries.`;
    case 'holds_actionable': return `Source ${status.source_id} is resumable: held files have a safe action (sync unblock).`;
    case 'recovery_pending': return `Source ${status.source_id} is resumable: a write's recovery record waits for an owner pass.`;
    case 'request_pending': return `Source ${status.source_id} is resumable: a write request is still unfinished; the next sync drains it.`;
    case 'status_unknown': return `Source ${status.source_id}: state unknown (a probe did not answer); not reported synced.`;
    case 'needs_human': return `Source ${status.source_id} is blocked: a person has to decide (see NEEDS HUMAN below).`;
    case 'head_blocked': return `Source ${status.source_id} is blocked: its oldest write waits on something only an operator clears.`;
    case 'recovery_blocked': return `Source ${status.source_id} is blocked: a write's recovery record found changed bytes on disk.`;
  }
}

export async function runSyncUnblock(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) return printSyncUnblockHelp();
  const sourceId = sourceOf(args);
  const outcome = await unblockSync(engine, sourceId, { apply: args.includes('--apply'), noLlm: args.includes('--no-llm'), noRepair: args.includes('--no-repair') });
  // #6712 PR 2: a soak intervention (soak-counters.ts).
  if (outcome.apply) await (await import('../../core/persistence/soak-counters.ts')).recordSoakEvent(engine, 'unblock_apply');
  const ctx = cliRenderContext();
  const rendered = { ...outcome,
    applied: outcome.applied.map(entry => entry.action === 'repair' ? { ...entry, repair: { ...entry.repair, next: renderAction(entry.repair.next, ctx) } } : entry),
    refused: outcome.refused.map(entry => ({ ...entry, fix: renderAction(entry.fix, ctx) })), next: outcome.next ? renderAction(outcome.next, ctx) : null };
  if (args.includes('--json')) return writeJsonDocument(JSON.stringify(rendered, null, 2));
  const repaired = outcome.applied.filter(entry => entry.action === 'repair').length;
  console.log(`Source ${sourceId}: ${outcome.applied.length} held file(s) ${outcome.apply ? `${repaired ? 'repaired or ' : ''}scheduled for a re-screen` : `would be ${repaired ? 'repaired or ' : ''}scheduled for a re-screen (preview; add --apply)`}, ${outcome.refused.length} refused.`);
  for (const entry of outcome.applied) {
    console.log(`  ${entry.path}: ${entry.code} → ${entry.action}: ${entry.detail}`);
    if (entry.action === 'repair' && entry.repair.receipt) console.log(`    receipt: ${Object.entries(entry.repair.receipt).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  for (const entry of outcome.refused) console.log(`  ${entry.path}: ${entry.code} refused (${entry.reason})${entry.needs_human ? ' NEEDS HUMAN' : ''}`);
  if (rendered.next) console.log(`  Next: ${rendered.next.command ?? rendered.next.argv?.join(' ')}\n  Why: ${rendered.next.why}`);
  else console.log('  Next: nothing held.');
}
