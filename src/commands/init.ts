import { execSync } from 'child_process';
import { PostgresEngine } from '../core/postgres-engine.ts';
import { SQLiteEngine } from '../core/sqlite-engine.ts';
import { saveConfig, getConfigDir, type GBrainConfig } from '../core/config.ts';
import { join } from 'path';

export async function runInit(args: string[]) {
  const isSqlite = args.includes('--sqlite');
  const urlIndex = args.indexOf('--url');
  const manualUrl = urlIndex !== -1 ? args[urlIndex + 1] : null;
  const pathIndex = args.indexOf('--path');
  const manualPath = pathIndex !== -1 ? args[pathIndex + 1] : null;

  if (isSqlite) {
    await initSqlite(manualPath);
  } else {
    await initPostgres(manualUrl);
  }
}

async function initSqlite(dbPath: string | null) {
  const resolvedPath = dbPath || join(getConfigDir(), 'brain.db');
  console.log(`Creating SQLite brain at ${resolvedPath}...`);

  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: resolvedPath });

  console.log('Running schema migration...');
  await engine.initSchema();

  const config: GBrainConfig = {
    engine: 'sqlite',
    database_path: resolvedPath,
  };
  saveConfig(config);
  console.log('Config saved to ~/.gbrain/config.json');

  const stats = await engine.getStats();
  await engine.disconnect();

  console.log(`\nBrain ready. ${stats.page_count} pages.`);
  console.log('Next: gbrain import <dir> to add your markdown.');
}

async function initPostgres(manualUrl: string | null) {
  let databaseUrl: string;

  if (manualUrl) {
    databaseUrl = manualUrl;
  } else {
    databaseUrl = await supabaseWizard();
  }

  console.log('Connecting to database...');
  const engine = new PostgresEngine();
  await engine.connect({ database_url: databaseUrl });

  console.log('Running schema migration...');
  await engine.initSchema();

  const config: GBrainConfig = {
    engine: 'postgres',
    database_url: databaseUrl,
  };
  saveConfig(config);
  console.log('Config saved to ~/.gbrain/config.json');

  const stats = await engine.getStats();
  await engine.disconnect();

  console.log(`\nBrain ready. ${stats.page_count} pages.`);
  console.log('Next: gbrain import <dir> to migrate your markdown.');
}

async function supabaseWizard(): Promise<string> {
  try {
    execSync('bunx supabase --version', { stdio: 'pipe' });
    console.log('Supabase CLI detected.');
    console.log('To auto-provision, run: bunx supabase login && bunx supabase projects create');
    console.log('Then use: gbrain init --url <your-connection-string>');
  } catch {
    console.log('Supabase CLI not found.');
    console.log('Install it: bun add -g supabase');
    console.log('Or provide a connection URL directly.');
  }

  console.log('\nEnter your Supabase/Postgres connection URL:');
  console.log('  Format: postgresql://user:password@host:port/database');
  console.log('  Find it: Supabase Dashboard > Settings > Database > Connection string\n');

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
