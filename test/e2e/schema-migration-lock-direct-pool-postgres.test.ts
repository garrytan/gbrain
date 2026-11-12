/**
 * GBRA-467: a short-lived command with a direct URL gets a DDL pool of one connection, and the migrations run on
 * the statement pool, so that connection sits idle past its 20 s idle timeout. A schema lock held there dropped
 * mid-step and let a second runner start the same migration. The lock now lives in a transaction on a backend
 * reserved from the statement pool. Direct Postgres only: a direct URL is by definition not the pooler (the
 * pooled arms are in test/e2e/schema-migration-lock-postgres.test.ts). The probe is test/helpers/schema-lock-probe.ts.
 */
import { describe, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { directPoolProfile, setDirectPoolProfile } from '../../src/core/direct-pool-profile.ts';
import { expectProbeAppliedOnce, probeDatabase, processStart } from '../helpers/schema-lock-probe.ts';
import { withEnv } from '../helpers/with-env.ts';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('schema migration lock on a one-connection direct pool (E2E)', () => {
  test('a second initSchema start waits out a step longer than the direct pool idle timeout', async () => {
    const db = await probeDatabase(DATABASE_URL!);
    const a = new PostgresEngine();
    const b = new PostgresEngine();
    const profile = directPoolProfile();
    try {
      setDirectPoolProfile('short_lived');
      await withEnv({ GBRAIN_DIRECT_DATABASE_URL: db.url }, async () => {
        await a.connect({ database_url: db.url, poolSize: 4 });
        await b.connect({ database_url: db.url, poolSize: 4 });
      });
      await expectProbeAppliedOnce(a, b, processStart, processStart, 25_000);
    } finally {
      setDirectPoolProfile(profile);
      await a.disconnect();
      await b.disconnect();
      await db.drop();
    }
  }, 240_000);
});
