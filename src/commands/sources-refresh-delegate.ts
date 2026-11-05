import type { GBrainConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { OperationError } from '../core/ops/contract.ts';
import { OperationTimeoutError, withTimeout } from '../core/timeout.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { REFRESH_HOLD_KEY, type WorktreeRefreshResult } from '../core/persistence/worktree-refresh.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import { parseRefreshArgs, printRefreshOutcome } from './sources-refresh.ts';

/**
 * A live PGLite owner (`gbrain serve`) holds the database and its writer
 * lock; `gbrain sources refresh` runs inside that owner over the local
 * persistence socket instead of waiting on or failing at the lock. Output and
 * refusals print exactly as a local refresh's do.
 */
export async function maybeDelegateSourcesRefresh(hostConfig: GBrainConfig | null, args: string[]): Promise<boolean> {
  const brainId = resolveBrainId(getCliOptions().brain, process.cwd());
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url || !inspectLockHolder(config.database_path).held) return false;
  const json = args.includes('--json');
  try {
    const { sourceId, options } = parseRefreshArgs(args);
    const delegated = await maybeDelegateLocalAdministration('writer_refresh', {
      source_id: sourceId, dry_run: options.dryRun === true, resume: options.resume === true, abandon: options.abandon === true,
      ...(options.waitDrainMs !== undefined ? { wait_drain_ms: options.waitDrainMs } : {}),
      ...(options.fetchTimeoutMs !== undefined ? { fetch_timeout_ms: options.fetchTimeoutMs } : {}),
    }, config, { timeoutMs: 86_400_000 });
    if (!delegated.handled) throw new OperationError('owner_unavailable', 'The registered PGLite owner stopped before the refresh started.',
      'Run the same gbrain sources refresh command again; nothing was fetched or merged.');
    printRefreshOutcome({ result: delegated.result as WorktreeRefreshResult }, json);
    return true;
  } catch (error) {
    if (error instanceof OperationError) { printRefreshOutcome({ error }, json); return true; }
    if (await reportPersistenceCliError(error, json)) return true;
    throw error;
  }
}

/** Inspect only the hold DB key through the authenticated owner; mutations still require the direct maintenance window. */
export async function maybeDelegateSourcesRefreshHoldGet(hostConfig: GBrainConfig | null, args: string[]): Promise<boolean> {
  if (args[0] !== 'get') return false;
  const brainId = resolveBrainId(getCliOptions().brain, process.cwd());
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url || !inspectLockHolder(config.database_path).held) return false;
  try {
    if (!(args.length === 1 || args.length === 2 && args[1] === '--json')) {
      throw new OperationError('invalid_params', 'Invalid sources refresh-hold arguments. Nothing was written.',
        'Usage: gbrain sources refresh-hold get [--json]');
    }
    const timeoutMs = getCliOptions().timeoutMs;
    const pending = maybeDelegateLocalAdministration('writer_refresh_hold_get', {}, config,
      { timeoutMs: timeoutMs ?? undefined });
    const delegated = await (timeoutMs === null ? pending : withTimeout(pending, timeoutMs, 'gbrain sources refresh-hold get'));
    if (!delegated.handled) return false; // Holder released before delegation: normal direct read is safe again.
    const result = delegated.result as Record<string, unknown> | null;
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).length !== 3 || Object.keys(result).some(key => !['key', 'present', 'value'].includes(key))
      || result.key !== REFRESH_HOLD_KEY || typeof result.present !== 'boolean'
      || (result.present ? typeof result.value !== 'string' : result.value !== null)) {
      throw new OperationError('unavailable', 'The local persistence owner returned an invalid refresh-hold result. Nothing was written.',
        'Inspect the running owner before retrying this read; do not use this response as a saved refresh-hold value.');
    }
    console.log(JSON.stringify(result));
    return true;
  } catch (error) {
    if (error instanceof OperationTimeoutError) {
      console.error(`${error.label} timed out.`);
      setCliExitVerdict(124);
      return true;
    }
    if (await reportPersistenceCliError(error, args.includes('--json'))) return true;
    throw error;
  }
}
