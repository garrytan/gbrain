/**
 * GBRA-133 on Postgres: an effect claim whose stamped owner this host can prove dead (same boot and pid namespace, its
 * pid gone or reused) is claimed on the consumer's next scan instead of after its 2-minute lease. Before, a crash while
 * a Git effect ran left the survivor waiting out the lease (the crash robot's 120 s stalls at `consumer:preparing` and
 * `effect_recovery:before_clear`). A live owner and an owner from another boot keep the claim. The takeover stays
 * exactly-once: the Git effect takes the worktree's native lock first, so while the old owner still holds it the
 * takeover settles `writer_busy` without parking and commits once the lock is free; the old owner's outcome write,
 * a compare-and-set on its token, lands nowhere.
 *
 * The claim is staged the way a SIGKILLed owner leaves it: `running`, its token, a lease minutes out, no recovery
 * record, and a `claim_owner` stamp of that token.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { PersistenceConsumer } from '../../src/core/persistence/consumer.ts';
import { completeEffect } from '../../src/core/persistence/effect-journal.ts';
import type { PersistenceEffect } from '../../src/core/persistence/effect-model.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { acquireWorktree } from '../../src/core/persistence/ownership.ts';
import { consumerIdentity } from '../../src/core/persistence/consumer-heartbeat.ts';
import { processStartTime, readBootId } from '../../src/core/pglite-lock.ts';
import { admission, fixtures, initializeFixtures, prepared, selectFixtureHost, type FixtureSource, type HarnessConfig } from '../../scripts/persistence/harness.ts';
import { assertSafeE2eDatabaseUrl, hasDatabase } from './helpers.ts';
import { deadPid } from '../helpers/dead-pid.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const linux = process.platform === 'linux' && readBootId() !== null;
const FOREIGN_BOOT = '00000000-0000-0000-0000-000000000000';
let live: ChildProcess;
let liveStart: string;

beforeAll(async () => {
  if (!linux) return;
  live = spawn('sleep', ['120'], { stdio: 'ignore' });
  await new Promise(resolve => live.once('spawn', resolve));
  liveStart = processStartTime(live.pid!)!;
});
afterAll(() => { live?.kill('SIGKILL'); });

type Ctx = { engine: PostgresEngine; config: HarnessConfig; sources: FixtureSource[] };
async function withBrain(run: (ctx: Ctx) => Promise<void>) {
  assertSafeE2eDatabaseUrl(DATABASE_URL);
  const name = `gbrain_test_dead_effect_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(DATABASE_URL); url.pathname = `/${name}`;
  const root = mkdtempSync(join(tmpdir(), 'gbrain-dead-effect-'));
  const config: HarnessConfig = { kind: 'postgres', root, dataDir: join(root, 'unused'), hostId: randomUUID(),
    seed: 133, schedules: 0, operations: 0, sourceIds: ['effect-a', 'effect-b'], principalIds: [randomUUID(), randomUUID()] };
  const engine = new PostgresEngine();
  try {
    await withEnv({ GBRAIN_HOME: root, GBRAIN_PERSISTENCE_FIXTURE_HOME: root }, async () => {
      await engine.connect({ database_url: url.toString(), poolSize: 6 });
      await engine.initSchema();
      selectFixtureHost(config.hostId);
      await initializeFixtures(engine, config);
      const sources = await fixtures(engine, config);
      for (const source of sources) {
        execFileSync('git', ['init', '-q', source.root]);
        // The Git effect commits with the repository's identity; a runner without a global one needs it here.
        for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.com']]) execFileSync('git', ['-C', source.root, 'config', key, value]);
        execFileSync('git', ['-C', source.root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
      }
      await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
      await run({ engine, config, sources: await fixtures(engine, config) });
    });
  } finally {
    await engine.disconnect();
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Committed page writes whose Git effects are pending again: a consumer publishes them, then every source's commits are
 * undone (the files stay) and the effects are queued again, as they stood before their Git run.
 */
