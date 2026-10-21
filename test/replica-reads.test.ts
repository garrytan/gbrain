/**
 * Read-replica routing, no database: which operations may read the replica
 * (src/core/replica-reads.ts), which engine reads go there and when they fall
 * back to the primary (src/core/postgres-engine/replica-route.ts), and that a
 * Postgres engine with no replica configured never builds or touches one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig, saveConfig, toEngineConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { ConnectionManager } from '../src/core/connection-manager.ts';
import { operationsByName } from '../src/core/operations.ts';
import {
  REPLICA_READ_YOUR_WRITES_MS,
  _resetReplicaReadsForTests,
  isReplicaEligible,
  replicaReadsAllowed,
  withOperationReadRouting,
} from '../src/core/replica-reads.ts';
import { REPLICA_COOLDOWN_MS, routeRead } from '../src/core/postgres-engine/replica-route.ts';
import { makeFakeSql, type Responder } from './helpers/fake-postgres-sql.ts';

const READ_OP = { scope: 'read', mutating: false } as const;
const WRITE_OP = { scope: 'write', mutating: true } as const;
const ADMIN_READ_OP = { scope: 'admin', mutating: false } as const;

afterEach(() => _resetReplicaReadsForTests());

function connError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

/** A Postgres engine over a fake primary, with a fake replica when `replica` is given. */
function engineWith(replica?: Responder) {
  const primary = makeFakeSql();
  const replicaSql = replica ? makeFakeSql(replica) : null;
  const downs: number[] = [];
  const engine = new PostgresEngine() as any;
  engine._sql = primary.sql;
  engine._connectionStyle = 'instance';
  let down = false;
  engine.connectionManager = replicaSql ? {
    replicaUrl: () => 'postgresql://replica.example:5432/brain',
    replica: () => (down ? null : replicaSql.sql),
    markReplicaDown: (ms: number) => { down = true; downs.push(ms); },
  } : null;
  return { engine, primary, replica: replicaSql, downs };
}

describe('operation classification', () => {
  test('reuses the cli-socket read test: read scope and not mutating', () => {
    expect(isReplicaEligible(operationsByName.search)).toBe(true);
    expect(isReplicaEligible(operationsByName.query)).toBe(true);
    expect(isReplicaEligible(operationsByName.get_page)).toBe(true);
    expect(isReplicaEligible(operationsByName.recall)).toBe(true);
    expect(isReplicaEligible(operationsByName.remember)).toBe(false);
    expect(isReplicaEligible(operationsByName.put_page)).toBe(false);
    expect(isReplicaEligible(operationsByName.think)).toBe(false);
    expect(isReplicaEligible(ADMIN_READ_OP)).toBe(false);
  });

  test('only an eligible read runs in the replica scope', async () => {
    expect(replicaReadsAllowed()).toBe(false);
    expect(await withOperationReadRouting(READ_OP, async () => replicaReadsAllowed())).toBe(true);
    expect(await withOperationReadRouting(ADMIN_READ_OP, async () => replicaReadsAllowed())).toBe(false);
    expect(replicaReadsAllowed()).toBe(false);
  });

  test('an op dispatched inside a read does not inherit its scope', async () => {
    const inner = await withOperationReadRouting(READ_OP, () => withOperationReadRouting(WRITE_OP, async () => replicaReadsAllowed()));
    expect(inner).toBe(false);
  });

  test('a write pins later reads in this process to the primary for the read-your-writes window', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    await withOperationReadRouting(WRITE_OP, async () => undefined, now);
    expect(await withOperationReadRouting(READ_OP, async () => replicaReadsAllowed(), now)).toBe(false);
    clock += REPLICA_READ_YOUR_WRITES_MS - 1;
    expect(await withOperationReadRouting(READ_OP, async () => replicaReadsAllowed(), now)).toBe(false);
    clock += 1;
    expect(await withOperationReadRouting(READ_OP, async () => replicaReadsAllowed(), now)).toBe(true);
  });

  test('a failed write still pins reads (it may have committed before failing)', async () => {
    const now = () => 5_000_000;
    await expect(withOperationReadRouting(WRITE_OP, async () => { throw new Error('boom'); }, now)).rejects.toThrow('boom');
    expect(await withOperationReadRouting(READ_OP, async () => replicaReadsAllowed(), now)).toBe(false);
  });

  test('a non-mutating admin op does not pin reads', async () => {
    const now = () => 7_000_000;
    await withOperationReadRouting(ADMIN_READ_OP, async () => undefined, now);
    expect(await withOperationReadRouting(READ_OP, async () => replicaReadsAllowed(), now)).toBe(true);
  });
});

