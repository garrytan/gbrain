#!/usr/bin/env bun

import { loadConfig } from './core/config.ts';
import { createLocalAuthPrincipal } from './core/auth-principal.ts';
import { createConnectedEngine, DEFAULT_RUNTIME_CONFIG } from './core/engine-factory.ts';
import type { BrainEngine } from './core/engine.ts';
import {
  operations,
  dispatchOperation,
  OperationError,
  formatOpHelp,
  formatOpUsage,
  formatResult as formatSharedResult,
  getMissingRequiredParams,
  parseOpArgs as parseSharedOpArgs,
  registerSyncBrainHandler,
} from './core/operations.ts';
import type { Operation, OperationContext } from './core/operations.ts';
import { performSync as performSyncCommand, runSync as runSyncCommand } from './commands/sync.ts';
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
    enqueue: { type: 'boolean', description: 'Submit a durable embed_backfill maintenance job instead of embedding inline' },
    run_job: { type: 'string', description: 'Claim and run a specific embed_backfill maintenance job id' },
  },
  handler: noopHandler,
  cliHints: { name: 'embed', positional: ['slug'] },
};

const DOCTOR_CLI_SPEC: Operation = {
  name: 'doctor',
  description: 'Run health checks for the target Postgres runtime or explicit legacy local profile and exit non-zero when failures are found.',
  params: {
    json: { type: 'boolean', description: 'Emit JSON instead of human-readable output' },
    agent: { type: 'boolean', description: 'Include installed Codex/Claude MCP and prompt readiness checks' },
    explain: { type: 'boolean', description: 'Explain installed-agent memory trust behavior; requires --agent' },
    agent_command: { type: 'string', description: 'Installed mbrain command to verify (default: mbrain)' },
  },
  handler: noopHandler,
  cliHints: { name: 'doctor' },
};

const MIGRATE_CLI_SPEC: Operation = {
  name: 'migrate',
  description: 'Prepare Markdown-first migration into the Postgres target runtime; legacy PGLite DB-copy remains an explicit escape hatch.',
  params: {
    to: { type: 'string', required: true, description: 'Target runtime: postgres or supabase; pglite is legacy-only' },
    url: { type: 'string', description: 'Postgres connection string for target initialization guidance' },
    path: { type: 'string', description: 'Legacy PGLite target path' },
    force: { type: 'boolean', description: 'Allow wiping a legacy PGLite target after backup preflight' },
  },
  handler: noopHandler,
  cliHints: { name: 'migrate' },
};

const SETUP_AGENT_CLI_SPEC: Operation = {
  name: 'setup_agent',
  description: 'Register MCP and inject managed Postgres target runtime rules for Claude Code and Codex.',
  params: {
    claude: { type: 'boolean', description: 'Configure Claude Code only' },
    codex: { type: 'boolean', description: 'Configure Codex only' },
    scope: { type: 'string', description: 'Claude MCP scope: user or local' },
    preview: { type: 'boolean', description: 'Preview managed setup actions without writing files' },
    diff: { type: 'boolean', description: 'Show redacted managed setup diffs without writing files' },
    apply: { type: 'boolean', description: 'Explicitly apply managed setup actions' },
    uninstall: { type: 'boolean', description: 'Remove managed setup actions without touching user content' },
    skip_mcp: { type: 'boolean', description: 'Inject rules without registering MCP' },
    no_autopilot: { type: 'boolean', description: 'Skip registering the daily candidate-only dream cycle schedule' },
    print: { type: 'boolean', description: 'Print the agent rules instead of writing files' },
    json: { type: 'boolean', description: 'Emit machine-readable setup results' },
  },
  handler: noopHandler,
  cliHints: { name: 'setup-agent' },
};

const SKILL_SURFACE_CLI_SPEC: Operation = {
  name: 'skill_surface',
  description: 'Inspect the packaged agent docs manifest and MCP docs resources.',
  params: {
    action: { type: 'string', description: 'Action: manifest or resources', enum: ['manifest', 'resources'] },
    json: { type: 'boolean', description: 'Emit JSON output' },
  },
  handler: noopHandler,
  cliHints: { name: 'skill-surface', positional: ['action'] },
};

