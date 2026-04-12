#!/usr/bin/env bun

import { readFileSync } from 'fs';
import { loadConfig, toEngineConfig } from './core/config.ts';
import type { BrainEngine } from './core/engine.ts';
import { operations, OperationError } from './core/operations.ts';
import type { Operation, OperationContext } from './core/operations.ts';
import { serializeMarkdown } from './core/markdown.ts';
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
const CLI_ONLY = new Set(['init', 'upgrade', 'post-upgrade', 'check-update', 'integrations', 'import', 'export', 'files', 'embed', 'serve', 'call', 'config', 'doctor', 'migrate']);

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

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
    params[op.cliHints.stdin] = readFileSync('/dev/stdin', 'utf-8');
  }

  return params;
}

function makeContext(engine: BrainEngine, params: Record<string, unknown>): OperationContext {
  return {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: (params.dry_run as boolean) || false,
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
      const score = Math.max(0, 10
        - (h.missing_embeddings > 0 ? 2 : 0)
        - (h.stale_pages > 0 ? 1 : 0)
        - (h.dead_links > 0 ? 1 : 0)
        - (h.orphan_pages > 0 ? 1 : 0));
      return [
        `Health score: ${score}/10`,
        `Embed coverage: ${(h.embed_coverage * 100).toFixed(1)}%`,
        `Missing embeddings: ${h.missing_embeddings}`,
        `Stale pages: ${h.stale_pages}`,
        `Orphan pages: ${h.orphan_pages}`,
        `Dead links: ${h.dead_links}`,
      ].join('\n') + '\n';
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
  if (command === 'upgrade') {
    const { runUpgrade } = await import('./commands/upgrade.ts');
    await runUpgrade(args);
    return;
  }
  if (command === 'post-upgrade') {
    const { runPostUpgrade } = await import('./commands/upgrade.ts');
    runPostUpgrade();
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
        await runServe(engine);
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
      case 'doctor': {
        const { runDoctor } = await import('./commands/doctor.ts');
        await runDoctor(engine, args);
        break;
      }
      case 'migrate': {
        const { runMigrateEngine } = await import('./commands/migrate-engine.ts');
        await runMigrateEngine(engine, args);
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
  const { createEngine } = await import('./core/engine-factory.ts');
  const engine = await createEngine(toEngineConfig(config));
  await engine.connect(toEngineConfig(config));
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
  init [--pglite|--supabase|--url]   Create brain (PGLite default, no server, OpenAI/Gemini embeddings)
  migrate --to <supabase|pglite>     Transfer brain between engines
  upgrade                            Self-update
  check-update [--json]              Check for new versions
  doctor [--json]                    Health check (pgvector, RLS, schema, embeddings)
  integrations [subcommand]          Manage integration recipes (senses + reflexes)

PAGES
  get <slug>                         Read a page
  put <slug> [< file.md]             Write/update a page
  delete <slug>                      Delete a page
  list [--type T] [--tag T] [-n N]   List pages

SEARCH
  search <query>                     Keyword search (tsvector)
  query <question> [--no-expand]     Hybrid search (RRF + expansion)

IMPORT/EXPORT
  import <dir> [--no-embed]          Import markdown directory
  sync [--repo <path>] [flags]       Git-to-brain incremental sync
  export [--dir ./out/]              Export to markdown

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

Run gbrain <command> --help for command-specific help.
`);
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