describe('routeRead', () => {
  const primary = { name: 'primary' } as any;
  const replica = { name: 'replica' } as any;
  const source = (downs: number[] = []) => ({ replica: () => replica, markReplicaDown: (ms: number) => { downs.push(ms); } });
  const pick = async (conn: { name: string }) => conn.name;

  test('no replica configured: the primary, in or out of a read scope', async () => {
    expect(await routeRead(() => primary, null, false, pick)).toBe('primary');
    expect(await withOperationReadRouting(READ_OP, () => routeRead(() => primary, null, false, pick))).toBe('primary');
  });

  test('a replica is used only inside a read scope and outside a transaction', async () => {
    expect(await routeRead(() => primary, source(), false, pick)).toBe('primary');
    expect(await withOperationReadRouting(READ_OP, () => routeRead(() => primary, source(), false, pick))).toBe('replica');
    expect(await withOperationReadRouting(READ_OP, () => routeRead(() => primary, source(), true, pick))).toBe('primary');
  });

  test('a replica connection failure retries on the primary and starts the cooldown', async () => {
    const downs: number[] = [];
    const read = (conn: { name: string }) => conn === replica ? Promise.reject(connError('ECONNREFUSED')) : pick(conn);
    expect(await withOperationReadRouting(READ_OP, () => routeRead(() => primary, source(downs), false, read))).toBe('primary');
    expect(downs).toEqual([REPLICA_COOLDOWN_MS]);
  });

  test('a recovery conflict retries on the primary without a cooldown', async () => {
    const downs: number[] = [];
    const read = (conn: { name: string }) => conn === replica ? Promise.reject(connError('40001')) : pick(conn);
    expect(await withOperationReadRouting(READ_OP, () => routeRead(() => primary, source(downs), false, read))).toBe('primary');
    expect(downs).toEqual([]);
  });

  test('a query error is the caller\'s, not the replica\'s: it is thrown, not retried', async () => {
    let primaryRuns = 0;
    const read = async (conn: { name: string }) => {
      if (conn === primary) primaryRuns++;
      throw connError('42601');
    };
    await expect(withOperationReadRouting(READ_OP, () => routeRead(() => primary, source(), false, read))).rejects.toThrow('connect 42601');
    expect(primaryRuns).toBe(0);
  });
});

describe('PostgresEngine read seams', () => {
  test('without a replica every read runs on the primary pool', async () => {
    const { engine, primary } = engineWith();
    await withOperationReadRouting(READ_OP, async () => {
      await engine.getAllSlugs();
      await engine.listFactsSince('default', new Date(0));
    });
    expect(primary.statements().length).toBeGreaterThanOrEqual(2);
    expect(primary.statements().every(s => s.lane === 'pool')).toBe(true);
  });

  test('with a replica, scoped and unscoped reads inside a read op go to the replica', async () => {
    const { engine, primary, replica } = engineWith(() => undefined);
    await withOperationReadRouting(READ_OP, async () => {
      await engine.getAllSlugs();
      await engine.listFactsSince('default', new Date(0));
      await engine.getTags('people/alice-example');
    });
    expect(primary.statements()).toEqual([]);
    expect(replica!.statements().length).toBeGreaterThanOrEqual(3);
  });

  test('the same reads outside a read op, and inside a write op, stay on the primary', async () => {
    const { engine, primary, replica } = engineWith(() => undefined);
    await engine.getAllSlugs();
    await withOperationReadRouting(WRITE_OP, async () => {
      await engine.getTags('people/alice-example');
      await engine.executeRaw('UPDATE pages SET title = title WHERE false');
    });
    expect(replica!.statements()).toEqual([]);
    expect(primary.statements().length).toBeGreaterThanOrEqual(3);
  });

  test('writes inside a read op still go to the primary', async () => {
    const { engine, primary, replica } = engineWith(() => undefined);
    await withOperationReadRouting(READ_OP, () => engine.executeRaw('INSERT INTO search_telemetry DEFAULT VALUES'));
    expect(replica!.statements()).toEqual([]);
    expect(primary.statements().map(s => s.text)).toEqual(['INSERT INTO search_telemetry DEFAULT VALUES']);
  });

  test('a read inside a transaction stays on the transaction, not the replica', async () => {
    const { engine, primary, replica } = engineWith(() => undefined);
    await withOperationReadRouting(READ_OP, () => engine.transaction((tx: any) => tx.getAllSlugs()));
    expect(replica!.statements()).toEqual([]);
    expect(primary.statements().every(s => s.lane === 'tx')).toBe(true);
  });

  test('an unreachable replica answers from the primary and is skipped during the cooldown', async () => {
    const { engine, primary, replica, downs } = engineWith(() => connError('ECONNREFUSED'));
    await withOperationReadRouting(READ_OP, async () => {
      await engine.getAllSlugs();
      await engine.getTags('people/alice-example');
    });
    expect(downs).toEqual([REPLICA_COOLDOWN_MS]);
    expect(replica!.statements()).toHaveLength(1);
    expect(primary.statements().length).toBeGreaterThanOrEqual(2);
  });
});