const MEMORY_REPORT_CLI_SPEC: Operation = {
  name: 'memory_report',
  description: 'Show the exception-first memory review report for the configured brain.',
  params: {
    json: { type: 'boolean', description: 'Emit JSON instead of human-readable output' },
    save: { type: 'boolean', description: 'Save the formatted report under brain/reports/memory-review-report' },
    report_dir: { type: 'string', description: 'Brain directory for --save (default: current directory)' },
    scope_id: { type: 'string', description: 'Scope to report (default: workspace:default)' },
    limit: { type: 'number', description: 'Maximum mutation and candidate rows to inspect (default: 100)' },
    now: { type: 'string', description: 'Override report generation timestamp as an ISO string' },
  },
  handler: noopHandler,
  cliHints: { name: 'memory-report' },
};

const EVAL_CLI_SPEC: Operation = {
  name: 'eval',
  description: 'Run context retrieval eval fixtures, compare eval reports, or record trace-linked corrections.',
  params: {
    domain: { type: 'string', description: 'Eval domain: context or correction' },
    action: { type: 'string', description: 'Eval subcommand, such as correction record' },
    fixture: { type: 'string', description: 'Context eval fixture JSON path' },
    compare: { type: 'boolean', description: 'Compare two eval report JSON files' },
    trace_id: { type: 'string', description: 'Trace id for correction records' },
    case_id: { type: 'string', description: 'Eval case id for correction records' },
    reason: { type: 'string', description: 'Correction reason or summary' },
    run_id: { type: 'string', description: 'Optional eval run id for correction records' },
    json: { type: 'boolean', description: 'Emit JSON output' },
  },
  handler: noopHandler,
  cliHints: { name: 'eval', positional: ['domain', 'action'] },
};

const SERVE_CLI_SPEC: Operation = {
  name: 'serve',
  description: 'Run the MCP server over stdio or Streamable HTTP.',
  params: {
    http: { type: 'boolean', description: 'Serve MCP over HTTP instead of stdio' },
    host: { type: 'string', description: 'HTTP host to bind (default: 127.0.0.1)' },
    port: { type: 'number', description: 'HTTP port to bind (default: 8787)' },
    oauth: { type: 'boolean', description: 'Enable OAuth 2.1/DCR routes for ChatGPT-style MCP clients' },
    public_url: { type: 'string', description: 'Public base URL for OAuth metadata when serving behind a tunnel' },
    oauth_allowed_scopes: { type: 'string', description: 'Comma/space-separated OAuth scopes to allow (default: mcp)' },
    tier: { type: 'string', description: 'Tool tier to expose: core, extended, or all (default: core)' },
  },
  handler: noopHandler,
  cliHints: { name: 'serve' },
};

const AUTH_CLI_SPEC: Operation = {
  name: 'auth',
  description: 'Create, list, revoke, or smoke-test remote MCP bearer tokens.',
  params: {
    action: { type: 'string', description: 'Action: create, list, revoke, or test', enum: ['create', 'list', 'revoke', 'test'] },
    name: { type: 'string', description: 'Token name for create/revoke' },
    url: { type: 'string', description: 'Remote MCP URL for test' },
    token: { type: 'string', description: 'Bearer token for test' },
    scope: { type: 'string', description: 'Token scope; may be repeated by the command parser' },
  },
  handler: noopHandler,
  cliHints: { name: 'auth', positional: ['action', 'name'] },
};

