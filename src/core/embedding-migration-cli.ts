import type { PaceKeyOverrides } from './pace-mode.ts';

export interface MigrateEmbeddingsFlags {
  maxCostUsd?: number;
  to?: string;
  dim?: number;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  noEmbed: boolean;
  ignoreEnvOverride: boolean;
  retarget: boolean;
  reranker?: string;
  batchSize?: number;
  pace?: { perCallMode?: string; perCall?: PaceKeyOverrides };
}

const CONTROLS: Record<string, string> = {
  '--to': 'text', '--dim': 'dimension', '--reranker': 'text',
  '--batch-size': 'batch', '--max-cost-usd': 'cost',
  '--yes': 'boolean', '--non-interactive': 'boolean', '--dry-run': 'boolean',
  '--json': 'boolean', '--no-embed': 'boolean', '--ignore-env-override': 'boolean',
  '--retarget': 'boolean', '--status': 'boolean', '--help': 'boolean', '-h': 'boolean',
  '--pace': 'pace', '--pace-max-concurrency': 'concurrency',
};
const GLOBAL_CONTROLS: Record<string, string> = {
  '--quiet': 'boolean', '--progress-json': 'boolean',
  '--progress-interval': 'interval', '--brain': 'brain',
};

class MigrationArgumentError extends Error {
  constructor(readonly flag: string, message: string) { super(message); }
}

export function parseMigrateEmbeddingsFlags(
  args: string[], options: { globals?: boolean; route?: string } = {},
): MigrateEmbeddingsFlags {
  const values = new Map<string, string>();
  const route = options.route === 'migrate' ? ['migrate', 'embeddings'] : options.route ? [options.route] : [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (route.length && token === route[0]) { route.shift(); continue; }
    if (!token.startsWith('-')) throw new MigrationArgumentError('<argument>', 'Unexpected positional argument; migration accepts only documented controls.');
    const equals = token.indexOf('=');
    const flag = equals < 0 ? token : token.slice(0, equals);
    const kind = Object.hasOwn(CONTROLS, flag) ? CONTROLS[flag]
      : options.globals && Object.hasOwn(GLOBAL_CONTROLS, flag) ? GLOBAL_CONTROLS[flag] : undefined;
    if (!kind) throw new MigrationArgumentError(flag, `unknown flag ${flag}; embedding migration is brain-wide and only documented controls are supported. Use --brain to select the brain.`);
    if (values.has(flag)) throw new MigrationArgumentError(flag, `Duplicate ${flag}; specify each migration control once.`);
    if (equals >= 0 && !['pace', 'concurrency', 'interval', 'brain'].includes(kind)) {
      throw new MigrationArgumentError(flag, `${flag}=value is unsupported; use the documented ${flag} syntax.`);
    }
    if (kind === 'pace' && equals < 0 && args[i + 1] && !args[i + 1].startsWith('-') && args[i + 1] !== route[0]) {
      throw new MigrationArgumentError(flag, '--pace accepts a bare flag or --pace=mode, not a separate mode value.');
    }
    let value = kind === 'boolean' ? 'true' : kind === 'pace' && equals < 0 ? 'balanced'
      : equals >= 0 ? token.slice(equals + 1) : args[++i];
    if (value === undefined || !value.trim() || value.startsWith('-')) {
      throw new MigrationArgumentError(flag, `${flag} requires a valid value; no default will be substituted.`);
    }
    if (['dimension', 'batch', 'concurrency', 'interval'].includes(kind)) {
      const max = kind === 'dimension' ? 100_000 : kind === 'batch' ? 10_000 : Number.MAX_SAFE_INTEGER;
      const min = kind === 'interval' ? 0 : 1;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
        throw new MigrationArgumentError(flag, `${flag} requires an integer from ${min} through ${max}; values are never truncated or clamped.`);
      }
    }
    if (kind === 'cost' && (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)))) {
      throw new MigrationArgumentError(flag, `${flag} requires a finite nonnegative dollar amount.`);
    }
    if (kind === 'pace') {
      value = value.trim().toLowerCase();
      if (!['off', 'gentle', 'balanced', 'aggressive'].includes(value)) throw new MigrationArgumentError(flag, `${flag} requires off, gentle, balanced, or aggressive.`);
    }
    if (kind === 'brain' && !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value)) {
      throw new MigrationArgumentError(flag, `${flag} requires a valid brain id.`);
    }
    values.set(flag, value);
  }
  if (route.length) throw new MigrationArgumentError(route[0], 'Incomplete migration command.');
  const paceMode = values.get('--pace');
  const concurrency = values.get('--pace-max-concurrency');
  return {
    ...(values.has('--max-cost-usd') && { maxCostUsd: Number(values.get('--max-cost-usd')) }),
    to: values.get('--to'), dim: values.has('--dim') ? Number(values.get('--dim')) : undefined,
    yes: values.has('--yes') || values.has('--non-interactive'), dryRun: values.has('--dry-run'),
    json: values.has('--json'), noEmbed: values.has('--no-embed'),
    ignoreEnvOverride: values.has('--ignore-env-override'), retarget: values.has('--retarget'),
    ...(values.has('--reranker') && { reranker: values.get('--reranker') }),
    ...(values.has('--batch-size') && { batchSize: Number(values.get('--batch-size')) }),
    pace: paceMode !== undefined || concurrency !== undefined ? {
      ...(paceMode !== undefined && { perCallMode: paceMode }),
      ...(concurrency !== undefined && { perCall: { maxConcurrency: Number(concurrency) } }),
    } : undefined,
  };
}

export function migrationCliArgumentError(command: string, args: string[], rawArgs?: string[]): MigrationArgumentError | null {
  if (command !== 'retrieval-upgrade' && !(command === 'migrate' && args[0] === 'embeddings')) return null;
  try {
    parseMigrateEmbeddingsFlags(rawArgs ?? (command === 'migrate' ? args.slice(1) : args), {
      globals: true, ...(rawArgs && { route: command }),
    });
    return null;
  } catch (error) {
    if (error instanceof MigrationArgumentError) return error;
    throw error;
  }
}