describe('replica_database_url config', () => {
  const FILE_PRIMARY = 'postgresql://u:p@file-primary.example:5432/brain';
  const FILE_REPLICA = 'postgresql://u:p@file-replica.example:5432/brain';
  const ENV_REPLICA = 'postgresql://u:p@env-replica.example:5432/brain';
  const NO_DB_ENV = { GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined, GBRAIN_REPLICA_DATABASE_URL: undefined };

  async function withHome(fileConfig: Parameters<typeof saveConfig>[0], run: (home: string) => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-replica-config-'));
    try {
      await withEnv({ GBRAIN_HOME: home, ...NO_DB_ENV }, () => saveConfig(fileConfig));
      await run(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test('unset: the engine config carries no replica key', async () => {
    await withHome({ engine: 'postgres', database_url: FILE_PRIMARY }, home => withEnv({ GBRAIN_HOME: home, ...NO_DB_ENV }, () => {
      const engineConfig = toEngineConfig(loadConfig()!);
      expect('replica_database_url' in engineConfig).toBe(false);
    }));
  });

  test('the file replica reaches the engine config with the file primary', async () => {
    await withHome({ engine: 'postgres', database_url: FILE_PRIMARY, replica_database_url: FILE_REPLICA }, home => withEnv({ GBRAIN_HOME: home, ...NO_DB_ENV }, () => {
      expect(toEngineConfig(loadConfig()!).replica_database_url).toBe(FILE_REPLICA);
    }));
  });

  test('GBRAIN_REPLICA_DATABASE_URL overrides the file replica', async () => {
    await withHome({ engine: 'postgres', database_url: FILE_PRIMARY, replica_database_url: FILE_REPLICA }, home =>
      withEnv({ GBRAIN_HOME: home, ...NO_DB_ENV, GBRAIN_REPLICA_DATABASE_URL: ENV_REPLICA }, () => {
        expect(loadConfig()!.replica_database_url).toBe(ENV_REPLICA);
      }));
  });

  test('an env primary drops the file replica, which belongs to the file primary', async () => {
    await withHome({ engine: 'postgres', database_url: FILE_PRIMARY, replica_database_url: FILE_REPLICA }, home =>
      withEnv({ GBRAIN_HOME: home, ...NO_DB_ENV, GBRAIN_DATABASE_URL: 'postgresql://u:p@other.example:5432/brain' }, () => {
        expect(loadConfig()!.replica_database_url).toBeUndefined();
      }));
  });
});

describe('ConnectionManager replica pool', () => {
  const PRIMARY = 'postgresql://user:secret@primary.example:5432/brain';
  const REPLICA = 'postgresql://user:secret@replica.example:5432/brain';

  test('no replica URL: no pool and no replica_host', () => {
    const manager = new ConnectionManager({ url: PRIMARY });
    expect(manager.replicaUrl()).toBeNull();
    expect(manager.replica()).toBeNull();
    expect(manager.describeMode().replica_host).toBeUndefined();
  });

  test('a replica URL builds one lazy pool, shared with child managers, and reports the host without credentials', async () => {
    const manager = new ConnectionManager({ url: PRIMARY, replicaUrl: REPLICA });
    const child = new ConnectionManager({ url: PRIMARY, parent: manager });
    const pool = manager.replica();
    expect(pool).not.toBeNull();
    expect(manager.replica()).toBe(pool);
    expect(child.replica()).toBe(pool);
    expect(child.replicaUrl()).toBe(REPLICA);
    expect(manager.describeMode().replica_host).toBe('replica.example:5432');
    await manager.disconnect();
  });

  test('markReplicaDown hides the replica until the cooldown ends, from the child too', async () => {
    const manager = new ConnectionManager({ url: PRIMARY, replicaUrl: REPLICA });
    const child = new ConnectionManager({ url: PRIMARY, parent: manager });
    child.markReplicaDown(1_000, 10_000);
    expect(manager.replica(10_500)).toBeNull();
    expect(child.replica(10_999)).toBeNull();
    expect(manager.replica(11_000)).not.toBeNull();
    await manager.disconnect();
  });
});
