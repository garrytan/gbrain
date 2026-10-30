/**
 * #7442 (found by GBRA-181's TLA+ model of the drain lease): the fence held the lease row `FOR SHARE`, which also blocks the
 * holder's own renewal (an UPDATE), and Postgres grants a new `FOR SHARE` beside held ones even while that UPDATE waits. So
 * fenced transactions longer than the 30 s renewal timeout, or overlapping ones (the coordinator's stamp checks beside the
 * pass's own), could keep the row share-locked across every renewal until a live holder's lease lapsed. The fence
 * (`fenceLockRow`) now takes `FOR KEY SHARE`, which a renewal passes; the takeover upsert also writes the key
 * (`id = EXCLUDED.id`), so it still waits for the fence, and a transaction fenced before a takeover keeps its token.
 *
 * A static check pins the one way the token may change. PGLite (one connection) checks the fence's verdicts; Postgres also checks the lock conflicts, here and through
 * test/e2e/drain-lease-key-share-7442-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { fenceLockRow, tryAcquireDbLock } from '../src/core/db-lock.ts';
import { testBackends, type TestBackend } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: Array<{ backend: TestBackend; engine: BrainEngine; close: () => Promise<void> }> = [];
const ID = 'test-7442-drain';
const BLOCKED = 'still waiting';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const within = <T>(work: Promise<T>, ms: number) => Promise.race([work, delay(ms).then(() => BLOCKED as typeof BLOCKED)]);
const tokenOf = async (engine: BrainEngine) => (await engine.executeRaw<{ token: string }>('SELECT acquisition_token::text AS token FROM gbrain_cycle_locks WHERE id=$1', [ID]))[0]?.token ?? null;

beforeAll(async () => {
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({ database_url: '' });
      await engine.initSchema();
      engines.push({ backend, engine, close: () => engine.disconnect() });
    } else {
      engines.push({ backend, ...await isolatedPersistencePostgres(process.env.DATABASE_URL!) });
    }
  }
}, 120_000);

afterAll(async () => { for (const e of engines) await e.close(); });
beforeEach(async () => { for (const { engine } of engines) await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [ID]); });

/** Opens a transaction that takes the fence with `token` and stays open until `release` resolves; `entered` once fenced. */
function fencedTransaction(engine: BrainEngine, token: string) {
  const entered = deferred(), release = deferred();
  let fenced: unknown[] = [], tokenInside: string | null = null;
  const done = engine.transaction(async tx => {
    fenced = await fenceLockRow(tx, ID, token);
    entered.resolve();
    await release.promise;
    tokenInside = (await tx.executeRaw<{ token: string }>('SELECT acquisition_token::text AS token FROM gbrain_cycle_locks WHERE id=$1', [ID]))[0]?.token ?? null;
  });
  return { entered: entered.promise, release: release.resolve, done, fenced: () => fenced, tokenInside: () => tokenInside };
}

describe('#7442: the drain-lease fence lets the renewal through and still holds off a takeover', () => {
  test('the fence holds for the live token only: not another token, not an expired row', async () => {
    for (const { engine } of engines) {
      const handle = (await tryAcquireDbLock(engine, ID, 2))!;
      expect(await fenceLockRow(engine, ID, handle.acquisitionToken)).toHaveLength(1);
      expect(await fenceLockRow(engine, ID, crypto.randomUUID())).toHaveLength(0);
      await engine.executeRaw("UPDATE gbrain_cycle_locks SET ttl_expires_at = now() - interval '1 second' WHERE id=$1", [ID]);
      expect(await fenceLockRow(engine, ID, handle.acquisitionToken)).toHaveLength(0);
      await handle.release();
    }
  }, 60_000);

  test('the token changes only in an ON CONFLICT upsert that also writes the key, so a KEY SHARE fence holds it off', () => {
    const assignments: string[] = [];
    for (const file of readdirSync('src', { recursive: true }) as string[]) {
      if (!file.endsWith('.ts')) continue;
      // test-reads-source-ok[structural]: the guard is a census of every token assignment in src/; a mutant that moves the token write out of the keyed upsert has no runtime symptom until a fence races it.
      const lines = readFileSync(join('src', file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/(^|[\s,(])acquisition_token\s*=(?!=)/.test(line) || /\b(WHERE|AND|OR)\b[^,]*acquisition_token\s*=/i.test(line)) return;
        const before = lines.slice(Math.max(0, i - 6), i).join('\n');
        assignments.push(`${file}:${i + 1} ${/ON CONFLICT \(id\) DO UPDATE\s+SET id = EXCLUDED\.id,/.test(before) ? 'keyed-upsert' : 'UNKEYED'}`);
      });
    }
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.filter(a => !a.endsWith('keyed-upsert'))).toEqual([]);
  });

  test('a renewal commits while a fenced transaction is open (Postgres)', async () => {
    for (const { backend, engine } of engines) {
      if (backend !== 'postgres') continue;
      const handle = (await tryAcquireDbLock(engine, ID, 2))!;
      const open = fencedTransaction(engine, handle.acquisitionToken);
      await open.entered;
      expect(open.fenced()).toHaveLength(1);
      try {
        expect(await within(handle.refresh(), 5_000)).toBe(true);
      } finally { open.release(); await open.done; }
      await handle.release();
    }
  }, 60_000);

  test('a follower polling a live holder waits behind the fence, and the holder\'s renewal does not queue behind that follower (Postgres)', async () => {
    for (const { backend, engine } of engines) {
      if (backend !== 'postgres') continue;
      const handle = (await tryAcquireDbLock(engine, ID, 2))!;
      const open = fencedTransaction(engine, handle.acquisitionToken);
      await open.entered;
      const follower = tryAcquireDbLock(engine, ID, 2);
      let lost;
      try {
        let waiting = 0;
        for (let i = 0; i < 100 && !waiting; i++) {
          await delay(50);
          waiting = (await engine.executeRaw<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO gbrain_cycle_locks%'"))[0]!.n;
        }
        expect(waiting).toBe(1);
        expect(await within(handle.refresh(), 1_000)).toBe(true);
        expect(await within(handle.refresh(), 1_000)).toBe(true);
      } finally { open.release(); await open.done; lost = await follower; }
      expect(lost).toBeNull();
      expect(await tokenOf(engine)).toBe(handle.acquisitionToken);
      expect(await handle.refresh()).toBe(true);
      await handle.release();
    }
  }, 60_000);

  test('a takeover of an expired row waits for the fence, the fenced transaction keeps its token, and the old token is then refused (Postgres)', async () => {
    for (const { backend, engine } of engines) {
      if (backend !== 'postgres') continue;
      const handle = (await tryAcquireDbLock(engine, ID, 2))!;
      const open = fencedTransaction(engine, handle.acquisitionToken);
      await open.entered;
      await engine.executeRaw("UPDATE gbrain_cycle_locks SET ttl_expires_at = now() - interval '1 minute', last_refreshed_at = now() - interval '1 hour' WHERE id=$1", [ID]);
      const takeover = tryAcquireDbLock(engine, ID, 2);
      let successor;
      try {
        expect(await within(takeover, 2_000)).toBe(BLOCKED);
      } finally { open.release(); await open.done; successor = await takeover; }
      expect(open.tokenInside()).toBe(handle.acquisitionToken);
      expect(successor).not.toBeNull();
      expect(await tokenOf(engine)).toBe(successor!.acquisitionToken);
      expect(await fenceLockRow(engine, ID, handle.acquisitionToken)).toHaveLength(0);
      expect(await handle.refresh()).toBe(false);
      await successor!.release();
    }
  }, 60_000);
});
