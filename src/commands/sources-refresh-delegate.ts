import type { GBrainConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { persistenceResidentOwner } from '../core/persistence/resident-owner.ts';
import { OperationError } from '../core/ops/contract.ts';
import type { WorktreeRefreshResult } from '../core/persistence/worktree-refresh.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import { parseRefreshArgs, printRefreshOutcome } from './sources-refresh.ts';

/**
 * A live owner (`gbrain serve` on a PGLite or Rust brain) holds the database and its writer
 * lock; `gbrain sources refresh` runs inside that owner over the local
 * persistence socket instead of waiting on or failing at the lock. Output and
 * refusals print exactly as a local refresh's do.
 */
export async function maybeDelegateSourcesRefresh(hostConfig: GBrainConfig | null, args: string[]): Promise<boolean> {
  const brainId = resolveBrainId(getCliOptions().brain, process.cwd());
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (!config || !(await persistenceResidentOwner(config))) return false;
  const json = args.includes('--json');
  try {
    const { sourceId, options } = parseRefreshArgs(args);
    const delegated = await maybeDelegateLocalAdministration('writer_refresh', {
      source_id: sourceId, dry_run: options.dryRun === true, resume: options.resume === true, abandon: options.abandon === true,
      ...(options.waitDrainMs !== undefined ? { wait_drain_ms: options.waitDrainMs } : {}),
      ...(options.fetchTimeoutMs !== undefined ? { fetch_timeout_ms: options.fetchTimeoutMs } : {}),
    }, config, { timeoutMs: 86_400_000 });
    if (!delegated.handled) throw new OperationError('owner_unavailable', 'The registered owner stopped before the refresh started.',
      'Run the same gbrain sources refresh command again; nothing was fetched or merged.');
    printRefreshOutcome({ result: delegated.result as WorktreeRefreshResult }, json);
    return true;
  } catch (error) {
    if (error instanceof OperationError) { printRefreshOutcome({ error }, json); return true; }
    if (await reportPersistenceCliError(error, json)) return true;
    throw error;
  }
}
