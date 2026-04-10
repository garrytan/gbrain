import { execSync } from 'child_process';
import { PostgresEngine } from '../core/postgres-engine.ts';
import { saveConfig, type GBrainConfig } from '../core/config.ts';

export async function runInit(args: string[]) {
  const isSupabase = args.includes('--supabase');
  const isNonInteractive = args.includes('--non-interactive');
  const jsonOutput = args.includes('--json');
  const urlIndex = args.indexOf('--url');
  const manualUrl = urlIndex !== -1 ? args[urlIndex + 1] : null;
  const keyIndex = args.indexOf('--key');
  const apiKey = keyIndex !== -1 ? args[keyIndex + 1] : null;

  let databaseUrl: string;

  if (manualUrl) {
    databaseUrl = manualUrl;
  } else if (isNonInteractive) {
    const envUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (envUrl) {
      databaseUrl = envUrl;
    } else {
      console.error('--non-interactive requires --url <connection_string> or GBRAIN_DATABASE_URL env var');
      process.exit(1);
    }
  } else if (isSupabase) {
    databaseUrl = await supabaseWizard();
  } else {
    databaseUrl = await supabaseWizard();
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
  const engine = new PostgresEngine();
  try {
    await engine.connect({ database_url: databaseUrl });
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

  // Check pgvector extension
  try {
    const conn = (engine as any).sql || (await import('../core/db.ts')).getConnection();
    const ext = await conn`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    if (ext.length === 0) {
      console.log('pgvector extension not found. Enabling it now...');
      try {
        await conn`CREATE EXTENSION IF NOT EXISTS vector`;
        console.log('pgvector extension enabled.');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('Failed to enable pgvector extension automatically:', msg);
        console.error('Run this manually in your Supabase SQL Editor:');
        console.error('  CREATE EXTENSION IF NOT EXISTS vector;');
        await engine.disconnect();
        process.exit(1);
      }
    }
  } catch {
    // Non-fatal: proceed without pgvector check if query fails
  }

  console.log('Running schema migration...');
  await engine.initSchema();

  // Save config
  const config: GBrainConfig = {
    engine: 'postgres',
    database_url: databaseUrl,
    ...(apiKey ? { openai_api_key: apiKey } : {}),
  };
  saveConfig(config);
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

async function supabaseWizard(): Promise<string> {
  // Try Supabase CLI auto-provision
  try {
    execSync('bunx supabase --version', { stdio: 'pipe' });
    console.log('Supabase CLI detected.');
    console.log('To auto-provision, run: bunx supabase login && bunx supabase projects create');
    console.log('Then use: gbrain init --url <your-connection-string>');
  } catch {
    console.log('Supabase CLI not found.');
    console.log('Or provide a connection URL directly.');
  }

  // Fallback to manual URL
  console.log('\nEnter your Supabase/Postgres connection URL:');
  console.log('  Format: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres');
  console.log('  Find it: Supabase Dashboard > gear icon (Project Settings) > Database >');
  console.log('           Connection string > URI tab > change dropdown to "Session pooler"\n');

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
