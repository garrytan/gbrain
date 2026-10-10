/**
 * #6317 (T1, T1b on Postgres): two processes, one brain. A real `gbrain serve
 * --http` subprocess (a full consumer with its heartbeat row) and this
 * process's managed drain (`performSync` as the `sync` kind) share one
 * isolated Postgres, a 100-page git fixture and lanes 4.
 *
 * With `persistence.single_consumer` on: the drain finishes, exactly one
 * full-mode heartbeat row exists on the host (the serve's), the CLI found the
 * owner through the table alone (its consumer reports `waiter_only` with the
 * serve's identity) and only the serve's pid appears in the members'
 * `claim_phase.owner`. With it off (the shipped default): both processes
 * run full consumers, both rows exist, the group still finishes. T1b: two
 * starters within one renewal both start full and doctor reports the
 * persistent overlap once both are older than 30 s; a waiter whose owner
 * disappears promotes within two leases and drains back after the owner has
 * been live for three ticks. Fails on the base branch: no heartbeat table,
 * no election, and the CLI's own pid stamps the claims whatever the switch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PersistenceConsumer } from '../../src/core/persistence/consumer.ts';
import { WaiterOnlyConsumer } from '../../src/core/persistence/consumer-election.ts';
import { consumerIdentity, listHostConsumers, resetConsumerIdentityForTest, startConsumerHeartbeat } from '../../src/core/persistence/consumer-heartbeat.ts';
import { claimOwner, setClaimOwnerForTest } from '../../src/core/persistence/claim-phase.ts';
import { localHostIdentity } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer, persistenceConsumerStatus, preparePersistedMutation, startPersistenceConsumer } from '../../src/core/persistence/service.ts';
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { twoConsumersOnHostCheck } from '../../src/commands/doctor/checks/persistence-consumers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';

const REPO = join(import.meta.dir, '..', '..');
const home = mkdtempSync(join(tmpdir(), 'gbrain-two-consumers-'));
let engine: BrainEngine;
let databaseUrl = '';
let close: (() => Promise<void>) | undefined;
let hostId = '';
const original = consumerIdentity();
const originalOwner = claimOwner();
const PROVIDER_KEYS = /(ANTHROPIC|OPENAI|GEMINI|GOOGLE|VOYAGE|TYPESAFE)_API_KEY|^GBRAIN_(DATABASE_URL|DIRECT_DATABASE_URL)$|^DATABASE_URL$/;

function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
const pad = (i: number) => String(i).padStart(3, '0');
async function fixture(count: number) {
  const id = `two-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) {
    const full = join(root, 'notes', `n${pad(i)}.md`); mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, `---\ntitle: Note ${i}\n---\nA durable observation number ${i} about acme-example, see [[notes/n${pad((i + 7) % count)}]].\n`);
  }
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
function freePort(): Promise<number> {
  return new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); }); });
}
function serveEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PROVIDER_KEYS.test(k)) env[k] = v;
  for (const k of ['GBRAIN_TEST_ALLOW_DATABASE_URL', 'GBRAIN_SOURCE', 'CLAUDECODE', 'CODEX_HOME']) delete env[k];
  Object.assign(env, { HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', NO_COLOR: '1', GBRAIN_NO_RETRY_CONNECT: '1', GBRAIN_ADMIN_BOOTSTRAP_TOKEN: 'two-consumers-test-token-0123456789abcdef' });
  return env;
}
/** A real `gbrain serve --http` against the isolated brain; resolves once /health answers. */
async function spawnServe() {
  const port = await freePort();
  const child = Bun.spawn([process.execPath, '--no-env-file', join(REPO, 'src', 'cli.ts'), 'serve', '--http', '--port', String(port)], { cwd: REPO, env: serveEnv(), stdout: 'pipe', stderr: 'pipe' });
  let stderr = '';
  void new Response(child.stderr).text().then(text => { stderr += text; });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).status < 500; } catch { return false; } }, { timeoutMs: 90_000, intervalMs: 250, label: `serve on :${port} answers /health` });
  return { pid: child.pid, port, stderr: () => stderr, async stop() { if (child.exitCode === null) child.kill('SIGTERM'); await Promise.race([child.exited, Bun.sleep(20_000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })]); } };
}
const imports = (source: string) => engine.executeRaw<{ slug: string; state: string; owner_pid: number | null; owner_kind: string | null; owner_nonce: string | null }>(
  `SELECT slug,state,(claim_phase->'owner'->>'pid')::int AS owner_pid,claim_phase->'owner'->>'kind' AS owner_kind,claim_phase->'owner'->>'nonce' AS owner_nonce
   FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [source]);

beforeAll(async () => {
  if (!hasDatabase()) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 12);
  engine = pg.engine; close = pg.close; databaseUrl = pg.databaseUrl;
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: databaseUrl, embedding_disabled: true }));
  await withEnv({ GBRAIN_HOME: home }, () => { hostId = localHostIdentity().id; });
  // This process plays the sync CLI: a resident kind that defers to a live owner.
  setClaimOwnerForTest({ ...originalOwner, kind: 'sync' });
}, 180_000);
afterAll(async () => {
  setClaimOwnerForTest(undefined);
  resetConsumerIdentityForTest(original);
  if (engine) await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); });
  resetWriteSwitches();
  await close?.();
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!hasDatabase())('two consumers on one host (Postgres, #6317)', () => {
  for (const single of [true, false]) {
    test(`a serve subprocess plus the CLI drain, lanes 4, 100 pages, persistence.single_consumer=${single}: the group finishes${single ? ' and only the serve publishes' : ' with both consumers full'}`, async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SYNC_BULK_SIZE: '8' }, async () => {
      await engine.setConfig('persistence.single_consumer', String(single));
      resetWriteSwitches();
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('DELETE FROM persistence_consumers');
      const serve = await spawnServe();
      try {
        await waitFor(async () => (await listHostConsumers(engine, hostId)).some(row => row.pid === serve.pid && row.kind === 'serve' && row.mode === 'full'), { timeoutMs: 30_000, intervalMs: 200, label: 'the serve writes its heartbeat row' });
        const f = await fixture(100);
        // The CLI's consumer settles before the drain admits anything: while it still probes it claims nothing, and a
        // fast serve could publish all 100 first. Its election is what this test pins, not that race.
        startPersistenceConsumer(engine, { engine: 'postgres' });
        const settled = single ? 'waiter_only' : 'full';
        await waitFor(async () => (persistenceConsumerStatus(engine) as { consumer_election?: { mode: string } }).consumer_election?.mode === settled,
          { timeoutMs: 30_000, intervalMs: 50, label: `the CLI consumer settles to ${settled}` });
        const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 4 });
        expect(result.drain?.outcome).toBe('synced');
        const rows = await imports(f.id);
        expect(rows).toHaveLength(100);
        expect(rows.every(row => row.state === 'committed')).toBe(true);
        const status = persistenceConsumerStatus(engine) as { consumer_election?: { mode: string; owner: { pid: number; kind: string } | null } };
        const consumers = await listHostConsumers(engine, hostId);
        const full = consumers.filter(row => row.mode === 'full' || row.mode === 'promoted');
        const stampedPids = [...new Set(rows.map(row => row.owner_pid))];
        if (single) {
          // The CLI found the owner through the table alone (no socket on Postgres) and claimed nothing.
          expect(status.consumer_election).toMatchObject({ mode: 'waiter_only', owner: { pid: serve.pid, kind: 'serve' } });
          expect(full.map(row => ({ pid: row.pid, kind: row.kind }))).toEqual([{ pid: serve.pid, kind: 'serve' }]);
          expect(stampedPids).toEqual([serve.pid]);
          expect(rows.every(row => row.owner_kind === 'serve' && row.owner_nonce)).toBe(true);
        } else {
          expect(status.consumer_election).toMatchObject({ mode: 'full' });
          expect(full.map(row => row.kind).sort()).toEqual(['serve', 'sync']);
          expect(full.map(row => row.pid).sort()).toEqual([process.pid, serve.pid].sort());
          expect(stampedPids.every(pid => pid === serve.pid || pid === process.pid)).toBe(true);
          expect(stampedPids).toContain(process.pid);
        }
        expect(await engine.getPage('notes/n042', { sourceId: f.id })).not.toBeNull();
      } finally {
        await disposePersistenceConsumer(engine);
        await serve.stop();
      }
      // The serve's row leaves with it (stop() deletes it); the CLI's, if any, left with dispose.
      await waitFor(async () => (await listHostConsumers(engine, hostId)).every(row => row.pid !== serve.pid), { timeoutMs: 10_000, label: 'the serve row is gone' });
    }), 300_000);
  }

  test('T1b: two starters within one renewal both start full; doctor reports the persistent overlap once both are over 30 s old', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    await engine.setConfig('persistence.single_consumer', 'true');
    resetWriteSwitches();
    await engine.executeRaw('DELETE FROM persistence_consumers');
    const make = () => new PersistenceConsumer(engine, { engine: 'postgres' }, preparePersistedMutation, { hostId, pollMs: 1_000_000, onError: () => {} });
    // "Both probe before either has written a row" is the precondition, not a race to win: each starter's first read
    // waits until the other's first read has started, so neither sees the row the other's start-up writes.
    const bothRead = Promise.withResolvers<void>();
    let firstReads = 0;
    const readTogether = () => {
      let first = true;
      return async (signal: AbortSignal) => {
        if (first) { first = false; if (++firstReads === 2) bothRead.resolve(); await bothRead.promise; }
        return listHostConsumers(engine, hostId, { signal });
      };
    };
    const a = new WaiterOnlyConsumer(engine, { engine: 'postgres' }, make, { kind: 'jobs', hostId, readConsumers: readTogether(), pollMs: 1_000_000, idleMaxMs: 1_000_000, heartbeatEveryMs: 1_000_000, log: () => {} });
    resetConsumerIdentityForTest({ pid: process.pid + 100_000, nonce: 'second-starter' });
    const b = new WaiterOnlyConsumer(engine, { engine: 'postgres' }, make, { kind: 'sync', hostId, readConsumers: readTogether(), pollMs: 1_000_000, idleMaxMs: 1_000_000, heartbeatEveryMs: 1_000_000, log: () => {} });
    resetConsumerIdentityForTest(original);
    try {
      // Both probe before either has written a row: the known residual (a preference, not a fenced role).
      a.start(); b.start();
      await Promise.all([a.probeTick(), b.probeTick()]);
      expect([a.mode, b.mode]).toEqual(['full', 'full']);
      await waitFor(async () => (await listHostConsumers(engine, hostId)).filter(row => row.mode === 'full').length === 2, { timeoutMs: 10_000, label: 'both rows exist' });
      expect((await twoConsumersOnHostCheck(engine, hostId)).status).toBe('ok');
      await engine.executeRaw("UPDATE persistence_consumers SET started_at=now()-interval '45 seconds' WHERE host_id=$1::uuid", [hostId]);
      const check = await twoConsumersOnHostCheck(engine, hostId);
      expect(check.status).toBe('warn');
      expect(check.message).toContain(`jobs pid ${process.pid}`);
      expect(check.message).toContain(`sync pid ${process.pid + 100_000}`);
      // Neither drains back: only a promoted consumer does.
      for (let i = 0; i < 4; i++) { await a.probeTick(); await b.probeTick(); }
      expect([a.mode, b.mode]).toEqual(['full', 'full']);
    } finally { await a.stop(); await b.stop(); }
    expect(await listHostConsumers(engine, hostId)).toEqual([]);
  }), 60_000);

  test('T1b: a waiter beside a live owner claims nothing; when the owner goes it promotes within two leases, and drains back after the owner is live for three ticks', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    await engine.setConfig('persistence.single_consumer', 'true');
    resetWriteSwitches();
    await engine.executeRaw('DELETE FROM persistence_consumers');
    const ownerIdentity = { pid: process.pid + 200_000, nonce: 'owner-serve', pid_ns: original.pid_ns };
    const owner = () => startConsumerHeartbeat(engine, hostId, { kind: 'serve', mode: 'full', identity: ownerIdentity, everyMs: 1_000_000, report: () => ({ restart_required: false, root_barrier_age_ms: null }) });
    let heartbeat = owner();
    await heartbeat.renew();
    const made: PersistenceConsumer[] = [];
    const waiter = new WaiterOnlyConsumer(engine, { engine: 'postgres' }, () => { const c = new PersistenceConsumer(engine, { engine: 'postgres' }, preparePersistedMutation, { hostId, pollMs: 1_000_000, onError: () => {} }); made.push(c); return c; },
      { kind: 'jobs', hostId, pollMs: 1_000_000, idleMaxMs: 1_000_000, heartbeatEveryMs: 1_000_000, log: () => {} });
    try {
      waiter.start();
      await waiter.probeTick();
      expect(waiter.mode).toBe('waiter_only');
      expect(waiter.electedOwner()).toMatchObject({ pid: ownerIdentity.pid, kind: 'serve' });
      expect(made).toHaveLength(0);
      expect((await listHostConsumers(engine, hostId)).map(row => row.pid)).toEqual([ownerIdentity.pid]);
      // The owner exits (its stop() removes the row): the waiter promotes on its next probe and writes a `promoted` row.
      await heartbeat.stop();
      await waiter.probeTick();
      expect(waiter.mode).toBe('promoted');
      expect(made).toHaveLength(1);
      await waitFor(async () => (await listHostConsumers(engine, hostId)).some(row => row.pid === process.pid && row.mode === 'promoted'), { timeoutMs: 10_000, label: 'the promoted row' });
      // The owner comes back: three live ticks later the promoted consumer finishes and defers again; its row goes.
      heartbeat = owner();
      await heartbeat.renew();
      await waiter.probeTick(); await waiter.probeTick();
      expect(waiter.mode).toBe('promoted');
      await waiter.probeTick();
      expect(waiter.mode).toBe('waiter_only');
      expect((await listHostConsumers(engine, hostId)).map(row => row.pid)).toEqual([ownerIdentity.pid]);
      // An owner whose heartbeat merely lapses (no stop) promotes the waiter too, once the row is 60 s stale.
      await engine.executeRaw("UPDATE persistence_consumers SET renewed_at=now()-interval '61 seconds' WHERE pid=$1", [ownerIdentity.pid]);
      await waiter.probeTick();
      expect(waiter.mode).toBe('promoted');
      expect(made).toHaveLength(2);
    } finally { await waiter.stop(); await heartbeat.stop(); }
  }), 60_000);
});
