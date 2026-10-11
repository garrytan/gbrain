import { opError } from './ops/contract.ts';
import { isValidSourceId } from './source-id.ts';

export interface EmbedFactsOptions {
  sourceId: string;
  all?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  maxCostUsd?: number;
  maxFacts?: number;
  batchSize?: number;
  budgetMs?: number;
}

export function validateEmbedFactsOptions(value: unknown): EmbedFactsOptions {
  const invalid = (message: string, suggestion: string): never => { throw opError('invalid_params', message, suggestion); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Fact backfill requires typed options',
    'Run fact repair through gbrain embed --stale --facts, which builds the typed options; an owner-proxy caller sends options as a JSON object.');
  const options = value as Record<string, unknown>;
  const allowed = ['sourceId', 'all', 'dryRun', 'yes', 'maxCostUsd', 'maxFacts', 'batchSize', 'budgetMs'];
  const extra = Object.keys(options).filter(key => !allowed.includes(key));
  if (extra.length) return invalid('Unsupported fact backfill options',
    `Remove ${extra.join(', ')}; fact repair options are ${allowed.join(', ')}. Run one gbrain release on the caller and the brain host.`);
  if (!isValidSourceId(options.sourceId)) return invalid('Fact backfill requires an explicit --source <id>',
    'Name the source with --source, e.g. gbrain embed --stale --facts --source default --dry-run; gbrain sources list --json lists the source ids.');
  for (const flag of ['all', 'dryRun', 'yes']) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') return invalid(`${flag} must be a boolean`,
      `Send ${flag} as a JSON boolean; on the CLI it is the bare flag ${flag === 'dryRun' ? '--dry-run' : flag === 'all' ? '--all' : '--yes'}.`);
  }
  for (const [key, flag, max] of [
    ['maxFacts', '--max-facts', 10_000], ['batchSize', '--batch-size', 100], ['budgetMs', '--budget-ms', 3_600_000],
  ] as const) {
    if (options[key] !== undefined && (typeof options[key] !== 'number' || !Number.isSafeInteger(options[key])
      || options[key] < 1 || options[key] > max)) return invalid(`${flag} must be an integer between 1 and ${max}`,
      `Pass ${flag} as a whole number from 1 to ${max}, or omit it for the default.`);
  }
  const dryRun = options.dryRun === true || options.yes !== true;
  if ((options.maxCostUsd !== undefined || !dryRun) && (typeof options.maxCostUsd !== 'number'
    || !Number.isFinite(options.maxCostUsd) || options.maxCostUsd < 0)) {
    return invalid('Fact backfill execution requires --yes and a finite --max-cost-usd >= 0',
      `Preview first with gbrain embed --stale --facts --source ${String(options.sourceId)} --dry-run; to apply, pass --yes with --max-cost-usd set to the dollar cap the user approved (e.g. --max-cost-usd 1).`);
  }
  return { ...options, dryRun } as unknown as EmbedFactsOptions;
}
