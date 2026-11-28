/**
 * Database-side writer evidence for swap eligibility on a Postgres primary (the maintainer's ruling of 2026-11-22:
 * triggers on the primary while a shadow runs).
 *
 * `gbrain engine shadow start --yes` hooks every base table of the brain's schema with one statement-level trigger,
 * `gbrain_writer_note`, which calls gbrain_note_writer() (migration v332). The function records the writing
 * connection in engine_writer_sessions, so a writer that is not a wrapped gbrain process (another machine, psql, an
 * old binary, raw SQL from a script) still leaves a row the swap counts as an unresolved writer. It never fails the
 * writer and waits at most 50 ms on its own tables: errors, lock waits included, become rows in
 * engine_writer_coverage_gaps. `stop` drops every hook.
 *
 * Crash safety: `<dir>/writer-hooks.json` is written before any trigger is created, and every hook carries the same
 * trigger name, so the next start, stop or full reconcile pass finds and removes hooks left by a killed start or a
 * crashed stop from the catalog itself (the manifest says that an install was attempted; the catalog says what is
 * there). A table found without a working hook while hooks are on (none, disabled, replica-only, other events or
 * another function) gets one and a gap row, so the window it was unhooked counts as unknown. A repair acts only while the
 * manifest says `installed`, and removal and repair share one advisory lock inside their transactions, so a process
 * that outlives `stop` cannot put a hook back.
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
/** Tables of the current schema that carry a trigger of the hook's name, whatever its state (what removal drops). */
const HOOKED_SQL = `SELECT c.relname::text AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND t.tgname = $1 ORDER BY 1`;
/**
 * Tables whose hook works: enabled for ordinary writes ('O' origin or 'A' always, not 'D' disabled or 'R' replica-only),
 * AFTER, statement-level, INSERT OR UPDATE OR DELETE OR TRUNCATE (tgtype 4+8+16+32 = 60), unconditional (no WHEN, no
 * UPDATE OF column list), calling gbrain_note_writer().
 * A hook that differs in any of these records nothing for some writes, so it counts as no hook.
 */
export const effectiveHookSql = (nameParam: string): string => `t.tgname = ${nameParam} AND t.tgenabled IN ('O', 'A') AND NOT t.tgisinternal AND t.tgtype = 60 AND t.tgqual IS NULL AND t.tgattr::text = ''
  AND EXISTS (SELECT 1 FROM pg_proc fp WHERE fp.oid = t.tgfoid AND fp.proname = 'gbrain_note_writer' AND fp.pronargs = 0)`;
const EFFECTIVE_SQL = `SELECT c.relname::text AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND ${effectiveHookSql('$1')} ORDER BY 1`;
/** One key for hook installs and removals, so a repair cannot interleave with a stop (pg_advisory_xact_lock). */
const HOOKS_LOCK = `pg_advisory_xact_lock(hashtext('gbrain_writer_hooks'))`;
const CREATE_HOOK = (table: string, replace = false): string =>
  `CREATE ${replace ? 'OR REPLACE ' : ''}TRIGGER ${WRITER_HOOK_TRIGGER} AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${quoted(table)} FOR EACH STATEMENT EXECUTE FUNCTION gbrain_note_writer()`;

function quoted(name: string): string {
  if (!IDENTIFIER.test(name)) throw Object.assign(new Error(`writer hooks: unexpected table name ${JSON.stringify(name)}`), { code: 'writer_hooks_bad_name' });
  return `"${name}"`;
}

export function writerHooksManifestPath(dir: string): string { return join(dir, 'writer-hooks.json'); }

export interface WriterHooksManifest { version: 1; state: 'installing' | 'installed' | 'removing'; at: string; tables: string[] }

