#!/usr/bin/env bun

import { readFileSync } from 'fs';
import { loadConfig, toEngineConfig } from './core/config.ts';
import type { BrainEngine } from './core/engine.ts';
import { operations, OperationError } from './core/operations.ts';
import type { Operation, OperationContext } from './core/operations.ts';
import { serializeMarkdown } from './core/markdown.ts';
import { parseGlobalFlags, setCliOptions, getCliOptions } from './core/cli-options.ts';
import { VERSION } from './version.ts';

// Build CLI name -> operation lookup
const cliOps = new Map<string, Operation>();
for (const op of operations) {
  const name = op.cliHints?.name;
  if (name && !op.cliHints?.hidden) {
    cliOps.set(name, op);
  }
}

// CLI-only commands that bypass the operation layer
const CLI_ONLY = new Set(['init', 'upgrade', 'post-upgrade', 'check-update', 'integrations', 'publish', 'check-backlinks', 'lint', 'report', 'import', 'export', 'files', 'embed', 'serve', 'call', 'config', 'doctor', 'migrate', 'eval', 'sync', 'extract', 'features', 'autopilot', 'graph-query', 'jobs', 'agent', 'apply-migrations', 'skillpack-check', 'skillpack', 'resolvers', 'integrity', 'repair-jsonb', 'orphans', 'sources', 'mounts', 'dream', 'check-resolvable', 'routing-eval', 'skillify', 'smoke-test', 'providers', 'storage', 'repos', 'code-def', 'code-refs', 'reindex-code', 'code-callers', 'code-callees', 'frontmatter', 'auth', 'friction', 'claw-test', 'book-mirror']);

async function main() {
  // Parse global flags (--quiet / --progress-json / --progress-interval)
  // BEFORE command dispatch, so `gbrain --progress-json doctor` works.
  // The stripped argv is what the command sees.
  const rawArgs = process.argv.slice(2);
  const { cliOpts, rest: args } = parseGlobalFlags(rawArgs);
  setCliOptions(cliOpts);

  let command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === '--version' || command === 'version') {
    console.log(`gbrain ${VERSION}`);
    return;
  }

  if (command === '--tools-json') {
    const { printToolsJson } = await import('./commands/tools-json.ts');
    printToolsJson();
    return;
  }

  const subArgs = args.slice(1);

  // DX alias: `ask` is a natural-language alias for `query`
  if (command === 'ask') {
    command = 'query';
  }

  // Per-command --help
  if (subArgs.includes('--help') || subArgs.includes('-h')) {
    const op = cliOps.get(command);
    if (op) {
      printOpHelp(op);
      return;
    }
  }

  // CLI-only commands
  if (CLI_ONLY.has(command)) {
    await handleCliOnly(command, subArgs);
    return;
  }

  // Shared operations
  const op = cliOps.get(command);
  if (!op) {
    console.error(`Unknown command: ${command}`);
    console.error('Run gbrain --help for available commands.');
    process.exit(1);
  }

  const engine = await connectEngine();
  try {
    const params = parseOpArgs(op, subArgs);

    // Validate required params before calling handler
    for (const [key, def] of Object.entries(op.params)) {
      if (def.required && params[key] === undefined) {
        const cliName = op.cliHints?.name || op.name;
        const positional = op.cliHints?.positional || [];
        const usage = positional.map(p => `<${p}>`).join(' ');
        console.error(`Usage: gbrain ${cliName} ${usage}`);
        process.exit(1);
      }
    }

    const ctx = makeContext(engine, params);
    const result = await op.handler(ctx, params);
    const output = formatResult(op.name, result);
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

function parseOpArgs(op: Operation, args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const positional = op.cliHints?.positional || [];
  let posIdx = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-/g, '_');
      const paramDef = op.params[key];
      if (paramDef?.type === 'boolean') {
        params[key] = true;
      } else if (i + 1 < args.length) {
        params[key] = args[++i];
        if (paramDef?.type === 'number') params[key] = Number(params[key]);
      }
    } else if (posIdx < positional.length) {
      const key = positional[posIdx++];
      const paramDef = op.params[key];
      params[key] = paramDef?.type === 'number' ? Number(arg) : arg;
    }
  }

  // Read stdin for content params
  if (op.cliHints?.stdin && !params[op.cliHints.stdin] && !process.stdin.isTTY) {
    const stdinContent = readFileSync('/dev/stdin', 'utf-8');
    const MAX_STDIN = 5_000_000; // 5MB
    if (Buffer.byteLength(stdinContent, 'utf-8') > MAX_STDIN) {
      console.error(`Error: stdin content exceeds ${MAX_STDIN} bytes. Split into smaller inputs.`);
      process.exit(1);
    }
    params[op.cliHints.stdin] = stdinContent;
  }

  return params;
}

