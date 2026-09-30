import type { GBrainConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { PersistenceIpcTransportError } from '../core/persistence/ipc.ts';
import { validateEmbedFactsOptions, type EmbedFactsOptions } from '../core/embed-facts-options.ts';
import type { EmbedFactsResult } from '../core/embed-facts.ts';
import { OperationError } from '../core/ops/contract.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';

export function parseFactEmbedArgs(args: string[]): EmbedFactsOptions {
  if (!args.includes('--stale') || !args.includes('--facts')) {
    throw new OperationError('invalid_params', 'Use embed --stale --facts --source <id> [--dry-run | --yes --max-cost-usd N] [--max-facts N]');
  }
  const options: Record<string, unknown> = {};
  const booleans = { '--dry-run': 'dryRun', '--yes': 'yes' } as const;
  const values = { '--source': 'sourceId', '--max-cost-usd': 'maxCostUsd', '--max-facts': 'maxFacts', '--batch-size': 'batchSize', '--budget-ms': 'budgetMs' } as const;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--stale', '--facts', '--json', '--quiet'].includes(arg)) continue;
    const boolean = booleans[arg as keyof typeof booleans];
    if (boolean) { options[boolean] = true; continue; }
    const key = values[arg as keyof typeof values];
    if (!key) throw new OperationError('invalid_params', 'Use embed --stale --facts with only source, preview, approval, and bounded repair options');
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${arg} requires a value`);
    if (options[key] !== undefined) throw new OperationError('invalid_params', `${arg} may be supplied only once`);
    options[key] = key === 'sourceId' ? value : Number(value);
  }
  return validateEmbedFactsOptions(options);
}

export async function maybeDelegateFactEmbed(hostConfig: GBrainConfig | null, args: string[]): Promise<boolean> {
  const options = parseFactEmbedArgs(args);
  const brainId = resolveBrainId(getCliOptions().brain, process.cwd());
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url || !inspectLockHolder(config.database_path).held) return false;
  try {
    const delegated = await maybeDelegateLocalAdministration('writer_embed_facts', { options }, config,
      { timeoutMs: (options.budgetMs ?? 60_000) + 30_000 });
    if (!delegated.handled) throw new OperationError('owner_unavailable', 'The observed PGLite owner stopped before fact repair admission');
    const result = delegated.result as EmbedFactsResult;
    await writeStdoutFinal(JSON.stringify(result, null, 2) + '\n');
    if (result.failures) setCliExitVerdict(1);
    return true;
  } catch (error) {
    if (error instanceof PersistenceIpcTransportError && error.sent) {
      error = new OperationError('write_pending', 'The fact repair acknowledgment was lost; the owner may still be finishing the bounded run.',
        'Wait for the owner to finish, then run a scoped preview before approving another repair. Do not retry automatically.');
    }
    if (await reportPersistenceCliError(error, args.includes('--json'))) return true;
    throw error;
  }
}
