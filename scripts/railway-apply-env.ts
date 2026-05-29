#!/usr/bin/env bun
import {
  formatReport,
  loadEnvFile,
  runPreflight,
} from './saas-preflight.ts';
import { loadManifest } from './provision-company-brain.ts';

export interface RailwayApplyEnvArgs {
  envFile?: string;
  services: RailwayServiceTarget[];
  environment?: string;
  manifestPath?: string;
  project?: string;
  dryRun: boolean;
  skipPreflight: boolean;
  strictPreflight: boolean;
  help: boolean;
}

export interface RailwayEnvEntry {
  key: string;
  value: string;
}

export interface RailwayServiceTarget {
  name: string;
  role?: 'web' | 'worker';
}

export function usageText(): string {
  return `Usage: bun run scripts/railway-apply-env.ts --env-file <path> --web-service <name> [--worker-service <name>] [options]

Options:
  --env-file <path>      Dotenv file with tenant variables
  --web-service <name>   Railway web service; sets CORTEX_PROCESS=web
  --worker-service <name> Railway worker service; sets CORTEX_PROCESS=worker
  --service <name>       Generic Railway service; no role override
  --environment <name>   Railway environment, defaults to production
  --manifest <path>      Tenant manifest to include in SaaS preflight
  --project <id>         Railway project ID, if the repo is not linked
  --skip-preflight       Apply env without running scripts/saas-preflight.ts first
  --strict-preflight     Treat preflight warnings as fatal
  --dry-run              Print services and variable names without setting values
  -h, --help             Show this help`;
}

export function readArgs(argv: string[]): RailwayApplyEnvArgs {
  const out: RailwayApplyEnvArgs = {
    services: [],
    dryRun: false,
    skipPreflight: false,
    strictPreflight: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--service') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new Error('--service requires a value');
      out.services.push({ name: val });
    } else if (arg === '--web-service') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new Error('--web-service requires a value');
      out.services.push({ name: val, role: 'web' });
    } else if (arg === '--worker-service') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new Error('--worker-service requires a value');
      out.services.push({ name: val, role: 'worker' });
    } else if (arg === '--env-file') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new Error('--env-file requires a value');
      out.envFile = val;
    } else if (arg === '--environment') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new Error('--environment requires a value');
      out.environment = val;
    } else if (arg === '--project') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new Error('--project requires a value');
      out.project = val;
    } else if (arg === '--manifest') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new Error('--manifest requires a value');
      out.manifestPath = val;
    } else if (arg === '--skip-preflight') {
      out.skipPreflight = true;
    } else if (arg === '--strict-preflight') {
      out.strictPreflight = true;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

export function envEntries(env: Record<string, string>): RailwayEnvEntry[] {
  return Object.entries(env)
    .filter(([, value]) => value.trim().length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }));
}

export function entriesForService(
  entries: RailwayEnvEntry[],
  target: RailwayServiceTarget,
): RailwayEnvEntry[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  if (target.role) {
    byKey.set('CORTEX_PROCESS', {
      key: 'CORTEX_PROCESS',
      value: target.role,
    });
  }
  if (target.role === 'worker' && !byKey.has('CORTEX_WORKER_RUN_SCHEMA_MIGRATIONS')) {
    byKey.set('CORTEX_WORKER_RUN_SCHEMA_MIGRATIONS', {
      key: 'CORTEX_WORKER_RUN_SCHEMA_MIGRATIONS',
      value: '0',
    });
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export function railwayVariableSetArgs(
  service: string,
  entries: RailwayEnvEntry[],
  opts: { environment?: string; project?: string } = {},
): string[] {
  const args = ['variable', 'set', '--service', service, '--environment', opts.environment ?? 'production', '--skip-deploys'];
  if (opts.project) args.push('--project', opts.project);
  args.push(...entries.map(({ key, value }) => `${key}=${value}`));
  return args;
}

async function runRailway(args: string[], dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] railway ${args.map((arg) => (arg.includes('=') ? `${arg.split('=')[0]}=<redacted>` : arg)).join(' ')}`);
    return;
  }
  const proc = Bun.spawn(['railway', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (stdout.trim()) console.log(stdout.trim());
  if (code !== 0) {
    console.error(stderr.trim() || `railway ${args[0]} failed`);
    process.exit(code);
  }
  if (stderr.trim()) console.error(stderr.trim());
}

async function main() {
  let args: RailwayApplyEnvArgs;
  try {
    args = readArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error(usageText());
    process.exit(2);
  }

  if (args.help) {
    console.log(usageText());
    process.exit(0);
  }
  if (!args.envFile) throw new Error('--env-file is required');
  if (args.services.length === 0) {
    throw new Error('at least one --web-service, --worker-service, or --service is required');
  }

  const env = await loadEnvFile(args.envFile);
  if (!args.skipPreflight) {
    const manifest = args.manifestPath ? await loadManifest(args.manifestPath) : undefined;
    const issues = runPreflight({ env: { ...process.env, ...env }, manifest, manifestPath: args.manifestPath });
    const errors = issues.filter((issue) => issue.level === 'error').length;
    const warnings = issues.filter((issue) => issue.level === 'warn').length;
    if (issues.length > 0) console.log(formatReport(issues));
    if (errors > 0 || (args.strictPreflight && warnings > 0)) {
      throw new Error('Railway env apply aborted by SaaS preflight.');
    }
  }

  const entries = envEntries(env);
  if (entries.length === 0) throw new Error(`No non-empty variables found in ${args.envFile}`);
  console.log(`Applying ${entries.length} variables to ${args.services.length} Railway service(s).`);
  for (const service of args.services) {
    const serviceEntries = entriesForService(entries, service);
    await runRailway(railwayVariableSetArgs(service.name, serviceEntries, {
      environment: args.environment,
      project: args.project,
    }), args.dryRun);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
