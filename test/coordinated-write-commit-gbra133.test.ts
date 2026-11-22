/**
 * GBRA-133 (PR 2b): a coordinated write's settings restore shares its transaction's COMMIT round trip on Postgres. The
 * restore is sent without waiting and left to the transaction (page-state/transactions.ts settleAtCommit): statements
 * after it in the transaction still see the restored settings, and a restore that fails rolls the transaction back and
 * rejects it with the restore's error. PGLite keeps awaiting the restore. Both backends; the Postgres arm runs in the E2E
 * lane through test/e2e/coordinated-write-commit-gbra133-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { freshBrainFactory } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const databaseUrl = process.env.DATABASE_URL;

for (const kind of testBackends()) {
  describe('GBRA-133 coordinated write restore at COMMIT (' + kind + ')', () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    beforeAll(async () => { factory = await freshBrainFactory(kind, databaseUrl); }, 120_000);
    afterAll(async () => { await factory?.dispose(); });

    test('the restore is left to COMMIT on Postgres and awaited on PGLite; later statements see the enclosing settings and the write commits', async () => {
      const engine = await factory.fresh();
      const seen = await engine.transaction(async tx => {
        await withCoordinatedWrite(tx, ['default'], () => tx.executeRaw("INSERT INTO config(key,value) VALUES('gbra133-commit','kept')"), TEST_WRITE_ATTRIBUTION);
        const left = (tx as { _commitChecks?: unknown[] })._commitChecks?.length;
        const [row] = await tx.executeRaw<{ sources: string | null }>("SELECT current_setting('gbrain.write_sources',true) AS sources");
        return { left, sources: row?.sources ?? '' };
      });
      expect(seen).toEqual({ left: kind === 'postgres' ? 1 : undefined, sources: '' });
      expect(await engine.getConfig('gbra133-commit')).toBe('kept');
    }, 60_000);

    test('a restore that fails rolls the transaction back and rejects with its error', async () => {
      const engine = await factory.fresh();
      const outcome = await engine.transaction(async tx => {
        const failing = Object.create(tx) as BrainEngine;
        // The restore is the typed `applyTransactionSettings` call; make it fail after a delay.
        failing.applyTransactionSettings = (async () => {
          await tx.executeRaw('SELECT 1/(SELECT 0 FROM pg_sleep(0.2)) AS never');
        }) as BrainEngine['applyTransactionSettings'];
        await withCoordinatedWrite(failing, ['default'], () => failing.executeRaw("INSERT INTO config(key,value) VALUES('gbra133-rolled-back','lost')"), TEST_WRITE_ATTRIBUTION);
      }).then(() => null, (error: { code?: string }) => error.code ?? String(error));
      expect(outcome).toBe('22012');
      expect(await engine.getConfig('gbra133-rolled-back')).toBeNull();
    }, 60_000);
  });
}
