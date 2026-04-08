#!/usr/bin/env bun

import { PostgresEngine } from './core/postgres-engine.ts';
import { SQLiteEngine } from './core/sqlite-engine.ts';
import { loadConfig, toEngineConfig } from './core/config.ts';
import type { BrainEngine } from './core/engine.ts';
import { VERSION } from './version.ts';

const COMMAND_HELP: Record<string, string> = {
  init: 'Usage: gbrain init [--supabase|--sqlite|--url <conn>] [--path <db-file>]\n\nCreate brain (guided wizard).',
  upgrade: 'Usage: gbrain upgrade\n\nSelf-update the CLI.\n\nDetects install method (bun, binary, clawhub) and runs the appropriate update.',
  get: 'Usage: gbrain get <slug>\n\nRead a page by slug (supports fuzzy matching).',
  put: 'Usage: gbrain put <slug> [< file.md]\n\nWrite or update a page from stdin.',
  delete: 'Usage: gbrain delete <slug>\n\nDelete a page.',
  list: 'Usage: gbrain list [--type T] [--tag T] [-n N]\n\nList pages with filters.',
  search: 'Usage: gbrain search <query>\n\nKeyword search (tsvector).',
  query: 'Usage: gbrain query <question> [--no-expand]\n\nHybrid search (vector + keyword + RRF + expansion).',
  import: 'Usage: gbrain import <dir> [--no-embed]\n\nImport markdown directory (idempotent).',
  sync: 'Usage: gbrain sync [--repo <path>] [--watch] [--full]\n\nGit-to-brain incremental sync.',
  export: 'Usage: gbrain export [--dir ./out/]\n\nExport to markdown (round-trip).',
  files: 'Usage: gbrain files <list|upload|sync|verify> [options]\n\nManage stored files.\n\n  files list [slug]                  List stored files\n  files upload <file> --page <slug>  Upload file to storage\n  files sync <dir>                   Bulk upload directory\n  files verify                       Verify all uploads',
  embed: 'Usage: gbrain embed [<slug>|--all|--stale]\n\nGenerate/refresh embeddings.',
  stats: 'Usage: gbrain stats\n\nBrain statistics.',
  health: 'Usage: gbrain health\n\nBrain health dashboard (embed coverage, stale, orphans).',
  tag: 'Usage: gbrain tag <slug> <tag>\n\nAdd tag to a page.',
  untag: 'Usage: gbrain untag <slug> <tag>\n\nRemove tag from a page.',
  tags: 'Usage: gbrain tags <slug>\n\nList tags for a page.',
  link: 'Usage: gbrain link <from> <to> [--type T]\n\nCreate typed link between pages.',
  unlink: 'Usage: gbrain unlink <from> <to>\n\nRemove link between pages.',
  backlinks: 'Usage: gbrain backlinks <slug>\n\nShow incoming links to a page.',
  graph: 'Usage: gbrain graph <slug> [--depth N]\n\nTraverse link graph (default depth 5).',
  timeline: 'Usage: gbrain timeline [<slug>]\n\nView timeline entries.',
  'timeline-add': 'Usage: gbrain timeline-add <slug> <date> <text>\n\nAdd timeline entry.',
  history: 'Usage: gbrain history <slug>\n\nPage version history.',
  revert: 'Usage: gbrain revert <slug> <version-id>\n\nRevert to previous version.',
  config: 'Usage: gbrain config [show|get|set] <key> [value]\n\nBrain config management.',
  serve: 'Usage: gbrain serve\n\nStart MCP server (stdio).',
  call: "Usage: gbrain call <tool> '<json>'\n\nRaw tool invocation.",
};

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

  // Per-command --help (before any dispatch or DB connection)
  const subArgs = args.slice(1);
  if (subArgs.includes('--help') || subArgs.includes('-h')) {
    const help = COMMAND_HELP[command];
    if (help) {
      console.log(help);
      return;
    }
  }

  // Unknown command check (before DB connection)
  if (!COMMAND_HELP[command]) {
    console.error(`Unknown command: ${command}`);
    console.error('Run gbrain --help for available commands.');
    process.exit(1);
  }

  // Commands that don't need a database connection
  if (command === 'init') {
    const { runInit } = await import('./commands/init.ts');
    await runInit(subArgs);
    return;
  }

  if (command === 'upgrade') {
    const { runUpgrade } = await import('./commands/upgrade.ts');
    await runUpgrade(subArgs);
    return;
  }

  // All other commands need a database connection
  const engine = await connectEngine();

  try {
    switch (command) {
      case 'get': {
        const { runGet } = await import('./commands/get.ts');
        await runGet(engine, subArgs);
        break;
      }
      case 'put': {
        const { runPut } = await import('./commands/put.ts');
        await runPut(engine, subArgs);
        break;
      }
      case 'list': {
        const { runList } = await import('./commands/list.ts');
        await runList(engine, subArgs);
        break;
      }
      case 'search': {
        const { runSearch } = await import('./commands/search.ts');
        await runSearch(engine, subArgs);
        break;
      }
      case 'query': {
        const { runQuery } = await import('./commands/query.ts');
        await runQuery(engine, subArgs);
        break;
      }
      case 'import': {
        const { runImport } = await import('./commands/import.ts');
        await runImport(engine, subArgs);
        break;
      }
      case 'sync': {
        const { runSync } = await import('./commands/sync.ts');
        await runSync(engine, subArgs);
        break;
      }
      case 'export': {
        const { runExport } = await import('./commands/export.ts');
        await runExport(engine, subArgs);
        break;
      }
      case 'files': {
        const { runFiles } = await import('./commands/files.ts');
        await runFiles(engine, subArgs);
        break;
      }
      case 'embed': {
        const { runEmbed } = await import('./commands/embed.ts');
        await runEmbed(engine, subArgs);
        break;
      }
      case 'stats': {
        const { runStats } = await import('./commands/stats.ts');
        await runStats(engine);
        break;
      }
      case 'health': {
        const { runHealth } = await import('./commands/health.ts');
        await runHealth(engine);
        break;
      }
      case 'tag': {
        const { runTag } = await import('./commands/tags.ts');
        await runTag(engine, subArgs);
        break;
      }
      case 'untag': {
        const { runUntag } = await import('./commands/tags.ts');
        await runUntag(engine, subArgs);
        break;
      }
      case 'tags': {
        const { runTags } = await import('./commands/tags.ts');
        await runTags(engine, subArgs);
        break;
      }
      case 'link': {
        const { runLink } = await import('./commands/link.ts');
        await runLink(engine, subArgs);
        break;
      }
      case 'unlink': {
        const { runUnlink } = await import('./commands/link.ts');
        await runUnlink(engine, subArgs);
        break;
      }
      case 'backlinks': {
        const { runBacklinks } = await import('./commands/link.ts');
        await runBacklinks(engine, subArgs);
        break;
      }
      case 'graph': {
        const { runGraph } = await import('./commands/link.ts');
        await runGraph(engine, subArgs);
        break;
      }
      case 'timeline': {
        const { runTimeline } = await import('./commands/timeline.ts');
        await runTimeline(engine, subArgs);
        break;
      }
      case 'timeline-add': {
        const { runTimelineAdd } = await import('./commands/timeline.ts');
        await runTimelineAdd(engine, subArgs);
        break;
      }
      case 'delete': {
        const { runDelete } = await import('./commands/delete.ts');
        await runDelete(engine, subArgs);
        break;
      }
      case 'history': {
        const { runHistory } = await import('./commands/version.ts');
        await runHistory(engine, subArgs);
        break;
      }
      case 'revert': {
        const { runRevert } = await import('./commands/version.ts');
        await runRevert(engine, subArgs);
        break;
      }
      case 'config': {
        const { runConfig } = await import('./commands/config.ts');
        await runConfig(engine, subArgs);
        break;
      }
      case 'serve': {
        const { runServe } = await import('./commands/serve.ts');
        await runServe(engine);
        break;
      }
      case 'call': {
        const { runCall } = await import('./commands/call.ts');
        await runCall(engine, subArgs);
        break;
      }
    }
  } finally {
    await engine.disconnect();
  }
}

async function connectEngine(): Promise<BrainEngine> {
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init --supabase or gbrain init --sqlite');
    process.exit(1);
  }

  const engine = config.engine === 'sqlite'
    ? new SQLiteEngine()
    : new PostgresEngine();

  await engine.connect(toEngineConfig(config));
  return engine;
}

function printHelp() {
  console.log(`gbrain ${VERSION} — personal knowledge brain

USAGE
  gbrain <command> [options]

SETUP
  init [--supabase|--sqlite|--url]    Create brain (guided wizard)
  upgrade                            Self-update

PAGES
  get <slug>                         Read a page
  put <slug> [< file.md]             Write/update a page
  delete <slug>                      Delete a page
  list [--type T] [--tag T] [-n N]   List pages

SEARCH
  search <query>                     Keyword search (tsvector)
  query <question>                   Hybrid search (RRF + expansion)

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
  config [show|get|set] <key> [value] Brain config
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
