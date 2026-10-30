/**
 * The direct (session) pool follows the command (maintainer-approved, 2026-10-21). Daemons keep the 3-connection pool; a short-lived
 * command that owns a consumer or takes a lease gets one connection; a one-shot command that takes no lease routes
 * nothing through it until it takes a lease, while schema DDL keeps the direct route for its session advisory lock and
 * 30-minute statement timeout. `GBRAIN_DIRECT_POOL_BY_COMMAND=0` restores the earlier behavior. Pure resolution, then
 * real PGLite and Postgres (when DATABASE_URL is set) with the direct route pointed at the test database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { ConnectionManager, resolveDirectPoolSize } from '../src/core/connection-manager.ts';
import { directPoolProfile, directPoolProfileForCommand, setDirectPoolProfile } from '../src/core/direct-pool-profile.ts';
import { OWNER_COMMANDS } from '../src/core/persistence/claim-phase.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const DIRECT_STATEMENT_TIMEOUT = '30min';
const ROUTE = { GBRAIN_DIRECT_POOL_SIZE: undefined, GBRAIN_DIRECT_POOL_BY_COMMAND: undefined, GBRAIN_DISABLE_DIRECT_POOL: undefined };

let pglite: PGLiteEngine | null = null;

beforeAll(async () => {
  if (!testBackends().includes('pglite')) return;
  pglite = new PGLiteEngine();
  await pglite.connect({ database_url: '' });
  await pglite.initSchema();
}, 60_000);

afterAll(async () => { await pglite?.disconnect(); });

afterEach(() => setDirectPoolProfile('resident'));

describe('directPoolProfileForCommand', () => {
  test('daemons are resident, exiting claim owners and route diagnostics short-lived, everything else one-shot', () => {
    for (const command of ['serve', 'jobs', 'autopilot']) expect(directPoolProfileForCommand(command, [])).toBe('resident');
    expect(directPoolProfileForCommand('sync', ['--watch'])).toBe('resident');
    for (const command of ['sync', 'put', 'import', 'dream', 'cycle', 'sources', 'mcp', 'migrate-graduation', 'doctor', 'engine'])
      expect(directPoolProfileForCommand(command, [])).toBe('short_lived');
    for (const command of ['search', 'query', 'get', 'capture', 'embed', 'extract', 'apply-migrations'])
      expect(directPoolProfileForCommand(command, [])).toBe('one_shot');
  });

  test('#7599: a read-only stdio serve is one-shot; a read-write serve stays resident', () => {
    expect(directPoolProfileForCommand('serve', ['--access', 'read-only'])).toBe('one_shot');
    expect(directPoolProfileForCommand('serve', ['--surface', 'full', '--access', 'read-only'])).toBe('one_shot');
    expect(directPoolProfileForCommand('serve', ['--access=read-only'])).toBe('one_shot');
    for (const args of [[], ['--access', 'full'], ['--access=full'], ['--surface', 'read-only'], ['--http', '--port', '8080']])
      expect(directPoolProfileForCommand('serve', args)).toBe('resident');
  });

  test('every claim owner keeps a direct route', () => {
    for (const command of OWNER_COMMANDS) expect(directPoolProfileForCommand(command, [])).not.toBe('one_shot');
  });
});

describe('direct pool size and routing by profile', () => {
  const manager = () => new ConnectionManager({ url: 'postgresql://u:p@localhost:5432/db', directUrl: 'postgresql://u:p@localhost:5433/db' });

  test('resident keeps 3 and the route; short-lived gets 1 and the route; one-shot gets no route', async () => {
    await withEnv(ROUTE, async () => {
      expect(resolveDirectPoolSize()).toBe(3);
      expect(manager().isDualPoolActive()).toBe(true);
      setDirectPoolProfile('short_lived');
      expect(resolveDirectPoolSize()).toBe(1);
      expect(manager().isDualPoolActive()).toBe(true);
      setDirectPoolProfile('one_shot');
      expect(manager().isDualPoolActive()).toBe(false);
      expect(manager().describeMode()).toMatchObject({ mode: 'single (one-shot command)', direct_profile: 'one_shot', direct_pool_size: 1 });
    });
  });

  test('GBRAIN_DIRECT_POOL_SIZE still sets the size, and the kill switch still wins', async () => {
    setDirectPoolProfile('short_lived');
    await withEnv({ ...ROUTE, GBRAIN_DIRECT_POOL_SIZE: '5' }, async () => { expect(resolveDirectPoolSize()).toBe(5); });
    await withEnv({ ...ROUTE, GBRAIN_DISABLE_DIRECT_POOL: '1' }, async () => {
      expect(manager().isDualPoolActive()).toBe(false);
      expect(manager().describeMode().mode).toBe('single (kill-switch)');
    });
  });

  test('GBRAIN_DIRECT_POOL_BY_COMMAND=0 restores the earlier behavior for every command', async () => {
    setDirectPoolProfile('one_shot');
    await withEnv({ ...ROUTE, GBRAIN_DIRECT_POOL_BY_COMMAND: '0' }, async () => {
      expect(directPoolProfile()).toBe('resident');
      expect(resolveDirectPoolSize()).toBe(3);
      expect(manager().isDualPoolActive()).toBe(true);
    });
  });
});

describe('real engines', () => {
  for (const backend of testBackends()) {
    test(`${backend}: a one-shot command routes nothing direct until it takes a lease; schema DDL keeps the direct route`, async () => {
      if (backend === 'pglite') {
        setDirectPoolProfile('one_shot');
        const handle = await tryAcquireDbLock(pglite!, 'test-direct-pool-profile', 5);
        expect(handle).not.toBeNull();
        expect(await handle!.refresh()).toBe(true);
        await handle!.release();
        expect(directPoolProfile()).toBe('one_shot');
        return;
      }
      const brain = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      const engine = new PostgresEngine();
      try {
        await withEnv({ ...ROUTE, GBRAIN_DIRECT_DATABASE_URL: brain.databaseUrl }, async () => {
          await engine.connect({ database_url: brain.databaseUrl, poolSize: 2 });
        });
        await withEnv(ROUTE, async () => {
          const directTimeout = async () => (await engine.executeRawDirect<{ statement_timeout: string }>('SHOW statement_timeout'))[0]!.statement_timeout;
          setDirectPoolProfile('one_shot');
          expect(await directTimeout()).not.toBe(DIRECT_STATEMENT_TIMEOUT);
          expect(await engine.transactionDirect(async tx => (await tx.executeRaw<{ statement_timeout: string }>('SHOW statement_timeout'))[0]!.statement_timeout)).not.toBe(DIRECT_STATEMENT_TIMEOUT);

          const ddl = await engine.connectionManager!.ddl();
          expect(ddl.options.max).toBe(1);
          expect((await ddl`SHOW statement_timeout`)[0]!.statement_timeout).toBe(DIRECT_STATEMENT_TIMEOUT);
          await engine.initSchema();

          const handle = await tryAcquireDbLock(engine, 'test-direct-pool-profile', 5);
          expect(handle).not.toBeNull();
          expect(directPoolProfile()).toBe('short_lived');
          expect(await directTimeout()).toBe(DIRECT_STATEMENT_TIMEOUT);
          expect(await handle!.refresh()).toBe(true);
          await handle!.release();
        });
      } finally {
        await engine.disconnect();
        await brain.close();
      }
    }, 120_000);
  }

  if (testBackends().includes('postgres')) {
    test('postgres: a resident process and the restore switch open the 3-connection direct pool', async () => {
      for (const env of [{}, { GBRAIN_DIRECT_POOL_BY_COMMAND: '0' }]) {
        const brain = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        const engine = new PostgresEngine();
        try {
          if ('GBRAIN_DIRECT_POOL_BY_COMMAND' in env) setDirectPoolProfile('one_shot');
          await withEnv({ ...ROUTE, ...env, GBRAIN_DIRECT_DATABASE_URL: brain.databaseUrl }, async () => {
            await engine.connect({ database_url: brain.databaseUrl, poolSize: 2 });
            expect((await engine.executeRawDirect<{ statement_timeout: string }>('SHOW statement_timeout'))[0]!.statement_timeout).toBe(DIRECT_STATEMENT_TIMEOUT);
            expect((await engine.connectionManager!.ddl()).options.max).toBe(3);
          });
        } finally {
          await engine.disconnect();
          await brain.close();
        }
      }
    }, 120_000);
  }
});
