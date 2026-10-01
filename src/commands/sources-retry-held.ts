/**
 * `gbrain sources retry-held <id> [--dry-run] [--json]` (fix wave 4 lane B):
 * re-attempts every held connector item of a source on its next sync.
 *
 * It records a retry request for the held keys; on a managed brain it also
 * writes, for each held item that kept a failed receipt, the durable
 * retry-pointer row `--retry-failed` writes, so the next sync admits the item
 * under a new request identity. Nothing runs now: the receipt says how many
 * items are scheduled and prints the sync and status commands.
 */
import type { BrainEngine } from '../core/engine.ts';
import { OperationError } from '../core/ops/contract.ts';
import { managedBrain, readAllSourceHolds, readHoldRetryKeys, requestHoldRetry, writeHeldRetryPointer } from '../core/connectors/item-holds-store.ts';

export interface RetryHeldReceipt {
  source_id: string;
  dry_run: boolean;
  scheduled: number;
  items: Array<{ key: string; code: string; action: 'would_retry' | 'retry_scheduled'; next_action: string }>;
  next_action: string;
}

export async function retryHeld(engine: BrainEngine, sourceId: string, opts: { dryRun?: boolean } = {}): Promise<RetryHeldReceipt> {
  const [source] = await engine.executeRaw<{ incarnation: string; config: Record<string, unknown> }>(
    'SELECT incarnation::text AS incarnation,config FROM sources WHERE id=$1 AND archived IS NOT TRUE', [sourceId]);
  if (!source) throw new OperationError('not_found', `Source "${sourceId}" was not found.`, 'List sources with: gbrain sources list');
  if (source.config.kind !== 'google' && source.config.kind !== 'github') {
    throw new OperationError('invalid_params', `Source "${sourceId}" is not a connector source; only Google and GitHub sources hold items.`,
      `For a Git source, re-attempt failed files with: gbrain sync --source ${sourceId} --retry-failed`);
  }
  const held = (await readAllSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.held ?? [];
  const dryRun = opts.dryRun === true;
  const sync = `gbrain sync --source ${sourceId}`;
  const status = `gbrain sources status ${sourceId}`;
  if (!held.length) return { source_id: sourceId, dry_run: dryRun, scheduled: 0, items: [], next_action: `No held items for ${sourceId}.` };
  const managed = await managedBrain(engine);
  if (!dryRun) {
    // Pointers first: a sync that sees the retry request must already find the replacement identity.
    if (managed) for (const record of held) if (record.request_id) await writeHeldRetryPointer(engine, sourceId, record.request_id);
    await requestHoldRetry(engine, sourceId, source.incarnation, held.map(record => record.key));
  }
  const already = new Set(dryRun ? await readHoldRetryKeys(engine, sourceId, source.incarnation) : []);
  const items = held.map(record => ({ key: record.key, code: record.code,
    action: dryRun && !already.has(record.key) ? 'would_retry' as const : 'retry_scheduled' as const,
    next_action: dryRun ? 'Run the same command without --dry-run to schedule it.' : `Re-attempted on the next ${sync}.` }));
  return { source_id: sourceId, dry_run: dryRun, scheduled: dryRun ? 0 : held.length, items,
    next_action: dryRun ? `${held.length} held item(s) would be scheduled; run: gbrain sources retry-held ${sourceId}`
      : `${held.length} held item(s) scheduled; none has run yet. Run them now with: ${sync}, then verify with: ${status}` };
}

export async function runRetryHeld(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain sources retry-held <id> [--dry-run] [--json]\n\n'
      + 'Re-attempt every held connector item of a Google or GitHub source on its next sync.\n'
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
  for (const item of receipt.items) console.log(`  ${item.key} (${item.code}): ${item.action}`);
  console.log(receipt.next_action);
}
