/**
 * Database-side writer evidence for swap eligibility on a Postgres primary (the maintainer's ruling of 2026-11-22:
 * triggers on the primary while a shadow runs).
 *
 * `gbrain engine shadow start --yes` hooks every base table of the brain's schema with one statement-level trigger,
 * `gbrain_writer_note`, which calls gbrain_note_writer() (migration v332). The function records the writing
 * connection in engine_writer_sessions, so a writer that is not a wrapped gbrain process (another machine, psql, an
 * old binary, raw SQL from a script) still leaves a row the swap counts as an unresolved writer. It never fails or
 * blocks the writer: errors become rows in engine_writer_coverage_gaps. `stop` drops every hook.
 *
 * Crash safety: `<dir>/writer-hooks.json` is written before any trigger is created, and every hook carries the same
 * trigger name, so the next start, stop or full reconcile pass finds and removes hooks left by a killed start or a
 * crashed stop from the catalog itself (the manifest says that an install was attempted; the catalog says what is
 * there). A table found without a hook while hooks are on gets one and a gap row, so the window it was unhooked
 * counts as unknown.
 *
 * PGLite is not hooked: a PGLite brain is one database directory that one process at a time opens on one machine, so
 * every writer is on the shadow host; its eligibility comes from process observations alone.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';

export const WRITER_HOOK_TRIGGER = 'gbrain_writer_note';
/** The evidence tables themselves are never hooked (their own writes would recurse). */
export const WRITER_EVIDENCE_TABLES: readonly string[] = ['engine_writer_coverage_gaps', 'engine_writer_observations', 'engine_writer_sessions'];
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Base and partitioned tables of the current schema, excluding the evidence tables. */
const TABLES_SQL = `SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
  AND c.relname::text <> ALL($1::text[]) ORDER BY 1`;
/** Tables of the current schema that carry the hook. */
const HOOKED_SQL = `SELECT c.relname::text AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND t.tgname = $1 ORDER BY 1`;

function quoted(name: string): string {
  if (!IDENTIFIER.test(name)) throw Object.assign(new Error(`writer hooks: unexpected table name ${JSON.stringify(name)}`), { code: 'writer_hooks_bad_name' });
  return `"${name}"`;
}

export function writerHooksManifestPath(dir: string): string { return join(dir, 'writer-hooks.json'); }

export interface WriterHooksManifest { version: 1; state: 'installing' | 'installed' | 'removing'; at: string; tables: string[] }

export function readWriterHooksManifest(dir: string): WriterHooksManifest | null {
  try { const m = JSON.parse(readFileSync(writerHooksManifestPath(dir), 'utf8')) as WriterHooksManifest; return m?.version === 1 ? m : null; } catch { return null; }
}

function writeManifest(dir: string, m: WriterHooksManifest): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = writerHooksManifestPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** Whether this primary is hooked at all: only a server database (PGLite keeps one process on one machine). */
export function primaryTakesWriterHooks(primaryEngine: string | undefined): boolean {
  return primaryEngine === 'postgres';
}

async function listTables(engine: BrainEngine): Promise<string[]> {
  return (await engine.executeRaw<{ name: string }>(TABLES_SQL, [[...WRITER_EVIDENCE_TABLES]])).map(r => r.name);
}

export async function listHookedTables(engine: BrainEngine): Promise<string[]> {
  return (await engine.executeRaw<{ name: string }>(HOOKED_SQL, [WRITER_HOOK_TRIGGER])).map(r => r.name);
}

export interface HookOptions {
  /** Seam for tests: called after each table is hooked (a throw simulates a killed start). */
  afterTable?: (table: string, index: number) => void;
  now?: () => Date;
}

/**
 * Hooks every table. Removes leftovers first, then writes the manifest, then creates the triggers in one transaction
 * with a short lock timeout, so a busy table refuses the start instead of queueing writers behind it.
 */
export async function installWriterHooks(engine: BrainEngine, dir: string, o: HookOptions = {}): Promise<string[]> {
  await removeWriterHooks(engine, dir);
  const tables = await listTables(engine);
  writeManifest(dir, { version: 1, state: 'installing', at: (o.now?.() ?? new Date()).toISOString(), tables });
  await engine.transaction(async (tx) => {
    await tx.executeRaw(`SET LOCAL lock_timeout = '5s'`);
    let i = 0;
    for (const table of tables) {
      await tx.executeRaw(`CREATE TRIGGER ${WRITER_HOOK_TRIGGER} AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${quoted(table)} FOR EACH STATEMENT EXECUTE FUNCTION gbrain_note_writer()`);
      o.afterTable?.(table, i++);
    }
  });
  writeManifest(dir, { version: 1, state: 'installed', at: (o.now?.() ?? new Date()).toISOString(), tables });
  return tables;
}

/** Drops every hook in the catalog (whatever the manifest says), then the manifest. Idempotent. */
export async function removeWriterHooks(engine: BrainEngine, dir: string): Promise<number> {
  const hooked = await listHookedTables(engine);
  if (hooked.length > 0) {
    if (existsSync(writerHooksManifestPath(dir))) {
      const prior = readWriterHooksManifest(dir);
      writeManifest(dir, { version: 1, state: 'removing', at: new Date().toISOString(), tables: prior?.tables ?? hooked });
    }
    await engine.transaction(async (tx) => {
      await tx.executeRaw(`SET LOCAL lock_timeout = '5s'`);
      for (const table of hooked) await tx.executeRaw(`DROP TRIGGER IF EXISTS ${WRITER_HOOK_TRIGGER} ON ${quoted(table)}`);
    });
  }
  rmSync(writerHooksManifestPath(dir), { force: true });
  return hooked.length;
}

/**
 * Full reconcile pass, hooks on: hooks any table that has none (a table a migration added, or one a killed install
 * missed) and records a gap row for each, so the window it was unhooked counts as unknown.
 */
export async function ensureWriterHooks(engine: BrainEngine): Promise<string[]> {
  const hooked = new Set(await listHookedTables(engine));
  const missing = (await listTables(engine)).filter(t => !hooked.has(t));
  if (missing.length === 0) return [];
  await engine.transaction(async (tx) => {
    await tx.executeRaw(`SET LOCAL lock_timeout = '5s'`);
    for (const table of missing) {
      await tx.executeRaw(`CREATE TRIGGER ${WRITER_HOOK_TRIGGER} AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${quoted(table)} FOR EACH STATEMENT EXECUTE FUNCTION gbrain_note_writer()`);
      await tx.executeRaw(`INSERT INTO engine_writer_coverage_gaps (code) VALUES ($1)`, ['table_unhooked']);
    }
  });
  return missing;
}
