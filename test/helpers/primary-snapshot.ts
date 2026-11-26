/**
 * Byte-level snapshots of a brain's primary store, for tests that prove a shadow command left it untouched:
 * every `persistence_*` table (all columns, ordered by primary key) and a directory tree (path, size, mtime, SHA-256).
 * `snapshotPersistence` works on PGLite and Postgres alike: it only needs `executeRaw`.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

interface RawEngine { executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> }

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Every `persistence_%` table in the current schema, as `{ table: [row json, ...] }` with rows ordered by primary key (or by their text when a table has none). */
export async function snapshotPersistence(engine: RawEngine): Promise<Record<string, string[]>> {
  const tables = await engine.executeRaw<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'persistence\\_%' ORDER BY tablename`);
  const out: Record<string, string[]> = {};
  for (const { tablename } of tables) {
    const pk = await engine.executeRaw<{ attname: string }>(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY a.attname`, [quote(tablename)]);
    const order = pk.length ? pk.map((c) => `t.${quote(c.attname)}`).join(', ') : 't::text';
    const rows = await engine.executeRaw<{ row: unknown }>(`SELECT to_jsonb(t) AS row FROM ${quote(tablename)} t ORDER BY ${order}`);
    out[tablename] = rows.map((r) => JSON.stringify(r.row));
  }
  return out;
}

/** `relative path -> type, size, mtime (ms) and SHA-256 of a file`, for everything under `root` except the `skip` paths. */
export function snapshotTree(root: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (skip.includes(path)) continue;
      const st = lstatSync(path);
      const rel = relative(root, path);
      if (st.isDirectory()) { out[rel] = `dir mtime=${st.mtimeMs}`; walk(path); }
      else if (st.isFile()) out[rel] = `file size=${st.size} mtime=${st.mtimeMs} sha256=${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
      else out[rel] = `other mtime=${st.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}