function makeContext(engine: BrainEngine, params: Record<string, unknown>): OperationContext {
  return {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: (params.dry_run as boolean) || false,
    // Local CLI invocation — the user owns the machine; do not apply remote-caller
    // confinement (e.g., cwd-locked file_upload).
    remote: false,
    cliOpts: getCliOptions(),
  };
}

function formatResult(opName: string, result: unknown): string {
  switch (opName) {
    case 'get_page': {
      const r = result as any;
      if (r.error === 'ambiguous_slug') {
        return `Ambiguous slug. Did you mean:\n${r.candidates.map((c: string) => `  ${c}`).join('\n')}\n`;
      }
      return serializeMarkdown(r.frontmatter || {}, r.compiled_truth || '', r.timeline || '', {
        type: r.type, title: r.title, tags: r.tags || [],
      });
    }
    case 'list_pages': {
      const pages = result as any[];
      if (pages.length === 0) return 'No pages found.\n';
      return pages.map(p =>
        `${p.slug}\t${p.type}\t${p.updated_at?.toString().slice(0, 10) || '?'}\t${p.title}`,
      ).join('\n') + '\n';
    }
    case 'search':
    case 'query': {
      const results = result as any[];
      if (results.length === 0) return 'No results.\n';
      return results.map(r =>
        `[${r.score?.toFixed(4) || '?'}] ${r.slug} -- ${r.chunk_text?.slice(0, 100) || ''}${r.stale ? ' (stale)' : ''}`,
      ).join('\n') + '\n';
    }
    case 'get_tags': {
      const tags = result as string[];
      return tags.length > 0 ? tags.join(', ') + '\n' : 'No tags.\n';
    }
    case 'get_stats': {
      const s = result as any;
      const lines = [
        `Pages:     ${s.page_count}`,
        `Chunks:    ${s.chunk_count}`,
        `Embedded:  ${s.embedded_count}`,
        `Links:     ${s.link_count}`,
        `Tags:      ${s.tag_count}`,
        `Timeline:  ${s.timeline_entry_count}`,
      ];
      if (s.pages_by_type) {
        lines.push('', 'By type:');
        for (const [k, v] of Object.entries(s.pages_by_type)) {
          lines.push(`  ${k}: ${v}`);
        }
      }
      return lines.join('\n') + '\n';
    }
    case 'get_health': {
      const h = result as any;
      // Health score weights: missing_embeddings is the heaviest (2 pts), other
      // graph quality issues are 1 pt each. link_coverage / timeline_coverage below
      // 50% on entity pages indicates the graph needs population.
      const score = Math.max(0, 10
        - (h.missing_embeddings > 0 ? 2 : 0)
        - (h.stale_pages > 0 ? 1 : 0)
        - (h.orphan_pages > 0 ? 1 : 0)
        - ((h.link_coverage ?? 1) < 0.5 ? 1 : 0)
        - ((h.timeline_coverage ?? 1) < 0.5 ? 1 : 0));
      const lines = [
        `Health score: ${score}/10`,
        `Embed coverage: ${(h.embed_coverage * 100).toFixed(1)}%`,
        `Missing embeddings: ${h.missing_embeddings}`,
        `Stale pages: ${h.stale_pages}`,
        `Orphan pages: ${h.orphan_pages}`,
      ];
      if (h.link_coverage !== undefined) {
        lines.push(`Link coverage (entities): ${(h.link_coverage * 100).toFixed(1)}%`);
      }
      if (h.timeline_coverage !== undefined) {
        lines.push(`Timeline coverage (entities): ${(h.timeline_coverage * 100).toFixed(1)}%`);
      }
      if (Array.isArray(h.most_connected) && h.most_connected.length > 0) {
        lines.push('Most connected entities:');
        for (const e of h.most_connected) {
          lines.push(`  ${e.slug}: ${e.link_count} links`);
        }
      }
      return lines.join('\n') + '\n';
    }
    case 'get_timeline': {
      const entries = result as any[];
      if (entries.length === 0) return 'No timeline entries.\n';
      return entries.map(e =>
        `${e.date}  ${e.summary}${e.source ? ` [${e.source}]` : ''}`,
      ).join('\n') + '\n';
    }
    case 'get_versions': {
      const versions = result as any[];
      if (versions.length === 0) return 'No versions.\n';
      return versions.map(v =>
        `#${v.id}  ${v.snapshot_at?.toString().slice(0, 19) || '?'}  ${v.compiled_truth?.slice(0, 60) || ''}...`,
      ).join('\n') + '\n';
    }
    default:
      return JSON.stringify(result, null, 2) + '\n';
  }
}