const DREAM_CLI_SPEC: Operation = {
  name: 'dream',
  description: 'Run the Dream maintenance phase runner.',
  params: {
    scope_id: { type: 'string', description: 'Dream scope id (default: workspace:default)' },
    now: { type: 'string', description: 'ISO timestamp for deterministic reports' },
    dry_run: { type: 'boolean', description: 'Preview without writing candidates' },
    apply: { type: 'boolean', description: 'Run candidate-writing phases behind a cycle lock' },
    write_candidates: { type: 'boolean', description: 'Allow governed candidate writes in apply mode' },
    apply_auto_promote: { type: 'boolean', description: 'Allow auto-promote to apply in apply mode' },
    allow_canonical_page_writes: { type: 'boolean', description: 'Allow auto-promote to write canonical pages' },
    limit: { type: 'number', description: 'Maximum items per phase family' },
    max_runner_calls: { type: 'number', description: 'Maximum runner calls for auto-promote review' },
    time_budget_ms: { type: 'number', description: 'Maximum auto-promote runner time budget in milliseconds' },
    phase_timeout_ms: { type: 'number', description: 'Maximum milliseconds per Dream phase before it is marked timed out' },
    max_candidates_per_cycle: { type: 'number', description: 'Maximum auto-promote candidates per Dream cycle' },
    report_dir: { type: 'string', description: 'Brain directory for saving the daily memory report phase output' },
    allow_llm: { type: 'boolean', description: 'Allow budgeted LLM use when a phase supports it' },
    allow_local_runner: { type: 'boolean', description: 'Allow local runner-backed phase work' },
  },
  handler: noopHandler,
  cliHints: { name: 'dream' },
};

const AUTO_PROMOTE_CLI_SPEC: Operation = {
  name: 'auto-promote',
  description: 'Preview or apply eligible Memory Inbox candidate promotion.',
  params: {
    apply: { type: 'boolean', description: 'Apply eligible inbox promotions' },
    dry_run: { type: 'boolean', description: 'Preview without writing promotions or verdict cache rows' },
    scope_id: { type: 'string', description: 'Memory scope id (default: workspace:default)' },
    limit: { type: 'number', description: 'Maximum candidates to review' },
    json: { type: 'boolean', description: 'Print JSON output' },
  },
  handler: noopHandler,
  cliHints: { name: 'auto-promote' },
};

const AGENT_SESSION_CLI_SPEC: Operation = {
  name: 'agent_session',
  description: 'Preview or capture a JSON agent-session envelope file through governed memory operations.',
  params: {
    action: { type: 'string', required: true, description: 'preview or capture', enum: ['preview', 'capture'] },
    file: { type: 'string', required: true, description: 'Path to a JSON capture envelope' },
    json: { type: 'boolean', description: 'Emit JSON output' },
    apply: { type: 'boolean', description: 'Apply governed writeback for capture mode' },
    dry_run: { type: 'boolean', description: 'Preview capture mode without mutation' },
    write_mode: { type: 'string', description: 'candidate_only or direct_personal_when_allowed', enum: ['candidate_only', 'direct_personal_when_allowed'] },
  },
  handler: noopHandler,
  cliHints: { name: 'agent-session', positional: ['action'] },
};

const CANONICALIZE_CLI_SPEC: Operation = {
  name: 'canonicalize',
  description: 'Preview draft from a PDF, Markdown/text file, or source tree path. Preview-only; does not write memory. PDFs are metadata-only in this MVP.',
  params: {
    path: { type: 'string', required: true, description: 'PDF, Markdown/text file, or source-code project path to preview. PDF text/OCR extraction is not performed.' },
    target_slug: { type: 'string', description: 'Optional canonical target slug override.' },
    title: { type: 'string', description: 'Optional title override for the generated draft.' },
    type: { type: 'string', description: 'Optional page type override.' },
    source_kind: { type: 'string', description: 'Optional source-kind override.' },
    now: { type: 'string', description: 'Optional ISO timestamp for deterministic timeline draft entries.' },
    json: { type: 'boolean', description: 'Emit JSON instead of concise review text.' },
  },
  handler: noopHandler,
  cliHints: { name: 'canonicalize', positional: ['path'] },
};