async function gitEffects(ctx: Ctx, pages: Array<[FixtureSource, string]>): Promise<PersistenceEffect[]> {
  const { engine, config, sources } = ctx;
  const rows = [];
  for (const [source, slug] of pages) rows.push(await admitWrite(engine, admission(config, source, slug, `${slug} body`)));
  const ids = rows.map(row => row.id);
  const consumer = consumerFor(ctx);
  try {
    consumer.start();
    await waitFor(async () => (await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE request_id=ANY($1::uuid[]) AND kind='git' AND state='committed'", [ids])).length === ids.length,
      { timeoutMs: 30_000, label: 'the writes and their Git effects commit' });
  } finally { await consumer.stop(); }
  for (const source of sources) execFileSync('git', ['-C', source.root, 'reset', '-q', execFileSync('git', ['-C', source.root, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim()]);
  const effects = await engine.executeRaw<PersistenceEffect>(`UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,outcome=NULL,
    next_attempt_at=now() WHERE request_id=ANY($1::uuid[]) AND kind='git' RETURNING *`, [ids]);
  for (const [source, slug] of pages) expect(commits(source, `${slug}.md`)).toBe(0);
  return rows.map(row => effects.find(effect => effect.request_id === row.id)!);
}

/** Stages `effect` as claimed by `owner` with a lease `leaseS` seconds out; returns the claim's token. */
async function stageClaim(engine: PostgresEngine, effect: PersistenceEffect, owner: Record<string, unknown>, leaseS = 120): Promise<string> {
  const token = randomUUID();
  const stamp = { token, owner: { kind: 'serve', version: '0.0.0', nonce: `n-${String(owner.pid)}`, pid_ns: consumerIdentity().pid_ns, boot_id: readBootId(), ...owner } };
  await engine.executeRaw(`UPDATE persistence_effects SET state='running',execution_token=$2::uuid,claim_expires_at=now()+($3::integer*interval '1 second'),
    claim_owner=$4::text::jsonb,attempts=attempts+1,updated_at=now() WHERE id=$1`, [effect.id, token, leaseS, JSON.stringify(stamp)]);
  return token;
}

const effectRow = async (engine: PostgresEngine, id: string | number) =>
  (await engine.executeRaw<PersistenceEffect & { lease_left_s: number | null }>(
    "SELECT *,EXTRACT(EPOCH FROM claim_expires_at-now())::float8 AS lease_left_s FROM persistence_effects WHERE id=$1", [id]))[0]!;
const commits = (source: FixtureSource, path: string) =>
  execFileSync('git', ['-C', source.root, 'log', '--format=%H', '--', path], { encoding: 'utf8' }).split('\n').filter(Boolean).length;
const consumerFor = ({ engine, config, sources }: Ctx) => new PersistenceConsumer(engine, { engine: 'postgres' },
  async (_engine, row) => prepared(row, sources, null, true), { hostId: config.hostId, concurrency: 2, pollMs: 500, phaseMs: 5_000, onError: () => {} });

describe.skipIf(!hasDatabase() || !linux)('an effect claim held by a provably dead owner is claimed at once (GBRA-133)', () => {
  test('dead and reused-pid owners: their Git effects commit within seconds, long before the lease; a live owner keeps its claim', () => withBrain(async ctx => {
    const { engine, sources } = ctx;
    const [dead, reused, kept] = await gitEffects(ctx, [[sources[0]!, 'effect-a/dead'], [sources[1]!, 'effect-b/reused'], [sources[0]!, 'effect-a/kept']]);
    const deadToken = await stageClaim(engine, dead, { pid: deadPid(), start: '1' });
    await stageClaim(engine, reused, { pid: live.pid!, start: '1' });
    const liveToken = await stageClaim(engine, kept, { pid: live.pid!, start: liveStart });
    const consumer = consumerFor(ctx);
    const started = Date.now();
    try {
      consumer.start();
      await waitFor(async () => (await effectRow(engine, dead.id)).state === 'committed' && (await effectRow(engine, reused.id)).state === 'committed',
        { timeoutMs: 20_000, label: 'the dead and reused-pid owners\' Git effects commit' });
      expect(Date.now() - started).toBeLessThan(20_000);
      const done = await effectRow(engine, dead.id);
      expect(done.execution_token).toBeNull();
      expect(done.outcome).toMatchObject({ git: 'committed' });
      expect([commits(sources[0]!, 'effect-a/dead.md'), commits(sources[1]!, 'effect-b/reused.md')]).toEqual([1, 1]);
      expect(deadToken).not.toBe(liveToken);
      const held = await effectRow(engine, kept.id);
      expect({ state: held.state, token: held.execution_token }).toEqual({ state: 'running', token: liveToken });
      expect(held.lease_left_s!).toBeGreaterThan(90);
    } finally { await consumer.stop(); }
  }), 90_000);

  test('a lying probe (the owner still runs and holds the native lock): the takeover waits as writer_busy without parking, the old owner\'s outcome write lands nowhere, one commit', () => withBrain(async ctx => {
    const { engine, sources } = ctx;
    const [effect] = await gitEffects(ctx, [[sources[0]!, 'effect-a/lying']]);
    const oldToken = await stageClaim(engine, effect, { pid: live.pid!, start: '1' });
    const lock = await acquireWorktree(sources[0]!.binding, 0, undefined, engine);
    expect(lock).not.toBeNull();
    const consumer = consumerFor(ctx);
    try {
      consumer.start();
      await waitFor(async () => (await effectRow(engine, effect.id)).execution_token !== oldToken, { timeoutMs: 20_000, label: 'the effect is taken from the probed-dead owner' });
      await waitFor(async () => (await effectRow(engine, effect.id)).error_code === 'writer_busy', { timeoutMs: 20_000, label: 'the takeover meets the held lock' });
      const busy = await effectRow(engine, effect.id);
      expect(busy.state).not.toBe('failed');
      expect(busy.data.parked ?? []).toEqual([]);
      await completeEffect(engine, { ...effect, execution_token: oldToken }, { git: 'old_owner' });
      expect((await effectRow(engine, effect.id)).outcome).not.toEqual({ git: 'old_owner' });
      expect(commits(sources[0]!, 'effect-a/lying.md')).toBe(0);
      await lock!.release();
      await waitFor(async () => (await effectRow(engine, effect.id)).state === 'committed', { timeoutMs: 20_000, label: 'the effect commits once the lock is free' });
      expect((await effectRow(engine, effect.id)).outcome).toMatchObject({ git: 'committed' });
      expect(commits(sources[0]!, 'effect-a/lying.md')).toBe(1);
    } finally { await lock?.release().catch(() => undefined); await consumer.stop(); }
  }), 90_000);

  test('an owner from another boot, an owner without the markers, and a stamp of an earlier claim wait for their lease', () => withBrain(async ctx => {
    const { engine, sources } = ctx;
    const [foreign, older, stale] = await gitEffects(ctx, [[sources[0]!, 'effect-a/foreign'], [sources[1]!, 'effect-b/older'], [sources[0]!, 'effect-a/stale']]);
    const foreignToken = await stageClaim(engine, foreign, { pid: deadPid(), start: '1', boot_id: FOREIGN_BOOT });
    const olderToken = await stageClaim(engine, older, { pid: deadPid(), boot_id: undefined, start: undefined });
    await stageClaim(engine, stale, { pid: deadPid(), start: '1' });
    const staleToken = randomUUID();
    await engine.executeRaw('UPDATE persistence_effects SET execution_token=$2::uuid WHERE id=$1', [stale.id, staleToken]);
    const consumer = consumerFor(ctx);
    try {
      consumer.start();
      await Bun.sleep(8_000);
      expect([(await effectRow(engine, foreign.id)).execution_token, (await effectRow(engine, older.id)).execution_token, (await effectRow(engine, stale.id)).execution_token])
        .toEqual([foreignToken, olderToken, staleToken]);
    } finally { await consumer.stop(); }
  }), 90_000);
});
