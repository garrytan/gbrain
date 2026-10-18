/**
 * #6650 defect 2 on Postgres: a running claim whose stamped owner this host
 * can prove dead (same boot and pid namespace, its pid gone or reused) is
 * reclaimed on the consumer's next scan instead of after its lease, which for
 * a publishing group is `publicationLeaseMs` (365 s by default). A live owner,
 * however long its lease, and an owner from another boot keep the claim.
 * Bug 1's heartbeat probe is pinned on real rows here too.
 *
 * The claim is staged the way an owner leaves it when it is SIGKILLed inside
 * its publication transaction (that transaction rolls back with its
 * connection): `running`, its token, a lease minutes out, a `publishing` stamp
 * of that token, no recovery record and no `publication_started`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { DEAD_OWNER_SCAN_MS, PersistenceConsumer } from '../../src/core/persistence/consumer.ts';
import { admitWrite, claimGroupFollowers, getWriteRequestById } from '../../src/core/persistence/journal.ts';
import { setClaimOwnerForTest } from '../../src/core/persistence/claim-phase.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { consumerIdentity, probeLiveFullConsumer } from '../../src/core/persistence/consumer-heartbeat.ts';
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

async function withBrain(run: (ctx: { engine: PostgresEngine; config: HarnessConfig; sources: FixtureSource[] }) => Promise<void>) {
  assertSafeE2eDatabaseUrl(DATABASE_URL);
  const name = `gbrain_test_dead_owner_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(DATABASE_URL); url.pathname = `/${name}`;
  const root = mkdtempSync(join(tmpdir(), 'gbrain-dead-owner-'));
  const config: HarnessConfig = { kind: 'postgres', root, dataDir: join(root, 'unused'), hostId: randomUUID(),
    seed: 6650, schedules: 0, operations: 0, sourceIds: ['dead-a', 'dead-b', 'dead-c'], principalIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()] };
  const engine = new PostgresEngine();
  try {
    await withEnv({ GBRAIN_HOME: root, GBRAIN_PERSISTENCE_FIXTURE_HOME: root }, async () => {
      await engine.connect({ database_url: url.toString(), poolSize: 6 });
      await engine.initSchema();
      selectFixtureHost(config.hostId);
      await initializeFixtures(engine, config);
      await run({ engine, config, sources: await fixtures(engine, config) });
    });
  } finally {
    await engine.disconnect();
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
    rmSync(root, { recursive: true, force: true });
  }
}

/** Stages `id` as claimed by `owner`, publishing, with a lease `leaseS` seconds out; returns the claim's token. */
async function stageClaim(engine: PostgresEngine, id: string, owner: Record<string, unknown>, leaseS = 360): Promise<string> {
  const token = randomUUID();
  const now = new Date().toISOString();
  const stamp = { phase: 'publishing', claimed_at: now, since: now, token, step: null, step_since: now, waiting_on: 'publication', last_sql: null,
    owner: { kind: 'sync', version: '0.0.0', nonce: `n-${String(owner.pid)}`, pid_ns: consumerIdentity().pid_ns, boot_id: readBootId(), ...owner } };
  await engine.executeRaw(`UPDATE persistence_requests SET state='running', execution_token=$2::uuid, claim_expires_at=now()+($3::integer*interval '1 second'),
    claim_phase=$4::text::jsonb, updated_at=now() WHERE id=$1::uuid`, [id, token, leaseS, JSON.stringify(stamp)]);
  return token;
}

/** Request id -> how many times its mutation was applied (in any transaction, committed or not). */
const applied = new Map<string, number>();
function consumerFor(engine: PostgresEngine, config: HarnessConfig, sources: FixtureSource[]) {
  return new PersistenceConsumer(engine, { engine: 'postgres' }, async (_engine, row) => {
    const mutation = prepared(row, sources);
    const apply = mutation.apply;
    mutation.apply = (tx, snapshot) => { applied.set(row.id, (applied.get(row.id) ?? 0) + 1); return apply(tx, snapshot); };
    return mutation;
  },
    { hostId: config.hostId, concurrency: 3, pollMs: 60_000, phaseMs: 5_000, onError: () => {} });
}

