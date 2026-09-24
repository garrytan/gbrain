import { OperationError } from './ops/contract.ts';
import { isValidSourceId } from './source-id.ts';

export interface EmbedFactsOptions {
  sourceId: string;
  dryRun?: boolean;
  yes?: boolean;
  maxCostUsd?: number;
  maxFacts?: number;
  batchSize?: number;
  budgetMs?: number;
}

export function validateEmbedFactsOptions(value: unknown): EmbedFactsOptions {
  const invalid = (message: string): never => { throw new OperationError('invalid_params', message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Fact backfill requires typed options');
  const options = value as Record<string, unknown>;
  const allowed = ['sourceId', 'dryRun', 'yes', 'maxCostUsd', 'maxFacts', 'batchSize', 'budgetMs'];
  if (Object.keys(options).some(key => !allowed.includes(key))) return invalid('Unsupported fact backfill options');
  if (!isValidSourceId(options.sourceId)) return invalid('Fact backfill requires an explicit --source <id>');
  for (const flag of ['dryRun', 'yes']) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') return invalid(`${flag} must be a boolean`);
  }
  for (const [key, flag, max] of [
    ['maxFacts', '--max-facts', 10_000], ['batchSize', '--batch-size', 100], ['budgetMs', '--budget-ms', 3_600_000],
  ] as const) {
    if (options[key] !== undefined && (typeof options[key] !== 'number' || !Number.isSafeInteger(options[key])
      || options[key] < 1 || options[key] > max)) return invalid(`${flag} must be an integer between 1 and ${max}`);
  }
  const dryRun = options.dryRun === true || options.yes !== true;
  if ((options.maxCostUsd !== undefined || !dryRun) && (typeof options.maxCostUsd !== 'number'
    || !Number.isFinite(options.maxCostUsd) || options.maxCostUsd < 0)) {
    return invalid('Fact backfill execution requires --yes and a finite --max-cost-usd >= 0');
  }
  return { ...options, dryRun } as unknown as EmbedFactsOptions;
}
