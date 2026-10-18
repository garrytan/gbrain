import type { GBrainConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { readFix } from '../core/ops/op-fix.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import { writeStdoutFinal } from '../core/cli-force-exit.ts';
import { formatManagedStaleExtraction, type ManagedLinkExtraction } from '../core/persistence/links-maintenance.ts';
import { parseStaleSourceArgs, type StaleSourceSelection } from './extract-stale-options.ts';

/**
 * A live PGLite owner holds the database; `extract --stale` runs inside it instead of failing on the lock. Every
 * `extract --stale` passes through here before connecting, so the source options are validated (#6803 D2) before
 * direct and owner dispatch alike.
 */
export async function maybeDelegateExtractStale(hostConfig: GBrainConfig | null, args: string[]): Promise<boolean> {
  const json = args.includes('--json');
  let selection: StaleSourceSelection;
  try { selection = parseStaleSourceArgs(args); } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    setCliExitVerdict(writeCliError(error, 'extract', { json }));
    return true;
  }
  const brainId = resolveBrainId(getCliOptions().brain, process.cwd());
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url || !inspectLockHolder(config.database_path).held) return false;
  const invalid = (message: string, suggestion: string) => opError('invalid_params', message, suggestion,
    { fix: readFix('Prints the gbrain extract forms and flags.', { argv: ['gbrain', 'extract', '--help'] }) });
  try {
    const params: Record<string, unknown> = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--dry-run') params.dry_run = true;
      else if (arg === '--source-id') {
        const value = args[++i];
        if (!value || value.startsWith('-')) throw invalid('--source-id requires a value.', 'Give --source-id the source to extract, e.g. gbrain extract --stale --source-id default, or omit it to extract every source.');
        params.source_id = value;
      } else if (arg === '--source' || arg === '--source=db') {
        if (arg === '--source') i++;
        params.source_mode = selection.mode;
      } else if (arg === '--catch-up') params.catch_up = true;
      else if (arg === '--retry-held') params.retry_held = true;
      else if (!['--stale', '--json', '--include-frontmatter', 'all'].includes(arg)) {
        throw invalid(`Unsupported owner-delegated extract --stale option: ${arg.split('=')[0]}.`,
          `Remove ${arg.split('=')[0]}; while the running serve holds the brain, extract --stale accepts --source-id, --dry-run, --json, --include-frontmatter, --catch-up and --retry-held. Stop the serve to use other extract options.`);
      }
    }
    const delegated = await maybeDelegateLocalAdministration('writer_extract_stale', params, config, { timeoutMs: 86_400_000 });
    if (!delegated.handled) throw opError('owner_unavailable', 'The registered owner stopped before extraction. Retry the same command.',
      'Nothing ran: the running serve exited before admitting the extraction. Run the same command again; it opens the brain directly or delegates to the new owner.',
      { fix: { argv: ['gbrain', 'extract', ...args], consent: [], actor: 'agent', requires_exclusive: false, why: 'The owner stopped before admission, so the same extraction has not run yet.' } });
    const result = delegated.result as ManagedLinkExtraction;
    const dryRun = params.dry_run === true;
    await writeStdoutFinal(formatManagedStaleExtraction(result, dryRun, json) + '\n');
    return true;
  } catch (error) {
    if (await reportPersistenceCliError(error, json)) return true;
    throw error;
  }
}
