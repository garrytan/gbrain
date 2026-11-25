/**
 * #10083: the recovery scan must not download a publishing write's payload.
 *
 * 1. Protects: while another process publishes a write (it holds the root's worktree lock and the row carries its
 *    intent and a before-image in `recovery`), every full consumer's recovery pass only names the row; neither the
 *    scan nor a by-id read returns `intent` or `recovery`. Once the lock is free, the same consumer recovers the row,
 *    a terminal row whose root is busy still settles with its full receipt, and a row blocked on changed file or
 *    staging bytes (an operator must look) waits 30 s between polls.
 * 2. Fails when: the scan selects `r.*`, or recovery reads the whole row before it holds the worktree lock (each
 *    read costs the row's size on every poll of every serve on the host).
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { recoverPublication } from '../src/core/persistence/coordinator.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { admitWrite, claimNextWrite, completeWrite, getWriteRequestById, prepareRecovery } from '../src/core/persistence/journal.ts';
import { recoveryFiles, type WriteRequest } from '../src/core/persistence/model.ts';
import { acquireWorktree } from '../src/core/persistence/ownership.ts';
import { admission, fixtures, initializeFixtures, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const BEFORE = 'a'.repeat(64 * 1024);
const AFTER = 'b'.repeat(64 * 1024);

for (const kind of testBackends()) {
  describe(`#10083 recovery scan payload (${kind})`, () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-recovery-scan-10083-'));
    const config: HarnessConfig = { kind, root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
      seed: 10083, schedules: 0, operations: 0, sourceIds: ['recovery-scan-10083'], principalIds: [randomUUID()] };
    const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => withEnv(env, async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 8));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({}); await pglite.initSchema();
        engine = pglite; close = () => pglite.disconnect();
      }
      selectFixtureHost(config.hostId);
      await initializeFixtures(engine, config);
    }), 120_000);
    afterAll(async () => { await close?.(); rmSync(home, { recursive: true, force: true }); });

    /** A write to an existing 64 KiB page, mid-publication: its recovery record holds the before-image, and the test holds the root's lock. */
    async function publishing(slug: string) {
      const [source] = await fixtures(engine, config);
      const path = join(source.root, `${slug}.md`);
      writeFileSync(path, BEFORE);
      await admitWrite(engine, admission(config, source, slug, AFTER));
      const row = (await claimNextWrite(engine, config.hostId))!;
      const lock = (await acquireWorktree(source.binding))!;
      expect(lock).not.toBeNull();
      await prepareRecovery(engine, row, { version: 1, root: source.root, path, before: Buffer.from(BEFORE).toString('base64'),
        beforeHash: sha256(BEFORE), afterHash: sha256(AFTER), mode: 0o600, ownerEpoch: String(source.binding.owner_epoch),
        attempt: row.execution_token! }, 2 * BEFORE.length);
      return { row, lock };
    }
    /**
     * The consumer's engine, recording each row any statement or engine member returns for `id` with a payload column in it.
     * The recovery scan and the by-id read run through typed members (listOwnerRecoveryHeads, getWriteRequestById) on the
     * engine's own executor, so a member's result is inspected like a statement's.
     */
    function observed(id: string) {
      const payloads: string[][] = [];
      let named = 0;
      const inspect = (value: unknown) => {
        for (const result of Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []) {
          if ((result as Record<string, unknown> | null)?.id !== id) continue;
          named++;
          const columns = ['intent', 'recovery'].filter(column => (result as Record<string, unknown>)[column] != null);
          if (columns.length) payloads.push(columns);
        }
        return value;
      };
      const proxy = new Proxy(engine, { get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function' || key === 'transaction') return typeof value === 'function' ? value.bind(target) : value;
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result instanceof Promise ? result.then(inspect) : result;
        };
      } });
      return { proxy, payloads, named: () => named };
    }
    const consumerOn = (proxy: BrainEngine, onSettled?: (row: WriteRequest) => void) => new PersistenceConsumer(proxy, { engine: kind }, async () => { throw new Error('recovery only'); },
      { hostId: config.hostId, concurrency: 0, requestsOnly: true, onSettled, onError: error => { throw error; } });
    const retries = (consumer: PersistenceConsumer) => (consumer as unknown as { rootRetryAfter: Map<string, number> }).rootRetryAfter;
    const finish = async (row: WriteRequest) => {
      await recoverPublication(engine, row.id, config.hostId);
      await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
    };

    test('a busy root is named by the scan without its intent or before-image; the consumer recovers it once the lock is free', () => withEnv(env, async () => {
      const { row, lock } = await publishing('busy-page');
      expect(Buffer.from(recoveryFiles((await getWriteRequestById(engine, row.id))!.recovery!)[0]!.before!, 'base64').byteLength).toBe(BEFORE.length);
      const { proxy, payloads, named } = observed(row.id);
      const consumer = consumerOn(proxy);
      try {
        await consumer.tick();
        expect(named()).toBeGreaterThan(0);
        expect(retries(consumer).has(row.worktree_id!)).toBe(true);
        expect(payloads).toEqual([]);
        expect((await getWriteRequestById(engine, row.id))!.recovery).not.toBeNull();

        await lock.release();
        retries(consumer).clear();
        await consumer.tick();
        expect((await getWriteRequestById(engine, row.id))!.recovery).toBeNull();
        expect(retries(consumer).has(row.worktree_id!)).toBe(false);
      } finally { await consumer.stop(); await lock.release(); await finish(row); }
    }), 120_000);

    test('a row blocked on changed staging bytes waits the long cooldown, like changed file bytes', () => withEnv(env, async () => {
      const { row, lock } = await publishing('blocked-staging');
      await engine.executeRaw("UPDATE persistence_requests SET blocked_reason='unexpected_staging_bytes' WHERE id=$1::uuid", [row.id]);
      const consumer = consumerOn(engine);
      try {
        const started = Date.now();
        await consumer.tick();
        expect(retries(consumer).get(row.worktree_id!)!).toBeGreaterThanOrEqual(started + 30_000);
      } finally { await consumer.stop(); await lock.release(); await finish(row); }
    }), 120_000);

    test('a terminal row whose root is busy still settles with its full receipt', () => withEnv(env, async () => {
      const { row, lock } = await publishing('busy-terminal');
      await engine.transaction(tx => completeWrite(tx, row, 'committed', {}));
      const terminal = await getWriteRequestById(engine, row.id);
      const seen: WriteRequest[] = [];
      const consumer = consumerOn(engine, current => seen.push(current));
      try {
        await consumer.tick();
        expect(seen).toEqual([terminal!]);
      } finally { await consumer.stop(); await lock.release(); await finish(row); }
    }), 120_000);
  });
}
