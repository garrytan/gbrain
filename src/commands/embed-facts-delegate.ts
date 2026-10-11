import type { GBrainConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { PersistenceIpcTransportError } from '../core/persistence/ipc.ts';
import { validateEmbedFactsOptions, type EmbedFactsOptions } from '../core/embed-facts-options.ts';
import type { EmbedFactsResult } from '../core/embed-facts.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';

const FACT_EMBED_EXAMPLES: Record<string, string> = { '--source': 'default', '--max-cost-usd': '1', '--max-facts': '500', '--batch-size': '50', '--budget-ms': '60000' };
const invalid = (message: string, suggestion: string) => opError('invalid_params', message, suggestion,
  { fix: readFix('Prints every gbrain embed form, including fact repair and its flags.', { argv: ['gbrain', 'embed', '--help'] }) });

export function parseFactEmbedArgs(args: string[]): EmbedFactsOptions {
  if (!args.includes('--stale') || !args.includes('--facts')) {
    throw invalid('Use embed --stale --facts --source <id> [--all] [--dry-run | --yes --max-cost-usd N] [--max-facts N]',
      'Fact repair takes both --stale and --facts: preview with gbrain embed --stale --facts --source SOURCE --dry-run, then apply with --yes --max-cost-usd N after the user approves the cost.');
  }
  const options: Record<string, unknown> = {};
  const booleans = { '--all': 'all', '--dry-run': 'dryRun', '--yes': 'yes' } as const;
  const values = { '--source': 'sourceId', '--max-cost-usd': 'maxCostUsd', '--max-facts': 'maxFacts', '--batch-size': 'batchSize', '--budget-ms': 'budgetMs' } as const;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--stale', '--facts', '--json', '--quiet'].includes(arg)) continue;
    const boolean = booleans[arg as keyof typeof booleans];
    if (boolean) { options[boolean] = true; continue; }
    const key = values[arg as keyof typeof values];
    if (!key) throw invalid('Use embed --stale --facts with only source, refresh, preview, approval, and bounded repair options',
      `Remove ${arg.split('=')[0]}; fact repair accepts --source, --all, --dry-run, --yes, --max-cost-usd, --max-facts, --batch-size, --budget-ms, --json and --quiet.`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw invalid(`${arg} requires a value`, `Give ${arg} its value right after it, e.g. ${arg} ${FACT_EMBED_EXAMPLES[arg]}.`);
    if (options[key] !== undefined) throw invalid(`${arg} may be supplied only once`, `Pass ${arg} once, with the one value you mean.`);
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
    if (!delegated.handled) {
      const paid = options.dryRun !== true;
      throw opError('owner_unavailable', 'The observed PGLite owner stopped before fact repair admission',
        `Nothing ran: the running serve exited before admitting the repair. Run the same command again; it opens the brain directly or delegates to the new owner.${paid ? ' It spends up to the approved --max-cost-usd, as before.' : ''}`,
        { fix: { argv: ['gbrain', 'embed', ...args], consent: paid ? ['paid'] : [], actor: 'agent', requires_exclusive: false,
          why: 'The owner stopped before admission, so the same request has not run yet.' } });
    }
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
