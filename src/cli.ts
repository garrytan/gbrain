#!/usr/bin/env bun

import { loadConfig } from './core/config.ts';
import { createConnectedEngine, DEFAULT_RUNTIME_CONFIG } from './core/engine-factory.ts';
import type { BrainEngine } from './core/engine.ts';
import {
  operations,
  OperationError,
  formatOpHelp,
  formatOpUsage,
  formatResult as formatSharedResult,
  getMissingRequiredParams,
  parseOpArgs as parseSharedOpArgs,
} from './core/operations.ts';
import type { Operation, OperationContext } from './core/operations.ts';
import { VERSION } from './version.ts';

// Build CLI name -> operation lookup
const cliOps = new Map<string, Operation>();
for (const op of operations) {
  const name = op.cliHints?.name;
  if (name && !op.cliHints?.hidden) {
    cliOps.set(name, op);
  }
}

type CliNoEngineHandler = (args: string[]) => Promise<void> | void;
type CliEngineHandler = (engine: BrainEngine, args: string[]) => Promise<void> | void;
type CliNoEngineLoader = () => Promise<CliNoEngineHandler>;
type CliEngineLoader = () => Promise<CliEngineHandler>;

function noopHandler() {
  return Promise.resolve(undefined);
}

const EMBED_CLI_SPEC: Operation = {
  name: 'embed',
  description: 'Generate or refresh embeddings for one page, all pages, or only stale chunks.',
  params: {
    slug: { type: 'string', description: 'Page slug to embed' },
    all: { type: 'boolean', description: 'Embed every page' },
    stale: { type: 'boolean', description: 'Only embed missing or stale chunks' },
  },
  handler: noopHandler,
  cliHints: { name: 'embed', positional: ['slug'] },
};

const DOCTOR_CLI_SPEC: Operation = {
  name: 'doctor',
  description: 'Run health checks against the configured brain and exit non-zero when failures are found.',
  params: {
    json: { type: 'boolean', description: 'Emit JSON instead of human-readable output' },
  },
  handler: noopHandler,
  cliHints: { name: 'doctor' },
};

const SYNC_CLI_SPEC: Operation = {
  name: 'sync_brain',
  description: 'Sync git repo to brain (incremental). CLI also supports a watch-mode extension for repeated polling.',
  params: {
    repo: { type: 'string', description: 'Path to git repo (optional if configured)' },
    dry_run: { type: 'boolean', description: 'Preview changes without applying' },
    full: { type: 'boolean', description: 'Full re-sync (ignore checkpoint)' },
    no_pull: { type: 'boolean', description: 'Skip git pull' },
    no_embed: { type: 'boolean', description: 'Compatibility no-op: sync already defers embeddings' },
    watch: { type: 'boolean', description: 'Poll for changes continuously until interrupted' },
    interval: { type: 'number', description: 'Seconds between watch polls (default 60)' },
  },
  handler: noopHandler,
  cliHints: { name: 'sync' },
};

const CLI_ONLY_SPECS: Partial<Record<string, Operation>> = {
  embed: EMBED_CLI_SPEC,
  doctor: DOCTOR_CLI_SPEC,
};

const DIRECT_NO_ENGINE_COMMANDS: Record<string, CliNoEngineLoader> = {
  init: async () => (await import('./commands/init.ts')).runInit,
  integrations: async () => (await import('./commands/integrations.ts')).runIntegrations,
  publish: async () => (await import('./commands/publish.ts')).runPublish,
  'check-backlinks': async () => (await import('./commands/backlinks.ts')).runBacklinks,
  lint: async () => (await import('./commands/lint.ts')).runLint,
  report: async () => (await import('./commands/report.ts')).runReport,
};