async function handleCliOnly(command: string, args: string[]) {
  // Commands that don't need a database connection
  if (command === 'init') {
    const { runInit } = await import('./commands/init.ts');
    await runInit(args);
    return;
  }
  if (command === 'auth') {
    const { runAuth } = await import('./commands/auth.ts');
    await runAuth(args);
    return;
  }
  if (command === 'upgrade') {
    const { runUpgrade } = await import('./commands/upgrade.ts');
    await runUpgrade(args);
    return;
  }
  if (command === 'post-upgrade') {
    const { runPostUpgrade } = await import('./commands/upgrade.ts');
    await runPostUpgrade(args);
    return;
  }
  if (command === 'check-update') {
    const { runCheckUpdate } = await import('./commands/check-update.ts');
    await runCheckUpdate(args);
    return;
  }
  if (command === 'integrations') {
    const { runIntegrations } = await import('./commands/integrations.ts');
    await runIntegrations(args);
    return;
  }
  if (command === 'providers') {
    const { runProviders } = await import('./commands/providers.ts');
    const [sub, ...rest] = args;
    await runProviders(sub, rest);
    return;
  }
  if (command === 'auth') {
    const { runAuth } = await import('./commands/auth.ts');
    await runAuth(args);
    return;
  }
  if (command === 'resolvers') {
    const { runResolvers } = await import('./commands/resolvers.ts');
    await runResolvers(args);
    return;
  }
  if (command === 'integrity') {
    const { runIntegrity } = await import('./commands/integrity.ts');
    await runIntegrity(args);
    return;
  }
  if (command === 'publish') {
    const { runPublish } = await import('./commands/publish.ts');
    await runPublish(args);
    return;
  }
  if (command === 'check-backlinks') {
    const { runBacklinks } = await import('./commands/backlinks.ts');
    await runBacklinks(args);
    return;
  }
  if (command === 'frontmatter') {
    const { runFrontmatter } = await import('./commands/frontmatter.ts');
    await runFrontmatter(args);
    return;
  }
  if (command === 'lint') {
    const { runLint } = await import('./commands/lint.ts');
    await runLint(args);
    return;
  }
  if (command === 'check-resolvable') {
    const { runCheckResolvable } = await import('./commands/check-resolvable.ts');
    await runCheckResolvable(args);
    return;
  }
  if (command === 'mounts') {
    // No DB needed: mounts.json is a local config file. Registry will
    // connect mount engines lazily on first use by op dispatch.
    const { runMounts } = await import('./commands/mounts.ts');
    await runMounts(args);
    return;
  }
  if (command === 'routing-eval') {
    const { runRoutingEvalCli } = await import('./commands/routing-eval.ts');
    await runRoutingEvalCli(args);
    return;
  }
  if (command === 'skillify') {
    const { runSkillify } = await import('./commands/skillify.ts');
    // `args` here is subArgs (command already stripped by caller), so
    // args[0] is the subcommand (scaffold|check).
    await runSkillify(args);
    return;
  }
  if (command === 'skillpack') {
    const { runSkillpack } = await import('./commands/skillpack.ts');
    // subArgs already has `skillpack` stripped; args[0] is the subcommand.
    await runSkillpack(args);
    return;
  }
  if (command === 'friction') {
    const { runFriction } = await import('./commands/friction.ts');
    process.exit(runFriction(args));
  }
  if (command === 'claw-test') {
    const { runClawTest } = await import('./commands/claw-test.ts');
    process.exit(await runClawTest(args));
  }
  if (command === 'report') {
    const { runReport } = await import('./commands/report.ts');
    await runReport(args);
    return;
  }
  if (command === 'apply-migrations') {
    // Does not need connectEngine — each phase (schema, smoke, host-rewrite)
    // manages its own subprocess or file-layer access directly. Avoids
    // connecting a second time when the orchestrator shells out to
    // `gbrain init --migrate-only` and `gbrain jobs smoke`.
    const { runApplyMigrations } = await import('./commands/apply-migrations.ts');
    await runApplyMigrations(args);
    return;
  }
  if (command === 'repair-jsonb') {
    const { runRepairJsonbCli } = await import('./commands/repair-jsonb.ts');
    await runRepairJsonbCli(args);
    return;
  }
  if (command === 'skillpack-check') {
    // Agent-readable health report. Shells out to doctor + apply-migrations
    // internally; does not need its own DB connection.
    const { runSkillpackCheck } = await import('./commands/skillpack-check.ts');
    await runSkillpackCheck(args);
    return;
  }
  if (command === 'doctor') {
    // Doctor runs filesystem checks first (no DB needed), then DB checks.
    // --fast skips DB checks entirely.
    const { runDoctor } = await import('./commands/doctor.ts');
    const { getDbUrlSource } = await import('./core/config.ts');
    if (args.includes('--fast')) {
      // Pass the DB URL source so doctor can tell "no config at all" from
      // "user chose --fast while config is present".
      await runDoctor(null, args, getDbUrlSource());
    } else {
      try {
        const eng = await connectEngine();
        await runDoctor(eng, args);
        await eng.disconnect();
      } catch {
        // DB unavailable — still run filesystem checks
        await runDoctor(null, args, getDbUrlSource());
      }
    }
    return;
  }

  if (command === 'smoke-test') {
    // Run smoke tests — no DB connection needed, the script handles its own checks
    const { execSync } = await import('child_process');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = resolve(scriptDir, '..', 'scripts', 'smoke-test.sh');
    try {
      execSync(`bash "${scriptPath}"`, { stdio: 'inherit', env: { ...process.env } });
    } catch (e: any) {
      // Non-zero exit = some tests failed (exit code = failure count)
      process.exit(e.status ?? 1);
    }
    return;
  }

  if (command === 'dream') {
    // Dream mirrors doctor's pattern: filesystem phases run without a DB,
    // so an engine connection failure is non-fatal. runCycle honestly
    // reports DB phases as skipped when engine is null.
    const { runDream } = await import('./commands/dream.ts');
    let eng: BrainEngine | null = null;
    try {
      eng = await connectEngine();
    } catch {
      // DB unavailable — lint + backlinks still run against the brain dir.
    }
    try {
      await runDream(eng, args);
    } finally {
      if (eng) await eng.disconnect();
    }
    return;
  }

  // All remaining CLI-only commands need a DB connection
  const engine = await connectEngine();
  try {
    switch (command) {
      case 'import': {
        const { runImport } = await import('./commands/import.ts');
        await runImport(engine, args);
        break;
      }
      case 'export': {
        const { runExport } = await import('./commands/export.ts');
        await runExport(engine, args);
        break;
      }
      case 'files': {
        const { runFiles } = await import('./commands/files.ts');
        await runFiles(engine, args);
        break;
      }
      case 'embed': {
        const { runEmbed } = await import('./commands/embed.ts');
        await runEmbed(engine, args);
        break;
      }
      case 'serve': {
        const { runServe } = await import('./commands/serve.ts');
        await runServe(engine, args);
        return; // serve doesn't disconnect
      }
      case 'call': {
        const { runCall } = await import('./commands/call.ts');
        await runCall(engine, args);
        break;
      }
      case 'config': {
        const { runConfig } = await import('./commands/config.ts');
        await runConfig(engine, args);
        break;
      }
      // doctor is handled before connectEngine() above
      case 'migrate': {
        const { runMigrateEngine } = await import('./commands/migrate-engine.ts');
        await runMigrateEngine(engine, args);
        break;
      }
      case 'eval': {
        const { runEvalCommand } = await import('./commands/eval.ts');
        await runEvalCommand(engine, args);
        break;
      }
      case 'jobs': {
        const { runJobs } = await import('./commands/jobs.ts');
        await runJobs(engine, args);
        break;
      }
      case 'agent': {
        const { runAgent } = await import('./commands/agent.ts');
        await runAgent(engine, args);
        break;
      }
      case 'book-mirror': {
        const { runBookMirrorCmd } = await import('./commands/book-mirror.ts');
        await runBookMirrorCmd(engine, args);
        break;
      }
      case 'sync': {
        const { runSync } = await import('./commands/sync.ts');
        await runSync(engine, args);
        break;
      }
      case 'extract': {
        const { runExtract } = await import('./commands/extract.ts');
        await runExtract(engine, args);
        break;
      }
      case 'features': {
        const { runFeatures } = await import('./commands/features.ts');
        await runFeatures(engine, args);
        break;
      }
      case 'autopilot': {
        const { runAutopilot } = await import('./commands/autopilot.ts');
        await runAutopilot(engine, args);
        return; // autopilot doesn't disconnect (long-running)
      }
      case 'graph-query': {
        const { runGraphQuery } = await import('./commands/graph-query.ts');
        await runGraphQuery(engine, args);
        break;
      }
      case 'reconcile-links': {
        // v0.20.0 Cathedral II Layer 8 D3: batch-recompute doc↔impl edges
        // for any markdown page that cites code files. Idempotent; safe to
        // re-run. Closes the v0.19.0 Layer 6 order-dependency bug where
        // guides imported before their code never got their edges written.
        const { runReconcileLinksCli } = await import('./commands/reconcile-links.ts');
        await runReconcileLinksCli(engine, args);
        break;
      }
      case 'orphans': {
        const { runOrphans } = await import('./commands/orphans.ts');
        await runOrphans(engine, args);
        break;
      }
      case 'sources': {
        const { runSources } = await import('./commands/sources.ts');
        await runSources(engine, args);
        break;
      }
      case 'pages': {
        // v0.26.5: page-level operator commands (purge-deleted escape hatch).
        const { runPages } = await import('./commands/pages.ts');
        await runPages(engine, args);
        break;
      }
      case 'storage': {
        const { runStorage } = await import('./commands/storage.ts');
        await runStorage(engine, args);
        break;
      }
      case 'code-def': {
        const { runCodeDef } = await import('./commands/code-def.ts');
        await runCodeDef(engine, args);
        break;
      }
      case 'code-refs': {
        const { runCodeRefs } = await import('./commands/code-refs.ts');
        await runCodeRefs(engine, args);
        break;
      }
      case 'reindex-code': {
        // v0.20.0 Cathedral II Layer 13 (E2): explicit code-page reindex
        // for users upgrading from v0.19.0. Cost-preview gated; TTY prompt
        // or ConfirmationRequired envelope for non-TTY/JSON callers.
        const { runReindexCodeCli } = await import('./commands/reindex-code.ts');
        await runReindexCodeCli(engine, args);
        break;
      }
      case 'code-callers': {
        // v0.20.0 Cathedral II Layer 10 (C4): "who calls <symbol>?"
        const { runCodeCallers } = await import('./commands/code-callers.ts');
        await runCodeCallers(engine, args);
        break;
      }
      case 'code-callees': {
        // v0.20.0 Cathedral II Layer 10 (C5): "what does <symbol> call?"
        const { runCodeCallees } = await import('./commands/code-callees.ts');
        await runCodeCallees(engine, args);
        break;
      }
      case 'repos': {
        // v0.19.0: `gbrain repos ...` is an alias into the v0.18.0 sources
        // subsystem. The repos abstraction (Garry's OpenClaw baseline) was
        // redundant with sources and carried per-user config state that
        // couldn't participate in federation / RLS / multi-tenancy. We
        // keep the alias so scripts like `gbrain repos add .` keep
        // working, with a nudge toward the canonical command.
        console.error('[gbrain] Note: "repos" is an alias for "sources" as of v0.19.0. Prefer `gbrain sources <subcommand>`.');
        const { runSources } = await import('./commands/sources.ts');
        await runSources(engine, args);
        break;
      }
    }
  } finally {
    if (command !== 'serve') await engine.disconnect();
  }
}

