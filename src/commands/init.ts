import { execSync } from 'child_process';
import {
  createLocalConfigDefaults,
  saveConfig,
  type GBrainConfig,
} from '../core/config.ts';
import { createEngineFromConfig, toEngineConfig } from '../core/engine-factory.ts';
import * as db from '../core/db.ts';

export async function runInit(args: string[]) {
  const isLocal = args.includes('--local');
  const isSupabase = args.includes('--supabase');
  const isNonInteractive = args.includes('--non-interactive');
  const jsonOutput = args.includes('--json');
  const urlIndex = args.indexOf('--url');
  const manualUrl = urlIndex !== -1 ? args[urlIndex + 1] : null;
  const keyIndex = args.indexOf('--key');
  const apiKey = keyIndex !== -1 ? args[keyIndex + 1] : null;
  const pathIndex = args.findIndex(arg => arg === '--path' || arg === '--db-path');
  const localDatabasePath = pathIndex !== -1 ? args[pathIndex + 1] : undefined;

  if (isLocal) {
    const engineConfig = createLocalConfigDefaults({
      ...(localDatabasePath ? { database_path: localDatabasePath } : {}),
    });
    const engine = createEngineFromConfig(engineConfig);

    console.log('Bootstrapping local SQLite brain...');
    await engine.connect(toEngineConfig(engineConfig));
    console.log('Running schema migration...');
    await engine.initSchema();

    saveConfig(engineConfig);
    console.log('Config saved to ~/.gbrain/config.json');

    const stats = await engine.getStats();
    await engine.disconnect();

    if (jsonOutput) {
      console.log(JSON.stringify({
        status: 'success',
        pages: stats.page_count,
        config_path: '~/.gbrain/config.json',
        profile: 'local_offline',
      }));
    } else {
      console.log(`\nLocal brain ready. ${stats.page_count} pages.`);
      console.log(`SQLite DB: ${engineConfig.database_path}`);
      console.log('Next: gbrain import <dir> to index your markdown locally.');
    }
    return;
  }

  let databaseUrl: string;

  if (manualUrl) {
    databaseUrl = manualUrl;
  } else if (isNonInteractive) {
    const envUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (envUrl) {
      databaseUrl = envUrl;
    } else {
      console.error('--non-interactive requires --url <connection_string> or GBRAIN_DATABASE_URL / DATABASE_URL');
      process.exit(1);
    }
  } else if (isSupabase) {
    databaseUrl = await postgresWizard();
  } else {
    databaseUrl = await postgresWizard();
  }

  // Detect Supabase direct connection URLs and warn about IPv6
  if (databaseUrl.match(/db\.[a-z]+\.supabase\.co/) || databaseUrl.includes('.supabase.co:5432')) {
    console.warn('');
    console.warn('WARNING: You provided a Supabase direct connection URL (db.*.supabase.co:5432).');
    console.warn('  Direct connections are IPv6 only and fail in many environments.');
    console.warn('  Use the Session pooler connection string instead (port 6543):');
    console.warn('  Supabase Dashboard > gear icon (Project Settings) > Database >');
    console.warn('  Connection string > URI tab > change dropdown to "Session pooler"');
    console.warn('');
  }

  // Connect and init schema
  console.log('Connecting to database...');
  const engineConfig: GBrainConfig = {
    engine: 'postgres',
    database_url: databaseUrl,
    offline: false,
    embedding_provider: 'none',
    query_rewrite_provider: 'none',
    ...(apiKey ? { openai_api_key: apiKey } : {}),
  };
  const engine = createEngineFromConfig(engineConfig);
  try {
    await engine.connect(toEngineConfig(engineConfig));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Provide better error for Supabase IPv6 failures
    if (databaseUrl.includes('supabase.co') && (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT'))) {
      console.error('Connection failed. Supabase direct connections (db.*.supabase.co:5432) are IPv6 only.');
      console.error('Use the Session pooler connection string instead (port 6543):');
      console.error('  Supabase Dashboard > gear icon (Project Settings) > Database >');
      console.error('  Connection string > URI tab > change dropdown to "Session pooler"');
    }
    throw e;
  }

  // Check pgvector extension.
  // db.getConnection() returns the module-level singleton set by PostgresEngine.connect().
  // This is safe here because createEngineFromConfig() above creates a standard (non-pooled)
  // connection that always initializes the db module singleton.
  try {
    const conn = db.getConnection();
    const ext = await conn`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    if (ext.length === 0) {
      console.error('pgvector extension not found. Run this on your Postgres database:');
      console.error('  CREATE EXTENSION vector;');
      console.error("  Use psql, your provider's query console, or Supabase SQL Editor if applicable.");
      await engine.disconnect();
      process.exit(1);
    }
  } catch {
    // Non-fatal: proceed without pgvector check if query fails
  }

  console.log('Running schema migration...');
  await engine.initSchema();

  // Save config
  saveConfig(engineConfig);
  console.log('Config saved to ~/.gbrain/config.json');

  // Verify
  const stats = await engine.getStats();
  await engine.disconnect();

  if (jsonOutput) {
    console.log(JSON.stringify({ status: 'success', pages: stats.page_count, config_path: '~/.gbrain/config.json' }));
  } else {
    console.log(`\nBrain ready. ${stats.page_count} pages.`);
    console.log('Next: gbrain import <dir> to migrate your markdown.');
    console.log('Production agent guide: docs/GBRAIN_SKILLPACK.md');
  }
}

async function postgresWizard(): Promise<string> {
  // Try Supabase CLI auto-provision
  try {
    execSync('bunx supabase --version', { stdio: 'pipe' });
    console.log('Supabase CLI detected (optional managed Postgres helper).');
    console.log('If you want a managed Postgres example, you can run:');
    console.log('  bunx supabase login && bunx supabase projects create');
    console.log('Then pass any working connection string with: gbrain init --url <connection_string>');
  } catch {
    console.log('No Supabase CLI detected (optional).');
    console.log('That is fine — any reachable Postgres connection string works.');
  }

  // Fallback to manual URL
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

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (chunk) => {
      data = chunk.toString().trim();
      resolve(data);
    });
    process.stdin.resume();
  });
}
