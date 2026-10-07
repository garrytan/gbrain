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
 */
import type { BrainEngine } from '../core/engine.ts';
import type { Action } from '../core/agent-output.ts';
import { OperationError } from '../core/ops/contract.ts';
import { managedBrain, readAllSourceHolds, readHoldRetryKeys, requestHoldRetry, writeHeldRetryPointer } from '../core/connectors/item-holds-store.ts';
import { isConnectorSourceKind } from '../core/persistence/connector-identity.ts';
import { fenceAutoRepairFor, holdRepairSteps, readGitHoldRetryPaths, readGitSourceHolds, requestGitHoldRetry } from '../core/persistence/sync-holds.ts';
import type { FenceAutoRepair } from '../core/fence-repair/hold-fix.ts';

export interface RetryHeldReceipt {
  source_id: string;
  /** `connector`: held Google/GitHub items; `git`: held files of a Git source. */
  kind: 'connector' | 'git';
  dry_run: boolean;
  scheduled: number;
  items: Array<{ key: string; code: string; reason?: string; action: 'would_retry' | 'retry_scheduled'; next_action: string }>;
  next_action: string;
  /** Git sources with held files: the one next step (the sync that re-screens them, or the scheduling command after a dry run). */
  fix?: Action;
}

interface Scheduled { items: Array<{ key: string; code: string; reason?: string; already: boolean }>; sync: string[]; fenceAuto?: FenceAutoRepair }

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

async function scheduleGitFiles(engine: BrainEngine, sourceId: string, incarnation: string, dryRun: boolean): Promise<Scheduled> {
  const held = (await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? [];
  // Managed sync refuses to pull; the plain command is the classic one.
  const sync = ['gbrain', 'sync', '--source', sourceId, ...(await managedBrain(engine) ? ['--no-pull'] : [])];
  if (!held.length) return { items: [], sync };
  if (!dryRun) await requestGitHoldRetry(engine, sourceId, incarnation, held.map(record => record.path));
  const already = new Set(dryRun ? await readGitHoldRetryPaths(engine, sourceId, incarnation) : []);
  const fenceAuto = await fenceAutoRepairFor(engine, held);
  return { items: held.map(record => ({ key: record.path, code: record.code, ...(record.meta.reason ? { reason: record.meta.reason } : {}),
    already: already.has(record.path) })), sync, ...(fenceAuto ? { fenceAuto } : {}) };
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
  return { text: `${count} held file(s) scheduled for a re-screen; none has run yet. ${automatic} Run it now with: ${sync}, then verify with: gbrain sources status ${sourceId}. `
      + `A file that still refuses stays held; ${holdRepairSteps(sourceId, { fences, others: count - fences }, scheduled.fenceAuto).text}.`,
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
  const items = scheduled.items.map(item => ({ key: item.key, code: item.code, ...(item.reason ? { reason: item.reason } : {}),
    action: dryRun && !item.already ? 'would_retry' as const : 'retry_scheduled' as const,
    next_action: dryRun ? 'Run the same command without --dry-run to schedule it.' : `${kind === 'git' ? 'Re-screened' : 'Re-attempted'} on the next ${sync}.` }));
  return { source_id: sourceId, kind, dry_run: dryRun, scheduled: dryRun ? 0 : count, items, next_action: next, ...(step ? { fix: step.fix } : {}) };
}

export async function runRetryHeld(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain sources retry-held <id> [--dry-run] [--json]\n\n'
      + 'Re-attempt every held connector item of a Google or GitHub source on its next sync, or re-screen every\n'
      + 'held file of a Git source on its next sync (most held files re-screen by themselves when they change).\n'
      + 'Nothing runs now. A file that still refuses stays held: preview frontmatter holds with\n'
      + "'gbrain repair frontmatter --source <id>' and fence holds (invalid_fence) with 'gbrain repair fences --source <id>'.\n"
      + '  --dry-run   show what would be scheduled; change nothing\n  --json      print the receipt as JSON');
    return;
  }
  const json = args.includes('--json');
  const positional = args.filter(arg => !arg.startsWith('--'));
  const unknown = args.find(arg => arg.startsWith('--') && arg !== '--dry-run' && arg !== '--json');
  if (unknown) throw new OperationError('invalid_params', `Unknown option: ${unknown}.`, 'Usage: gbrain sources retry-held <id> [--dry-run] [--json]');
  if (positional.length !== 1) throw new OperationError('invalid_params', 'Name one source.', 'Usage: gbrain sources retry-held <id> [--dry-run] [--json]');
  const receipt = await retryHeld(engine, positional[0], { dryRun: args.includes('--dry-run') });
  if (json) { console.log(JSON.stringify(receipt, null, 2)); return; }
  for (const item of receipt.items) console.log(`  ${item.key} (${item.code}${item.reason ? `, ${item.reason}` : ''}): ${item.action}`);
  console.log(receipt.next_action);
}
