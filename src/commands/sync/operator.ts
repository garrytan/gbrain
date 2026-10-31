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
import { readSyncStatus, unblockSync, type SyncStatus, type SyncStatusHold } from '../../core/persistence/sync-status.ts';
import { pageSortedRows, topCounts } from '../../core/bounded-listing.ts';
import { nextListingCommand, parseListingFlags } from '../../core/bounded-listing-cli.ts';
import { HOLD_ATTEMPTS_NEEDS_HUMAN, HOLD_ESCALATE_MS } from '../../core/persistence/sync-fault-class.ts';
import { CONTENT_REPAIR_HOLD_KINDS } from '../../core/repair/content-lane.ts';
import { resolveSourceIdEngineFree } from '../../core/source-resolver.ts';

/** The hold codes the content-repair lane clears today, for the help text. */
const CONTENT_HOLD_CODES = Object.entries(CONTENT_REPAIR_HOLD_KINDS).filter(([, kind]) => kind).map(([code]) => code).join(', ');

/** #7243: how the text status names what superseded a last error. */
const SUPERSEDED_TEXT: Record<NonNullable<NonNullable<SyncStatus['last_error']>['superseded']>['by'] & string, string> = {
  commit: 'the sync committed a page', admission: 'a later sync admitted a page', level_read: 'a later pass read the source', pin: 'a later pass started',
};

