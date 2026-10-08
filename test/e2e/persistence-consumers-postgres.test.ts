/**
 * #6317 on Postgres (T1d, T3): the consumer heartbeat rows and what doctor
 * reads from them. Protects: a full consumer's row appears within one renewal
 * carrying the process identity (pid, nonce, pid namespace), kind, mode and
 * wedge report, and leaves on stop(); a row lapsed 90 s is deleted by the next
 * renewal of any consumer on the host while a merely stale row stays; the
 * probe sees a live full resident row and ignores this process, a `put`
 * row, a lapsed row, a `restart_required` row and a root barrier past the
 * ceiling; doctor `two_consumers_on_host` lists a 10 s old `put` row beside a
 * `serve` without warning and warns for two resident rows alive over 30 s;
 * `consumers_without_heartbeat` names a running claim's owner that has no
 * row (an older build); `host_identity_mismatch` names both identity files
 * when two `GBRAIN_HOME`s mint two `host.json` files on one machine against
 * one brain, and flags the container shape (no machine id, worktree at the
 * binding's path, identity minted later under another home); `writer status
 * --json` carries `host.consumers`; the v222 table has PGLite/Postgres parity.
 * Fails on the base branch: the table, the module and the checks do not exist.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  CONSUMER_LAPSED_MS, CONSUMER_LIVE_MS, CONSUMER_PURGE_MS, consumerIdentity, listHostConsumers, probeLiveFullConsumer, resetConsumerIdentityForTest, startConsumerHeartbeat,
  type ConsumerProcessIdentity,
} from '../../src/core/persistence/consumer-heartbeat.ts';
import { consumerOverlap, hostIdentityMismatches, ownersWithoutHeartbeat } from '../../src/core/persistence/consumer-diagnostics.ts';
import { localHostIdentity, readMachineId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { claimPhaseStamp, startClaimPhase } from '../../src/core/persistence/claim-phase.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { consumersWithoutHeartbeatCheck, hostIdentityMismatchCheck, twoConsumersOnHostCheck } from '../../src/commands/doctor/checks/persistence-consumers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-consumers-e2e-'));
let engine: BrainEngine;
let close: (() => Promise<void>) | undefined;
let hostId: string;
const original = consumerIdentity();

const rows = (host = hostId) => listHostConsumers(engine, host);
const identity = (pid: number, nonce = `n-${pid}`): ConsumerProcessIdentity => ({ pid, nonce, pid_ns: original.pid_ns });
/** Writes a row for another process with the given age and renewal age (seconds), as that process's heartbeat would have left it. */
async function seedRow(id: ConsumerProcessIdentity, over: { kind?: string; mode?: string; ageS?: number; renewedAgoS?: number; restart_required?: boolean; root_barrier_age_ms?: number | null; host?: string } = {}) {
  await engine.executeRaw(`INSERT INTO persistence_consumers(host_id,pid,nonce,pid_ns,kind,mode,started_at,renewed_at,restart_required,root_barrier_age_ms,host_json_path,persistence_home,version)
    VALUES($1::uuid,$2,$3,$4,$5,$6,now()-($7::integer*interval '1 second'),now()-($8::integer*interval '1 second'),$9,$10,$11,$12,'0.60.100.0')
    ON CONFLICT (host_id,pid,nonce) DO UPDATE SET renewed_at=EXCLUDED.renewed_at,started_at=EXCLUDED.started_at,mode=EXCLUDED.mode,restart_required=EXCLUDED.restart_required,root_barrier_age_ms=EXCLUDED.root_barrier_age_ms`,
    [over.host ?? hostId, id.pid, id.nonce, id.pid_ns, over.kind ?? 'serve', over.mode ?? 'full', over.ageS ?? 600, over.renewedAgoS ?? 1, over.restart_required ?? false, over.root_barrier_age_ms ?? null,
      `/other/${id.pid}/.gbrain/persistence/host.json`, `/other/${id.pid}/.gbrain/persistence`]);
}
const clear = () => engine.executeRaw('DELETE FROM persistence_consumers');

