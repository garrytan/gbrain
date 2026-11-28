/**
 * Shadow and back on two writer hosts: a Postgres brain both hosts write to moves to the server host's Rust store,
 * which `gbrain serve` then serves over TLS on a non-loopback address, and fails back to Postgres
 * (src/commands/engine-swap.ts, src/core/engine-swap/run.ts, probe-token.ts, failback.ts; test/helpers/two-host-brain.ts).
 *
 * Authoring gate (docs/TESTING.md): (1) protects the M3 move for a brain written from two machines: the plan on the
 * serving host reads READY on config only; the run checks the real brain server with its own short-lived probe token
 * and removes that token before it ends; the second host keeps writing through rust_server.url after the cutover; a
 * server that is down at the cutover gives authority back to Postgres; and failback brings every write from both hosts
 * home, none lost and none doubled, with no probe token and no owner token keys on Postgres. (2) Fails when the plan
 * refuses the served destination, when the run cannot pass its brain server check (no credential the server accepts),
 * when the probe token outlives the run or reaches Postgres, when a down server leaves the brain on Rust, or when
 * failback loses or doubles a write. (3) test/engine-swap-two-host.test.ts proves the served topology itself;
 * test/engine-swap-run.serial.test.ts proves the probe token rules on PGLite with an injected prober;
 * test/engine-swap-run-postgres.serial.test.ts runs a one-host Postgres swap. Nothing else runs a real served cutover.
 * (4) Seams: the shadow child's RPC runs in process (test/helpers/follow-rig.ts) and the shadow status document is
 * injected (readinessReadyFor with two writer hosts), because a real 5-day observation window cannot run in a test; the
 * down-server row shortens the 60 s brain server wait to 4 s. The CLI on both hosts, pg_dump, the fence, the route
 * probe (a fresh `gbrain engine status --probe`), `gbrain serve`, the TLS brain server check, the probe token and
 * failback are real. Needs DATABASE_URL (a disposable Postgres), the addon and a non-loopback address; skips without
 * them (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { openReadSource } from '../src/shadow/read-pool.ts';
import { shadowBrainKey, shadowDirFor } from '../src/shadow/state.ts';
import { runEngineSwap, type EngineSwapCliDeps } from '../src/commands/engine-swap.ts';
import { subprocessProber } from '../src/core/engine-swap/route.ts';
import { probeServedUntil } from '../src/core/engine-swap/served-probe.ts';
import { readSwapRecord, swapRecordPath } from '../src/core/engine-swap/record.ts';
import { PROBE_TOKEN_PREFIX } from '../src/core/engine-swap/probe-token.ts';
import { OWNER_TOKEN_EXPIRES_CONFIG_KEY, OWNER_TOKEN_IDS_CONFIG_KEY } from '../src/core/rust-engine/served/auth.ts';
import { openFollowRig, type FollowRig } from './helpers/follow-rig.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readinessReadyFor } from './helpers/swap-ready-status.ts';
import {
  HAVE_TWO_HOST_ADDON, TWO_HOST_ADDON, TWO_HOST_CLI, interfaceAddress, startTwoHostPostgresBrain, type CliRun, type TwoHostPostgresBrain,
} from './helpers/two-host-brain.ts';
import { withEnv } from './helpers/with-env.ts';

if (!HAVE_TWO_HOST_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${TWO_HOST_ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}
const URL_ = process.env.DATABASE_URL;
const ADDRESS = interfaceAddress();
const NOW = new Date('2026-12-01T00:00:00Z');

const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;
const ok = (r: CliRun, what: string): CliRun => {
  if (r.exitCode !== 0) throw new Error(`${what} exited ${r.exitCode}: ${r.stderr.slice(-2000)}`);
  return r;
};
const bodyOf = (r: CliRun): string => (JSON.parse(r.stdout) as { compiled_truth: string }).compiled_truth;

interface World {
  db: { engine: PostgresEngine; databaseUrl: string; close: () => Promise<void> };
  brain: TwoHostPostgresBrain;
  rig: FollowRig | null;
  reads: ReturnType<typeof openReadSource> | null;
  serve: ReturnType<typeof Bun.spawn> | null;
  serveLog: string;
}

async function openWorld(): Promise<World> {
  const db = await isolatedPersistencePostgres(URL_!, 'instance', 4);
  const brain = await startTwoHostPostgresBrain({ databaseUrl: db.databaseUrl, address: ADDRESS! });
  return { db, brain, rig: null, reads: null, serve: null, serveLog: '' };
}

/** The server host's process environment for the in-process steps (the plan, the run, the shadow seed). */
const inServer = <T>(w: World, fn: () => Promise<T>): Promise<T> => withEnv({
  GBRAIN_HOME: w.brain.serverHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_RUST_MULTIUSER: '1',
  GBRAIN_RUST_ENGINE_ADDON: TWO_HOST_ADDON, GBRAIN_RUST_SERVER_TOKEN: undefined,
}, fn);