const CANONICALIZE_CODE_CLI_SPEC: Operation = {
  name: 'preview_canonicalize_code_path',
  description: 'Preview source-code project draft from a repository path. Preview-only; does not write memory.',
  params: {
    path: { type: 'string', required: true, description: 'Source-code project or repository path to preview.' },
    target_slug: { type: 'string', description: 'Optional canonical target slug override.' },
    title: { type: 'string', description: 'Optional title override for the generated draft.' },
    type: { type: 'string', description: 'Optional page type override.' },
    now: { type: 'string', description: 'Optional ISO timestamp for deterministic timeline draft entries.' },
    json: { type: 'boolean', description: 'Emit JSON instead of concise review text.' },
  },
  handler: noopHandler,
  cliHints: { name: 'canonicalize-code', positional: ['path'] },
};

const CONNECTORS_CLI_SPEC: Operation = {
  name: 'connectors',
  description: 'Inspect connector definitions or sync supported personal connector sources.',
  params: {
    action: { type: 'string', description: 'Connector action: list, show, or sync' },
    connector_id: { type: 'string', description: 'Connector id for show/sync' },
    path: { type: 'string', description: 'Filesystem path for meeting transcript sync' },
    dry_run: { type: 'boolean', description: 'Preview connector sync without writing source rows' },
  },
  handler: noopHandler,
  cliHints: { name: 'connectors', positional: ['action', 'connector_id'] },
};

const SYNC_CLI_SPEC: Operation = {
  name: 'sync_brain',
  description: 'Sync git repo to brain (incremental). CLI also supports a watch-mode extension for repeated polling.',
  params: {
    repo: { type: 'string', description: 'Path to git repo (optional if configured)' },
    subbrain: { type: 'string', description: 'Registered sub-brain id to sync' },
    all_subbrains: { type: 'boolean', description: 'Sync every registered sub-brain' },
    dry_run: { type: 'boolean', description: 'Preview changes without applying' },
    full: { type: 'boolean', description: 'Full re-sync (ignore checkpoint)' },
    no_pull: { type: 'boolean', description: 'Skip git pull' },
    no_embed: { type: 'boolean', description: 'Compatibility no-op: sync already defers embeddings' },
    watch: { type: 'boolean', description: 'Poll for changes continuously until interrupted' },
    interval: { type: 'number', description: 'Seconds between watch polls (default 60)' },
    clear_failure: { type: 'boolean', description: 'Dismiss the recorded sync watch failure marker and exit' },
  },
  handler: noopHandler,
  cliHints: { name: 'sync' },
};

const CLI_ONLY_SPECS: Partial<Record<string, Operation>> = {
  auth: AUTH_CLI_SPEC,
  serve: SERVE_CLI_SPEC,
  embed: EMBED_CLI_SPEC,
  doctor: DOCTOR_CLI_SPEC,
  migrate: MIGRATE_CLI_SPEC,
  'memory-report': MEMORY_REPORT_CLI_SPEC,
  eval: EVAL_CLI_SPEC,
  'auto-promote': AUTO_PROMOTE_CLI_SPEC,
  'agent-session': AGENT_SESSION_CLI_SPEC,
  canonicalize: CANONICALIZE_CLI_SPEC,
  'canonicalize-code': CANONICALIZE_CODE_CLI_SPEC,
  'setup-agent': SETUP_AGENT_CLI_SPEC,
  'skill-surface': SKILL_SURFACE_CLI_SPEC,
};

const DIRECT_NO_ENGINE_COMMANDS: Record<string, CliNoEngineLoader> = {
  init: async () => (await import('./commands/init.ts')).runInit,
  integrations: async () => (await import('./commands/integrations.ts')).runIntegrations,
  autopilot: async () => (await import('./commands/autopilot.ts')).runAutopilot,
  publish: async () => (await import('./commands/publish.ts')).runPublish,
  'check-backlinks': async () => (await import('./commands/backlinks.ts')).runBacklinks,
  lint: async () => (await import('./commands/lint.ts')).runLint,
  report: async () => (await import('./commands/report.ts')).runReport,
  canonicalize: async () => (await import('./commands/canonicalize.ts')).runCanonicalize,
  'canonicalize-code': async () => (await import('./commands/canonicalize.ts')).runCanonicalizeCode,
  'auth': async () => (await import('./commands/auth.ts')).runAuth,
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
  'skill-surface': async () => (await import('./commands/skill-surface.ts')).runSkillSurface,
};

