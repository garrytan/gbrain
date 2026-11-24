import type { GBrainConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { persistenceResidentOwner } from '../core/persistence/resident-owner.ts';
import { opError } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { DEFAULT_PAID_CAP_USD } from '../core/consent.ts';
import { consentGate } from '../core/consent-cli.ts';
import type { ReindexCodeOpts, ReindexCodeResult } from './reindex-code.ts';

const invalid = (message: string, suggestion: string) => opError('invalid_params', message, suggestion,
  { fix: readFix('Prints the gbrain reindex-code flags.', { argv: ['gbrain', 'reindex-code', '--help'] }) });

export function parseReindexCodeDelegateArgs(args: string[]): ReindexCodeOpts {
  const options: ReindexCodeOpts = {};
  const booleans = { '--force': 'force', '--no-embed': 'noEmbed', '--dry-run': 'dryRun', '--yes': 'yes', '-y': 'yes', '--json': 'json' } as const;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const key = booleans[arg as keyof typeof booleans];
    if (key) { options[key] = true; continue; }
    if (!['--source', '--workers', '--concurrency', '--max-cost', '--max-cost-usd'].includes(arg)) throw invalid('Unsupported owner-delegated reindex-code option. Run gbrain reindex-code --help.',
      `Remove ${arg.split('=')[0]}; while the running serve holds the brain, reindex-code accepts --source, --workers, --max-cost-usd, --force, --no-embed, --dry-run, --yes and --json.`);
    const value = args[++i];
    if (!value || value.startsWith('-')) throw invalid(`${arg} requires a value.`,
      `Give ${arg} its value right after it, e.g. ${arg} ${arg === '--source' ? 'default' : arg === '--workers' || arg === '--concurrency' ? '4' : '2'}.`);
    if (arg === '--source') options.sourceId = value;
    else if (arg === '--workers' || arg === '--concurrency') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 64) throw invalid('workers must be an integer from 1 to 64.', `Pass ${arg} as a whole number from 1 to 64, e.g. ${arg} 4.`);
      options.workers = Number(value);
    } else {
      if (!Number.isFinite(Number(value)) || Number(value) <= 0) throw invalid('Owner-delegated reindex requires a positive numeric cost cap.', `Pass ${arg} as a positive dollar amount, e.g. ${arg} 2, or use --no-embed for the free text-only rebuild.`);
      options.maxCostUsd = Number(value);
    }
  }
  return options;
}

export async function maybeDelegateReindexCode(hostConfig: GBrainConfig | null, args: string[]): Promise<boolean> {
  const brainId = resolveBrainId(getCliOptions().brain, process.cwd());
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (!config || !(await persistenceResidentOwner(config))) return false;
  try {
    const options = parseReindexCodeDelegateArgs(args);
    if (!options.noEmbed && !options.dryRun) {
      // A4: paid. The owner holds the brain, so no estimate is available here: the cap is
      // --max-cost when given, else the printed default cap. The owner re-checks `yes`.
      const auth = await consentGate({
        command: 'reindex-code', effects: ['paid'], actor: 'agent',
        what: 'Re-embed the code pages through the running gbrain serve',
        why: 'Rebuilds code chunks and their embeddings so code search uses current chunking; the running serve owns the brain, so it does the work.',
        risk: `Spends with the embedding provider, capped at ${options.maxCostUsd !== undefined ? `$${options.maxCostUsd.toFixed(2)}` : `the default $${DEFAULT_PAID_CAP_USD.toFixed(2)}`} (no estimate while the serve holds the brain). --no-embed rebuilds text and symbol metadata for free.`,
        user_message: `Re-embed the brain's code pages (paid embeddings, at most ${options.maxCostUsd !== undefined ? `$${options.maxCostUsd.toFixed(2)}` : `$${DEFAULT_PAID_CAP_USD.toFixed(2)}`})? --no-embed does the free text-only rebuild instead.`,
        argv: ['gbrain', 'reindex-code', ...args.filter(a => a !== '--yes' && a !== '-y')],
        preview_argv: ['gbrain', 'reindex-code', ...args.filter(a => a !== '--yes' && a !== '-y' && a !== '--json'), '--dry-run', '--json'],
        est_usd: null,
        args,
      }, { json: options.json === true });
      if (!auth) return true;
      options.yes = true;
      if (options.maxCostUsd === undefined && auth.cap_usd !== null) options.maxCostUsd = auth.cap_usd;
    }
    const delegated = await maybeDelegateLocalAdministration('writer_reindex_code', { options }, config, { timeoutMs: 86_400_000 });
    if (!delegated.handled) {
      const paid = !options.noEmbed && !options.dryRun;
      throw opError('owner_unavailable', 'The registered owner stopped before reindex admission. Retry the same command.',
        `Nothing ran: the running serve exited before admitting the reindex. Run the same command again; it opens the brain directly or delegates to the new owner.${paid ? ' Re-embedding stays paid and needs the same approval.' : ''}`,
        { fix: { argv: ['gbrain', 'reindex-code', ...args], consent: paid ? ['paid'] : [], actor: 'agent', requires_exclusive: false,
          why: 'The owner stopped before admission, so the same reindex has not run yet.' } });
    }
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
