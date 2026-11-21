/**
 * Opening gbrain's real engines for the baseline: createEngine (engine-factory.ts) + connect + initSchema,
 * exactly as the CLI does. The embedding column is vector(1024): the gateway is never configured here, so
 * initSchema falls back to gbrain's default shape (DEFAULT_EMBEDDING_DIMENSIONS = 1024, voyage:voyage-4),
 * which is also the corpus dimension. No provider is called: every vector comes from the corpus.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createEngine } from '../../../../src/core/engine-factory.ts';
import type { BrainEngine } from '../../../../src/core/engine.ts';
import type { EngineConfig } from '../../../../src/core/types.ts';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from '../../../../src/core/ai/defaults.ts';

export interface StoreSpec {
  kind: 'pglite' | 'postgres';
  /** PGLite data directory. */
  dataDir?: string;
  /** Postgres connection string. */
  databaseUrl?: string;
  /** Postgres pool size (gbrain's own default is 10; the runner raises it so 16 clients are 16 connections). */
  poolMax?: number;
}

export const EMBEDDING_DIMS = DEFAULT_EMBEDDING_DIMENSIONS;
export const EMBEDDING_MODEL = DEFAULT_EMBEDDING_MODEL;
export const MARKER_COMMENT = 'gbrain-bakeoff-baseline';

export function engineConfig(spec: StoreSpec): EngineConfig {
  if (spec.kind === 'pglite') {
    if (!spec.dataDir) throw new Error('pglite needs a data directory');
    return { engine: 'pglite', database_path: spec.dataDir };
  }
  if (!spec.databaseUrl) throw new Error('postgres needs --database-url');
  return { engine: 'postgres', database_url: spec.databaseUrl, pool_max: spec.poolMax ?? 20 };
}

export async function openEngine(spec: StoreSpec, opts: { initSchema?: boolean } = {}): Promise<BrainEngine> {
  const config = engineConfig(spec);
  const engine = await createEngine(config);
  await engine.connect(config);
  if (opts.initSchema) await engine.initSchema();
  return engine;
}

function markerPath(dataDir: string) { return `${dataDir}.bakeoff-marker`; }

/** Prepare an empty PGLite data directory. Only a directory this runner created (marker file) is ever removed. */
export function preparePgliteDir(dataDir: string, fresh: boolean): void {
  const exists = existsSync(dataDir) && readdirSync(dataDir).length > 0;
  if (exists && fresh) {
    if (!existsSync(markerPath(dataDir))) throw new Error(`--fresh refuses to delete ${dataDir}: it was not created by this runner (no ${markerPath(dataDir)})`);
    rmSync(dataDir, { recursive: true, force: true });
  } else if (exists && !fresh) {
    return;
  }
  mkdirSync(dirname(dataDir), { recursive: true });
  writeFileSync(markerPath(dataDir), `${MARKER_COMMENT}\n`);
}

function adminUrl(databaseUrl: string): { admin: string; name: string } {
  const u = new URL(databaseUrl);
  const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`database name ${JSON.stringify(name)} is not a plain identifier`);
  u.pathname = '/postgres';
  return { admin: u.toString(), name };
}

/**
 * Create the benchmark database if it is missing; with `fresh`, drop and recreate it, but only when its comment
 * says this runner created it. Never touches a database it did not create.
 */
export async function preparePostgresDatabase(databaseUrl: string, fresh: boolean): Promise<'created' | 'recreated' | 'existing'> {
  const { default: postgres } = await import('#postgres');
  const { admin, name } = adminUrl(databaseUrl);
  const sql = postgres(admin, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ comment: string | null }[]>`
      SELECT shobj_description(d.oid, 'pg_database') AS comment FROM pg_database d WHERE d.datname = ${name}`;
    const quoted = `"${name}"`;
    if (rows.length === 0) {
      await sql.unsafe(`CREATE DATABASE ${quoted}`);
      await sql.unsafe(`COMMENT ON DATABASE ${quoted} IS '${MARKER_COMMENT}'`);
      return 'created';
    }
    if (!fresh) return 'existing';
    if (rows[0]!.comment !== MARKER_COMMENT) throw new Error(`--fresh refuses to drop database ${name}: it was not created by this runner`);
    await sql.unsafe(`DROP DATABASE ${quoted} WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE ${quoted}`);
    await sql.unsafe(`COMMENT ON DATABASE ${quoted} IS '${MARKER_COMMENT}'`);
    return 'recreated';
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function countPages(engine: BrainEngine): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>('SELECT count(*)::int AS n FROM pages');
  return Number(rows[0]?.n ?? 0);
}

export async function countChunks(engine: BrainEngine): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>('SELECT count(*)::int AS n FROM content_chunks');
  return Number(rows[0]?.n ?? 0);
}

/** A bench source row, like test/eval seeds do (sources have no typed create method in BrainEngine). */
export async function ensureSource(engine: BrainEngine, id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`, [id]);
}

export async function versions(engine: BrainEngine): Promise<Record<string, string>> {
  const out: Record<string, string> = { bun: Bun.version };
  const row = async (sql: string) => (await engine.executeRaw<Record<string, string>>(sql))[0];
  try { out.server = (await row('SHOW server_version'))?.server_version ?? ''; } catch { /* ignore */ }
  try { out.pgvector = (await row(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`))?.extversion ?? ''; } catch { /* ignore */ }
  try {
    const pkg = await Bun.file(new URL('../../../../node_modules/@electric-sql/pglite/package.json', import.meta.url)).json();
    out.pglite = pkg.version;
  } catch { /* ignore */ }
  return out;
}
