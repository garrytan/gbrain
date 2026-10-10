/**
 * Engine graduation custody harness: a real disk-backed PGLite source brain
 * in a temp GBRAIN_HOME and a real target engine (an in-memory PGLite, or
 * Postgres when the caller passes a guarded test DATABASE_URL), with the
 * copy/verify/drain/target lanes replaced by thin, honest stand-ins over one
 * carried probe table. Custody, schema, fence, manifest, marker, tombstone,
 * lock and routing code under test is the production code.
 */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GraduationDeps } from '../../src/core/persistence/engine-graduation.ts';
import type { InventoryEntry, TableReceipt, VerifyResult } from '../../src/core/persistence/engine-graduation.types.ts';
import { withGraduationRun } from '../../src/core/persistence/graduation-schema.ts';
import { withEnv } from './with-env.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

export const PROBE: InventoryEntry = {
  relation: 'grad_probe', kind: 'table', class: 'carry', engines: { pglite: true, postgres: true },
  lossKind: 'user_data', transforms: [], reason: 'harness probe table',
};
const PROBE_DDL = 'CREATE TABLE IF NOT EXISTS grad_probe (id integer PRIMARY KEY, v text NOT NULL)';
export const TARGET_URL = 'postgres://alice-example:secret-pw@db.example.test:5432/brain';
export const SOURCE_TOKEN_ID = '00000000-0000-4000-8000-0000000000a1';

/** An unconnected PGLite engine for held-lock opens (callers disconnect it). */
export function newPgliteEngine(): PGLiteEngine { return new PGLiteEngine(); }

/** Open a disk-backed PGLite engine (callers disconnect it). */
export async function openPglite(dataDir: string): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dataDir });
  return engine;
}

export async function probeRows(engine: BrainEngine): Promise<Array<{ id: number; v: string }>> {
  const [present] = await engine.executeRaw<{ ok: boolean }>(`SELECT to_regclass('grad_probe') IS NOT NULL AS ok`);
  if (!present?.ok) return [];
  return engine.executeRaw<{ id: number; v: string }>('SELECT id, v FROM grad_probe ORDER BY id');
}

export const TOKENS: InventoryEntry = {
  relation: 'access_tokens', kind: 'table', class: 'carry', engines: { pglite: true, postgres: true },
  lossKind: 'security', transforms: [], reason: 'harness security table',
};

async function tableRows(engine: BrainEngine, relation: string): Promise<string[]> {
  const [present] = await engine.executeRaw<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [relation]);
  if (!present?.ok) return [];
  const rows = await engine.transaction(async tx => {
    await tx.executeRaw(`SELECT set_config('TimeZone', 'UTC', true)`);
    return tx.executeRaw<{ r: unknown }>(`SELECT to_jsonb(t) AS r FROM ${relation} t`);
  });
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return rows.map(({ r }) => JSON.stringify(canonical(typeof r === 'string' ? JSON.parse(r) : r))).sort();
}

async function digest(engine: BrainEngine, entry: InventoryEntry): Promise<TableReceipt> {
  const rows = await tableRows(engine, entry.relation);
  return { relation: entry.relation, rows: rows.length, rootSha256: createHash('sha256').update(rows.join('\n')).digest('hex'), batches: [] };
}

