/**
 * #10083: idle full consumers must not download a live publisher's intent and
 * before-image on every recovery pass. A real second process holds an update
 * to an existing 64 KiB page at before_commit, with its worktree lock held.
 * This process runs another full consumer and counts payload columns actually
 * returned by Postgres across three recovery scans, including by-id reads.
 * Existing two-consumer tests check election and completion, not returned
 * payloads. Then kill the publisher and require this same consumer to recover.
 * Uses existing fault points and engine proxies, no production seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admission, fixtures, initializeFixtures, selectFixtureHost, type HarnessConfig } from '../../scripts/persistence/harness.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { admitWrite, claimNextWrite, getWriteRequestById } from '../../src/core/persistence/journal.ts';
import { recoveryFiles } from '../../src/core/persistence/model.ts';
import { acquireWorktree } from '../../src/core/persistence/ownership.ts';
import { listHostConsumers } from '../../src/core/persistence/consumer-heartbeat.ts';
import { disposePersistenceConsumer, registerMutationPreparer, startPersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { testWaitMs, waitFor } from '../helpers/wait-for.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hasDatabase } from './helpers.ts';

const REPO = join(import.meta.dir, '..', '..');
// Scaled startup, three scans, kill and recovery waits, plus 15 s for fixture work and shutdown.
const TEST_TIMEOUT = 2 * testWaitMs(15_000) + testWaitMs(5_000) + testWaitMs(10_000) + 15_000;
const home = mkdtempSync(join(tmpdir(), 'gbrain-recovery-scan-10083-'));
const config: HarnessConfig = { kind: 'postgres', root: home, dataDir: join(home, 'unused'), hostId: randomUUID(),
  seed: 10083, schedules: 0, operations: 0, sourceIds: ['recovery-scan-10083'], principalIds: [randomUUID()] };
const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
let pg: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;

beforeAll(async () => {
  if (!hasDatabase()) return;
  pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 8);
  config.databaseUrl = pg.databaseUrl;
  await withEnv(env, async () => { selectFixtureHost(config.hostId); await initializeFixtures(pg.engine, config); });
}, 120_000);
afterAll(async () => { await pg?.close(); rmSync(home, { recursive: true, force: true }); });

describe.skipIf(!hasDatabase())('recovery scan payload (Postgres, #10083)', () => {
  test('a non-owning full consumer skips live payloads, then recovers the killed publisher', async () => withEnv(env, async () => {
    const { engine } = pg;
    const [source] = await fixtures(engine, config);
    const slug = 'existing-page';
    const before = 'a'.repeat(64 * 1024);
    const after = 'b'.repeat(64 * 1024);
    const initial = await admitWrite(engine, admission(config, source, slug, before));
    const claimed = await claimNextWrite(engine, config.hostId);
    expect(claimed?.id).toBe(initial.id);
    const seeded = await publishMutation(engine, claimed!, {
      observedRevision: null, file: { root: source.root, path: join(source.root, `${slug}.md`), content: before },
      apply: async tx => { await tx.putPage(slug, { type: 'note', title: slug, compiled_truth: before }, { sourceId: source.id }); return { status: 'written' }; },
    }, config.hostId);
    expect(seeded.state).toBe('committed');
    expect(Buffer.byteLength(readFileSync(join(source.root, `${slug}.md`)))).toBe(64 * 1024);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: source.id }))!;
    const row = await admitWrite(engine, admission(config, source, slug, after, 0, { pageId: snapshot.page.id }));
    const marker = join(home, 'publishing');
    // A runs the full consumer with real claim renewal, heartbeat and native
    // worktree exclusion. Only the publication boundary is held by the test.
    const code = `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { openEngine, fixtures } from './scripts/persistence/harness.ts';
      import { PersistenceConsumer } from './src/core/persistence/consumer.ts';
      import { claimOwner } from './src/core/persistence/claim-phase.ts';
      import { startConsumerHeartbeat } from './src/core/persistence/consumer-heartbeat.ts';
      import { installFaultHook } from './src/core/persistence/fault-points.ts';
      const config = ${JSON.stringify(config)};
      const engine = await openEngine(config);
      const [source] = await fixtures(engine, config);
      const release = new Response(Bun.stdin).text();
      installFaultHook(async (point, detail) => {
        if (point === 'publication:before_commit' && detail.requestId === ${JSON.stringify(row.request_id)}) {
          writeFileSync(${JSON.stringify(marker)}, String(process.pid));
          await release;
        }
      });
      const consumer = new PersistenceConsumer(engine, { engine: 'postgres', embedding_disabled: true }, async (e, row) => ({
        observedRevision: (await e.readPageSnapshot(row.slug, { sourceId: row.source_id }))?.revision ?? null,
        file: { root: source.root, path: join(source.root, row.slug + '.md'), content: row.intent.content },
        apply: async tx => { await tx.putPage(row.slug, { type: 'note', title: row.slug, compiled_truth: row.intent.content }, { sourceId: row.source_id }); return { status: 'written' }; },
      }), { hostId: config.hostId, onError: error => { throw error; } });
      const heartbeat = startConsumerHeartbeat(engine, config.hostId, { kind: claimOwner().kind, mode: 'full',
        report: () => ({ restart_required: consumer.restartRequired(), root_barrier_age_ms: consumer.oldestRootBarrierAgeMs() }) });
      consumer.start();
      await release;
      await consumer.stop();
      await heartbeat.stop();
      installFaultHook(undefined);
      await engine.disconnect();
    `;
    const publisher = Bun.spawn([process.execPath, '--no-env-file', '-e', code], { cwd: REPO,
      env: keylessBrainEnv(process.env, home, { ...env, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_DIRECT_DATABASE_URL: undefined }),
      stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' });
    let publisherExited = false;
    const exited = publisher.exited.then(code => { publisherExited = true; return code; });
    const stderr = new Response(publisher.stderr).text();
    let scans = 0;
    const payloadReads: Array<{ scan: number; columns: string[]; intent_bytes: number; recovery_bytes: number }> = [];
    const proxy = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw' || key === 'executeRawDirect') return async (...args: Parameters<typeof engine.executeRaw>) => {
        const rows = await target[key](...args);
        if (args[0].includes('ORDER BY r.updated_at,r.sequence LIMIT 16')) scans++;
        for (const result of rows as Record<string, unknown>[]) {
          if (result.id !== row.id) continue;
          const columns = ['intent', 'recovery'].filter(column => result[column] != null);
          if (columns.length) payloadReads.push({ scan: scans, columns,
            intent_bytes: result.intent == null ? 0 : Buffer.byteLength(JSON.stringify(result.intent)),
            recovery_bytes: result.recovery == null ? 0 : Buffer.byteLength(JSON.stringify(result.recovery)) });
        }
        return rows;
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await waitFor(() => {
        if (publisherExited) throw new Error(`Publisher exited before publication: ${publisher.exitCode}`);
        return existsSync(marker);
      }, { timeoutMs: 15_000, label: 'A holds the publication before commit' });
      expect(Number(readFileSync(marker, 'utf8'))).toBe(publisher.pid);
      expect(publisher.pid).not.toBe(process.pid);
      const publishing = await getWriteRequestById(engine, row.id);
      expect(publishing?.state).toBe('running');
      expect(publishing?.claim_phase).toMatchObject({ phase: 'publishing', owner: { pid: publisher.pid } });
      expect(Buffer.from(recoveryFiles(publishing!.recovery!)[0].before!, 'base64').byteLength).toBe(64 * 1024);
      const lock = await acquireWorktree(source.binding, 0, undefined, engine, { yieldLanes: true });
      try { expect(lock).toBeNull(); } finally { await lock?.release(); }
      registerMutationPreparer('put_page', async (e, current) => ({
        observedRevision: (await e.readPageSnapshot(current.slug, { sourceId: current.source_id }))?.revision ?? null,
        file: { root: source.root, path: join(source.root, `${current.slug}.md`), content: String(current.intent!.content) },
        apply: async tx => {
          await tx.putPage(current.slug, { type: 'note', title: current.slug, compiled_truth: String(current.intent!.content) }, { sourceId: current.source_id });
          return { status: 'written' };
        },
      }));
      const consumer = startPersistenceConsumer(proxy, { engine: 'postgres', embedding_disabled: true });
      await waitFor(() => scans >= 3, { timeoutMs: 15_000, label: 'B completes three recovery scans while A holds the lock' });
      await consumer.tick();
      const consumers = await listHostConsumers(engine, config.hostId);
      expect(consumers.filter(c => c.mode === 'full' && c.liveness === 'live').map(c => c.pid).sort()).toEqual([publisher.pid, process.pid].sort());
      expect(consumer.status().last_error).toBeUndefined();
      expect((await engine.readPageSnapshot(slug, { sourceId: source.id }))?.page.compiled_truth).toBe(before);
      console.info(`#10083: page_bytes=${Buffer.byteLength(before)} scans=${scans} payload_reads=${payloadReads.length}`);
      expect(payloadReads).toEqual([]);
      expect(publisherExited).toBe(false);
      const killedAt = Date.now();
      publisher.kill('SIGKILL');
      await waitFor(() => publisherExited, { timeoutMs: 5_000, label: 'A exits after SIGKILL' });
      await exited;
      await waitFor(async () => {
        const recovered = await getWriteRequestById(engine, row.id);
        return recovered?.state === 'committed' && recovered.recovery === null;
      }, { timeoutMs: 10_000, label: 'kill-and-recover: B completes killed A with cleared recovery' });
      expect(await getWriteRequestById(engine, row.id)).toMatchObject({ state: 'committed', recovery: null });
      expect(readFileSync(join(source.root, `${slug}.md`), 'utf8')).toBe(after);
      expect((await engine.readPageSnapshot(slug, { sourceId: source.id }))?.page.compiled_truth).toBe(after);
      expect(consumer.status().last_error).toBeUndefined();
      console.info(`#10083: kill_and_recover_ms=${Date.now() - killedAt}`);
    } finally {
      await disposePersistenceConsumer(proxy);
      if (!publisherExited) publisher.kill('SIGKILL');
      publisher.stdin.end();
      await exited;
      await stderr;
    }
  }), TEST_TIMEOUT);
});
