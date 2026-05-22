/**
 * E2E test helpers: DB lifecycle, fixture import, timing, and diagnostics.
 *
 * Usage in test files:
 *   import { setupDB, teardownDB, importFixtures, time } from './helpers.ts';
 *   beforeAll(async () => { await setupDB(); await importFixtures(); });
 *   afterAll(async () => { await teardownDB(); });
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative, dirname, basename, extname } from 'path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as db from '../../src/core/db.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';

// Load .env.testing if present
const envPath = resolve(import.meta.dir, '../../.env.testing');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
const FIXTURES_DIR = resolve(import.meta.dir, 'fixtures');

let engine: PostgresEngine | null = null;

const ALL_TABLES = [
  'content_chunks',
  'links',
  'tags',
  'raw_data',
  'timeline_entries',
  'page_versions',
  'ingest_log',
  'files',
  'pages',       // last because of foreign keys
  'config',
  'minion_attachments',
  'minion_inbox',
  'minion_jobs',
];

/**
 * Check if a real database is available for E2E tests.
 */
export function hasDatabase(): boolean {
  return !!DATABASE_URL;
}

/**
 * Connect to DB, run schema init, truncate all tables.
 * Call in beforeAll() of each test file.
 */
export async function setupDB(): Promise<PostgresEngine> {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL not set. Copy .env.testing.example to .env.testing and configure it.');
  }

  // Disconnect any prior connection (clean slate)
  await db.disconnect();

  // Connect fresh
  await db.connect({ database_url: DATABASE_URL });
  await db.initSchema();

  // Truncate all data tables (preserves schema + extensions)
  const conn = db.getConnection();
  for (const table of ALL_TABLES) {
    await conn.unsafe(`TRUNCATE ${table} CASCADE`);
  }

  // Re-seed config (initSchema inserts default config rows)
  await conn.unsafe(`
    INSERT INTO config (key, value) VALUES ('schema_version', '1')
    ON CONFLICT (key) DO NOTHING
  `);

  engine = new PostgresEngine();
  await engine.connect({ database_url: DATABASE_URL });
  return engine;
}

/**
 * Disconnect from DB. Call in afterAll() of each test file.
 */
export async function teardownDB(): Promise<void> {
  if (engine) {
    await engine.disconnect();
    engine = null;
  }
  await db.disconnect();
}

/**
 * Get the current engine instance.
 */
export function getEngine(): PostgresEngine {
  if (!engine) throw new Error('setupDB() must be called first');
  return engine;
}

/**
 * Get a raw DB connection for direct queries.
 */
export function getConn() {
  return db.getConnection();
}

/**
 * Import all fixture files from test/e2e/fixtures/ into the brain.
 * Returns the list of import results.
 */
export async function importFixtures() {
  const e = getEngine();
  const results: Array<{ slug: string; status: string; chunks: number }> = [];

  const files = findMarkdownFiles(FIXTURES_DIR);
  for (const filePath of files) {
    const relPath = relative(FIXTURES_DIR, filePath);
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseMarkdown(content, relPath);
    const result = await importFromContent(e, parsed.slug, content, { noEmbed: true });
    results.push(result);
  }

  return results;
}

/**
 * Import a single fixture by its relative path within fixtures/.
 */
export async function importFixture(relativePath: string) {
  const e = getEngine();
  const filePath = join(FIXTURES_DIR, relativePath);
  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseMarkdown(content, relativePath);
  return importFromContent(e, parsed.slug, content, { noEmbed: true });
}

/**
 * Recursively find all .md files in a directory.
 */
function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findMarkdownFiles(full));
    } else if (extname(entry) === '.md') {
      results.push(full);
    }
  }
  return results.sort();
}

/**
 * Time a function and return [result, durationMs].
 */
export async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await fn();
  const dur = performance.now() - start;
  return [result, dur];
}

/**
 * Dump DB state for debugging on test failure.
 */
export async function dumpDBState(): Promise<string> {
  const conn = db.getConnection();
  const pages = await conn.unsafe(`SELECT slug, type, title FROM pages ORDER BY slug`);
  const chunkCount = await conn.unsafe(`SELECT count(*) as n FROM content_chunks`);
  const linkCount = await conn.unsafe(`SELECT count(*) as n FROM links`);
  const tagCount = await conn.unsafe(`SELECT count(*) as n FROM tags`);

  const lines = [
    `=== DB STATE DUMP ===`,
    `Pages (${pages.length}):`,
    ...pages.map((p: any) => `  ${p.slug} [${p.type}] "${p.title}"`),
    `Chunks: ${chunkCount[0]?.n ?? 0}`,
    `Links: ${linkCount[0]?.n ?? 0}`,
    `Tags: ${tagCount[0]?.n ?? 0}`,
    `=== END DUMP ===`,
  ];
  return lines.join('\n');
}

/**
 * Get the fixtures directory path.
 */
export const FIXTURES_PATH = FIXTURES_DIR;

/**
 * Rewind schema state to `targetVersion` and re-apply migrations in
 * version order up to (and including) `targetVersion`.
 *
 * Used by the v15→v23 chain E2E to simulate the field report's starting
 * state (schema at v15, ~100 real rows, kick off full migration). Before
 * this helper, no CLI flag or test hook existed to stop the migration
 * chain at an intermediate version — `gbrain init --migrate-only` always
 * ran to latest.
 *
 * Caveats:
 *   - Postgres-only (the v15→v23 chain only matters for Postgres anyway;
 *     PGLite's schema is monolithic).
 *   - Destructive to existing DDL: dropping a migration that created
 *     a table leaves tables behind. This helper re-runs migrations from
 *     the CURRENT version (whatever config.version says) upward. It
 *     does NOT rewind down. Pair with `setupDB()` to truncate first.
 *   - After calling this, the schema is whatever `v1..targetVersion`
 *     produced. Columns added by v(targetVersion+1)+ will be missing.
 *
 * Call order in a test:
 *   const engine = await setupDB();         // latest schema, empty tables
 *   await conn.unsafe('ALTER TABLE ...');   // optional: drop forward columns
 *   await setConfigVersion(1);              // reset schema version
 *   await runMigrationsUpTo(engine, 15);    // advance to v15
 *   // ... seed fixture data at v15 shape ...
 *   await runMigrationsFromCurrent(engine); // advance to latest
 */
export async function runMigrationsUpTo(
  engine: PostgresEngine,
  targetVersion: number,
): Promise<void> {
  const { MIGRATIONS } = await import('../../src/core/migrate.ts');
  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);

  const currentStr = await engine.getConfig('version');
  const current = parseInt(currentStr || '1', 10);

  const pending = sorted.filter(m => m.version > current && m.version <= targetVersion);

  for (const m of pending) {
    const sql = m.sqlFor?.[engine.kind] ?? m.sql;
    if (sql) {
      // Inline the transactional wrap from runMigrationSQL so we can
      // stop cleanly at targetVersion without re-invoking the full
      // runMigrations loop.
      await engine.transaction(async (tx) => {
        await tx.runMigration(m.version, sql);
      });
    }
    if (m.handler) {
      await m.handler(engine);
    }
    await engine.setConfig('version', String(m.version));
  }
}

/**
 * Reset `config.version` to the given value. Used to simulate a brain
 * at an older schema state before applying partial migrations via
 * `runMigrationsUpTo`. Does NOT undo DDL — just moves the version
 * marker that the migration runner uses to decide what's pending.
 */
export async function setConfigVersion(version: number): Promise<void> {
  const conn = db.getConnection();
  await conn.unsafe(`
    INSERT INTO config (key, value) VALUES ('version', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [String(version)]);
}
