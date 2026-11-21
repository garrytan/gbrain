/**
 * State 1 of a swap run: an immutable, verified recovery checkpoint of the primary (a PGLite brain).
 *
 * The checkpoint is PGLite's own data directory dump, taken under the writer lock the run holds, written 0600 and
 * hashed. "Verified" means the dump loads into a fresh in-memory PGLite and every table there has the row count the
 * primary had when the dump was taken. A resume checks the file against its hash again before it goes on; a checkpoint
 * that changed is never trusted.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { BrainEngine } from '../engine.ts';
import { getEmbeddedPgliteOptions } from '../pglite-embedded-assets.ts';
import { REAL_FS, type SwapFs } from './record.ts';

export interface Checkpoint { path: string; sha256: string; bytes: number; tables: Record<string, number> }

const TABLES_SQL = `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind = 'r' ORDER BY c.relname COLLATE "C"`;

async function tableCounts(query: (sql: string) => Promise<Array<Record<string, unknown>>>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { name } of await query(TABLES_SQL) as Array<{ name: string }>) {
    const [row] = await query(`SELECT count(*)::int AS n FROM "${name.replace(/"/g, '""')}"`);
    out[name] = Number(row?.n ?? 0);
  }
  return out;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Loads `bytes` into an in-memory PGLite and returns its table counts. */
async function loadedCounts(bytes: Uint8Array): Promise<Record<string, number>> {
  const db = await PGlite.create({ loadDataDir: new Blob([new Uint8Array(bytes)]), ...(await getEmbeddedPgliteOptions()) });
  try {
    return await tableCounts(async sql => (await db.query<Record<string, unknown>>(sql)).rows);
  } finally {
    await db.close();
  }
}

/** Dumps `primary` (a connected PGLite engine) to `path`, verifies the dump and returns the checkpoint. */
export async function writeCheckpoint(primary: BrainEngine, path: string, fs: SwapFs = REAL_FS): Promise<Checkpoint> {
  if (existsSync(path)) throw new Error(`the checkpoint path already exists: ${path}`);
  const db = (primary as unknown as { db?: { dumpDataDir(c: 'none'): Promise<Blob> } }).db;
  if (!db || typeof db.dumpDataDir !== 'function') throw new Error('a swap checkpoint needs a PGLite primary');
  const tables = await tableCounts(sql => primary.executeRaw(sql));
  const bytes = new Uint8Array(await (await db.dumpDataDir('none')).arrayBuffer());
  const fd = fs.open(path);
  try {
    fs.write(fd, bytes);
    fs.fsync(fd);
  } finally {
    fs.close(fd);
  }
  const checkpoint: Checkpoint = { path, sha256: sha256(bytes), bytes: bytes.byteLength, tables };
  await verifyCheckpoint(checkpoint, { load: true });
  return checkpoint;
}

/**
 * Checks the file against its recorded hash and size; with `load`, also loads it and compares every table count.
 * Throws when anything differs.
 */
export async function verifyCheckpoint(c: Checkpoint, opts: { load?: boolean } = {}): Promise<void> {
  if (!existsSync(c.path)) throw new Error('the checkpoint file is missing');
  if (statSync(c.path).size !== c.bytes) throw new Error('the checkpoint file changed size');
  const bytes = new Uint8Array(readFileSync(c.path));
  if (sha256(bytes) !== c.sha256) throw new Error('the checkpoint file no longer matches its hash');
  if (!opts.load) return;
  const loaded = await loadedCounts(bytes);
  const differs = Object.keys({ ...c.tables, ...loaded }).filter(t => c.tables[t] !== loaded[t]);
  if (differs.length) throw new Error(`the checkpoint loads with other row counts in ${differs.length} table(s)`);
}
