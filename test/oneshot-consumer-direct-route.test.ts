/**
 * A one-shot command that starts a persistence consumer (`gbrain repair <kind> --apply`, `gbrain cli`, ...) takes the
 * direct route when one is configured. Since the direct pool follows the command (#7312), a one-shot process routed
 * nothing direct until it took a lease, so a consumer it started ran its claims and scans through the transaction-mode
 * pooler even with GBRAIN_DIRECT_DATABASE_URL set, and printed the `reason=transaction_pooler` line. Starting a consumer
 * now makes the process short-lived (one direct connection), as taking a lease does.
 *
 * And a write admission that database contention kept blocking (`storage_error`, detail `database_contention`) is
 * contention, not a storage fault: the item classifier names it `database_contention`, so a repair apply stops with
 * the resume command instead of failing the item, and the error envelope reads retryable.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { codeRetryable } from '../src/core/error-catalogue.ts';
import { directPoolProfile, setDirectPoolProfile } from '../src/core/direct-pool-profile.ts';
import { classifyItemFailure } from '../src/core/item-failure.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { retryWriteAdmission } from '../src/core/persistence/admission-retry.ts';
import { consumerConnectionRoute, consumerStatementEngine } from '../src/core/persistence/consumer-lane.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const ROUTE = { GBRAIN_DIRECT_POOL_SIZE: undefined, GBRAIN_DIRECT_POOL_BY_COMMAND: undefined, GBRAIN_DISABLE_DIRECT_POOL: undefined, GBRAIN_CONSUMER_DIRECT_LANE: undefined };

afterEach(() => setDirectPoolProfile('resident'));

describe('a one-shot command that starts a persistence consumer', () => {
  let pglite: PGLiteEngine | null = null;
  beforeAll(async () => {
    if (!testBackends().includes('pglite')) return;
    pglite = new PGLiteEngine();
    await pglite.connect({ database_url: '' });
    await pglite.initSchema();
  }, 60_000);
  afterAll(async () => { if (pglite) { await disposePersistenceConsumer(pglite); await pglite.disconnect(); } });

  test('becomes short-lived', async () => {
    if (!pglite) return;
    setDirectPoolProfile('one_shot');
    startPersistenceConsumer(pglite, { engine: 'pglite', embedding_disabled: true } as never);
    expect(directPoolProfile()).toBe('short_lived');
  });

  if (testBackends().includes('postgres')) {
    test('postgres with a transaction-pooler URL and GBRAIN_DIRECT_DATABASE_URL: the consumer runs on the direct route', async () => {
      const brain = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      const engine = new PostgresEngine();
      const pooler = new URL(brain.databaseUrl);
      pooler.searchParams.set('prepare', 'false');
      const lines: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      try {
        await withEnv({ ...ROUTE, GBRAIN_DIRECT_DATABASE_URL: brain.databaseUrl }, async () => {
          setDirectPoolProfile('one_shot');
          await engine.connect({ database_url: pooler.toString(), poolSize: 2 });
          expect(consumerConnectionRoute(engine)).toMatchObject({ lane: 'pool', pooler_mode: 'transaction' });
          process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
          try { startPersistenceConsumer(engine, { engine: 'postgres', embedding_disabled: true } as never); }
          finally { process.stderr.write = write; }
          expect(consumerConnectionRoute(engine)).toMatchObject({ lane: 'direct', pooler_mode: 'transaction' });
          expect(lines.join('')).not.toContain('reason=transaction_pooler');
          const timeout = await consumerStatementEngine(engine).executeRaw<{ statement_timeout: string }>('SHOW statement_timeout');
          expect(timeout[0]!.statement_timeout).toBe('30min');
        });
      } finally {
        process.stderr.write = write;
        await disposePersistenceConsumer(engine);
        await engine.disconnect();
        await brain.close();
      }
    }, 120_000);
  }
});

describe('write admission blocked by database contention', () => {
  async function admissionContention(): Promise<OperationError> {
    const error = await retryWriteAdmission('req-example', async () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); }, 30)
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OperationError);
    return error as OperationError;
  }

  test('is classified as database_contention for the run, not a storage fault', async () => {
    const error = await admissionContention();
    expect(error).toMatchObject({ code: 'storage_error', detail: 'database_contention' });
    expect(classifyItemFailure(error)).toMatchObject({ code: 'database_contention', scope: 'run', class: 'transient' });
  });

  test('reads retryable', async () => {
    const error = await admissionContention();
    expect(error.reason).toBe('database_contention');
    expect(codeRetryable(error.code, error.reason)).toBe(true);
    expect(codeRetryable('storage_error')).toBe(false);
  });
});
