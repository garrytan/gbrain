import { execSync } from 'child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, lstatSync } from 'fs';
import { basename, dirname, join } from 'path';
import {
  configPath,
  createLocalConfigDefaults,
  defaultPGLiteDatabasePath,
  saveConfig,
  type MBrainConfig,
  type MBrainConfigInput,
} from '../core/config.ts';
import { createConnectedEngine, createEngine, createEngineFromConfig, toEngineConfig } from '../core/engine-factory.ts';
import { assertExplicitRemoteDsn } from '../core/postgres-runtime/connection-profile.ts';
import { MBrainError } from '../core/types.ts';
import * as db from '../core/db.ts';

export interface ConfigOverwriteGuardResult {
  backedUpTo: string | null;
}

interface ConfigTarget {
  engine: 'postgres' | 'sqlite' | 'pglite';
  database_url?: string;
  database_path?: string;
}

// Keep a small window of credential-bearing config backups instead of
// accumulating them forever.
const MAX_CONFIG_BACKUPS = 5;

/** Mask the password portion of a DSN for user-facing messages. */
function sanitizeDsnForDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url.replace(/:\/\/([^:@/]+):[^@/]+@/, '://$1:***@');
  }
}

function describeConfigTarget(target: ConfigTarget): string {
  const location = target.database_url !== undefined
    ? sanitizeDsnForDisplay(target.database_url)
    : target.database_path ?? '(no target)';
  return `${target.engine} ${location}`;
}

/**
 * Guard against `mbrain init` silently clobbering an existing user config
 * (the 2026-06-12 incident: an E2E run repointed ~/.mbrain/config.json at a
 * throwaway test database). Re-initializing the same target is allowed;
 * switching targets requires --force. Any overwrite first copies the current
 * config to a timestamped .bak file.
 */
