import type { GBrainConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { OperationError } from '../core/ops/contract.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import { writeStdoutFinal } from '../core/cli-force-exit.ts';
import { formatManagedStaleExtraction, type ManagedLinkExtraction } from '../core/persistence/links-maintenance.ts';

/** A live PGLite owner holds the database; `extract --stale` runs inside it instead of failing on the lock. */
export async function maybeDelegateExtractStale(hostConfig: GBrainConfig | null, args: string[]): Promise<boolean> {
  const brainId = resolveBrainId(getCliOptions().brain, process.cwd());
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url || !inspectLockHolder(config.database_path).held) return false;
  const json = args.includes('--json');
  try {
    const params: Record<string, unknown> = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--dry-run') params.dry_run = true;
      else if (arg === '--source-id') {
        const value = args[++i];
        if (!value || value.startsWith('-')) throw new OperationError('invalid_params', '--source-id requires a value.');
        params.source_id = value;
      } else if (arg === '--source') {
        if (args[++i] !== 'db') throw new OperationError('invalid_params', "extract --stale is DB-source only; drop '--source fs'.");
      } else if (!['--stale', '--json', '--include-frontmatter', '--catch-up', 'all'].includes(arg)) {
        throw new OperationError('invalid_params', `Unsupported owner-delegated extract --stale option: ${arg}.`);
      }
    }
    const delegated = await maybeDelegateLocalAdministration('writer_extract_stale', params, config, { timeoutMs: 86_400_000 });
    if (!delegated.handled) throw new OperationError('owner_unavailable', 'The registered owner stopped before extraction. Retry the same command.');
    const result = delegated.result as ManagedLinkExtraction;
    const dryRun = params.dry_run === true;
    await writeStdoutFinal(formatManagedStaleExtraction(result, dryRun, json) + '\n');
    return true;
  } catch (error) {
    if (await reportPersistenceCliError(error, json)) return true;
    throw error;
  }
}
