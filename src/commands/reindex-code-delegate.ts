import type { GBrainConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { OperationError } from '../core/ops/contract.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import type { ReindexCodeOpts, ReindexCodeResult } from './reindex-code.ts';

export function parseReindexCodeDelegateArgs(args: string[]): ReindexCodeOpts {
  const options: ReindexCodeOpts = {};
  const booleans = { '--force': 'force', '--no-embed': 'noEmbed', '--dry-run': 'dryRun', '--yes': 'yes', '-y': 'yes', '--json': 'json' } as const;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const key = booleans[arg as keyof typeof booleans];
    if (key) { options[key] = true; continue; }
    if (!['--source', '--workers', '--concurrency', '--max-cost', '--max-cost-usd'].includes(arg)) throw new OperationError('invalid_params', 'Unsupported owner-delegated reindex-code option. Run gbrain reindex-code --help.');
    const value = args[++i];
    if (!value || value.startsWith('-')) throw new OperationError('invalid_params', `${arg} requires a value.`);
    if (arg === '--source') options.sourceId = value;
    else if (arg === '--workers' || arg === '--concurrency') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 64) throw new OperationError('invalid_params', 'workers must be an integer from 1 to 64.');
      options.workers = Number(value);
    } else {
      if (!Number.isFinite(Number(value)) || Number(value) <= 0) throw new OperationError('invalid_params', 'Owner-delegated reindex requires a positive numeric cost cap.');
      options.maxCostUsd = Number(value);
    }
  }
  return options;
}

export async function maybeDelegateReindexCode(hostConfig: GBrainConfig | null, args: string[]): Promise<boolean> {
  const brainId = resolveBrainId(getCliOptions().brain, process.cwd());
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url || !inspectLockHolder(config.database_path).held) return false;
  try {
    const options = parseReindexCodeDelegateArgs(args);
    if (!options.noEmbed && !options.dryRun && !options.yes) throw new OperationError('confirmation_required', 'Pass --no-embed for keyless text recovery, --dry-run for a preview, or --yes to authorize embedding costs.');
    const delegated = await maybeDelegateLocalAdministration('writer_reindex_code', { options }, config, { timeoutMs: 86_400_000 });
    if (!delegated.handled) throw new OperationError('owner_unavailable', 'The registered owner stopped before reindex admission. Retry the same command.');
    const result = delegated.result as ReindexCodeResult;
    await writeStdoutFinal(options.json ? JSON.stringify(result) + '\n' :
      `reindex-code: ${result.reindexed} reindexed, ${result.skipped} skipped, ${result.failed} failed (${result.codePages} code pages).\n`);
    if (result.failed) setCliExitVerdict(1);
    return true;
  } catch (error) {
    if (await reportPersistenceCliError(error, args.includes('--json'))) return true;
    throw error;
  }
}