export function ensureConfigOverwriteAllowed(
  next: ConfigTarget,
  opts: { force: boolean },
): ConfigOverwriteGuardResult {
  const path = configPath();
  if (!existsSync(path)) return { backedUpTo: null };

  let existing: MBrainConfigInput | null = null;
  try {
    existing = JSON.parse(readFileSync(path, 'utf-8')) as MBrainConfigInput;
  } catch {
    existing = null;
  }

  const existingEngine = existing
    ? (existing.engine ?? (existing.database_path ? 'pglite' : 'postgres'))
    : null;
  const sameTarget = existing !== null
    && existingEngine === next.engine
    && (existing.database_url ?? null) === (next.database_url ?? null)
    && (existing.database_path ?? null) === (next.database_path ?? null);

  if (!sameTarget && !opts.force) {
    const existingDescription = existing
      ? describeConfigTarget({
        engine: existingEngine as ConfigTarget['engine'],
        database_url: existing.database_url,
        database_path: existing.database_path,
      })
      : 'an unparseable config';
    throw new MBrainError(
      'Refusing to overwrite existing config',
      `${path} already points to ${existingDescription}, but init was asked to write ${describeConfigTarget(next)}`,
      'Re-run with --force to overwrite (a timestamped backup of the current config is created first)',
    );
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.bak-${timestamp}`;
  copyFileSync(path, backupPath);
  pruneConfigBackups(path);
  return { backedUpTo: backupPath };
}

function pruneConfigBackups(configFilePath: string): void {
  try {
    const dir = dirname(configFilePath);
    const prefix = `${basename(configFilePath)}.bak-`;
    const stale = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort() // ISO timestamps sort lexicographically, oldest first
      .slice(0, -MAX_CONFIG_BACKUPS);
    for (const name of stale) {
      rmSync(join(dir, name), { force: true });
    }
  } catch {
    // Pruning is best-effort; never block init on cleanup.
  }
}

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
  const force = args.includes('--force');
  const urlIndex = args.indexOf('--url');
  const dsnIndex = args.indexOf('--dsn');
  const manualUrl = urlIndex !== -1 ? args[urlIndex + 1] : dsnIndex !== -1 ? args[dsnIndex + 1] : null;
  const profileIndex = args.indexOf('--profile');
  const profile = profileIndex !== -1 ? args[profileIndex + 1] : null;
  const keyIndex = args.indexOf('--key');
  const apiKey = keyIndex !== -1 ? args[keyIndex + 1] : null;
  const pathIndex = args.findIndex(arg => arg === '--path' || arg === '--db-path');
  const customPath = pathIndex !== -1 ? args[pathIndex + 1] : null;

  if (isLocal) {
    return initSQLite({ jsonOutput, apiKey, customPath, force });
  }

  if (isPGLite) {
    return initPGLite({ jsonOutput, apiKey, customPath, force });
  }

  let databaseUrl: string;
  if (manualUrl) {
    databaseUrl = manualUrl;
  } else if (profile) {
    databaseUrl = localPostgresProfileUrl(profile);
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

  return initPostgres({ databaseUrl, jsonOutput, apiKey, force });
}

function printInitHelp() {
  console.log(`Usage: mbrain init [options]

Create a Postgres-backed brain. Bare mbrain init now targets Postgres; pass a
legacy local flag only when you intentionally want SQLite or PGLite.

OPTIONS
  --local                   Legacy local SQLite profile
  --pglite                  Legacy local PGLite profile
  --supabase                Managed Supabase Postgres (interactive wizard)
  --url <conn>              Existing Postgres connection string (postgres:// or postgresql://)
  --dsn <conn>              Alias for --url
  --profile <name>          Local Postgres profile: homebrew-postgres, linux-system-postgres, container-postgres
  --non-interactive         Fail instead of prompting; use with --url or MBRAIN_DATABASE_URL
  --force                   Overwrite a config that points to a different brain (backup created)
  --path <path>             Override the SQLite/PGLite database path
  --key <openai_api_key>    Save an OpenAI API key in the config
  --json                    Emit machine-readable status output
  -h, --help                Show this help and exit

Examples
  mbrain init --profile homebrew-postgres
  mbrain init --dsn postgresql://user:pass@localhost:5432/mbrain --non-interactive
  mbrain init --local
`);
}

async function initSQLite(opts: { jsonOutput: boolean; apiKey: string | null; customPath: string | null; force: boolean }) {
  const engineConfig = createLocalConfigDefaults({
    ...(opts.customPath ? { database_path: opts.customPath } : {}),
    ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
  });
  const guard = ensureConfigOverwriteAllowed(
    { engine: 'sqlite', database_path: engineConfig.database_path },
    { force: opts.force },
  );
  reportConfigBackup(guard);
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

async function initPGLite(opts: { jsonOutput: boolean; apiKey: string | null; customPath: string | null; force: boolean }) {
  const dbPath = opts.customPath || defaultPGLiteDatabasePath();
  const guard = ensureConfigOverwriteAllowed(
    { engine: 'pglite', database_path: dbPath },
    { force: opts.force },
  );
  reportConfigBackup(guard);
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
    console.log('When you outgrow legacy local mode: mbrain migrate --to postgres');
  }
}

async function initPostgres(opts: { databaseUrl: string; jsonOutput: boolean; apiKey: string | null; force: boolean }) {
  const { databaseUrl } = opts;
  const guard = ensureConfigOverwriteAllowed(
    { engine: 'postgres', database_url: databaseUrl },
    { force: opts.force },
  );
  reportConfigBackup(guard);

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
    database_url_explicit: true,
    offline: false,
    embedding_provider: 'none',
    query_rewrite_provider: 'none',
    ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
  };
  assertExplicitRemoteDsn(engineConfig);
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

function reportConfigBackup(guard: ConfigOverwriteGuardResult): void {
  if (guard.backedUpTo) {
    console.log(`Existing config backed up to ${guard.backedUpTo}`);
  }
}

function localPostgresProfileUrl(profile: string): string {
  const user = process.env.PGUSER || process.env.USER || 'postgres';
  switch (profile) {
    case 'homebrew-postgres':
    case 'linux-system-postgres':
    case 'container-postgres':
      return `postgresql://${encodeURIComponent(user)}@localhost:5432/mbrain`;
    default:
      throw new MBrainError(
        'Invalid Postgres profile',
        `Unsupported profile: ${profile}`,
        'Use homebrew-postgres, linux-system-postgres, or container-postgres',
      );
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