const CLI_NO_ENGINE_COMMANDS: Record<string, CliNoEngineLoader> = {
  // `upgrade` replaces the installed package/binary and is process-management only.
  upgrade: async () => (await import('./commands/upgrade.ts')).runUpgrade,
  // `post-upgrade` finalizes shell/package-manager side effects after self-update.
  'post-upgrade': async () => {
    const { runPostUpgrade } = await import('./commands/upgrade.ts');
    return () => runPostUpgrade();
  },
  // `check-update` queries release metadata without depending on brain state.
  'check-update': async () => (await import('./commands/check-update.ts')).runCheckUpdate,
  // `setup-agent` edits user tooling config and installs hooks outside the shared contract.
  'setup-agent': async () => (await import('./commands/setup-agent.ts')).runSetupAgent,
};

const DIRECT_ENGINE_COMMANDS: Record<string, CliEngineLoader> = {
  import: async () => (await import('./commands/import.ts')).runImport,
  export: async () => (await import('./commands/export.ts')).runExport,
  files: async () => (await import('./commands/files.ts')).runFiles,
  embed: async () => (await import('./commands/embed.ts')).runEmbed,
  call: async () => (await import('./commands/call.ts')).runCall,
  config: async () => (await import('./commands/config.ts')).runConfig,
  doctor: async () => (await import('./commands/doctor.ts')).runDoctor,
  migrate: async () => (await import('./commands/migrate-engine.ts')).runMigrateEngine,
};

const CLI_ONLY = new Set([
  'serve',
  'setup-agent',
  'upgrade',
  'post-upgrade',
  'check-update',
]);
// Shared-contract commands such as `sync` must stay out of CLI_ONLY so operations.ts remains authoritative.

const CLI_ENGINE_COMMANDS: Record<string, CliEngineLoader> = {
  // `serve` owns the current stdio process and cannot run through the shared request/response contract.
  serve: async () => {
    const { runServe } = await import('./commands/serve.ts');
    return (engine) => runServe(engine);
  },
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === '--version' || command === 'version') {
    console.log(`mbrain ${VERSION}`);
    return;
  }

  if (command === '--tools-json') {
    const { printToolsJson } = await import('./commands/tools-json.ts');
    printToolsJson();
    return;
  }

  let subArgs = args.slice(1);

  if (subArgs.includes('--help') || subArgs.includes('-h')) {
    const op = getCliHelpSpec(command);
    if (op) {
      process.stdout.write(formatOpHelp(op));
      return;
    }
  }

  if (command === 'sync') {
    const syncCliRouting = resolveSyncCliRouting(subArgs);
    for (const warning of syncCliRouting.warnings) {
      console.error(warning);
    }
    if (syncCliRouting.error) {
      console.error(syncCliRouting.error);
      process.exit(1);
    }
    subArgs = syncCliRouting.args;
    if (syncCliRouting.watch) {
      await handleSyncCliExtension(subArgs);
      return;
    }
  }

  if (CLI_ONLY.has(command)) {
    await handleCliOnly(command, subArgs);
    return;
  }

  if (await handleDirectCommand(command, subArgs)) {
    return;
  }

  const op = cliOps.get(command);
  if (!op) {
    console.error(`Unknown command: ${command}`);
    console.error('Run mbrain --help for available commands.');
    process.exit(1);
  }

  const engine = await connectEngine();
  try {
    const params = parseSharedOpArgs(op, subArgs);

    if (getMissingRequiredParams(op, params).length > 0) {
      console.error(formatOpUsage(op));
      process.exit(1);
    }

    const ctx = makeContext(engine, params);
    const result = await op.handler(ctx, params);
    const output = formatResult(op.name, result, params);
    if (output) process.stdout.write(output);
  } catch (e: unknown) {
    if (e instanceof OperationError) {
      console.error(`Error [${e.code}]: ${e.message}`);
      if (e.suggestion) console.error(`  Fix: ${e.suggestion}`);
      process.exit(1);
    }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  } finally {
    await engine.disconnect();
  }
}

export interface ParseOpArgsOptions {
  warn?: (msg: string) => void;
}

