/**
 * `gbrain sources retry-held <id> [--dry-run] [--json]` (fix wave 4 lane B):
 * re-attempts every held connector item of a source on its next sync.
 *
 * It records a retry request for the held keys; on a managed brain it also
 * writes, for each held item that kept a failed receipt, the durable
 * retry-pointer row `--retry-failed` writes, so the next sync admits the item
 * under a new request identity. Nothing runs now: the receipt says how many
 * items are scheduled and prints the sync and status commands.
 *
 * #5988: on a Git source it records a re-screen request (op `sync-hold-retry`)
 * for every held file; the next sync adds those paths to its manifest even if
 * Git did not touch them, imports each one that now passes and keeps the rest
 * held. Most holds re-screen by themselves (changed or deleted file, newer
 * gbrain); the request covers causes outside the file (#6188: a prepare-time
 * fence hold whose stored-row conflict was fixed in the database).
 *
 * #6865: `--unindexed` runs the bounded unindexed-file detector for a Git
 * source (committed files with no page, no hold and no scheduled re-screen;
 * persistence/unindexed-files.ts), schedules those paths the same way, stores
 * the result doctor `unindexed_files` reads, and prints the follow-up sync.
 * `--dry-run` lists them and writes nothing.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { Action } from '../core/agent-output.ts';
import { OperationError } from '../core/ops/contract.ts';
import { managedBrain, readAllSourceHolds, readHoldRetryKeys, requestHoldRetry, writeHeldRetryPointer } from '../core/connectors/item-holds-store.ts';
import { isConnectorSourceKind } from '../core/persistence/connector-identity.ts';
import { GIT_HOLD_OP, gitHoldFingerprint, outOfAttemptsHold, fenceAutoRepairFor, holdRepairSteps, readGitHoldRetryPaths, readGitSourceHolds, requestGitHoldRetry, type GitHoldRecord } from '../core/persistence/sync-holds.ts';
import { readManagedSyncBacklog } from '../core/persistence/sync-drain.ts';
import type { FenceAutoRepair } from '../core/fence-repair/hold-fix.ts';
import { companyBrainProfile } from '../core/company-brain/policy.ts';
import { findUnindexedFiles, refreshUnindexedFiles, unindexedScanBudgetMs, type UnindexedScan } from '../core/persistence/unindexed-files.ts';

export interface RetryHeldReceipt {
  source_id: string;
  /** `connector`: held Google/GitHub items; `git`: held files of a Git source. */
  kind: 'connector' | 'git';
  dry_run: boolean;
  scheduled: number;
  items: Array<{ key: string; code: string; reason?: string; fingerprint?: string; action: 'would_retry' | 'retry_scheduled'; next_action: string }>;
  /** #7364 (git): the hold rows this receipt read (`op_checkpoints` op `sync-hold` of the source's current incarnation), so a refusal that names a hold this listing missed shows which row each one read. */
  hold_rows?: { op: string; source_id: string; incarnation: string; read: number };
  next_action: string;
  /** Git sources with held files: the one next step (the sync that re-screens them, or the scheduling command after a dry run). */
  fix?: Action;
  /** `--unindexed`: what the detector pass covered and found (counts only). */
  unindexed?: { complete: boolean; target: string | null; scanned: number; unindexed: number; slug_taken: number; already_scheduled: number; by_code: Record<string, number>; metafile_skipped: number };
}

interface Scheduled { items: Array<{ key: string; code: string; reason?: string; fingerprint?: string; already: boolean }>; sync: string[]; fenceAuto?: FenceAutoRepair }

