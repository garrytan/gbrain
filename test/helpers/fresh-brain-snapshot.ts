/**
 * State snapshot of a keyless PGLite brain for the E8 fresh-install audit
 * (`test/migrations-fresh-install-audit.serial.test.ts`): the public schema
 * (columns, indexes, constraints), per-table row counts, the config table and
 * the GBRAIN_HOME file tree. Two equal snapshots taken around an orchestrator
 * run prove the orchestrator changed nothing.
 *
 * File-tree noise every engine open produces is excluded by name, each with
 * its reason, so a real write by an orchestrator is never hidden:
 * - the PGLite datastore directory (binary pages change on any open; its
 *   logical state is the schema/config/row-count part of the snapshot);
 * - lock files and owner records (rewritten with the opener's pid);
 * - Bun's install cache under HOME (not gbrain state).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

export interface BrainSnapshot {
  columns: string[];
  indexes: string[];
  constraints: string[];
  row_counts: Record<string, number>;
  config: Record<string, string>;
  files: Record<string, string>;
}

const VOLATILE_FILE = [
  /(^|\/)\.locks(\/|$)/,
  /(^|\/)locks\//,
  /\.lock$/,
  /\.gbrain-owner\.json$/,
  /(^|\/)\.bun(\/|$)/,
  /(^|\/)\.capy(\/|$)/,
  /(^|\/)persistence\/[^/]+\.(cli|stdio|http)\.json$/,
  /(^|\/)last-update-check$/,
];

function walk(root: string, dir: string, skip: string, out: Record<string, string>): void {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const rel = relative(root, path);
    if (path === skip || VOLATILE_FILE.some(pattern => pattern.test(rel))) continue;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out[`${rel}/`] = 'dir';
      walk(root, path, skip, out);
    } else {
      out[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
}

export function snapshotFiles(home: string, databasePath: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (existsSync(home)) walk(home, home, databasePath, files);
  return files;
}

export async function snapshotBrain(home: string, databasePath: string): Promise<BrainSnapshot> {
  const snapshot = await snapshotDatabase(databasePath);
  return { ...snapshot, files: snapshotFiles(home, databasePath) };
}

async function snapshotDatabase(databasePath: string): Promise<BrainSnapshot> {
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: databasePath });
  try {
    const columns = await engine.executeRaw<{ c: string }>(
      `SELECT table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable || ' default=' || COALESCE(column_default, '') AS c
         FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`);
    const indexes = await engine.executeRaw<{ c: string }>(
      `SELECT tablename || ' ' || indexdef AS c FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname`);
    const constraints = await engine.executeRaw<{ c: string }>(
      `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS c
         FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`);
    const tables = await engine.executeRaw<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`);
    const row_counts: Record<string, number> = {};
    for (const { t } of tables) {
      const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM "${t.replace(/"/g, '""')}"`);
      row_counts[t] = Number(row?.n ?? 0);
    }
    const config: Record<string, string> = {};
    for (const row of await engine.executeRaw<{ key: string; value: string }>('SELECT key, value FROM config ORDER BY key')) {
      config[row.key] = row.value;
    }
    return {
      columns: columns.map(r => r.c), indexes: indexes.map(r => r.c), constraints: constraints.map(r => r.c),
      row_counts, config, files: {},
    };
  } finally {
    await engine.disconnect();
  }
}
