/**
 * State 1 of a swap run on a Postgres brain: the recovery checkpoint is a `pg_dump --format custom` of the brain's
 * database (docs/guides/engine-swap.md#checkpoint).
 *
 * The dump holds every page, fact and token of the brain, so it goes only under the gbrain home (never a repo), in a
 * 0700 directory as a 0600 file, and nothing prints or uploads it: the run record keeps its path, size and SHA-256.
 * The database URL reaches pg_dump as its arguments without the password, and the password as `PGPASSWORD` in the
 * child's environment only. "Verified" means `pg_restore --list` reads the file and lists data for every table the
 * brain had when the dump was taken. A resume checks the file against its hash again; a changed file is never trusted.
 *
 * Before the dump, `postgresCheckpointUnavailable` refuses `checkpoint_unavailable` (nothing written) when pg_dump is
 * missing or older than the server, or when the disk under the run directory has less free space than the database's
 * size (`pg_database_size`, an upper bound for a compressed custom dump).
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '../spawn.ts';
import { configDir } from '../config.ts';
import { gbrainApplicationName } from '../db.ts';
import type { BrainEngine } from '../engine.ts';
import type { OperationError } from '../ops/contract.ts';
import { swapRefusal } from './refusals.ts';

const run = promisify(execFile);

export interface PostgresCheckpoint {
  format: 'pg_dump_custom';
  path: string;
  sha256: string;
  bytes: number;
  /** The tables (current schema) the brain had when the dump was taken; `pg_restore --list` must list data for each. */
  tables: Record<string, number>;
}

/** The two client tools the checkpoint uses. Tests replace `version` to prove the refusals. */
export interface PgTools {
  /** pg_dump's major version, or null when pg_dump is not installed. */
  version(): Promise<number | null>;
  dump(args: string[], env: Record<string, string>): Promise<void>;
  list(path: string): Promise<string>;
}

export const SYSTEM_PG_TOOLS: PgTools = {
  async version() {
    try {
      const { stdout } = await run('pg_dump', ['--version'], { timeout: 30_000 });
      const m = /(\d+)(?:\.\d+)?/.exec(String(stdout));
      return m ? Number(m[1]) : null;
    } catch {
      return null; // not installed or not runnable: the caller refuses checkpoint_unavailable
    }
  },
  async dump(args, env) {
    await run('pg_dump', args, { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });
  },
  async list(path) {
    const { stdout } = await run('pg_restore', ['--list', path], { maxBuffer: 64 * 1024 * 1024 });
    return String(stdout);
  },
};

const TABLES_SQL = `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') ORDER BY c.relname COLLATE "C"`;

function gbrainRoot(home?: string): string {
  return resolve(home ? join(home, '.gbrain') : configDir());
}

