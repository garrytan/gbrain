/**
 * GBRA-161: SIGKILL a real child process at each generation publish fault point and check what a reopened brain holds.
 * The child publishes generation 1 of a synthetic key, installs a fault hook that blocks at the chosen point, and starts
 * publishing generation 2 (which retires one item); the parent kills it there. A recovery child then reads the ledger
 * and pages, reruns the identical publication twice and reports. Disk PGLite, or a fresh Postgres database per case.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from '#postgres'
import { childEnvironment } from '../../scripts/persistence/validate.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { publishGeneration } from '../../src/core/generations/publish.ts';
import { installFaultHook, type FaultPoint } from '../../src/core/persistence/fault-points.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { liveSlugs, setSyntheticInput, syntheticAdapter, syntheticItem, syntheticKey } from '../helpers/synthetic-generation.ts';

export const GENERATION_CRASH_POINTS = ['generation:published', 'generation:retired', 'generation:activated'] as const satisfies readonly FaultPoint[];
type Point = typeof GENERATION_CRASH_POINTS[number];
interface WorkerConfig { kind: 'pglite' | 'postgres'; point: Point; root: string; dataDir: string; databaseUrl?: string }
interface WorkerEvent { event: string; point?: string; result?: Record<string, unknown>; message?: string }

const OWNER = 'owner:notes/crash-source';
const key = syntheticKey('default', OWNER);
const items = (names: string[]) => names.map(name => syntheticItem(OWNER, `derived/${name}`, `${name} claim.`));
const emit = (event: WorkerEvent) => process.stdout.write(`${JSON.stringify(event)}\n`);

function stopSynchronously(event: WorkerEvent): never {
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
  for (let offset = 0; offset < bytes.length;) offset += writeSync(1, bytes, offset, bytes.length - offset);
  const blocked = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(blocked, 0, 0);
}

async function openEngine(config: WorkerConfig): Promise<BrainEngine> {
  const engine = config.kind === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
  if (config.kind === 'postgres') assertSafeE2eDatabaseUrl(config.databaseUrl!);
  await engine.connect(config.kind === 'pglite' ? { database_path: config.dataDir } : { database_url: config.databaseUrl!, poolSize: 4 });
  await engine.initSchema();
  return engine;
}

const second = (engine: BrainEngine) => { setSyntheticInput(key, { pin: 'pin-2', size: 100 });
  return publishGeneration(engine, syntheticAdapter, { key, items: items(['a', 'b', 'c']), input: { pin: 'pin-2', size: 100 } }); };

async function crash(config: WorkerConfig): Promise<void> {
  const engine = await openEngine(config);
  setSyntheticInput(key, { pin: 'pin-1', size: 100 });
  const first = await publishGeneration(engine, syntheticAdapter, { key, items: items(['a', 'b', 'c', 'd']), input: { pin: 'pin-1', size: 100 } });
  assert.equal(first.state, 'published');
  installFaultHook(point => { if (point === config.point) stopSynchronously({ event: 'boundary', point }); });
  await second(engine);
  emit({ event: 'failure', message: `publication finished without reaching ${config.point}` });
  process.exit(1);
}

async function recover(config: WorkerConfig): Promise<Record<string, unknown>> {
  const engine = await openEngine(config);
  try {
    const ledger = async () => (await engine.executeRaw<{ generation: number; state: string }>(
      'SELECT generation, state FROM derived_generations ORDER BY id')).map(row => `${row.state}:${Number(row.generation)}`);
    const before = { ledger: await ledger(), live: await liveSlugs(engine, OWNER) };
    const rerun = await second(engine);
    const again = await second(engine);
    const [items] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id WHERE g.state='live'`);
    return { before, rerun: rerun.state, rerun_generation: 'generation' in rerun ? rerun.generation : null, again: again.state,
      after: { ledger: await ledger(), live: await liveSlugs(engine, OWNER), live_items: Number(items!.n) } };
  } finally { await engine.disconnect(); }
}

function spawnWorker(configPath: string, home: string, mode: 'crash' | 'recover') {
  const child = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.path), mode, configPath],
    { cwd: home, env: childEnvironment(home), stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
  const events: WorkerEvent[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try { const event = JSON.parse(line); if (typeof event.event === 'string') events.push(event); } catch {}
      }
    }
  })();
  return {
    child,
    async event(name: string): Promise<WorkerEvent> {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const found = events.find(event => event.event === name);
        if (found) return found;
        const failure = events.find(event => event.event === 'failure');
        assert(!failure, `${mode}: ${failure?.message}`);
        assert(child.exitCode === null || events.length, `${mode} exited before ${name}`);
        assert(Date.now() < deadline, `${mode} timed out before ${name}`);
        await Bun.sleep(100);
      }
    },
    async kill() { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; await reading; },
  };
}

export async function runGenerationCrashCase(options: { kind: 'pglite' | 'postgres'; point: Point; databaseUrl?: string }): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-generation-crash-'));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const children: ReturnType<typeof spawnWorker>[] = [];
  let admin: ReturnType<typeof postgres> | undefined;
  let database: string | undefined;
  try {
    let databaseUrl: string | undefined;
    if (options.kind === 'postgres') {
      assert(options.databaseUrl, 'Postgres crash coverage requires an explicit test DATABASE_URL');
      assertSafeE2eDatabaseUrl(options.databaseUrl);
      admin = postgres(options.databaseUrl, { max: 1, prepare: false, onnotice() {} });
      database = `gbrain_test_generation_crash_${randomUUID().replaceAll('-', '')}`;
      await admin.unsafe(`CREATE DATABASE ${database}`);
      const url = new URL(options.databaseUrl);
      url.pathname = `/${database}`;
      databaseUrl = url.toString();
    }
    const config: WorkerConfig = { ...options, databaseUrl, root, dataDir: join(root, 'data') };
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const killed = spawnWorker(configPath, home, 'crash');
    children.push(killed);
    const reached = await killed.event('boundary');
    assert.equal(reached.point, options.point);
    assert.equal(killed.child.exitCode, null, 'the fault point must be a live blocked process');
    await killed.kill();
    const restarted = spawnWorker(configPath, home, 'recover');
    children.push(restarted);
    const done = await restarted.event('done');
    assert.equal(await restarted.child.exited, 0);
    return { killed_signal: killed.child.signalCode, ...done.result };
  } finally {
    try { await Promise.all(children.map(child => child.kill())); }
    finally {
      try { if (database && admin) await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`); }
      finally { await admin?.end({ timeout: 1 }); rmSync(root, { recursive: true, force: true }); }
    }
  }
}

if (import.meta.main) {
  const [mode, configPath] = process.argv.slice(2);
  const config: WorkerConfig = JSON.parse(readFileSync(configPath!, 'utf8'));
  try {
    if (mode === 'crash') await crash(config);
    else { emit({ event: 'done', result: await recover(config) }); process.exit(0); }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown worker failure';
    emit({ event: 'failure', message: config.databaseUrl ? message.replaceAll(config.databaseUrl, '[test database]') : message });
    process.exit(1);
  }
}