export function parseOpArgs(
  op: Operation,
  args: string[],
  options: ParseOpArgsOptions = {},
): Record<string, unknown> {
  return parseSharedOpArgs(op, args, options);
}

function makeContext(engine: BrainEngine, params: Record<string, unknown>): OperationContext {
  return {
    engine,
    config: loadConfig() || DEFAULT_RUNTIME_CONFIG,
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: (params.dry_run as boolean) || false,
  };
}

export function formatResult(opName: string, result: unknown, params: Record<string, unknown> = {}): string {
  return formatSharedResult(opName, result, params);
}

function getCliHelpSpec(command: string): Operation | undefined {
  if (command === 'sync') return SYNC_CLI_SPEC;
  return cliOps.get(command) || CLI_ONLY_SPECS[command];
}

function resolveSyncCliRouting(
  args: string[],
): { watch: boolean; args: string[]; warnings: string[]; error?: string } {
  const warnings: string[] = [];
  const params = parseSharedOpArgs(SYNC_CLI_SPEC, args, {
    warn: (message) => warnings.push(`Warning: ${message}`),
  });
  const watchEnabled = params.watch === true;
  const intervalProvided = args.some(arg => arg === '--interval' || arg.startsWith('--interval='));

  if (intervalProvided && !watchEnabled) {
    return { watch: false, args, warnings, error: '--interval requires --watch' };
  }

  if (watchEnabled) {
    return { watch: true, args: normalizeSyncCliExtensionArgs(params), warnings };
  }

  return {
    watch: false,
    args: args.filter(arg => arg !== '--watch=false'),
    warnings: [],
  };
}

function normalizeSyncCliExtensionArgs(params: Record<string, unknown>): string[] {
  const args: string[] = [];

  if (typeof params.repo === 'string' && params.repo.length > 0) {
    args.push('--repo', params.repo);
  }
  if (params.dry_run === true) args.push('--dry-run');
  if (params.full === true) args.push('--full');
  if (params.no_pull === true) args.push('--no-pull');
  if (params.no_embed === true) args.push('--no-embed');
  if (params.watch === true) args.push('--watch');
  if (typeof params.interval === 'number') args.push('--interval', String(params.interval));

  return args;
}

async function handleCliOnly(command: string, args: string[]) {
  const noEngineLoader = CLI_NO_ENGINE_COMMANDS[command];
  if (noEngineLoader) {
    const runCommand = await noEngineLoader();
    await runCommand(args);
    return;
  }

  const engineLoader = CLI_ENGINE_COMMANDS[command];
  if (!engineLoader) {
    return;
  }

  const engine = await connectEngine();
  try {
    const runCommand = await engineLoader();
    await runCommand(engine, normalizeCliOnlyArgs(command, args));
  } finally {
    if (command !== 'serve') await engine.disconnect();
  }
}

async function handleSyncCliExtension(args: string[]) {
  const engine = await connectEngine();
  try {
    const { runSync } = await import('./commands/sync.ts');
    await runSync(engine, args);
  } finally {
    await engine.disconnect();
  }
}

async function handleDirectCommand(command: string, args: string[]): Promise<boolean> {
  const noEngineLoader = DIRECT_NO_ENGINE_COMMANDS[command];
  if (noEngineLoader) {
    const runCommand = await noEngineLoader();
    await runCommand(args);
    return true;
  }

  const engineLoader = DIRECT_ENGINE_COMMANDS[command];
  if (!engineLoader) {
    return false;
  }

  const engine = await connectEngine();
  try {
    const runCommand = await engineLoader();
    const normalizedArgs = CLI_ONLY_SPECS[command] ? normalizeCliOnlyArgs(command, args) : args;
    await runCommand(engine, normalizedArgs);
    return true;
  } finally {
    await engine.disconnect();
  }
}