const DIRECT_ENGINE_COMMANDS: Record<string, CliEngineLoader> = {
  import: async () => (await import('./commands/import.ts')).runImport,
  export: async () => (await import('./commands/export.ts')).runExport,
  files: async () => (await import('./commands/files.ts')).runFiles,
  embed: async () => (await import('./commands/embed.ts')).runEmbed,
  dream: async () => (await import('./commands/dream.ts')).runDream,
  call: async () => (await import('./commands/call.ts')).runCall,
  config: async () => (await import('./commands/config.ts')).runConfig,
  doctor: async () => (await import('./commands/doctor.ts')).runDoctor,
  'memory-report': async () => (await import('./commands/memory-report.ts')).runMemoryReport,
  eval: async () => (await import('./commands/eval.ts')).runEval,
  'auto-promote': async () => (await import('./commands/auto-promote.ts')).runAutoPromoteCommand,
  'agent-session': async () => (await import('./commands/agent-session.ts')).runAgentSession,
  connectors: async () => (await import('./commands/connectors.ts')).runConnectors,
  migrate: async () => (await import('./commands/migrate-engine.ts')).runMigrateEngine,
  subbrain: async () => (await import('./commands/subbrain.ts')).runSubbrain,
};

const CLI_ONLY = new Set([
  'serve',
  'setup-agent',
  'skill-surface',
  'upgrade',
  'post-upgrade',
  'check-update',
]);
// Shared-contract commands such as `sync` must stay out of CLI_ONLY so operations.ts remains authoritative.

const CLI_ENGINE_COMMANDS: Record<string, CliEngineLoader> = {
  // `serve` owns the current stdio process and cannot run through the shared request/response contract.
  serve: async () => {
    const { runServe } = await import('./commands/serve.ts');
    return (engine, args) => runServe(engine, args);
  },
};

export type CliCommandExposureMode =
  | 'cli_shared'
  | 'cli_direct_engine'
  | 'cli_direct_no_engine'
  | 'cli_only';

export type CliCommandCatalogEntry = {
  command: string;
  mode: CliCommandExposureMode;
  operation_name?: string;
  operation_spec_name?: string;
  reason?: string;
};

export type CliCommandCatalog = {
  schema_version: 1;
  commands: Record<string, CliCommandCatalogEntry>;
};

export function getCliCommandCatalog(sourceOperations: Operation[] = operations): CliCommandCatalog {
  const commands: Record<string, CliCommandCatalogEntry> = {};

  const setCommand = (entry: CliCommandCatalogEntry) => {
    commands[entry.command] = entry;
  };

  for (const op of sourceOperations) {
    const command = op.cliHints?.name;
    if (!command || op.cliHints?.hidden) continue;
    setCommand({
      command,
      mode: 'cli_shared',
      operation_name: op.name,
    });
  }

  for (const command of Object.keys(DIRECT_ENGINE_COMMANDS).sort()) {
    setCommand({
      command,
      mode: 'cli_direct_engine',
      operation_name: commands[command]?.operation_name,
      operation_spec_name: CLI_ONLY_SPECS[command]?.name,
      reason: 'direct_engine_command',
    });
  }

  for (const command of Object.keys(DIRECT_NO_ENGINE_COMMANDS).sort()) {
    setCommand({
      command,
      mode: 'cli_direct_no_engine',
      operation_name: commands[command]?.operation_name,
      operation_spec_name: CLI_ONLY_SPECS[command]?.name,
      reason: 'direct_no_engine_command',
    });
  }

  for (const command of Object.keys(CLI_NO_ENGINE_COMMANDS).sort()) {
    setCommand({
      command,
      mode: 'cli_direct_no_engine',
      operation_name: commands[command]?.operation_name,
      operation_spec_name: CLI_ONLY_SPECS[command]?.name,
      reason: 'cli_no_engine_command',
    });
  }

  for (const command of [...CLI_ONLY].sort()) {
    setCommand({
      command,
      mode: 'cli_only',
      operation_name: commands[command]?.operation_name,
      operation_spec_name: CLI_ONLY_SPECS[command]?.name,
      reason: 'process_or_shell_bound',
    });
  }

  return {
    schema_version: 1,
    commands: Object.fromEntries(Object.entries(commands).sort(([a], [b]) => compareAscii(a, b))),
  };
}