/** Seeds the server host's shadow store from the Postgres brain (the shadow child's seed, in process). */
async function seedShadow(w: World): Promise<void> {
  await inServer(w, async () => {
    const key = shadowBrainKey(toEngineConfig(loadConfig()!))!;
    const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: TWO_HOST_ADDON } });
    w.rig = await openFollowRig(w.db.engine, addon, shadowDirFor(key), 'postgres');
    w.reads = openReadSource(w.db.engine, { pauseMs: 0 });
  });
}

async function closeShadow(w: World): Promise<void> {
  const { rig, reads } = w;
  w.rig = null;
  w.reads = null;
  await reads?.close().catch(() => undefined);
  await rig?.close().catch(() => undefined);
}

function startServe(w: World): void {
  if (w.serve) return;
  const proc = Bun.spawn(['bun', 'run', TWO_HOST_CLI, 'serve'], { cwd: w.brain.root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: w.brain.serverEnv() });
  w.serve = proc;
  void new Response(proc.stdout as ReadableStream).text();
  void (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      w.serveLog += decoder.decode(value);
    }
  })();
}

async function stopServe(w: World): Promise<void> {
  const running = w.serve;
  w.serve = null;
  if (!running) return;
  try { (running.stdin as { end?: () => void } | undefined)?.end?.(); } catch { /* closed */ }
  try { running.kill(); } catch { /* gone */ }
  await Promise.race([running.exited, Bun.sleep(10_000)]);
}

async function closeWorld(w: World | undefined): Promise<void> {
  if (!w) return;
  await stopServe(w);
  await closeShadow(w);
  await w.db.close().catch(() => undefined);
  await w.brain.stop();
}

interface Captured { out: string[]; err: string[] }

/** The CLI deps of `gbrain engine swap` on the server host. Only the shadow side and the shadow status are injected. */
function swapDeps(w: World, io: Captured, run: NonNullable<EngineSwapCliDeps['run']> = {}): EngineSwapCliDeps {
  const status = readinessReadyFor();
  return {
    env: w.brain.serverEnv(), home: w.brain.serverHome, now: NOW, cliBrain: null, freeBytes: () => 500e9,
    readShadowStatus: async () => ({ ...status, eligibility: { ...status.eligibility, writer_hosts_7d: 2 } }),
    out: t => { io.out.push(t); }, err: t => { io.err.push(t); },
    writeError: (e) => { io.err.push(`ERROR ${(e as { code?: string }).code ?? ''} ${(e as { reason?: string }).reason ?? ''} ${(e as Error).message}`); return 1; },
    run: {
      // The shadow child's side of the final check, in process; closing it releases the store before the switch.
      openRust: async () => {
        const rig = w.rig!;
        const reads = w.reads!;
        return { rpc: rig.rpc, reads, close: async () => { await closeShadow(w); } };
      },
      prober: subprocessProber(['bun', 'run', TWO_HOST_CLI], w.brain.serverEnv()),
      intervalRows: 2,
      ...run,
    },
  };
}

const lastJson = <T>(io: Captured): T => JSON.parse(io.out[io.out.length - 1]!) as T;
const configOf = (home: string): Record<string, unknown> => JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));