describe.skipIf(!hasDatabase() || !linux)('a claim held by a provably dead owner is reclaimed at once (#6650)', () => {
  test('dead and reused-pid owners: reclaimed and committed long before the lease; a live owner keeps its claim', () => withBrain(async ({ engine, config, sources }) => {
    const dead = await admitWrite(engine, admission(config, sources[0]!, 'dead-a/page', 'dead owner body'));
    const reused = await admitWrite(engine, admission(config, sources[1]!, 'dead-b/page', 'reused pid body'));
    const kept = await admitWrite(engine, admission(config, sources[2]!, 'dead-c/page', 'live owner body'));
    await stageClaim(engine, dead.id, { pid: deadPid(), start: '1' });
    await stageClaim(engine, reused.id, { pid: live.pid!, start: '1' });
    const liveToken = await stageClaim(engine, kept.id, { pid: live.pid!, start: liveStart });
    const consumer = consumerFor(engine, config, sources);
    try {
      await consumer.tick();
      await waitFor(async () => (await getWriteRequestById(engine, dead.id))?.state === 'committed'
        && (await getWriteRequestById(engine, reused.id))?.state === 'committed', { timeoutMs: 20_000, label: 'the dead and reused-pid owners\' claims commit' });
      await consumer.tick();
      const held = await getWriteRequestById(engine, kept.id);
      expect({ state: held?.state, token: held?.execution_token }).toEqual({ state: 'running', token: liveToken });
    } finally { await consumer.stop(); }
  }), 90_000);

  test('an already idle consumer finds a dead owner\'s live-leased claim on its own (no wake, no other work)', () => withBrain(async ({ engine, config, sources }) => {
    const consumer = consumerFor(engine, config, sources);
    try {
      await consumer.tick();
      const orphan = await admitWrite(engine, admission(config, sources[0]!, 'dead-a/idle', 'idle consumer body'));
      await stageClaim(engine, orphan.id, { pid: deadPid(), start: '1' });
      await Bun.sleep(DEAD_OWNER_SCAN_MS);
      await consumer.tick();
      await waitFor(async () => (await getWriteRequestById(engine, orphan.id))?.state === 'committed', { timeoutMs: 20_000, label: 'the idle consumer reclaims and commits it' });
    } finally { await consumer.stop(); }
  }), 90_000);

  test('a dead owner behind more than a scan page of live claims is still found', () => withBrain(async ({ engine, config, sources }) => {
    const liveOwner = { pid: live.pid!, start: liveStart };
    for (let i = 0; i < 110; i++) await stageClaim(engine, (await admitWrite(engine, admission(config, sources[1]!, `dead-b/live-${i}`, `live ${i}`, i % 4))).id, liveOwner);
    const orphan = await admitWrite(engine, admission(config, sources[0]!, 'dead-a/behind', 'behind the live prefix'));
    await stageClaim(engine, orphan.id, { pid: deadPid(), start: '1' });
    const consumer = consumerFor(engine, config, sources);
    try {
      await consumer.tick();
      await waitFor(async () => (await getWriteRequestById(engine, orphan.id))?.state === 'committed', { timeoutMs: 20_000, label: 'the claim behind the live prefix commits' });
    } finally { await consumer.stop(); }
  }), 90_000);

  test('a claim re-taken by a live owner between the scan and the reclaim keeps its new token and attempt count', () => withBrain(async ({ engine, config, sources }) => {
    const req = await admitWrite(engine, admission(config, sources[0]!, 'dead-a/retaken', 'retaken body'));
    await stageClaim(engine, req.id, { pid: deadPid(), start: '1' });
    const consumer = consumerFor(engine, config, sources);
    const seam = consumer as unknown as { deadOwnerClaims: (signal?: AbortSignal) => Promise<string[]> };
    const scan = seam.deadOwnerClaims.bind(consumer);
    let liveToken = '';
    seam.deadOwnerClaims = async signal => {
      const found = await scan(signal);
      liveToken = await stageClaim(engine, req.id, { pid: live.pid!, start: liveStart });
      return found;
    };
    try {
      await consumer.tick();
      const held = await getWriteRequestById(engine, req.id);
      expect({ state: held?.state, token: held?.execution_token, attempts: held?.preparation_attempts }).toEqual({ state: 'running', token: liveToken, attempts: 0 });
    } finally { await consumer.stop(); }
  }), 90_000);

  test('a dead owner\'s claim whose publication started is left to its lease and recovery, never reclaimed early', () => withBrain(async ({ engine, config, sources }) => {
    const started = await admitWrite(engine, admission(config, sources[0]!, 'dead-a/started', 'publication started body'));
    const token = await stageClaim(engine, started.id, { pid: deadPid(), start: '1' });
    await engine.executeRaw('UPDATE persistence_requests SET publication_started=true WHERE id=$1::uuid', [started.id]);
    const consumer = consumerFor(engine, config, sources);
    try {
      await consumer.tick();
      await Bun.sleep(1_000);
      const held = await getWriteRequestById(engine, started.id);
      expect({ state: held?.state, token: held?.execution_token }).toEqual({ state: 'running', token });
    } finally { await consumer.stop(); }
  }), 90_000);

  /** A page batch of `size` whose head `owner` claimed and whose followers it claimed but never dispatched (no phase stamp). */
  async function stageGroup(engine: PostgresEngine, config: HarnessConfig, source: FixtureSource, prefix: string, owner: { pid: number; start: string }, size = 4) {
    const batch = randomUUID();
    const rows: WriteRequest[] = [];
    for (let i = 0; i < size; i++) rows.push(await admitWrite(engine, admission(config, source, `${prefix}-${i}`, `${prefix} body ${i}`, 0,
      { intent: { content: `${prefix} body ${i}`, page_batch: { id: batch, index: i, size } }, callerIntent: { content: `${prefix} body ${i}` } })));
    await stageClaim(engine, rows[0]!.id, owner, 30);
    const head = (await getWriteRequestById(engine, rows[0]!.id))!;
    setClaimOwnerForTest({ kind: 'sync', version: '0.0.0', nonce: `n-${owner.pid}`, pid_ns: consumerIdentity().pid_ns, boot_id: readBootId(), ...owner });
    try { expect((await claimGroupFollowers(engine, head, `batch:${batch}`, 10)).length).toBe(size - 1); } finally { setClaimOwnerForTest(undefined); }
    return rows;
  }

  test('a killed leader\'s undispatched followers are reclaimed with it in under 10 s and each publishes once', () => withBrain(async ({ engine, config, sources }) => {
    const rows = await stageGroup(engine, config, sources[0]!, 'dead-a/group', { pid: deadPid(), start: '1' });
    const followers = await Promise.all(rows.slice(1).map(row => getWriteRequestById(engine, row.id)));
    expect(followers.map(row => [row?.state, (row?.claim_phase as { phase?: string } | null)?.phase ?? null])).toEqual(followers.map(() => ['running', null]));
    const consumer = consumerFor(engine, config, sources);
    const started = Date.now();
    try {
      await consumer.tick();
      await waitFor(async () => (await Promise.all(rows.map(row => getWriteRequestById(engine, row.id)))).every(row => row?.state === 'committed'),
        { timeoutMs: 10_000, label: 'the leader and every follower commit' });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(rows.map(row => applied.get(row.id) ?? 0)).toEqual(rows.map(() => 1));
      const ids = rows.map(row => row.id);
      expect(await engine.executeRaw(`SELECT e.request_id,e.kind FROM persistence_effects e WHERE e.request_id=ANY($1::uuid[]) GROUP BY e.request_id,e.kind HAVING count(*)>1`, [ids])).toEqual([]);
      const [pages] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'dead-a/group-%' AND deleted_at IS NULL`);
      expect(Number(pages!.n)).toBe(rows.length);
    } finally { await consumer.stop(); }
  }), 90_000);

  test('a live, slow leader\'s undispatched followers keep their claims', () => withBrain(async ({ engine, config, sources }) => {
    const rows = await stageGroup(engine, config, sources[0]!, 'dead-a/slow', { pid: live.pid!, start: liveStart });
    const before = await Promise.all(rows.map(row => getWriteRequestById(engine, row.id)));
    const consumer = consumerFor(engine, config, sources);
    try {
      await consumer.tick();
      await Bun.sleep(1_000);
      const after = await Promise.all(rows.map(row => getWriteRequestById(engine, row.id)));
      expect(after.map(row => [row?.state, row?.execution_token])).toEqual(before.map(row => ['running', row?.execution_token]));
    } finally { await consumer.stop(); }
  }), 90_000);

  test('an owner from another boot, and an older stamp without the markers, wait for their lease', () => withBrain(async ({ engine, config, sources }) => {
    const foreign = await admitWrite(engine, admission(config, sources[0]!, 'dead-a/foreign', 'foreign boot body'));
    const older = await admitWrite(engine, admission(config, sources[1]!, 'dead-b/older', 'older owner body'));
    const foreignToken = await stageClaim(engine, foreign.id, { pid: deadPid(), start: '1', boot_id: FOREIGN_BOOT });
    const olderToken = await stageClaim(engine, older.id, { pid: deadPid(), boot_id: undefined, start: undefined });
    const consumer = consumerFor(engine, config, sources);
    try {
      await consumer.tick();
      await Bun.sleep(1_000);
      expect([(await getWriteRequestById(engine, foreign.id))?.execution_token, (await getWriteRequestById(engine, older.id))?.execution_token])
        .toEqual([foreignToken, olderToken]);
    } finally { await consumer.stop(); }
  }), 90_000);

  test('the heartbeat probe skips a dead same-boot row and keeps a live one and a foreign-boot one (bug 1)', () => withBrain(async ({ engine }) => {
    const host = randomUUID();
    const self = consumerIdentity();
    const seed = (pid: number, kind: string, ageS: number, boot: string | null, start: string | null) => engine.executeRaw(
      `INSERT INTO persistence_consumers(host_id,pid,nonce,pid_ns,kind,mode,started_at,renewed_at,host_json_path,persistence_home,version,boot_id,process_start)
        VALUES($1::uuid,$2,$3,$4,$5,'full',now()-($6::integer*interval '1 second'),now(),'/h','/p','0.0.0',$7,$8)`,
      [host, pid, `n-${pid}-${kind}`, self.pid_ns, kind, ageS, boot, start]);
    await seed(deadPid(), 'sync', 60, readBootId(), '1');
    await seed(live.pid!, 'serve', 5, readBootId(), liveStart);
    expect((await probeLiveFullConsumer(engine, host))?.kind).toBe('serve');
    await engine.executeRaw('DELETE FROM persistence_consumers WHERE host_id=$1::uuid', [host]);
    const foreignPid = deadPid();
    await seed(foreignPid, 'serve', 60, FOREIGN_BOOT, '1');
    expect((await probeLiveFullConsumer(engine, host))?.pid).toBe(foreignPid);
  }), 90_000);
});