function compareAscii(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

async function main() {
  registerSyncBrainHandler(performSyncCommand);

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
      process.stdout.write(formatCliHelp(command, op));
      return;
    }
  }

  if (command === 'sync') {
    // --clear-failure must run before any engine connection: the marker
    // typically exists because the database is unreachable.
    if (subArgs.includes('--clear-failure')) {
      if (subArgs.includes('--watch')) {
        console.error('--clear-failure cannot be combined with --watch; clear first, then restart with: mbrain sync --watch');
        process.exit(1);
      }
      const { clearSyncWatchFailure } = await import('./core/health-beacon.ts');
      clearSyncWatchFailure();
      console.log('Sync watch failure marker cleared. Restart live sync with: mbrain sync --watch');
      return;
    }
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
    const result = await dispatchOperation(ctx, op, params);
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
    auth_principal: createLocalAuthPrincipal('cli', {
      principalType: 'local_cli',
      principalId: `mbrain-cli:${process.pid}`,
      principalName: 'mbrain CLI',
      actorType: 'cli',
      actorId: `mbrain-cli:${process.pid}`,
    }),
  };
}

export function formatResult(opName: string, result: unknown, params: Record<string, unknown> = {}): string {
  return formatSharedResult(opName, result, params);
}

function getCliHelpSpec(command: string): Operation | undefined {
  if (command === 'sync') return SYNC_CLI_SPEC;
  if (command === 'dream') return DREAM_CLI_SPEC;
  if (command === 'connectors') return CONNECTORS_CLI_SPEC;
  return cliOps.get(command) || CLI_ONLY_SPECS[command];
}

function formatCliHelp(command: string, op: Operation): string {
  const help = formatOpHelp(op);
  if (command !== 'put') return help;

  return `${help}
Governance:
  put is the direct canonical write path. Prefer route-memory-writeback for
  governed writes, and provide --write-session-id (write_session_id) when the
  router returns one. Otherwise provide --expected-content-hash
  (expected_content_hash) with a real content hash when updating a page, or the
  literal value null when the target is expected to be absent. The route-first
  contract requires a router-issued write session, an observed target hash, or
  explicit absence before canonical memory is mutated; memory_session_id alone
  is not a write grant.
`;
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
  if (typeof params.subbrain === 'string' && params.subbrain.length > 0) {
    args.push('--subbrain', params.subbrain);
  }
  if (params.all_subbrains === true) args.push('--all-subbrains');
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

  if (command === 'serve') {
    const { runServe } = await import('./commands/serve.ts');
    const enginePromise = connectEngine();
    await runServe(enginePromise, normalizeCliOnlyArgs(command, args));
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
    await runSyncCommand(engine, args);
  } finally {
    await engine.disconnect();
  }
}