beforeAll(async () => {
  if (!hasDatabase()) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 6);
  engine = pg.engine; close = pg.close;
  await withEnv({ GBRAIN_HOME: home }, () => { hostId = localHostIdentity().id; });
}, 120_000);
afterAll(async () => {
  resetConsumerIdentityForTest(original);
  await close?.();
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!hasDatabase())('consumer heartbeat rows (Postgres, #6317)', () => {
  test('a full consumer writes its row at once with its identity and wedge report, renews it, and removes it on stop()', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    await clear();
    let restartRequired = false;
    const heartbeat = startConsumerHeartbeat(engine, hostId, { kind: 'serve', mode: 'full', everyMs: 100, report: () => ({ restart_required: restartRequired, root_barrier_age_ms: restartRequired ? 650_000 : null, pool: { checked_out: 2, max: 6, waiters: 0 } }) });
    await waitFor(async () => (await rows()).length === 1, { timeoutMs: 5_000, label: 'the row appears' });
    const [row] = await rows();
    const me = localHostIdentity();
    expect(row).toMatchObject({ host_id: hostId, pid: process.pid, nonce: original.nonce, pid_ns: original.pid_ns, kind: 'serve', mode: 'full', restart_required: false, root_barrier_age_ms: null,
      pool: { checked_out: 2, max: 6, waiters: 0 }, host_json_path: me.path, persistence_home: me.persistence_home, liveness: 'live', self: true });
    expect(row!.minted_under).toMatchObject({ home: process.env.HOME ?? null, gbrain_home: home });
    expect(readFileSync(me.path, 'utf8')).toContain('"minted_under"');
    const first = row!.renewed_at;
    restartRequired = true;
    await waitFor(async () => { const [r] = await rows(); return r?.renewed_at !== first && r?.restart_required === true; }, { timeoutMs: 5_000, label: 'a renewal carries the wedge report' });
    expect((await rows())[0]).toMatchObject({ restart_required: true, root_barrier_age_ms: 650_000 });
    expect(heartbeat.failures).toBe(0);
    await heartbeat.stop();
    expect(await rows()).toEqual([]);
  }), 30_000);

  test('a renewal purges rows lapsed over 90 s on this host and leaves stale, live and other-host rows', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    await clear();
    const otherHost = randomUUID();
    await seedRow(identity(101), { renewedAgoS: CONSUMER_PURGE_MS / 1000 + 1 });
    await seedRow(identity(102), { renewedAgoS: CONSUMER_LAPSED_MS / 1000 + 5 });
    await seedRow(identity(103), { renewedAgoS: 1 });
    await seedRow(identity(104), { renewedAgoS: CONSUMER_PURGE_MS / 1000 + 100, host: otherHost });
    const heartbeat = startConsumerHeartbeat(engine, hostId, { kind: 'sync', mode: 'full', everyMs: 1_000_000, report: () => ({ restart_required: false, root_barrier_age_ms: null }) });
    await heartbeat.renew();
    const after = await rows();
    expect(after.map(row => row.pid).sort()).toEqual([102, 103, process.pid].sort());
    expect(after.find(row => row.pid === 102)!.liveness).toBe('lapsed');
    expect(after.find(row => row.pid === 103)!.liveness).toBe('live');
    expect((await rows(otherHost)).map(row => row.pid)).toEqual([104]);
    await heartbeat.stop();
    await engine.executeRaw('DELETE FROM persistence_consumers WHERE host_id=$1::uuid', [otherHost]);
  }), 30_000);

  test('the probe finds the first live full resident row that is not this process and ignores put rows, lapsed, wedged and restart_required owners', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    await clear();
    const self = consumerIdentity();
    expect(await probeLiveFullConsumer(engine, hostId, self)).toBeNull();
    await seedRow(identity(201), { kind: 'put' });
    await seedRow(identity(202), { renewedAgoS: CONSUMER_LIVE_MS / 1000 + 1 });
    await seedRow(identity(203), { restart_required: true });
    await seedRow(identity(204), { root_barrier_age_ms: 600_000 });
    await seedRow({ pid: self.pid, nonce: self.nonce, pid_ns: self.pid_ns }, { kind: 'serve' });
    expect(await probeLiveFullConsumer(engine, hostId, self, { ceilingMs: 600_000 })).toBeNull();
    await seedRow(identity(205), { kind: 'jobs', ageS: 5 });
    expect((await probeLiveFullConsumer(engine, hostId, self, { ceilingMs: 600_000 }))?.pid).toBe(205);
    // The ceiling is the brain's: a barrier under a raised ceiling is not wedged.
    expect((await probeLiveFullConsumer(engine, hostId, self, { ceilingMs: 700_000 }))?.pid).toBe(204);
    // The same pid with another nonce is another process (a container reusing the pid), so it can be an owner.
    await clear();
    await seedRow({ pid: self.pid, nonce: 'reused-pid-other-process', pid_ns: 'pid:[1]' }, { kind: 'serve' });
    expect((await probeLiveFullConsumer(engine, hostId, self))?.nonce).toBe('reused-pid-other-process');
  }), 30_000);

  test('doctor two_consumers_on_host: a put row 10 s old beside a serve is listed, not warned; two resident rows alive over 30 s warn; a young second row does not', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    await clear();
    await seedRow(identity(301), { kind: 'serve', ageS: 600 });
    await seedRow(identity(302), { kind: 'put', ageS: 10 });
    let check = await twoConsumersOnHostCheck(engine, hostId);
    expect(check.status).toBe('ok');
    expect((check.details as { consumers: unknown[] }).consumers).toHaveLength(2);
    await seedRow(identity(303), { kind: 'sync', ageS: 10 });
    check = await twoConsumersOnHostCheck(engine, hostId);
    expect(check.status).toBe('ok');
    await seedRow(identity(303), { kind: 'sync', ageS: 60 });
    check = await twoConsumersOnHostCheck(engine, hostId);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('two_consumers_on_host');
    expect(check.message).toContain('serve pid 301');
    expect(check.message).toContain('sync pid 303');
    expect(check.details).toMatchObject({ count: 2 });
    expect(check.fix?.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--json']);
    expect(consumerOverlap(await rows()).map(row => row.pid)).toEqual([301, 303]);
    // A lapsed second resident row is no overlap.
    await seedRow(identity(303), { kind: 'sync', ageS: 60, renewedAgoS: CONSUMER_LIVE_MS / 1000 + 1 });
    expect((await twoConsumersOnHostCheck(engine, hostId)).status).toBe('ok');
  }), 30_000);

  test('doctor consumers_without_heartbeat names the owner of a live running claim that wrote no row (an older build) and clears once its row exists', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home }, async () => {
    await clear();
    const sourceId = `hb-${randomUUID().slice(0, 8)}`;
    const root = join(home, sourceId); mkdirSync(root, { recursive: true });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
    const binding = await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const [incarnation] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    const principal = { kind: 'local_cli' as const, id: (await registerLocalWriter(engine, 'cli')).id };
    const row = await admitWrite(engine, { principal, requestId: randomUUID(), operation: 'put_page', sourceId, sourceIncarnation: incarnation!.incarnation, pageId: null,
      slug: 'notes/alice-example', worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation, intent: { content: 'x' }, callerIntent: { content: 'x' },
      authority: { version: 1, principal, remote: false, sourceId, sourceIncarnation: incarnation!.incarnation, scopes: ['read', 'write'], operations: null, slugPrefixes: null } });
    const token = randomUUID();
    const stamp = claimPhaseStamp(startClaimPhase(), token, { kind: 'sync', pid: 4242, version: '0.60.100.0' });
    await engine.executeRaw(`UPDATE persistence_requests SET state='running',execution_token=$2::uuid,claim_expires_at=now()+interval '30 seconds',claim_phase=$3::text::jsonb WHERE id=$1::uuid`, [row.id, token, stamp]);
    const owners = await ownersWithoutHeartbeat(engine, hostId);
    expect(owners).toEqual([{ kind: 'sync', pid: 4242, nonce: null, version: '0.60.100.0', requests: 1, sources: [sourceId], lapsed: false }]);
    const check = await consumersWithoutHeartbeatCheck(engine, hostId);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('sync pid 4242 v0.60.100.0');
    await seedRow(identity(4242, 'any'), { kind: 'sync' });
    expect((await consumersWithoutHeartbeatCheck(engine, hostId)).status).toBe('ok');
    // A lapsed claim's owner is gone; that is persistence_write_stall's and the drain's finding, not this one.
    await clear();
    await engine.executeRaw("UPDATE persistence_requests SET claim_expires_at=now()-interval '1 second' WHERE id=$1::uuid", [row.id]);
    expect(await ownersWithoutHeartbeat(engine, hostId)).toEqual([]);
    await engine.executeRaw("UPDATE persistence_requests SET state='cancelled',execution_token=NULL,claim_expires_at=NULL WHERE id=$1::uuid", [row.id]);
  }), 60_000);

  test('T3: two GBRAIN_HOMEs against one brain mint two identities; doctor host_identity_mismatch names both files and the GBRAIN_HOME fix', async () => {
    await clear();
    const ownerHome = mkdtempSync(join(tmpdir(), 'gbrain-owner-home-'));
    const workerHome = mkdtempSync(join(tmpdir(), 'gbrain-worker-home-'));
    const sourceId = `id-${randomUUID().slice(0, 8)}`;
    const root = join(ownerHome, 'content'); mkdirSync(root, { recursive: true });
    try {
      // The owner (a serve under its own GBRAIN_HOME) claims the source and leaves a heartbeat row carrying its identity file.
      await withEnv({ GBRAIN_HOME: ownerHome, GBRAIN_PERSISTENCE_FIXTURE_HOME: ownerHome }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const owner = localHostIdentity();
        resetConsumerIdentityForTest({ pid: 777, nonce: 'owner-serve' });
        const heartbeat = startConsumerHeartbeat(engine, owner.id, { kind: 'serve', mode: 'full', everyMs: 1_000_000, report: () => ({ restart_required: false, root_barrier_age_ms: null }) });
        await heartbeat.renew();
        expect((await listHostConsumers(engine, owner.id)).map(row => row.host_json_path)).toEqual([owner.path]);
        resetConsumerIdentityForTest(original);
      });
      // A worker started with another GBRAIN_HOME on the same machine mints a second host.json.
      await withEnv({ GBRAIN_HOME: workerHome, GBRAIN_PERSISTENCE_FIXTURE_HOME: workerHome }, async () => {
        const me = localHostIdentity();
        const ownerPath = join(ownerHome, '.gbrain', 'persistence', 'host.json');
        expect(me.path).toBe(join(workerHome, '.gbrain', 'persistence', 'host.json'));
        expect(me.id).not.toBe(JSON.parse(readFileSync(ownerPath, 'utf8')).id);
        // Earlier tests' worktrees under the test home are other-host bindings on this filesystem too; this case is about the owner's.
        const found = (await hostIdentityMismatches(engine, me)).filter(m => m.source_ids.includes(sourceId));
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ source_ids: [sourceId], local_path: root, reason: readMachineId() ? 'same_machine_id' : 'worktree_on_this_filesystem',
          this_host: { host_id: me.id, host_json_path: me.path }, owner_host: { host_json_path: ownerPath, persistence_home: join(ownerHome, '.gbrain', 'persistence') }, fix_env: `GBRAIN_HOME=${ownerHome}` });
        const check = await hostIdentityMismatchCheck(engine);
        expect(check.status).toBe('warn');
        expect(check.message).toContain(me.path);
        expect(check.message).toContain(ownerPath);
        expect(check.message).toContain(`GBRAIN_HOME=${ownerHome}`);
        expect(check.message).toContain('never delete or regenerate either host.json');
        expect((check.details as { count: number }).count).toBeGreaterThanOrEqual(1);
        expect(check.fix?.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--json']);
      });
      // The owner itself does not see its own binding as a mismatch.
      await withEnv({ GBRAIN_HOME: ownerHome }, async () => {
        expect((await hostIdentityMismatches(engine, localHostIdentity())).filter(m => m.source_ids.includes(sourceId))).toEqual([]);
      });
    } finally {
      await engine.executeRaw('DELETE FROM persistence_consumers');
      rmSync(ownerHome, { recursive: true, force: true }); rmSync(workerHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('T3 container shape: no machine id, the managed worktree at the binding path, an identity minted after the binding under another home', async () => {
    await clear();
    const ownerHome = mkdtempSync(join(tmpdir(), 'gbrain-owner-home-'));
    const workerHome = mkdtempSync(join(tmpdir(), 'gbrain-worker-home-'));
    const sourceId = `ct-${randomUUID().slice(0, 8)}`;
    const root = join(ownerHome, 'content'); mkdirSync(root, { recursive: true });
    try {
      await withEnv({ GBRAIN_HOME: ownerHome, GBRAIN_PERSISTENCE_FIXTURE_HOME: ownerHome }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      });
      // No heartbeat row from the owner (an older serve) and no machine id on either side: only the filesystem evidence remains.
      await withEnv({ GBRAIN_HOME: workerHome, GBRAIN_PERSISTENCE_FIXTURE_HOME: workerHome }, async () => {
        const me = { ...localHostIdentity(), minted_under: { home: '/root', gbrain_home: null, hostname: 'container', machine_id: null } };
        const mine = (found: Awaited<ReturnType<typeof hostIdentityMismatches>>) => found.filter(m => m.source_ids.includes(sourceId));
        const found = mine(await hostIdentityMismatches(engine, me, { marked: () => true, hostJsonMintedAt: Date.now() + 60_000 }));
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ reason: 'worktree_on_this_filesystem', source_ids: [sourceId], owner_host: { host_json_path: 'unknown', minted_under: 'unknown' }, fix_env: null });
        // Minted before the binding (the identity predates the claim): not this shape.
        expect(mine(await hostIdentityMismatches(engine, me, { marked: () => true, hostJsonMintedAt: Date.now() - 86_400_000 }))).toEqual([]);
        // The path exists but holds no managed marker: not this shape either.
        expect(mine(await hostIdentityMismatches(engine, me, { marked: () => false, hostJsonMintedAt: Date.now() + 60_000 }))).toEqual([]);
      });
    } finally { rmSync(ownerHome, { recursive: true, force: true }); rmSync(workerHome, { recursive: true, force: true }); }
  }, 60_000);

  test('writer status --json carries host.consumers from the rows', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    await clear();
    await seedRow(identity(401), { kind: 'serve' });
    const status = await runPersistenceAdministration(engine, 'writer_status', {}) as { host: { host_id: string; consumers: Array<{ pid: number; kind: string; mode: string }>; overlap: unknown[]; lapsed_after_ms: number } };
    expect(status.host.host_id).toBe(hostId);
    expect(status.host.consumers.map(row => ({ pid: row.pid, kind: row.kind, mode: row.mode }))).toEqual([{ pid: 401, kind: 'serve', mode: 'full' }]);
    expect(status.host).toMatchObject({ overlap: [], lapsed_after_ms: CONSUMER_LAPSED_MS });
  }), 30_000);
});

