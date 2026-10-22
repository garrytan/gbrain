/**
 * GBRA-156: the reads a one-shot CLI write sends behind a transaction pooler. Each case counts the statements a step sends
 * (and the waves they form) and keeps the result the step returned before. Both backends.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { readCapacityForecast } from '../src/core/persistence/capacity-forecast.ts';
import { cachedCapacitySnapshot } from '../src/core/persistence/capacity-snapshot.ts';
import { randomUUID } from 'node:crypto';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { claimHousekeepingTurn, completeHousekeepingTurn, HOUSEKEEPING_TURN_OP } from '../src/core/persistence/housekeeping-turn.ts';
import { markOneShotCommand } from '../src/core/persistence/claim-phase.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { readWriteSwitchSnapshot, resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { commandStartupConfig, keepCommandStartupConfig, requestConfigValue, withRequestConfigSnapshot } from '../src/core/config-snapshot.ts';
import { mergeDbPlaneConfig } from '../src/cli/db-plane-config.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalWriter, registerLocalWriter, revokeLocalWriter, verifyLocalWriter, withRequestIdentityMemo } from '../src/core/persistence/identity.ts';
import { freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';

async function recordStatements<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<{ result: T; waves: number; statements: string[] }> {
  let inFlight = 0;
  let waves = 0;
  const statements: string[] = [];
  const target = engine as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = target.executeRaw!;
  target.executeRaw = function (this: unknown, ...args: unknown[]) {
    if (inFlight === 0) waves++;
    inFlight++;
    statements.push(String(args[0]).replace(/\s+/g, ' ').trim());
    return original.apply(this, args).finally(() => { inFlight--; });
  };
  try {
    return { result: await fn(), waves, statements };
  } finally {
    delete target.executeRaw;
  }
}

const configReads = (statements: string[]) => statements.filter(s => /FROM config\b/.test(s));

type Gate = { upkeepAllowed(): Promise<boolean>; sweepAllowed(direct: boolean): Promise<boolean>; housekeepingTurn: boolean;
  settleTurn(): void; turnDone?: Promise<void>; stopping: boolean };
const turnState = async (engine: BrainEngine, hostId: string) => (await engine.executeRaw<{ state: string[] }>(
  'SELECT completed_keys AS state FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [HOUSEKEEPING_TURN_OP, hostId]))[0]?.state;
const oneShotConsumer = (engine: BrainEngine, hostId: string, waiting: () => boolean) => new PersistenceConsumer(engine, { engine: engine.kind } as never,
  async () => { throw new Error('unused'); }, { hostId, oneShot: { waiting } }) as unknown as Gate;
const turns = async (engine: BrainEngine, hostId: string) => (await engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [HOUSEKEEPING_TURN_OP, hostId]))[0]!.n;

describe('GBRA-156 command startup config', () => {
  test('a seeded request snapshot answers from the seed without a table read', async () => {
    let bulk = 0;
    const engine = { getConfig: async () => 'live', getAllConfig: async () => { bulk++; return { k: 'live' }; } };
    const value = await withRequestConfigSnapshot(engine, () => requestConfigValue(engine, 'k'), { k: 'seeded' });
    expect(value).toBe('seeded');
    expect(bulk).toBe(0);
  });

  test('the startup read is handed over once, and not when it is older than its window', () => {
    const engine = {};
    keepCommandStartupConfig(engine, { k: 'v' }, 1_000);
    expect(commandStartupConfig(engine, 2_000)).toEqual({ k: 'v' });
    expect(commandStartupConfig(engine, 2_000)).toBeUndefined();
    keepCommandStartupConfig(engine, { k: 'v' }, 1_000);
    expect(commandStartupConfig(engine, 7_000)).toBeUndefined();
  });
});

for (const kind of testBackends()) {
  describe('GBRA-156 write round trips (' + kind + ')', () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    beforeAll(async () => { factory = await freshBrainFactory(kind, process.env.DATABASE_URL); }, 120_000);
    afterAll(async () => { await factory?.dispose(); });

    test('the receipt capacity snapshot reads its config keys in one statement beside the journal limits', async () => {
      const engine = await factory.fresh();
      const requests = await requestFixture(engine);
      await requests.admit('gbra156-capacity');
      await engine.executeRaw(`INSERT INTO config(key,value) VALUES ('persistence.capacity.warn_days','11'),('persistence.capacity.fail_days','3'),
        ('persistence.receipt_retention_days','9'),('persistence.capacity.background_pause_pct','60')
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
      const { result, statements } = await recordStatements(engine, () => cachedCapacitySnapshot(engine, Date.now() + 1e9));
      expect(configReads(statements)).toHaveLength(2);
      expect(result.status).toBe('ok');
      expect(result.pause_pct).toBe(60);
      const forecast = await readCapacityForecast(engine, { light: true });
      expect(forecast.thresholds).toMatchObject({ warn_days: 11, fail_days: 3 });
      expect(forecast.retention_days).toBe(9);
    }, 120_000);

    test('the connect-time config merge seeds the write switches and hands its read to the command', async () => {
      const engine = await factory.fresh();
      resetWriteSwitches();
      await mergeDbPlaneConfig(engine, { engine: engine.kind } as never, new WeakMap());
      const { statements } = await recordStatements(engine, () => readWriteSwitchSnapshot(engine));
      expect(statements).toEqual([]);
      expect(commandStartupConfig(engine)).toBeDefined();
    }, 120_000);

    test('the host housekeeping turn is granted once per interval per host', async () => {
      const engine = await factory.fresh();
      const host = randomUUID();
      expect(await claimHousekeepingTurn(engine, host, 60_000)).toBe(true);
      expect(await claimHousekeepingTurn(engine, host, 60_000)).toBe(false);
      expect(await claimHousekeepingTurn(engine, randomUUID(), 60_000)).toBe(true);
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '2 minutes' WHERE op=$1 AND fingerprint=$2", [HOUSEKEEPING_TURN_OP, host]);
      expect(await claimHousekeepingTurn(engine, host, 60_000)).toBe(true);
    }, 120_000);

    test('a finished turn holds the host for the interval, judged from when it finished', async () => {
      const engine = await factory.fresh();
      const host = randomUUID();
      expect(await claimHousekeepingTurn(engine, host, 60_000)).toBe(true);
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '2 minutes' WHERE op=$1 AND fingerprint=$2", [HOUSEKEEPING_TURN_OP, host]);
      await completeHousekeepingTurn(engine, host);
      expect(await turnState(engine, host)).toEqual(['done']);
      expect(await claimHousekeepingTurn(engine, host, 600_000)).toBe(false);
      expect(await claimHousekeepingTurn(engine, host, 0)).toBe(true);
    }, 120_000);

    test('a turn cut short is not counted as done: the next process takes it once the lease runs out, not after the interval', async () => {
      const engine = await factory.fresh();
      const host = randomUUID();
      expect(await claimHousekeepingTurn(engine, host, 600_000)).toBe(true);
      expect(await claimHousekeepingTurn(engine, host, 600_000)).toBe(false);
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '2 minutes' WHERE op=$1 AND fingerprint=$2", [HOUSEKEEPING_TURN_OP, host]);
      expect(await claimHousekeepingTurn(engine, host, 600_000)).toBe(true);
    }, 120_000);

    test('a consumer marks its turn done when its upkeep settles, and leaves it leased when a stop aborted that upkeep', async () => {
      const engine = await factory.fresh();
      for (const aborted of [false, true]) {
        const host = randomUUID();
        const consumer = oneShotConsumer(engine, host, () => false);
        expect(await consumer.upkeepAllowed()).toBe(true);
        consumer.stopping = aborted;
        consumer.settleTurn();
        await consumer.turnDone;
        expect(await turnState(engine, host)).toEqual([aborted ? 'leased' : 'done']);
      }
    }, 120_000);

    test('no housekeeping turn while a resident full consumer of the host is live', async () => {
      const engine = await factory.fresh();
      const host = randomUUID();
      await engine.executeRaw(`INSERT INTO persistence_consumers (host_id,pid,nonce,kind,mode,host_json_path,persistence_home,version)
        VALUES ($1::uuid,4242,'n','serve','full','/h.json','/home','0')`, [host]);
      expect(await claimHousekeepingTurn(engine, host, 60_000)).toBe(false);
      await engine.executeRaw("UPDATE persistence_consumers SET renewed_at=now()-interval '10 minutes' WHERE host_id=$1::uuid", [host]);
      expect(await claimHousekeepingTurn(engine, host, 60_000)).toBe(true);
    }, 120_000);

    test('a one-shot consumer keeps upkeep off while a write is awaited, and the direct claim of its own write sweeps nothing', async () => {
      const engine = await factory.fresh();
      const host = randomUUID();
      const consumer = oneShotConsumer(engine, host, () => true);
      expect(await consumer.upkeepAllowed()).toBe(false);
      expect(await consumer.sweepAllowed(true)).toBe(false);
      expect(await consumer.sweepAllowed(false)).toBe(true);
      expect(await turns(engine, host)).toBe(0);
    }, 120_000);

    test('after the write, one one-shot consumer per host and interval takes the housekeeping turn', async () => {
      const engine = await factory.fresh();
      const host = randomUUID();
      const first = oneShotConsumer(engine, host, () => false);
      expect(await first.upkeepAllowed()).toBe(true);
      expect(await first.sweepAllowed(false)).toBe(true);
      expect(await turns(engine, host)).toBe(1);
      const second = oneShotConsumer(engine, host, () => false);
      expect(await second.upkeepAllowed()).toBe(false);
      expect(await second.sweepAllowed(false)).toBe(false);
      first.housekeepingTurn = false;
      expect(await first.upkeepAllowed()).toBe(false);
      await withEnv({ GBRAIN_ONESHOT_HOUSEKEEPING_INTERVAL_MS: '0' }, async () => {
        expect(await oneShotConsumer(engine, host, () => false).upkeepAllowed()).toBe(true);
      });
      const resident = new PersistenceConsumer(engine, { engine: engine.kind } as never, async () => { throw new Error('unused'); }, { hostId: host }) as unknown as Gate;
      expect(await resident.upkeepAllowed()).toBe(true);
      expect(await resident.sweepAllowed(true)).toBe(true);
    }, 120_000);

    test('only a one-shot command starts its consumer with the housekeeping ration', async () => {
      for (const oneShot of [true, false]) {
        const engine = await factory.fresh();
        markOneShotCommand(oneShot);
        try {
          const consumer = startPersistenceConsumer(engine, { engine: engine.kind } as never) as unknown as { opts: { oneShot?: unknown } };
          expect(consumer.opts.oneShot !== undefined).toBe(oneShot);
        } finally {
          markOneShotCommand(false);
          await disposePersistenceConsumer(engine);
        }
      }
    }, 120_000);

    const identity = (statements: string[]) => ({
      brain: statements.filter(s => s.startsWith('SELECT brain_id FROM persistence_brain')).length,
      writer: statements.filter(s => s.startsWith('SELECT lane,credential_hash,grant_ceiling,revoked_at FROM persistence_local_writers')).length });

    test('one request reads the brain identity and verifies a local writer once for its pre-submission checks', async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbra156-identity-')) }, async () => {
        await registerLocalWriter(engine, 'cli');
        const { statements } = await recordStatements(engine, () => withRequestIdentityMemo(async () => {
          const local = await readLocalWriter(engine, 'cli');
          await verifyLocalWriter(engine, await readLocalWriter(engine, 'cli'));
          await verifyLocalWriter(engine, local);
        }));
        expect(identity(statements)).toEqual({ brain: 1, writer: 1 });
        const locked = await recordStatements(engine, () => withRequestIdentityMemo(async () => {
          const local = await readLocalWriter(engine, 'cli');
          await verifyLocalWriter(engine, local, true);
        }));
        expect(locked.statements.filter(s => /persistence_local_writers WHERE id=\$1::uuid FOR SHARE$/.test(s))).toHaveLength(1);
      });
    }, 120_000);

    test('a credential revoked between two requests in the same process is refused on the second', async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbra156-revoke-')) }, async () => {
        const local = await registerLocalWriter(engine, 'cli');
        expect((await withRequestIdentityMemo(() => readLocalWriter(engine, 'cli'))).id).toBe(local.id);
        expect(await revokeLocalWriter(engine, local.id)).toBe(true);
        await expect(withRequestIdentityMemo(() => readLocalWriter(engine, 'cli'))).rejects.toMatchObject({ code: 'permission_denied' });
      });
    }, 120_000);

    test('a revocation inside a request is seen by that request\'s later checks', async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbra156-revoke-in-')) }, async () => {
        const local = await registerLocalWriter(engine, 'cli');
        await withRequestIdentityMemo(async () => {
          await verifyLocalWriter(engine, local);
          await revokeLocalWriter(engine, local.id);
          await expect(verifyLocalWriter(engine, local)).rejects.toMatchObject({ code: 'permission_denied' });
        });
      });
    }, 120_000);

    test('an unreadable retention setting still falls back to the default, and bad thresholds to theirs', async () => {
      const engine = await factory.fresh();
      await engine.executeRaw(`INSERT INTO config(key,value) VALUES ('persistence.capacity.warn_days','-1'),('persistence.receipt_retention_days','soon')
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
      const forecast = await readCapacityForecast(engine, { light: true });
      expect(forecast.thresholds.warn_days).toBe(30);
      expect(forecast.retention_days).toBe(30);
    }, 120_000);
  });
}