async function connectEngine(): Promise<BrainEngine> {
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(1);
  }

  // Configure the AI gateway BEFORE engine connect — initSchema needs embedding dims.
  // Env is read once here; the gateway never reads process.env at call time (Codex C3).
  const { configureGateway } = await import('./core/ai/gateway.ts');
  configureGateway({
    embedding_model: config.embedding_model,
    embedding_dimensions: config.embedding_dimensions,
    expansion_model: config.expansion_model,
    chat_model: config.chat_model,
    chat_fallback_chain: config.chat_fallback_chain,
    base_urls: config.provider_base_urls,
    env: { ...process.env },
  });

  const { createEngine } = await import('./core/engine-factory.ts');
  const engine = await createEngine(toEngineConfig(config));
  const noRetry = process.argv.includes('--no-retry-connect') ||
                  process.env.GBRAIN_NO_RETRY_CONNECT === '1';
  const { connectWithRetry } = await import('./core/db.ts');
  await connectWithRetry(engine, toEngineConfig(config), { noRetry });
  return engine;
}

function printOpHelp(op: Operation) {
  const positional = (op.cliHints?.positional || []).map(p => `<${p}>`).join(' ');
  const name = op.cliHints?.name || op.name;
  console.log(`Usage: gbrain ${name} ${positional} [options]\n`);
  console.log(op.description + '\n');
  const entries = Object.entries(op.params);
  if (entries.length > 0) {
    console.log('Options:');
    for (const [key, def] of entries) {
      const isPos = op.cliHints?.positional?.includes(key);
      const req = def.required ? ' (required)' : '';
      const prefix = isPos ? `  <${key}>` : `  --${key.replace(/_/g, '-')}`;
      console.log(`${prefix.padEnd(28)} ${def.description || ''}${req}`);
    }
  }
}