async function scheduleConnectorItems(engine: BrainEngine, sourceId: string, incarnation: string, dryRun: boolean): Promise<Scheduled> {
  const held = (await readAllSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.held ?? [];
  const sync = ['gbrain', 'sync', '--source', sourceId];
  if (!held.length) return { items: [], sync };
  if (!dryRun) {
    // Pointers first: a sync that sees the retry request must already find the replacement identity.
    if (await managedBrain(engine)) for (const record of held) if (record.request_id) await writeHeldRetryPointer(engine, sourceId, record.request_id);
    await requestHoldRetry(engine, sourceId, incarnation, held.map(record => record.key));
  }
  const already = new Set(dryRun ? await readHoldRetryKeys(engine, sourceId, incarnation) : []);
  return { items: held.map(record => ({ key: record.key, code: record.code, already: already.has(record.key) })), sync };
}

/**
 * #6278: the follow-up sync keeps the run's processing options (`--no-embed`
 * and friends) instead of starting a second cursor: the unfinished managed
 * cursor's options when one exists, else the arguments a `preparation_stalled`
 * hold recorded, else the plain command.
 */
export async function gitFollowUpSync(engine: BrainEngine, sourceId: string, held: ReadonlyArray<Pick<GitHoldRecord, 'code' | 'meta'>>): Promise<string[]> {
  if (!await managedBrain(engine)) return ['gbrain', 'sync', '--source', sourceId];
  const [backlog] = await readManagedSyncBacklog(engine, [sourceId]).catch(() => []);
  if (backlog) return ['gbrain', 'sync', ...backlog.resume_args];
  const stalled = held.find(record => outOfAttemptsHold(record.code) && record.meta.stall?.sync_argv?.length);
  return ['gbrain', 'sync', ...(stalled?.meta.stall?.sync_argv ?? ['--source', sourceId, '--no-pull'])];
}

async function scheduleGitFiles(engine: BrainEngine, sourceId: string, incarnation: string, dryRun: boolean): Promise<Scheduled> {
  const held = (await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? [];
  // Managed sync refuses to pull; the plain command is the classic one.
  const sync = await gitFollowUpSync(engine, sourceId, held);
  if (!held.length) return { items: [], sync };
  if (!dryRun) await requestGitHoldRetry(engine, sourceId, incarnation, held.map(record => record.path));
  const already = new Set(dryRun ? await readGitHoldRetryPaths(engine, sourceId, incarnation) : []);
  const fenceAuto = await fenceAutoRepairFor(engine, held);
  return { items: held.map(record => ({ key: record.path, code: record.code, ...(record.meta.reason ? { reason: record.meta.reason } : {}),
    fingerprint: gitHoldFingerprint(record.source_id, record.incarnation, record.path), already: already.has(record.path) })), sync, ...(fenceAuto ? { fenceAuto } : {}) };
}

function gitNextStep(sourceId: string, dryRun: boolean, scheduled: Scheduled): { text: string; fix: Action } {
  const count = scheduled.items.length;
  const sync = scheduled.sync.join(' ');
  const verify = { argv: ['gbrain', 'sources', 'status', sourceId, '--json'] };
  const automatic = 'Most holds re-screen on the next sync by themselves (the file changed or was deleted, or a newer gbrain can read it); '
    + 'a scheduled re-screen covers a cause outside the file, such as a conflicting page that has since moved.';
  if (dryRun) return { text: `${count} held file(s) would be scheduled for a re-screen; run: gbrain sources retry-held ${sourceId}. ${automatic}`,
    fix: { argv: ['gbrain', 'sources', 'retry-held', sourceId], consent: [], actor: 'agent', requires_exclusive: false, verify,
      why: `Schedules a re-screen of ${count} held file(s) on the next sync of ${sourceId}; nothing runs now.` } };
  const fences = scheduled.items.filter(item => item.code === 'invalid_fence').length;
  const concurrent = scheduled.items.filter(item => item.code === 'concurrent_write').length;
  const stalled = scheduled.items.filter(item => outOfAttemptsHold(item.code)).length;
  const dirty = scheduled.items.filter(item => item.code === 'worktree_dirty').length;
  const drift = scheduled.items.filter(item => item.code === 'file_drift').length;
  return { text: `${count} held file(s) scheduled for a re-screen; none has run yet. ${automatic} Run it now with: ${sync}, then verify with: gbrain sources status ${sourceId}. `
      + `A file that still refuses stays held; ${holdRepairSteps(sourceId, { fences, others: count - fences - concurrent - stalled - dirty - drift, concurrent, stalled, dirty, drift }, scheduled.fenceAuto).text}.`,
    fix: { argv: scheduled.sync, consent: [], actor: 'agent', requires_exclusive: false, verify,
      why: `The sync re-screens the ${count} scheduled file(s): each one that now passes imports and its hold clears; the rest stay held without blocking the sync.` } };
}

export async function retryHeld(engine: BrainEngine, sourceId: string, opts: { dryRun?: boolean } = {}): Promise<RetryHeldReceipt> {
  const [source] = await engine.executeRaw<{ incarnation: string; config: Record<string, unknown> }>(
    'SELECT incarnation::text AS incarnation,config FROM sources WHERE id=$1 AND archived IS NOT TRUE', [sourceId]);
  if (!source) throw new OperationError('not_found', `Source "${sourceId}" was not found.`, 'List sources with: gbrain sources list');
  const kind = isConnectorSourceKind(source.config.kind) ? 'connector' as const : 'git' as const;
  const dryRun = opts.dryRun === true;
  const scheduled = await (kind === 'connector' ? scheduleConnectorItems : scheduleGitFiles)(engine, sourceId, source.incarnation, dryRun);
  const count = scheduled.items.length;
  const sync = scheduled.sync.join(' ');
  const step = kind === 'git' && count ? gitNextStep(sourceId, dryRun, scheduled) : undefined;
  const next = !count ? `No held ${kind === 'connector' ? 'items' : 'files'} for ${sourceId}.`
    : step ? step.text
      : dryRun ? `${count} held item(s) would be scheduled; run: gbrain sources retry-held ${sourceId}`
        : `${count} held item(s) scheduled; none has run yet. Run them now with: ${sync}, then verify with: gbrain sources status ${sourceId}`;
  const items = scheduled.items.map(item => ({ key: item.key, code: item.code, ...(item.reason ? { reason: item.reason } : {}), ...(item.fingerprint ? { fingerprint: item.fingerprint } : {}),
    action: dryRun && !item.already ? 'would_retry' as const : 'retry_scheduled' as const }));
  const holdRows = kind === 'git' ? { hold_rows: { op: GIT_HOLD_OP, source_id: sourceId, incarnation: source.incarnation, read: count } } : {};
  return receiptOf({ source_id: sourceId, kind, dry_run: dryRun, scheduled: dryRun ? 0 : count, ...holdRows, ...(step ? { fix: step.fix } : {}) }, items, next,
    dryRun ? 'Run the same command without --dry-run to schedule it.' : `${kind === 'git' ? 'Re-screened' : 'Re-attempted'} on the next ${sync}.`);
}

/** The receipt both modes print; every item shares one next step (schedule it after a dry run, else the run that re-attempts it). */
function receiptOf(base: Omit<RetryHeldReceipt, 'items' | 'next_action'>, items: Array<Omit<RetryHeldReceipt['items'][number], 'next_action'>>, next: string, itemNext: string): RetryHeldReceipt {
  return { ...base, items: items.map(item => ({ ...item, next_action: itemNext })), next_action: next };
}

const UNINDEXED_VERIFY = { argv: ['gbrain', 'doctor', '--only', 'unindexed_files', '--json'] };

/**
 * #6865 `--unindexed`: one bounded detector pass for a Git source. A real run schedules the found files for a re-screen
 * on the next sync and stores the result (continuing an incomplete stored scan); a dry run lists them and writes nothing.
 */
export async function retryUnindexed(engine: BrainEngine, sourceId: string, opts: { dryRun?: boolean; budgetMs?: number } = {}): Promise<RetryHeldReceipt> {
  const [source] = await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1 AND archived IS NOT TRUE', [sourceId]);
  if (!source) throw new OperationError('not_found', `Source "${sourceId}" was not found.`, 'List sources with: gbrain sources list');
  if (source.config?.kind != null || companyBrainProfile(source.config ?? {})) throw new OperationError('invalid_params',
    `Source ${sourceId} is a ${source.config?.kind != null ? 'connector' : 'company-brain'} source; --unindexed applies to managed Git sources only.`,
    `Run gbrain sources retry-held ${sourceId} without --unindexed to re-attempt its held items.`);
  const dryRun = opts.dryRun === true;
  const deadlineAt = Date.now() + (opts.budgetMs ?? await unindexedScanBudgetMs(engine, sourceId));
  let scan: UnindexedScan, scheduled: string[] = [];
  if (dryRun) scan = await findUnindexedFiles(engine, sourceId, { deadlineAt });
  else ({ scan, scheduled } = await refreshUnindexedFiles(engine, sourceId, { deadlineAt }));
  const sync = await gitFollowUpSync(engine, sourceId, []);
  const again = ['gbrain', 'sources', 'retry-held', sourceId, '--unindexed'];
  const count = scan.files.length;
  const partial = scan.complete ? '' : ` The scan stopped at its time budget after ${scan.scanned} file(s); run ${again.join(' ')} again to continue.`;
  const waiting = count + scan.scheduled;
  const next = !count ? (scan.complete ? `No unindexed files for ${sourceId}.` : `No unindexed files found so far in ${sourceId}.`)
      + (scan.scheduled ? ` ${scan.scheduled} file(s) already wait for a re-screen; run: ${sync.join(' ')}.` : '') + partial
    : dryRun ? `${count} unindexed file(s) would be scheduled for a re-screen; run: ${again.join(' ')}.${partial}`
      : `${count} unindexed file(s) scheduled for a re-screen; none has run yet. Run it now with: ${sync.join(' ')}, then verify with: ${UNINDEXED_VERIFY.argv.join(' ')}. `
        + `Each file that passes imports; each one that refuses is held and listed by gbrain sources status ${sourceId}.${partial}`;
  const fix: Action | undefined = dryRun && count
    ? { argv: again, consent: [], actor: 'agent', requires_exclusive: false, verify: UNINDEXED_VERIFY, why: `Schedules ${count} unindexed file(s) of ${sourceId} for a re-screen on its next sync; nothing runs now.` }
    : !dryRun && waiting
      ? { argv: sync, consent: [], actor: 'agent', requires_exclusive: false, verify: UNINDEXED_VERIFY,
        why: `The sync re-screens the ${waiting} scheduled file(s): each one that passes imports and each one that refuses is recorded as a hold.` }
      : !scan.complete ? { argv: again, consent: [], actor: 'agent', requires_exclusive: false, verify: UNINDEXED_VERIFY, why: `Continues the scan of ${sourceId} where this pass stopped.` }
        : undefined;
  return receiptOf({ source_id: sourceId, kind: 'git', dry_run: dryRun, scheduled: scheduled.length, ...(fix ? { fix } : {}),
    unindexed: { complete: scan.complete, target: scan.target, scanned: scan.scanned, unindexed: scan.unindexed, slug_taken: scan.slug_taken, already_scheduled: scan.scheduled, by_code: scan.by_code, metafile_skipped: scan.metafile_skipped } },
  scan.files.map(file => ({ key: file.path, code: file.code, reason: 'unindexed', action: dryRun ? 'would_retry' as const : 'retry_scheduled' as const })), next,
  dryRun ? 'Run the same command without --dry-run to schedule it.' : `Re-screened on the next ${sync.join(' ')}.`);
}

export async function runRetryHeld(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain sources retry-held <id> [--unindexed] [--dry-run] [--json]\n\n'
      + 'Re-attempt every held connector item of a Google or GitHub source on its next sync, or re-screen every\n'
      + 'held file of a Git source on its next sync (most held files re-screen by themselves when they change).\n'
      + 'Nothing runs now. A file that still refuses stays held: preview frontmatter holds with\n'
      + "'gbrain repair frontmatter --source <id>' and fence holds (invalid_fence) with 'gbrain repair fences --source <id>';\n"
      + "a preparation_stalled hold needs no file repair: inspect 'gbrain sources writer status --source <id> --json', then rerun the sync it prints.\n"
      + "  --unindexed find committed files of a managed Git source with no page and no hold (files an older gbrain\n"
      + "              refused before refusals became holds), schedule them for a re-screen on the next sync and refresh\n"
      + "              doctor unindexed_files; the scan is bounded and the next run continues an incomplete one\n"
      + '  --dry-run   show what would be scheduled; change nothing\n  --json      print the receipt as JSON');
    return;
  }
  const json = args.includes('--json');
  const positional = args.filter(arg => !arg.startsWith('--'));
  const unknown = args.find(arg => arg.startsWith('--') && arg !== '--dry-run' && arg !== '--json' && arg !== '--unindexed');
  if (unknown) throw new OperationError('invalid_params', `Unknown option: ${unknown}.`, 'Usage: gbrain sources retry-held <id> [--unindexed] [--dry-run] [--json]');
  if (positional.length !== 1) throw new OperationError('invalid_params', 'Name one source.', 'Usage: gbrain sources retry-held <id> [--unindexed] [--dry-run] [--json]');
  const receipt = await (args.includes('--unindexed') ? retryUnindexed : retryHeld)(engine, positional[0], { dryRun: args.includes('--dry-run') });
  // #6712 PR 2: a soak intervention (soak-counters.ts).
  if (!args.includes('--dry-run')) await (await import('../core/persistence/soak-counters.ts')).recordSoakEvent(engine, 'retry_held');
  if (json) { console.log(JSON.stringify(receipt, null, 2)); return; }
  for (const item of receipt.items) console.log(`  ${item.key} (${item.code}${item.reason ? `, ${item.reason}` : ''}): ${item.action}`);
  console.log(receipt.next_action);
}