describe('persistence_consumers on PGLite (#6317)', () => {
  test('the migration creates the table and the watermark index on both engines; the heartbeat and probe are inert on PGLite', async () => {
    const pglite = new PGLiteEngine();
    await pglite.connect({} as never);
    await pglite.initSchema();
    try {
      const [table] = await pglite.executeRaw<{ present: boolean }>("SELECT to_regclass('persistence_consumers') IS NOT NULL AS present");
      const [index] = await pglite.executeRaw<{ present: boolean }>("SELECT to_regclass('persistence_requests_committed_watermark') IS NOT NULL AS present");
      expect(table?.present).toBe(true);
      expect(index?.present).toBe(true);
      const heartbeat = startConsumerHeartbeat(pglite, randomUUID(), { kind: 'serve', mode: 'full', report: () => ({ restart_required: false, root_barrier_age_ms: null }) });
      await heartbeat.renew();
      expect(await pglite.executeRaw('SELECT 1 FROM persistence_consumers')).toEqual([]);
      expect(await probeLiveFullConsumer(pglite, randomUUID())).toBeNull();
      expect(await listHostConsumers(pglite, randomUUID())).toEqual([]);
      await heartbeat.stop();
      if (hasDatabase()) {
        const [pg] = await engine.executeRaw<{ present: boolean }>("SELECT to_regclass('persistence_requests_committed_watermark') IS NOT NULL AS present");
        expect(pg?.present).toBe(true);
        const [def] = await engine.executeRaw<{ def: string }>("SELECT indexdef AS def FROM pg_indexes WHERE indexname='persistence_requests_committed_watermark'");
        expect(def?.def).toContain("(worktree_id, completed_at DESC) WHERE (state = 'committed'::text)");
      }
    } finally { await pglite.disconnect(); }
  }, 120_000);
});