export function readWriterHooksManifest(dir: string): WriterHooksManifest | null {
  // silent-read-ok: a missing or torn manifest only means no install was recorded; removal reads the catalog itself.
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

/** Tables that carry a trigger of the hook's name, in any state. */
export async function listHookedTables(engine: BrainEngine): Promise<string[]> {
  return (await engine.executeRaw<{ name: string }>(HOOKED_SQL, [WRITER_HOOK_TRIGGER])).map(r => r.name);
}

/** Tables whose hook would fire and record for every write (enabled, statement-level, all four events, our function). */
export async function listEffectiveHookedTables(engine: BrainEngine): Promise<string[]> {
  return (await engine.executeRaw<{ name: string }>(EFFECTIVE_SQL, [WRITER_HOOK_TRIGGER])).map(r => r.name);
}

/** Every brain table carries a working hook (what a full reconcile pass repairs when it is not so); seal.ts reads it. */
export async function hooksIntact(engine: BrainEngine): Promise<boolean> {
  const effective = new Set(await listEffectiveHookedTables(engine));
  return (await listTables(engine)).every(t => effective.has(t));
}

export interface HookOptions {
  /** Seam for tests: called after each table is hooked (a throw simulates a killed start). */
  afterTable?: (table: string, index: number) => void | Promise<void>;
  now?: () => Date;
  /** A gap row to record in the install's own transaction (a restart after stop: the hooks were off for a while). */
  gap?: string;
}

/**
 * Hooks every table. Removes leftovers first, then writes the manifest, then creates the triggers in one transaction
 * with a short lock timeout, so a busy table refuses the start instead of queueing writers behind it.
 */
export async function installWriterHooks(engine: BrainEngine, dir: string, o: HookOptions = {}): Promise<string[]> {
  const prior = existsSync(writerHooksManifestPath(dir)) ? readWriterHooksManifest(dir) : null;
  const tables = await listTables(engine);
  writeManifest(dir, { version: 1, state: 'installing', at: (o.now?.() ?? new Date()).toISOString(), tables });
  let committed = false;
  try {
    // One transaction replaces every hook: writers see the old hooks until the commit and the new ones after it, so a
    // restart leaves no committed stretch without a hook, and a failed install rolls back to the hooks that were there.
    await engine.transaction(async (tx) => {
      await tx.executeRaw(`SET LOCAL lock_timeout = '5s'`);
      await tx.executeRaw(`SELECT ${HOOKS_LOCK}`);
      const existing = new Set((await tx.executeRaw<{ name: string }>(HOOKED_SQL, [WRITER_HOOK_TRIGGER])).map(r => r.name));
      // CREATE OR REPLACE TRIGGER (PostgreSQL 14 and newer) swaps a hook without the ACCESS EXCLUSIVE lock a DROP takes, so reads
      // are never blocked; older servers drop and create. Hooks on tables that are no longer brain tables are dropped.
      const [{ v }] = await tx.executeRaw<{ v: string }>(`SELECT current_setting('server_version_num') AS v`) as [{ v: string }];
      const replaceOk = Number(v) >= 140000;
      for (const table of existing) if (!tables.includes(table) || !replaceOk) await tx.executeRaw(`DROP TRIGGER IF EXISTS ${WRITER_HOOK_TRIGGER} ON ${quoted(table)}`);
      let i = 0;
      for (const table of tables) {
        await tx.executeRaw(CREATE_HOOK(table, replaceOk && existing.has(table)));
        await o.afterTable?.(table, i++);
      }
      // A replaced hook must come out enabled and complete; anything else rolls the whole install back to the hooks that were there.
      const effective = new Set((await tx.executeRaw<{ name: string }>(EFFECTIVE_SQL, [WRITER_HOOK_TRIGGER])).map(r => r.name));
      if (tables.some(t => !effective.has(t))) throw Object.assign(new Error('writer hooks: a hook is not effective after install'), { code: 'writer_hooks_ineffective' });
      if (o.gap) await tx.executeRaw(`INSERT INTO engine_writer_coverage_gaps (created_at, code) VALUES (clock_timestamp(), $1)`, [o.gap]);
    });
    committed = true;
  } finally {
    // Rolled back: the earlier hooks, if any, are still in place, so put their manifest back and let repairs resume.
    if (!committed && prior) writeManifest(dir, prior);
  }
  writeManifest(dir, { version: 1, state: 'installed', at: (o.now?.() ?? new Date()).toISOString(), tables });
  return tables;
}

/**
 * Drops every hook in the catalog (whatever the manifest says), then the manifest. Idempotent. The manifest says
 * `removing` first, then the drop runs under the hooks lock and lists the catalog inside its own transaction, so a
 * repair that is committing at that moment is dropped too and a repair that starts later sees `removing` and does nothing.
 */
export async function removeWriterHooks(engine: BrainEngine, dir: string): Promise<number> {
  const prior = existsSync(writerHooksManifestPath(dir)) ? readWriterHooksManifest(dir) : null;
  if (existsSync(writerHooksManifestPath(dir))) writeManifest(dir, { version: 1, state: 'removing', at: new Date().toISOString(), tables: prior?.tables ?? [] });
  const removed = await engine.transaction(async (tx) => {
    await tx.executeRaw(`SET LOCAL lock_timeout = '5s'`);
    await tx.executeRaw(`SELECT ${HOOKS_LOCK}`);
    const hooked = (await tx.executeRaw<{ name: string }>(HOOKED_SQL, [WRITER_HOOK_TRIGGER])).map(r => r.name);
    for (const table of hooked) await tx.executeRaw(`DROP TRIGGER IF EXISTS ${WRITER_HOOK_TRIGGER} ON ${quoted(table)}`);
    // Coverage ends here, so the stretch until hooks return is unknown: record it in the same transaction as the removal.
    // A table that cannot take the row leaves the eligibility read failing, which is NOT READY too, so it must not stop the removal.
    if (hooked.length > 0) await tx.executeRaw(`DO $gap$ BEGIN INSERT INTO engine_writer_coverage_gaps (created_at, code) VALUES (clock_timestamp(), 'hooks_removed'); EXCEPTION WHEN OTHERS THEN NULL; END $gap$`);
    return hooked.length;
  });
  rmSync(writerHooksManifestPath(dir), { force: true });
  return removed;
}

/** Whether the hooks are meant to exist: the manifest says an install finished and no removal began. */
function hooksWanted(dir: string): boolean { return readWriterHooksManifest(dir)?.state === 'installed'; }

/**
 * Full reconcile pass, hooks on: repairs any table whose hook is missing or does not fire for every write (disabled,
 * replica-only, another event set or function: dropped and created again) and records a gap row for each, so the
 * window it was unhooked counts as unknown. It acts only while the manifest says `installed`, checked before it
 * starts and again, under the hooks lock, before its DDL, so a stop that began cannot be undone.
 */
export async function ensureWriterHooks(engine: BrainEngine, dir: string): Promise<string[]> {
  if (!hooksWanted(dir)) return [];
  const effective = new Set(await listEffectiveHookedTables(engine));
  const broken = (await listTables(engine)).filter(t => !effective.has(t));
  if (broken.length === 0) return [];
  const present = new Set(await listHookedTables(engine));
  return engine.transaction(async (tx) => {
    await tx.executeRaw(`SET LOCAL lock_timeout = '5s'`);
    await tx.executeRaw(`SELECT ${HOOKS_LOCK}`);
    if (!hooksWanted(dir)) return [];
    for (const table of broken) {
      if (present.has(table)) await tx.executeRaw(`DROP TRIGGER IF EXISTS ${WRITER_HOOK_TRIGGER} ON ${quoted(table)}`);
      await tx.executeRaw(CREATE_HOOK(table));
      await tx.executeRaw(`INSERT INTO engine_writer_coverage_gaps (created_at, code) VALUES (clock_timestamp(), $1)`, [present.has(table) ? 'hook_ineffective' : 'table_unhooked']);
    }
    return broken;
  });
}
