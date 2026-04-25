import { execSync } from 'child_process';
import { readdirSync, statSync, lstatSync } from 'fs';
import { join } from 'path';
import {
  createLocalConfigDefaults,
  defaultPGLiteDatabasePath,
  saveConfig,
  type MBrainConfig,
} from '../core/config.ts';
import { createConnectedEngine, createEngine, createEngineFromConfig, toEngineConfig } from '../core/engine-factory.ts';
import * as db from '../core/db.ts';

export async function runInit(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    printInitHelp();
    return;
  }

  const isLocal = args.includes('--local');
  const isSupabase = args.includes('--supabase');
  const isPGLite = args.includes('--pglite');
  const isNonInteractive = args.includes('--non-interactive');
  const jsonOutput = args.includes('--json');
  const urlIndex = args.indexOf('--url');
  const manualUrl = urlIndex !== -1 ? args[urlIndex + 1] : null;
  const keyIndex = args.indexOf('--key');
  const apiKey = keyIndex !== -1 ? args[keyIndex + 1] : null;
  const pathIndex = args.findIndex(arg => arg === '--path' || arg === '--db-path');
  const customPath = pathIndex !== -1 ? args[pathIndex + 1] : null;

  if (isLocal) {
    return initSQLite({ jsonOutput, apiKey, customPath });
  }

  // Upstream default: local PGLite unless the user explicitly picked Supabase/Postgres.
  if (isPGLite || (!isSupabase && !manualUrl && !isNonInteractive)) {
    if (!isPGLite && !isSupabase) {
      const fileCount = countMarkdownFiles(process.cwd());
      if (fileCount >= 1000) {
        console.log(`Found ~${fileCount} .md files. For a brain this size, Supabase gives faster`);
        console.log('search and remote access ($25/mo). PGLite works too but search will be slower at scale.');
        console.log('');
        console.log('  mbrain init --supabase   Set up with Supabase (recommended for large brains)');
        console.log('  mbrain init --pglite     Use local PGLite anyway');
        console.log('');
      }
    }

    return initPGLite({ jsonOutput, apiKey, customPath });
  }

  let databaseUrl: string;
  if (manualUrl) {
    databaseUrl = manualUrl;
  } else if (isNonInteractive) {
    const envUrl = process.env.MBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (envUrl) {
      databaseUrl = envUrl;
    } else {
      console.error('--non-interactive requires --url <connection_string> or MBRAIN_DATABASE_URL / DATABASE_URL');
      process.exit(1);
    }
  } else {
    databaseUrl = await postgresWizard();
  }

  return initPostgres({ databaseUrl, jsonOutput, apiKey });
}

function printInitHelp() {
  console.log(`Usage: mbrain init [options]

Create a brain. For personal/offline use, prefer --local (SQLite).
Bare mbrain init remains local PGLite for compatibility; pass a flag to pick an engine.

OPTIONS
  --local                   Recommended personal path: local SQLite (fully offline; no server needed)
  --pglite                  Local PGLite (embedded Postgres; compatibility default)
  --supabase                Managed Supabase Postgres (interactive wizard)
  --url <conn>              Existing Postgres connection string (postgres:// or postgresql://)
  --non-interactive         Fail instead of prompting; use with --url or MBRAIN_DATABASE_URL
  --path <path>             Override the SQLite/PGLite database path
  --key <openai_api_key>    Save an OpenAI API key in the config
  --json                    Emit machine-readable status output
  -h, --help                Show this help and exit

Examples
  mbrain init --local
  mbrain init --pglite --path ~/brains/work.pglite
  mbrain init --url postgresql://user:pass@host:5432/db --non-interactive
`);
}

async function initSQLite(opts: { jsonOutput: boolean; apiKey: string | null; customPath: string | null }) {
  const engineConfig = createLocalConfigDefaults({
    ...(opts.customPath ? { database_path: opts.customPath } : {}),
    ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
  });
  const engine = createEngineFromConfig(engineConfig);

  console.log('Bootstrapping local SQLite brain...');
  await engine.connect(toEngineConfig(engineConfig));
  console.log('Running schema migration...');
  await engine.initSchema();

  saveConfig(engineConfig);
  console.log('Config saved to ~/.mbrain/config.json');

  const stats = await engine.getStats();
  await engine.disconnect();

  if (opts.jsonOutput) {
    console.log(JSON.stringify({
      status: 'success',
      engine: 'sqlite',
      pages: stats.page_count,
      path: engineConfig.database_path,
      profile: 'local_offline',
    }));
  } else {
    console.log(`\nLocal brain ready. ${stats.page_count} pages.`);
    console.log(`SQLite DB: ${engineConfig.database_path}`);
    console.log('Next: mbrain import <dir> to index your markdown locally.');
    console.log('Then: mbrain setup-agent to configure Claude Code / Codex.');
  }
}