function printHelp() {
  // Gather shared operations grouped by category
  const cliNames = Array.from(cliOps.entries())
    .map(([name, op]) => ({ name, desc: op.description }));

  console.log(`gbrain ${VERSION} -- personal knowledge brain

USAGE
  gbrain <command> [options]

SETUP
  init [--pglite|--supabase|--url]   Create brain (PGLite default, no server)
  migrate --to <supabase|pglite>     Transfer brain between engines
  upgrade                            Self-update
  check-update [--json]              Check for new versions
  doctor [--json] [--fast]            Health check (resolver, skills, pgvector, RLS, embeddings)
  integrations [subcommand]          Manage integration recipes (senses + reflexes)

PAGES
  get <slug>                         Read a page
  put <slug> [< file.md]             Write/update a page
  delete <slug>                      Delete a page
  list [--type T] [--tag T] [-n N]   List pages

SEARCH
  search <query>                     Keyword search (tsvector)
  query <question> [--no-expand]     Hybrid search (RRF + expansion)
  ask <question> [--no-expand]       Alias for query

IMPORT/EXPORT
  import <dir> [--no-embed]          Import markdown directory
  sync [--repo <path>] [flags]       Git-to-brain incremental sync
  sync --watch [--interval N]        Continuous sync (loops until stopped)
  sync --install-cron                Install persistent sync daemon
  export [--dir ./out/]              Export to markdown
  export --restore-only [--repo <p>] Restore missing supabase-only files
        [--type T] [--slug-prefix S] With optional filters

FILES
  files list [slug]                  List stored files
  files upload <file> --page <slug>  Upload file to storage
  files upload-raw <file> --page <s> Smart upload (size routing + .redirect.yaml)
  files signed-url <path>            Generate signed URL (1-hour)
  files sync <dir>                   Bulk upload directory
  files verify                       Verify all uploads

EMBEDDINGS
  embed [<slug>|--all|--stale]       Generate/refresh embeddings

LINKS
  link <from> <to> [--type T]        Create typed link
  unlink <from> <to>                 Remove link
  backlinks <slug>                   Incoming links
  graph <slug> [--depth N]           Traverse link graph (returns nodes)
  graph-query <slug> [--type T]      Edge-based traversal with type/direction filters
        [--depth N] [--direction in|out|both]

TAGS
  tags <slug>                        List tags
  tag <slug> <tag>                   Add tag
  untag <slug> <tag>                 Remove tag

TIMELINE
  timeline [<slug>]                  View timeline
  timeline-add <slug> <date> <text>  Add timeline entry

TOOLS
  extract <links|timeline|all>       Extract links/timeline (idempotent)
        [--source fs|db]             fs (default) walks .md files; db iterates engine pages
        [--dir <brain>]              brain dir for fs source
        [--type T] [--since DATE]    filters (db source)
        [--dry-run] [--json]
  publish <page.md> [--password]     Shareable HTML (strips private data, optional AES-256)
  check-backlinks <check|fix> [dir]  Find/fix missing back-links across brain
  lint <dir|file> [--fix]            Catch LLM artifacts, placeholder dates, bad frontmatter
  orphans [--json] [--count]         Find pages with no inbound wikilinks
  dream [--dry-run] [--json]         Run the overnight maintenance cycle once (cron-friendly).
                                     See also: autopilot --install (continuous daemon).
  check-resolvable [--json] [--fix]  Validate skill tree (reachability/MECE/DRY)
  report --type <name> --content ... Save timestamped report to brain/reports/

SOURCES (multi-repo / multi-brain)
  sources list                       Show registered sources
  sources add <id> --path <p>        Register a source (id = short name, e.g. 'wiki')
  sources remove <id>                Remove a source + its pages
  sync --all                         Sync all sources with a local_path
  sync --source <id>                 Sync one specific source
  repos ...                          DEPRECATED alias for 'sources' (v0.19.0)

CODE INDEXING (v0.19.0 / v0.20.0 Cathedral II)
  code-def <symbol> [--lang l]       Find the definition of a symbol across code pages
  code-refs <symbol> [--lang l]      Find all references to a symbol (JSON-first)
  code-callers <symbol>              Who calls this symbol? (v0.20.0 A1)
  code-callees <symbol>              What does this symbol call? (v0.20.0 A1)
  query <q> --lang <l>               Filter hybrid search to one language (v0.20.0)
  query <q> --symbol-kind <k>        Filter to symbol type (function|class|method|...) (v0.20.0)
  reconcile-links [--dry-run]        Batch-recompute doc↔impl edges (v0.20.0)
  reindex-code [--source id] [--yes] Explicit code-page reindex (v0.20.0)
  sync --strategy code               Sync code files into the brain

JOBS (Minions)
  jobs submit <name> [--params JSON]  Submit background job [--follow] [--dry-run]
  jobs list [--status S] [--limit N]  List jobs
  jobs get <id>                       Job details + history
  jobs cancel <id>                    Cancel job
  jobs retry <id>                     Re-queue failed/dead job
  jobs prune [--older-than 30d]       Clean old jobs
  jobs stats                          Job health dashboard
  jobs work [--queue Q]               Start worker daemon (Postgres only)

ADMIN
  stats                              Brain statistics
  health                             Brain health dashboard
  history <slug>                     Page version history
  revert <slug> <version-id>         Revert to version
  features [--json] [--auto-fix]     Scan usage + recommend unused features
  autopilot [--repo] [--interval N]  Self-maintaining brain daemon
  config [show|get|set] <key> [val]  Brain config
  storage status [--repo <path>]     Storage tier status and health
        [--json]                     (git-tracked vs supabase-only)
  serve                              MCP server (stdio)
  serve --http [--port N]            HTTP MCP server with OAuth 2.1
    --token-ttl N                    Access token TTL in seconds (default: 3600)
    --enable-dcr                     Enable Dynamic Client Registration
    --public-url URL                 Public issuer URL (required behind proxy/tunnel)
  call <tool> '<json>'               Raw tool invocation
  version                            Version info
  --tools-json                       Tool discovery (JSON)

Run gbrain <command> --help for command-specific help.
`);
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