function insideRoot(path: string, root: string): boolean {
  const p = resolve(path);
  return p.startsWith(root + sep);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function nearestExisting(dir: string): string {
  let d = resolve(dir);
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return d;
}

function defaultFreeBytes(dir: string): number | null {
  try { const s = statfsSync(nearestExisting(dir)); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

function human(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function unavailable(message: string, why: string): OperationError {
  return swapRefusal('checkpoint_unavailable', message, why);
}

/**
 * Null when a checkpoint can be taken into `dir`; otherwise the `checkpoint_unavailable` refusal naming what is
 * missing (pg_dump, a newer pg_dump, or the free space needed). Reads only; creates nothing.
 */
export async function postgresCheckpointUnavailable(
  primary: BrainEngine, dir: string,
  opts: { tools?: PgTools; home?: string; freeBytes?: (dir: string) => number | null } = {},
): Promise<OperationError | null> {
  if (!insideRoot(dir, gbrainRoot(opts.home))) {
    return unavailable('the checkpoint directory is outside the gbrain home.', 'The checkpoint holds the whole brain, so it is only written under the gbrain home.');
  }
  const tools = opts.tools ?? SYSTEM_PG_TOOLS;
  const toolMajor = await tools.version();
  if (toolMajor === null) {
    return unavailable('pg_dump is not installed, so the recovery checkpoint cannot be taken.',
      'Install the PostgreSQL client tools (pg_dump and pg_restore) at the server\'s major version or newer, then run the swap again.');
  }
  const [v] = await primary.executeRaw<{ n: number | string }>(`SELECT current_setting('server_version_num')::int AS n`);
  const serverMajor = Math.floor(Number(v?.n ?? 0) / 10000);
  if (toolMajor < serverMajor) {
    return unavailable(`pg_dump ${toolMajor} is older than the server (PostgreSQL ${serverMajor}), so its dump may not restore.`,
      `Install pg_dump ${serverMajor} or newer, then run the swap again.`);
  }
  const [s] = await primary.executeRaw<{ n: number | string }>('SELECT pg_database_size(current_database())::bigint AS n');
  const needed = Number(s?.n ?? 0);
  const free = (opts.freeBytes ?? defaultFreeBytes)(dir);
  if (free === null || free < needed) {
    return unavailable(`the recovery checkpoint needs about ${human(needed)} free under the gbrain home${free === null ? ' and the free space could not be read' : `, and ${human(free)} is free`}.`,
      'Free space on the disk that holds the gbrain home, then run the swap again.');
  }
  return null;
}

/** Other gbrain sessions on this database (by application_name), not counting this process's own pools. */
export async function postgresSessionsInUse(primary: BrainEngine): Promise<number> {
  const [row] = await primary.executeRaw<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND application_name LIKE 'gbrain %' AND application_name <> $1`, [gbrainApplicationName()]);
  return Number(row?.n ?? 0);
}

/** pg_dump's arguments for `url` (no password) and the child-only environment that carries the password. */
function dumpTarget(url: string): { dbname: string; env: Record<string, string> } {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { dbname: u.toString(), env: password ? { PGPASSWORD: password } : {} };
}

/** Dumps the brain's database into `path` (under the gbrain home), verifies it and returns the checkpoint. */
export async function writePostgresCheckpoint(
  primary: BrainEngine, path: string, opts: { url: string; home?: string; tools?: PgTools },
): Promise<PostgresCheckpoint> {
  if (!insideRoot(path, gbrainRoot(opts.home))) throw new Error('the checkpoint path is outside the gbrain home');
  if (existsSync(path)) throw new Error('the checkpoint path already exists');
  const tools = opts.tools ?? SYSTEM_PG_TOOLS;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The file exists 0600 before pg_dump writes into it, so the dump is never readable by others, even for a moment.
  closeSync(openSync(path, 'wx', 0o600));
  const tables: Record<string, number> = {};
  for (const { name } of await primary.executeRaw<{ name: string }>(TABLES_SQL)) tables[name] = 0;
  const target = dumpTarget(opts.url);
  try {
    await tools.dump(['--format', 'custom', '--no-owner', '--file', path, '--dbname', target.dbname], target.env);
  } catch (error) {
    // pg_dump's stderr can name the host and database; keep only that it failed.
    throw new Error(`pg_dump failed (exit ${(error as { code?: unknown }).code ?? 'unknown'})`);
  }
  const checkpoint: PostgresCheckpoint = { format: 'pg_dump_custom', path, sha256: sha256File(path), bytes: statSync(path).size, tables };
  await verifyPostgresCheckpoint(checkpoint, { list: true, tools });
  return checkpoint;
}

/** Checks the file against its hash and size; with `list`, also that pg_restore lists data for every recorded table. */
export async function verifyPostgresCheckpoint(c: PostgresCheckpoint, opts: { list?: boolean; tools?: PgTools } = {}): Promise<void> {
  if (!existsSync(c.path)) throw new Error('the checkpoint file is missing');
  if ((statSync(c.path).mode & 0o077) !== 0) throw new Error('the checkpoint file is readable by others');
  if (statSync(c.path).size !== c.bytes) throw new Error('the checkpoint file changed size');
  if (sha256File(c.path) !== c.sha256) throw new Error('the checkpoint file no longer matches its hash');
  if (!opts.list) return;
  const toc = await (opts.tools ?? SYSTEM_PG_TOOLS).list(c.path);
  const listed = new Set<string>();
  for (const line of toc.split('\n')) {
    const m = /\bTABLE DATA \S+ (\S+) /.exec(line);
    if (m) listed.add(m[1]!);
  }
  const missing = Object.keys(c.tables).filter(t => !listed.has(t));
  if (missing.length) throw new Error(`the checkpoint is missing ${missing.length} table(s)`);
}