async function initPGLite(opts: { jsonOutput: boolean; apiKey: string | null; customPath: string | null }) {
  const dbPath = opts.customPath || defaultPGLiteDatabasePath();
  console.log('Setting up local brain with PGLite (no server needed)...');

  const engine = await createEngine({ engine: 'pglite' });
  await engine.connect({ database_path: dbPath, engine: 'pglite' });
  await engine.initSchema();

  const config: MBrainConfig = {
    engine: 'pglite',
    database_path: dbPath,
    offline: false,
    embedding_provider: 'none',
    query_rewrite_provider: 'none',
    ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
  };
  saveConfig(config);

  const stats = await engine.getStats();
  await engine.disconnect();

  if (opts.jsonOutput) {
    console.log(JSON.stringify({ status: 'success', engine: 'pglite', path: dbPath, pages: stats.page_count }));
  } else {
    console.log(`\nBrain ready at ${dbPath}`);
    console.log(`${stats.page_count} pages. Engine: PGLite (local Postgres).`);
    console.log('Next: mbrain import <dir>');
    console.log('');
    console.log('When you outgrow local: mbrain migrate --to supabase');
  }
}

async function initPostgres(opts: { databaseUrl: string; jsonOutput: boolean; apiKey: string | null }) {
  const { databaseUrl } = opts;

  if (databaseUrl.match(/db\.[a-z]+\.supabase\.co/) || databaseUrl.includes('.supabase.co:5432')) {
    console.warn('');
    console.warn('WARNING: You provided a Supabase direct connection URL (db.*.supabase.co:5432).');
    console.warn('  Direct connections are IPv6 only and fail in many environments.');
    console.warn('  Use the Session pooler connection string instead (port 6543):');
    console.warn('  Supabase Dashboard > gear icon (Project Settings) > Database >');
    console.warn('  Connection string > URI tab > change dropdown to "Session pooler"');
    console.warn('');
  }

  console.log('Connecting to database...');
  const engineConfig: MBrainConfig = {
    engine: 'postgres',
    database_url: databaseUrl,
    offline: false,
    embedding_provider: 'none',
    query_rewrite_provider: 'none',
    ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
  };
  try {
    const engine = await createConnectedEngine(engineConfig);
    try {
      const conn = db.getConnection();
      const ext = await conn`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
      if (ext.length === 0) {
        console.log('pgvector extension not found. Attempting to create...');
        try {
          await conn`CREATE EXTENSION IF NOT EXISTS vector`;
          console.log('pgvector extension created successfully.');
        } catch {
          console.error('Could not auto-create pgvector extension. Run this on your Postgres database:');
          console.error('  CREATE EXTENSION vector;');
          console.error("  Use psql, your provider's query console, or Supabase SQL Editor if applicable.");
          await engine.disconnect();
          process.exit(1);
        }
      }
    } catch {
      // Non-fatal: proceed without pgvector if the capability check itself fails.
    }

    console.log('Running schema migration...');
    await engine.initSchema();

    saveConfig(engineConfig);
    console.log('Config saved to ~/.mbrain/config.json');

    const stats = await engine.getStats();
    await engine.disconnect();

    if (opts.jsonOutput) {
      console.log(JSON.stringify({ status: 'success', engine: 'postgres', pages: stats.page_count }));
    } else {
      console.log(`\nBrain ready. ${stats.page_count} pages.`);
      console.log('Next: mbrain import <dir> to migrate your markdown.');
      console.log('Then: mbrain setup-agent to configure Claude Code / Codex.');
      console.log('Full reference: docs/MBRAIN_SKILLPACK.md');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (databaseUrl.includes('supabase.co') && (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT'))) {
      console.error('Connection failed. Supabase direct connections (db.*.supabase.co:5432) are IPv6 only.');
      console.error('Use the Session pooler connection string instead (port 6543).');
    }
    throw e;
  }
}

async function postgresWizard(): Promise<string> {
  try {
    execSync('bunx supabase --version', { stdio: 'pipe' });
    console.log('Supabase CLI detected (optional managed Postgres helper).');
    console.log('If you want a managed Postgres example, you can run:');
    console.log('  bunx supabase login && bunx supabase projects create');
    console.log('Then pass any working connection string with: mbrain init --url <connection_string>');
  } catch {
    console.log('No Supabase CLI detected (optional).');
    console.log('That is fine — any reachable Postgres connection string works.');
  }

  console.log('\nEnter your Postgres connection URL:');
  console.log('  Example format: postgresql://user:password@host:5432/database');
  console.log('  Any working postgres:// or postgresql:// connection string is acceptable.');
  console.log('  Example managed provider: Supabase session pooler URI from Dashboard >');
  console.log('    gear icon (Project Settings) > Database > Connection string > URI > Session pooler\n');

  const url = await readLine('Connection URL: ');
  if (!url) {
    console.error('No URL provided.');
    process.exit(1);
  }
  return url;
}

function countMarkdownFiles(dir: string, maxScan = 1500): number {
  let count = 0;
  try {
    const scan = (d: string) => {
      if (count >= maxScan) return;
      for (const entry of readdirSync(d)) {
        if (count >= maxScan) return;
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const full = join(d, entry);
        try {
          const stat = lstatSync(full);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) scan(full);
          else if (entry.endsWith('.md')) count++;
        } catch {
          // Skip unreadable paths.
        }
      }
    };
    scan(dir);
  } catch {
    // Skip unreadable roots.
  }
  return count;
}

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (chunk) => {
      process.stdin.pause();
      resolve(chunk.toString().trim());
    });
    process.stdin.resume();
  });
}