/** The Rust store, opened in process as its owner (no serve may run). */
async function withStore<T>(w: World, fn: (e: BrainEngine) => Promise<T>): Promise<T> {
  return inServer(w, async () => {
    const store = join(shadowDirFor(shadowBrainKeyOf(w)), 'store');
    const cfg = { engine: 'rust' as const, database_path: store, create_store: false };
    const engine = await createEngine(cfg as never);
    await engine.connect(cfg as never);
    try { return await fn(engine); } finally { await engine.disconnect(); }
  });
}

async function planHash(w: World): Promise<{ hash: string; plan: Record<string, unknown> }> {
  const io: Captured = { out: [], err: [] };
  const code = await inServer(w, () => runEngineSwap(['--to', 'rust', '--plan', '--json'], swapDeps(w, io)));
  if (code !== 0) throw new Error(`the plan failed: ${io.err.join('\n')}`);
  const plan = lastJson<Record<string, unknown> & { plan_hash: string }>(io);
  return { hash: plan.plan_hash, plan };
}

const probeTokensOnPostgres = async (w: World) =>
  (await w.db.engine.listAccessTokens()).filter(r => r.name.startsWith(PROBE_TOKEN_PREFIX));

(HAVE_TWO_HOST_ADDON && URL_ && ADDRESS ? describe : describe.skip)('two writer hosts: a Postgres brain moves to a served Rust brain and back', () => {
  let w: World;
  let token = '';
  beforeAll(async () => { w = await openWorld(); }, 300_000);
  afterAll(async () => { await closeWorld(w); }, 120_000);

  test('both hosts write to a Postgres brain for the observation window; the plan on the serving host reads READY on config only', async () => {
    ok(await w.brain.cli('server', ['put', 'notes/server-before', '--content', page('Server before', 'Written on the server host before the swap.'), '--json']), 'server put');
    ok(await w.brain.cli('client', ['put', 'notes/client-before', '--content', page('Client before', 'Written on the second host before the swap.'), '--json']), 'client put');
    expect(bodyOf(ok(await w.brain.cli('server', ['get', 'notes/client-before', '--json']), 'server get'))).toContain('second host before');
    expect(bodyOf(ok(await w.brain.cli('client', ['get', 'notes/server-before', '--json']), 'client get'))).toContain('server host before');
    await seedShadow(w);
    // A write after the seed: the final check's catch-up must carry it.
    ok(await w.brain.cli('client', ['put', 'notes/client-after-seed', '--content', page('Client after seed', 'Written on the second host after the seed.'), '--json']), 'client put');

    const { plan } = await planHash(w);
    expect(plan.verdict).toBe('READY');
    expect(plan.blockers).toEqual([]);
    const c11 = (plan.criteria as Array<{ n: number; state: string; detail: string }>).find(c => c.n === 11)!;
    expect(c11.state).toBe('pass');
    expect(c11.detail).toContain('accepted on config only');
    const pause = plan.write_pause as { seconds: number; basis: string };
    expect(pause.basis).toContain(`waiting for the brain server at gbrain+tls://${w.brain.listen}`);
    expect(pause.seconds).toBeGreaterThanOrEqual(60);
  }, 300_000);

  test('engine swap --to rust --yes --expect <hash> runs shadow, switch and cutover; the probe passes and the second host keeps writing through rust_server.url', async () => {
    const { hash } = await planHash(w);
    const io: Captured = { out: [], err: [] };
    const deps = swapDeps(w, io);
    // The run does not start the server: like a service manager, start it when the run says it waits for it.
    const err = deps.err!;
    deps.err = (line) => { err(line); if (line.includes('waiting for the brain server')) startServe(w); };
    const code = await inServer(w, () => runEngineSwap(['--to', 'rust', '--yes', '--expect', hash, '--json'], deps));
    expect(io.err.filter(l => l.startsWith('ERROR'))).toEqual([]);
    expect(code).toBe(0);
    const run = lastJson<{ run: { run_id: string; state: string; probe: { served: { ok: boolean } } } }>(io).run;
    expect(run.state).toBe('succeeded');
    expect(run.probe.served.ok).toBe(true);
    expect(io.err.filter(l => l.includes('waiting for the brain server'))).toHaveLength(1);
    // The probe token was removed while the server ran: no line says it could not be.
    expect(io.err.filter(l => l.includes('could not be removed'))).toEqual([]);
    const cfg = configOf(w.brain.serverHome);
    expect(cfg.engine).toBe('rust');
    expect(cfg.database_url).toBeUndefined();

    // The second host moves to the brain server with an owner token the server host mints.
    const minted = ok(await w.brain.cli('server', ['auth', 'create', 'second-host', '--rust-server-owner']), 'auth create');
    token = /gbrain_[A-Za-z0-9_-]+/.exec(minted.stdout)?.[0] ?? '';
    expect(token).not.toBe('');
    writeFileSync(join(w.brain.clientHome, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'rust', rust_server: { url: w.brain.url, token_env: 'GBRAIN_RUST_SERVER_TOKEN', ca_file: w.brain.tls.cert } }));
    const asClient = { GBRAIN_RUST_SERVER_TOKEN: token };
    ok(await w.brain.cli('client', ['put', 'notes/client-on-rust', '--content', page('Client on Rust', 'Written on the second host after the cutover.'), '--json'], asClient), 'client put on rust');
    ok(await w.brain.cli('server', ['put', 'notes/server-on-rust', '--content', page('Server on Rust', 'Written on the server host after the cutover.'), '--json']), 'server put on rust');
    expect(bodyOf(ok(await w.brain.cli('server', ['get', 'notes/client-on-rust', '--json']), 'server get'))).toContain('after the cutover');
    expect(bodyOf(ok(await w.brain.cli('client', ['get', 'notes/server-on-rust', '--json'], asClient), 'client get'))).toContain('server host after');
    expect(bodyOf(ok(await w.brain.cli('client', ['get', 'notes/client-after-seed', '--json'], asClient), 'client get'))).toContain('after the seed');
    expect(w.serveLog).not.toContain(token);

    await stopServe(w);
    // The probe token is revoked and both owner token keys list only the second host's token.
    const after = await withStore(w, async (e) => ({
      probes: (await e.listAccessTokens()).filter(r => r.name.startsWith(PROBE_TOKEN_PREFIX)),
      ids: JSON.parse((await e.getConfig(OWNER_TOKEN_IDS_CONFIG_KEY)) ?? '[]') as string[],
      expiries: await e.getConfig(OWNER_TOKEN_EXPIRES_CONFIG_KEY),
      tokens: await e.listAccessTokens(),
    }));
    expect(after.probes.length).toBe(1);
    expect(after.probes[0]!.revoked_at).not.toBeNull();
    expect(after.probes[0]!.name).toBe(`${PROBE_TOKEN_PREFIX}${run.run_id}`);
    const second = after.tokens.find(t => t.name === 'second-host')!;
    expect(after.ids).toEqual([second.id]);
    expect(after.expiries).toBeNull();
  }, 600_000);

  test('engine swap --to postgres fails back; every write from both hosts is on Postgres, none lost and none doubled', async () => {
    const io: Captured = { out: [], err: [] };
    const deps: EngineSwapCliDeps = { ...swapDeps(w, io), failback: { prober: subprocessProber(['bun', 'run', TWO_HOST_CLI], w.brain.serverEnv()) } };
    expect(await inServer(w, () => runEngineSwap(['--to', 'postgres', '--plan', '--json'], deps))).toBe(0);
    const plan = lastJson<{ plan_hash: string }>(io);
    const code = await inServer(w, () => runEngineSwap(['--to', 'postgres', '--yes', '--expect', plan.plan_hash, '--json'], deps));
    expect(io.err.filter(l => l.startsWith('ERROR'))).toEqual([]);
    expect(code).toBe(0);
    const cfg = configOf(w.brain.serverHome);
    expect(cfg.engine).toBe('postgres');
    expect(cfg.database_url).toBe(w.db.databaseUrl);

    const rows = await w.db.engine.executeRaw<{ slug: string; n: number }>(
      `SELECT slug, count(*)::int AS n FROM pages WHERE deleted_at IS NULL AND slug LIKE 'notes/%' GROUP BY slug ORDER BY slug COLLATE "C"`);
    expect(rows).toEqual(['notes/client-after-seed', 'notes/client-before', 'notes/client-on-rust', 'notes/server-before', 'notes/server-on-rust'].map(slug => ({ slug, n: 1 })));
    // No probe token row and no owner token key reached Postgres.
    expect(await probeTokensOnPostgres(w)).toEqual([]);
    expect(await w.db.engine.getConfig(OWNER_TOKEN_IDS_CONFIG_KEY)).toBeNull();
    expect(await w.db.engine.getConfig(OWNER_TOKEN_EXPIRES_CONFIG_KEY)).toBeNull();

    // Both hosts write to Postgres again.
    writeFileSync(join(w.brain.clientHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: w.db.databaseUrl }));
    ok(await w.brain.cli('client', ['put', 'notes/client-back', '--content', page('Client back', 'Written on the second host after failback.'), '--json']), 'client put back');
    expect(bodyOf(ok(await w.brain.cli('server', ['get', 'notes/client-back', '--json']), 'server get'))).toContain('after failback');
    expect(bodyOf(ok(await w.brain.cli('client', ['get', 'notes/client-on-rust', '--json']), 'client get'))).toContain('after the cutover');
  }, 600_000);
});