/** A non-disconnecting view of the shared target, so the orchestrator's cleanup leaves it open for assertions. */
function borrowed(engine: BrainEngine): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'disconnect') return async () => {};
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export interface Harness {
  root: string;
  home: string;
  /** configDir() under this harness: config.json and the graduation manifest live here. */
  gbrainDir: string;
  dataDir: string;
  mountsPath: string;
  target: BrainEngine;
  deps: Partial<GraduationDeps>;
  calls: Record<string, number>;
  /** Run fn with GBRAIN_HOME pointing at this harness. */
  inHome<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface HarnessOptions { postgresUrl?: string }

/**
 * An empty target brain. On Postgres it is a database of its own, dropped on
 * close: a graduation leaves its target fenced (rollback abandons it that way
 * on purpose), and the shared test database must stay writable for every
 * later file in the same lane.
 */
async function freshTarget(opts: HarnessOptions): Promise<{ engine: BrainEngine; drop: () => Promise<void> }> {
  if (!opts.postgresUrl) {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    return { engine, drop: async () => {} };
  }
  assertSafeE2eDatabaseUrl(opts.postgresUrl);
  const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
  const database = `gbrain_test_graduation_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(opts.postgresUrl, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  const url = new URL(opts.postgresUrl);
  url.pathname = `/${database}`;
  const engine = new PostgresEngine();
  const drop = async () => { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); };
  try {
    await engine.connect({ engine: 'postgres', database_url: url.toString() });
  } catch (error) {
    await drop();
    throw error;
  }
  return { engine, drop };
}

let sourceTemplate: Promise<string> | undefined;

/**
 * One initialized, seeded source datastore per test process. A fresh PGLite
 * datastore costs an initdb plus the full schema replay (about 2 s); every
 * harness copies this closed template instead (under 0.2 s), so a file that
 * builds a harness per test stays inside its lane budget.
 */
function seededSourceTemplate(): Promise<string> {
  sourceTemplate ??= (async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'gbrain-graduation-template-')), 'brain.pglite');
    const source = await openPglite(dir);
    try {
      await source.initSchema();
      await source.executeRaw(PROBE_DDL);
      await source.executeRaw(`INSERT INTO grad_probe VALUES (1,'alpha'),(2,'beta'),(3,'gamma')`);
      await source.executeRaw(`INSERT INTO access_tokens (id, name, token_hash) VALUES ($1::uuid, 'agent-example', 'hash-a1')`, [SOURCE_TOKEN_ID]);
    } finally { await source.disconnect(); }
    return dir;
  })();
  return sourceTemplate;
}

/**
 * A source brain with history-shaped rows: three probe rows and one access
 * token. The datastore is a copy of the process template, opened once at its
 * own path in the harness home (which writes its owner sidecars there), with
 * the identity values initSchema randomizes per brain drawn fresh, so no two
 * harnesses share a brain id or shared-skill secret.
 */
export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-graduation-'));
  const home = join(root, 'home');
  const gbrainDir = join(home, '.gbrain');
  mkdirSync(gbrainDir, { recursive: true });
  const dataDir = join(root, 'brain.pglite');
  const mountsPath = join(root, 'mounts.json');
  writeFileSync(join(gbrainDir, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dataDir }), { mode: 0o600 });
  writeFileSync(mountsPath, JSON.stringify({ version: 1, mounts: [{ id: 'team-example', path: root, engine: 'pglite', database_path: dataDir }] }), { mode: 0o600 });
  cpSync(await seededSourceTemplate(), dataDir, { recursive: true });
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const source = await openPglite(dataDir);
    try {
      await source.executeRaw(`UPDATE persistence_brain SET brain_id = gen_random_uuid() WHERE singleton = 1`);
      await source.executeRaw(`UPDATE shared_skill_state SET token_secret = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), serving_epoch = gen_random_uuid() WHERE singleton = 1`);
    } finally { await source.disconnect(); }
  });
  const { engine: target, drop: dropTarget } = await freshTarget(opts);
  const calls: Record<string, number> = {};
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  const deps: Partial<GraduationDeps> = {
    inventory: { version: 900, entries: [PROBE, TOKENS] },
    assertRelationSet: async () => {},
    copyOrder: async () => [PROBE, TOKENS],
    fkClosure: async () => [],
    digestTable: async (engine, entry) => digest(engine, entry),
    verifyGraduation: async (e): Promise<VerifyResult> => {
      count('verify');
      const tables: TableReceipt[] = [];
      const failures: VerifyResult['failures'][number][] = [];
      for (const entry of [PROBE, TOKENS]) {
        const [source, copied] = [await digest(e.source, entry), await digest(e.target, entry)];
        tables.push(copied);
        if (source.rootSha256 !== copied.rootSha256) failures.push({ relation: entry.relation, kind: 'digest', detail: 'differs' });
      }
      return { ok: failures.length === 0, tables, failures, replay: { status: 'not_available', reason: 'no_caller_input' }, doctorFailingChecks: [] };
    },
    resolveTargetRoutes: ({ url, urlEnv, env }) => {
      const mainUrl = url ?? (urlEnv ? env?.[urlEnv] : undefined) ?? TARGET_URL;
      return { main: 'postgres://alice-example@db.example.test:5432/brain', ddl: 'postgres://alice-example@db.example.test:5432/brain', mainUrl, ddlUrl: mainUrl, ...(urlEnv ? { urlEnv } : {}) };
    },
    targetIdentity: () => ({ id: createHash('sha256').update('db.example.test|5432|brain|alice-example').digest('hex'), host: 'db.example.test', port: 5432, database: 'brain', user: 'alice-example' }),
    probeTarget: async () => ({
      reachable: true, auth: true, ddl: { reachable: true, auth: true }, serverVersion: '16.0', serverVersionNum: 160000,
      vector: { installed: '0.8.0', available: '0.8.0', halfvec: true }, createPrivilege: { database: true, schema: true },
      replicaRole: true, ownsTables: true, triggerBypass: 'session_replication_role',
      gbrainSchema: (await target.executeRaw<{ ok: boolean }>(`SELECT to_regclass('config') IS NOT NULL AS ok`))[0]?.ok === true,
      empty: (await probeRows(target)).length === 0, nonEmptyTables: [], embeddingColumns: [], otherSessions: 0,
    }),
    crossCheckRoutes: async () => {},
    graduationBlockers: async () => [],
    drainForGraduation: async () => { count('drain'); return { drained: [], blockers: [] }; },
    freezeSource: async () => {},
    detectTriggerBypass: async () => 'session_replication_role',
    copyTable: async (e, entry, o) => {
      count('copy');
      if (entry.relation === PROBE.relation) count('copy_probe');
      const rows = await tableRows(e.source, entry.relation);
      await withGraduationRun(e.target, o.runId, async tx => {
        await tx.executeRaw(`DELETE FROM ${entry.relation}`);
        for (const row of rows) await tx.executeRaw(`INSERT INTO ${entry.relation} SELECT * FROM jsonb_populate_record(NULL::${entry.relation}, $1::text::jsonb)`, [row]);
      });
      return { rows: rows.length };
    },
    copySequences: async () => [],
    deferIndexes: async () => [],
    buildDeferredIndexes: async () => ({ built: [] }),
    reenableTriggers: async () => [],
    connectTargets: async () => ({ main: borrowed(target), ddl: borrowed(target), close: async () => {} }),
    initTargetSchema: async t => { await t.initSchema(); await t.executeRaw(PROBE_DDL); },
    claimAutopilotPause: async () => () => { count('pause_released'); },
    runTargetDoctor: async () => ({ failing: [], exempted: [] }),
    runSourceDoctor: async () => [],
    hostId: () => '00000000-0000-4000-8000-00000000beef',
    mountsPath: () => mountsPath,
  };
  return {
    root, home, gbrainDir, dataDir, mountsPath, target, deps, calls,
    inHome: fn => withEnv({ GBRAIN_HOME: home }, fn),
    close: async () => { await target.disconnect(); await dropTarget(); },
  };
}

/** A pause hook that simulates a crash at `step` (the process's cleanup stands in for process death). */
export function crashAt(step: string): (s: string) => Promise<void> {
  return async s => { if (s === step) throw new Error(`simulated crash at ${s}`); };
}