async function handleDirectCommand(command: string, args: string[]): Promise<boolean> {
  if (command === 'config' && args[0] === 'show') {
    const { runConfigShow } = await import('./commands/config.ts');
    runConfigShow();
    return true;
  }

  if (command === 'connectors' && args[0] !== 'sync') {
    const { runConnectors } = await import('./commands/connectors.ts');
    await runConnectors(args);
    return true;
  }

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
    const normalizedArgs = command === 'eval'
      ? args
      : CLI_ONLY_SPECS[command] ? normalizeCliOnlyArgs(command, args) : args;
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
    console.error('No brain configured. Run: mbrain init --profile homebrew-postgres, mbrain init --url <postgres_connection_string>, or set MBRAIN_DATABASE_URL / DATABASE_URL.');
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
                                    Create target Postgres brain; legacy SQLite/PGLite only by explicit flag
  setup-agent [--preview|--diff|--apply|--uninstall] [--claude|--codex] [--scope user|local]
                                    Register MCP, inject rules, install Claude prompt/stop hooks
  migrate --to <postgres|supabase>   Prepare Markdown-first migration into the Postgres target runtime
  upgrade                            Self-update
  check-update [--json]              Check for new versions
  doctor [--json] [--agent] [--explain]
                                    Health check (engine, schema, embeddings, local/managed capabilities)
  integrations [subcommand]          Manage integration recipes
  connectors [list|show|sync]        Inspect or sync personal data connector sources
  auth <create|list|revoke|test>     Manage remote MCP bearer tokens
  agent-session preview|capture      Preview or capture a JSON agent-session envelope file

AGENT MEMORY LOOP
  retrieve-context <query>           Probe for relevant context and required reads
  read-context --selectors <json>    Read canonical evidence selected by retrieve-context
  route-memory-writeback             Route durable writes before canonical mutation
  memory-report [--json] [--save]    Show or save the review surface for memory debt
  eval context --fixture <file>       Persist a context eval fixture run

PAGES
  get <slug>                         Read a page
  put <slug> [< file.md]             Governed/direct canonical write; use expected content hash
  delete <slug>                      Delete a page
  list [--type T] [--tag T] [-n N]   List pages

SEARCH
  search <query>                     Keyword search (engine-native)
  query <question> [--no-expand]     Hybrid search (RRF + expansion)

IMPORT/EXPORT
  import <dir> [--no-embed]          Import markdown directory
  canonicalize <path> [--json]       Preview draft from a PDF, Markdown/text file, or source tree
                                    PDFs are metadata-only in this MVP
  canonicalize-code <path> [--json]  Preview source-code project draft from a repository path
  sync [--repo <path>] [flags]       Git-to-brain incremental sync
  export [--dir ./out/] [--personal-export]  Export pages or curated personal markdown

FILES
  files list [slug]                  List stored files
  files upload <file> --page <slug>  Upload file to storage
  files sync <dir>                   Bulk upload directory
  files verify                       Verify all uploads

EMBEDDINGS
  embed [<slug>|--all|--stale]       Generate/refresh embeddings; add --enqueue for durable backfill

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
  assertion-retrieval [--target-slug S]
                                    List lifecycle-aware assertion retrieval plans
  dream [--apply|--dry-run] [--apply-auto-promote] [--allow-canonical-page-writes]
                                    Run the Dream maintenance phase runner
  lifecycle-report [--scope-id S]     Report lifecycle forgetting candidates and restore windows
  lifecycle-plan-purge [--scope-id S] Create a reviewed lifecycle purge plan
  lifecycle-restore --entity-type T --entity-id ID
                                    Restore stale/expired/archived memory where policy allows
  lifecycle-review-purge-plan --purge-plan-id P --decision approve
                                    Approve, reject, or cancel a lifecycle purge plan
  lifecycle-purge --entity-type T --entity-id ID --purge-plan-id P
                                    Purge one approved due expired/archived memory row
  autopilot <enable|disable|start|stop|status|install|uninstall|logs|config|run-once|dream>
                                    Manage scheduled maintenance autopilot
  subbrain <add|list|remove>          Manage registered git-backed sub-brains
  serve [--http] [--host H] [--port P] [--oauth] [--oauth-allowed-scopes S] [--tier core|extended|all]
                                    MCP server (stdio or Streamable HTTP)
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