(HAVE_TWO_HOST_ADDON && URL_ && ADDRESS ? describe : describe.skip)('two writer hosts: a brain server that is down at the cutover', () => {
  let w: World;
  beforeAll(async () => { w = await openWorld(); }, 300_000);
  afterAll(async () => { await closeWorld(w); }, 120_000);

  test('a server that is down at cutover: the probe fails and the run gives authority back to Postgres (fail-first restore row)', async () => {
    ok(await w.brain.cli('server', ['put', 'notes/server-before', '--content', page('Server before', 'Written on the server host.'), '--json']), 'server put');
    ok(await w.brain.cli('client', ['put', 'notes/client-before', '--content', page('Client before', 'Written on the second host.'), '--json']), 'client put');
    await seedShadow(w);
    const { hash } = await planHash(w);
    const io: Captured = { out: [], err: [] };
    // Nothing serves the brain; the 60 s wait is shortened to 4 s.
    const deps = swapDeps(w, io, { servedProbe: (i, win) => probeServedUntil(i, { ...win, windowMs: 4000, intervalMs: 500 }) });
    const code = await inServer(w, () => runEngineSwap(['--to', 'rust', '--yes', '--expect', hash, '--json'], deps));
    expect(code).not.toBe(0);
    expect(io.err.filter(l => l.includes('waiting for the brain server'))).toHaveLength(1);
    expect(io.err.join('\n')).toContain('unreachable');
    const record = (await inServer(w, async () => readSwapRecord(swapRecordPath(shadowBrainKeyOf(w)))))!;
    expect(record.state).toBe('verified');
    expect(record.error!.code).toBe('served_probe_failed');
    expect(record.probe!.served).toMatchObject({ ok: false, reason: 'unreachable' });
    // Authority is back on Postgres: the config names the database again.
    const cfg = configOf(w.brain.serverHome);
    expect(cfg.engine).toBe('postgres');
    expect(cfg.database_url).toBe(w.db.databaseUrl);
    // The old engine stays fenced: the second host's write is refused, never acknowledged.
    const refused = await w.brain.cli('client', ['put', 'notes/client-during', '--content', page('During', 'Must be refused.'), '--json']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain('graduation_in_progress');
    // The probe token is gone from the Rust store and never reached Postgres.
    expect(await probeTokensOnPostgres(w)).toEqual([]);
    const probes = await withStore(w, async (e) => (await e.listAccessTokens()).filter(r => r.name.startsWith(PROBE_TOKEN_PREFIX)));
    expect(probes.map(r => r.revoked_at !== null)).toEqual([true]);
  }, 600_000);
});

function shadowBrainKeyOf(w: World): string {
  return shadowBrainKey(toEngineConfig({ engine: 'postgres', database_url: w.db.databaseUrl } as never))!;
}