function normalizeCliOnlyArgs(command: string, args: string[]): string[] {
  const spec = CLI_ONLY_SPECS[command];
  if (!spec) return args;

  const params = parseSharedOpArgs(spec, args);
  const normalized: string[] = [];
  for (const positional of spec.cliHints?.positional || []) {
    const value = params[positional];
    if (typeof value === 'string' && value.length > 0) {
      normalized.push(value);
    }
  }
  for (const [key, def] of Object.entries(spec.params)) {
    if (spec.cliHints?.positional?.includes(key)) continue;
    const value = params[key];
    if (value === undefined) continue;
    const flag = `--${key.replace(/_/g, '-')}`;
    if (def.type === 'boolean') {
      if (value === true) normalized.push(flag);
    } else {
      normalized.push(flag, String(value));
    }
  }
  return normalized;
}

async function connectEngine(): Promise<BrainEngine> {
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: mbrain init or set MBRAIN_DATABASE_URL / DATABASE_URL.');
    process.exit(1);
  }
  return createConnectedEngine(config);
}

function printHelp() {
  console.log(`mbrain ${VERSION} -- personal knowledge brain

USAGE
  mbrain <command> [options]

SETUP
  init [--local|--pglite|--supabase|--url <conn>]
                                    Create brain (SQLite local, PGLite, or managed Postgres)
  setup-agent [--claude|--codex] [--scope user|local]
                                    Register MCP, inject rules, install Claude stop hook
  migrate --to <supabase|pglite>     Transfer brain between engines
  upgrade                            Self-update
  check-update [--json]              Check for new versions
  doctor [--json]                    Health check (engine, schema, embeddings, local/managed capabilities)
  integrations [subcommand]          Manage integration recipes

PAGES
  get <slug>                         Read a page
  put <slug> [< file.md]             Write/update a page
  delete <slug>                      Delete a page
  list [--type T] [--tag T] [-n N]   List pages

SEARCH
  search <query>                     Keyword search (engine-native)
  query <question> [--no-expand]     Hybrid search (RRF + expansion)

IMPORT/EXPORT
  import <dir> [--no-embed]          Import markdown directory
  sync [--repo <path>] [flags]       Git-to-brain incremental sync
  export [--dir ./out/] [--personal-export]  Export pages or curated personal markdown

FILES
  files list [slug]                  List stored files
  files upload <file> --page <slug>  Upload file to storage
  files sync <dir>                   Bulk upload directory
  files verify                       Verify all uploads

EMBEDDINGS
  embed [<slug>|--all|--stale]       Generate/refresh embeddings

LINKS
  link <from> <to> [--type T]        Create typed link
  unlink <from> <to>                 Remove link
  backlinks <slug>                   Incoming links
  graph <slug> [--depth N]           Traverse link graph

TAGS
  tags <slug>                        List tags
  tag <slug> <tag>                   Add tag
  untag <slug> <tag>                 Remove tag

TIMELINE
  timeline [<slug>]                  View timeline
  timeline-add <slug> <date> <text>  Add timeline entry

TOOLS (deterministic, no DB / no LLM)
  publish <page.md> [--password]     Share a page as self-contained HTML
  check-backlinks <check|fix>        Enforce the Iron Law of Back-Linking
  lint <dir|file> [--fix]            Flag LLM slop, broken frontmatter, stale dates
  report --type <name> [--title]     Save timestamped report under brain/reports/

ADMIN
  stats                              Brain statistics
  health                             Brain health dashboard
  history <slug>                     Page version history
  revert <slug> <version-id>         Revert to version
  config [show|get|set] <key> [val]  Brain config
  serve                              MCP server (stdio)
  call <tool> '<json>'               Raw tool invocation
  version                            Version info
  --tools-json                       Tool discovery (JSON)

Run mbrain <command> --help for command-specific help.
`);
}

if (import.meta.main) {
  main().catch(e => {
    console.error(e.message || e);
    process.exit(1);
  });
}