export function printSyncStatusHelp(): void {
  console.log(`Usage: gbrain sync status --source <id> [--detail] [--json]
                          [--limit <n>] [--cursor <next_cursor>] [--all] [--hold-state <state>]

Where a managed catch-up stands and what to do next, for an operator agent:
the newest sync pass (convergence: outcome, round, candidates, settled,
remaining, classes) or, for a company-brain source, the cursor (index/total,
pinned target, last advance), pages committed in the last 10 minutes, every
held file and the last recorded failure, each with
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

convergence.classes counts the newest round's paths by class, each with an
action (who finishes it):
  none    matched, adopt, kept, untracked, gone, deleted_same, legacy_same, db_ahead
  owner   sync finishes it: in_flight, import, reparse, delete, keep_db,
          keep_db_pending, legacy_unverified, paused_keep_db
  repair  a person decides: held, drift, delete_drift, deleted_edited, dirty,
          spelling, deletes_withheld
Committed mode reads a file's working-copy dirtiness only for candidates, so
dirty counts only paths sync would otherwise admit.

Every status names last_commit (the commit sync applied through) and live (the
process holding the drain lease, a serve pass included, with its heartbeat and
progress; null when nothing holds it).

Holds are bounded: holds_summary counts every hold by code and by state
(needs_human | actionable | held), then holds lists the first ${PLAIN_STATUS_HOLDS}
(needs_human first). With --detail the list pages (100 per page): holds_page
carries returned, limit, complete, next_cursor and next_command; --limit <n>
sets the page size, --cursor <next_cursor> prints the next page, --all prints
every hold, and --hold-state <state> lists only that state.

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

/** #7243: the holds a plain status lists (the rest are counted in `holds_summary`; `--detail` pages through them). */
export const PLAIN_STATUS_HOLDS = 20;
const HOLD_STATES = ['needs_human', 'actionable', 'held'] as const;
type HoldState = typeof HOLD_STATES[number];
/** A hold's state: a person decides, `sync unblock` has a safe action for it, or it stays held (by design or until its file changes). */
const holdState = (hold: SyncStatusHold): HoldState => hold.needs_human ? 'needs_human' : hold.safe_actions[0] !== 'none' ? 'actionable' : 'held';

/**
 * #7243: the holds of one status read as a bounded listing: counts by code and state over every hold, then one page,
 * needs-human first (a plain status lists the first `PLAIN_STATUS_HOLDS`; `--detail`, `--limit`, `--cursor` and `--all` page).
 * A first page that holds every hold keeps the earlier shape (`holds` only, beside the summary).
 */
function holdsListing(holds: readonly SyncStatusHold[], args: string[], sourceId: string) {
  const { request, rest } = parseListingFlags(args, 'gbrain sync status');
  const stateAt = rest.indexOf('--hold-state');
  const state = stateAt >= 0 ? rest[stateAt + 1] : undefined;
  if (stateAt >= 0 && !HOLD_STATES.includes(state as HoldState)) {
    throw opError('invalid_params', `--hold-state must be one of ${HOLD_STATES.join(', ')} (got "${state ?? ''}").`, `Example: gbrain sync status --source ${sourceId} --detail --hold-state needs_human --json`);
  }
  const sized = args.some(a => a === '--all' || a === '--limit' || a.startsWith('--limit='));
  const page = pageSortedRows(state ? holds.filter(hold => holdState(hold) === state) : holds, hold => [String(HOLD_STATES.indexOf(holdState(hold))), hold.path],
    args.includes('--detail') || sized ? request : { ...request, limit: PLAIN_STATUS_HOLDS }, `sync_status_holds:${sourceId}:${state ?? 'all'}`);
  const summary = { total: holds.length, by_code: topCounts(holds, hold => hold.code, 20), by_state: topCounts(holds, holdState, 20) };
  const paging = page.complete && request.cursor === undefined ? null
    : { returned: page.returned, limit: page.limit, complete: page.complete, next_cursor: page.next_cursor, next_command: nextListingCommand(['gbrain', 'sync', 'status', ...rest], page) };
  return { summary, paging, rows: page.rows };
}

export async function runSyncStatus(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) return printSyncStatusHelp();
  const sourceId = sourceOf(args);
  const status = await readSyncStatus(engine, sourceId, { detail: args.includes('--detail') });
  const listing = holdsListing(status.holds, args, sourceId);
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
  const { readNotifierBlock, formatNotifierBlock } = await import('../../core/notifier/status.ts');
  const notifierBlock = await readNotifierBlock(engine, sourceId).catch(() => null);
  const notifier = notifierBlock && { ...notifierBlock, fix: notifierBlock.fix ? renderAction(notifierBlock.fix, ctx) : null };
  const read = (r: typeof status.cursors_read) => r.status === 'read' ? r : { ...r, fix: renderAction(r.fix, ctx) };
  const { holds: _holds, ...shown } = status;
  const rendered = { ...shown,
    git_push_holds: status.git_push_holds.map(hold => ({ ...hold, fix: renderAction(hold.fix, ctx) })),
    fence_holds: status.fence_holds.map(hold => ({ ...hold, fix: renderAction(hold.fix, ctx) })), next: status.next ? renderAction(status.next, ctx) : null,
    checkpoint_blockers_read: read(status.checkpoint_blockers_read), cursors_read: read(status.cursors_read), terminal_failures_read: read(status.terminal_failures_read),
    landing_read: read(status.landing_read), landing: status.landing?.status === 'ok' ? { ...status.landing, pages: status.landing.pages.map(page => ({ ...page, fix: page.fix ? renderAction(page.fix, ctx) : null })) } : status.landing,
    capacity: { status: snapshot.status, pause_pct: snapshot.pause_pct, low: snapshot.low, paused: snapshot.paused }, freshness, notifier, ...(notices.length ? { notices } : {}),
    // #7243: the holds come last, summary first, so a reader can stop before the rows.
    holds_summary: listing.summary, ...(listing.paging ? { holds_page: listing.paging } : {}), holds: listing.rows.map(hold => ({ ...hold, fix: renderAction(hold.fix, ctx) })) };
  if (args.includes('--json')) return writeJsonDocument(JSON.stringify(rendered, null, 2));
  const c = status.cursor;
  console.log(syncStatusHeadline(status));
  console.log(`  ${c ? c.done ? `last run finished at ${c.index}/${c.total} (pinned ${c.pinned_target?.slice(0, 8) ?? '?'})` : `cursor ${c.index}/${c.total} at pinned target ${c.pinned_target?.slice(0, 8) ?? '?'}`
    + `${c.last_advance_at ? `, last advance ${c.last_advance_at}` : ''}` : 'no managed cursor'}`);
  console.log(`  committed in the last 10 minutes: ${status.committed_last_10m}${status.rate_pages_per_min !== null ? `, ${status.rate_pages_per_min} pages/min` : ''}`);
  // #7243: the applied-through commit, the job doing the work, and what the newest pass pinned against what a stamp backs.
  console.log(`  last synced commit: ${status.last_commit?.slice(0, 8) ?? 'none yet'}`);
  console.log(`  last converged: ${status.last_sync_at ?? 'never'}; last committed write: ${status.last_committed_at ?? 'none yet'}${status.last_committed_at && (!status.last_sync_at || status.last_committed_at > status.last_sync_at) ? ' (still importing since it last converged)' : ''}`);
  const live = status.live;
  console.log(`  live: ${live ? `${live.kind}${live.job_id !== null ? ` job #${live.job_id}` : live.id ? ` ${live.id}` : ''}${live.pid ? ` (PID ${live.pid})` : ''} holds the drain lease since ${live.started_at ?? '?'}`
    + `${live.progress ? `, ${live.progress.committed} page(s) committed since` : ''}${live.stalled ? ', STALLED (no commit or save for the stall window)' : ''}` : 'nothing holds the drain lease'}`);
  const cut = status.interrupted;
  if (cut) console.log(`  INTERRUPTED: pass ${cut.pass_id.slice(0, 8)} stopped before it ended (last write ${cut.since})${cut.holder ? `; its holder ${cut.holder.kind}${cut.holder.pid ? ` (PID ${cut.holder.pid})` : ''} stopped renewing the lease at ${cut.holder.last_heartbeat_at ?? '?'}${cut.holder.progress ? ` after committing ${cut.holder.progress.committed} page(s)` : ''}` : ''}`);
  const pass = status.convergence?.dry_run === false ? status.convergence : null;
  if (pass) console.log(`  newest pass: ${pass.outcome}${pass.stop_reason ? ` (${pass.stop_reason})` : ''}, round ${pass.round}, pinned ${pass.target.slice(0, 8)}; `
    + `${pass.converged_target ? `last converged at ${pass.converged_target.slice(0, 8)} (${pass.converged_at})` : 'no converged stamp stored'}`);
  if (freshness) console.log(`  freshness: ${formatSyncFreshness(freshness)}`);
  if (notifierBlock) console.log(`  ${formatNotifierBlock(sourceId, notifierBlock)}`);
  console.log(`  holds: ${status.holds.length}${status.holds.length ? ` (${status.holds.filter(h => h.needs_human).length} need a person)` : ''}; last error: ${status.last_error ? `${status.last_error.code} [${status.last_error.class}]` : 'none'}`);
  for (const hold of listing.rows) console.log(`    ${hold.path}${hold.slug ? ` (${hold.slug})` : ''}: ${hold.code} [${hold.class}] safe: ${hold.safe_actions.join(',')}${hold.needs_human ? ` NEEDS HUMAN: ${hold.human_reason}` : ''}${hold.attempts > 1 ? ` (held ${hold.attempts} times)` : ''}`);
  if (listing.paging && !listing.paging.complete) {
    const codes = Object.entries(listing.summary.by_code.counts).map(([code, n]) => `${code} ${n}`).join(', ');
    console.log(`    ... ${status.holds.length - listing.rows.length} more not listed here (${codes}${listing.summary.by_code.other ? `, other ${listing.summary.by_code.other}` : ''}); `
      + `${listing.paging?.next_command ? listing.paging.next_command.join(' ') : `gbrain sync status --source ${sourceId} --detail --json`} lists them`);
  }
  const superseded = status.last_error?.superseded;
  if (status.last_error) console.log(`    ${status.last_error.path ?? ''}: ${status.last_error.code}${superseded ? ` (superseded: ${SUPERSEDED_TEXT[superseded.by ?? 'commit']} at ${superseded.at}, after this error${superseded.age_seconds !== undefined ? `, recorded ${Math.round(superseded.age_seconds / 60)} min ago` : ''})` : ` safe: ${status.last_error.safe_actions.join(',')}${status.last_error.needs_human ? ` NEEDS HUMAN: ${status.last_error.human_reason}` : ''}`}`);
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
  const landing = status.landing;
  if (landing?.status === 'ok') {
    console.log(`  synced but not searchable after ${landing.after_seconds} s (last ${landing.window_hours} h, ${landing.checked} page(s)${landing.complete ? '' : ', newest receipts only'}): ${landing.gaps}`
      + `${landing.gaps ? ` (${Object.entries(landing.by_state).map(([state, n]) => `${state} ${n}`).join(', ')})` : ''}`);
    for (const page of landing.pages) console.log(`    ${page.slug}: ${page.state}, synced ${page.age_seconds} s ago${page.fix?.argv ? `; fix: ${page.fix.argv.join(' ')}` : ''}`);
  } else if (landing) console.log(`  synced but not searchable: ${landing.status} (${landing.reason})`);
  for (const hold of status.fence_holds) console.log(`  ${hold.kind} held (${hold.reason}) on ${hold.slug}: ${hold.rows} row(s) kept live; ASK THE USER: ${hold.fix.user_message ?? hold.fix.why}`);
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
    case 'held_needs_human': return `Source ${status.source_id} is synced except ${status.holds.length} held file(s), some waiting on a person (see NEEDS HUMAN below); the rest keeps syncing.`;
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
    case 'pass_unfinished': return `Source ${status.source_id} is resumable: the newest sync pass did not finish; the next sync continues it.`;
    case 'pass_interrupted': return `Source ${status.source_id} is resumable: the newest sync pass stopped before it ended and no process owns it (killed, crashed or stopped by an unrecorded error); the next sync continues it.`;
    case 'pass_abandoned': return `Source ${status.source_id} is blocked: its sync passes keep stopping before they end; another plain sync will not change that (report what doctor shows).`;
    case 'not_converged': return `Source ${status.source_id} is resumable: the newest sync pass ran out of rounds before every path settled.`;
    case 'settle_mismatch': return `Source ${status.source_id} is resumable: a path keeps settling without reading settled; three passes in a row hold it.`;
    case 'deletes_withheld': return `Source ${status.source_id} is blocked: sync withheld a mass delete; the rest of the source is synced.`;
    case 'selection_scoped': return `Source ${status.source_id} is synced at a narrower selection; the plain sync runs the configured one.`;
    case 'admission_paused': return `Source ${status.source_id} is resumable: sync.admission pauses what sync admits.`;
    case 'writeback_failed': return `Source ${status.source_id} is blocked: the Git effect of a file sync rewrote failed and is parked; the checkout lags the brain.`;
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
