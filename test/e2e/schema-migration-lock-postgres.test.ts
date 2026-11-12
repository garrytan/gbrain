/**
 * GBRA-467: every path that runs schema migrations takes one lock, and it holds through a transaction-mode
 * PgBouncer (this file is in scripts/e2e-backend-matrix.txt, so it also runs through the pooler).
 *
 * Before the fix, `gbrain apply-migrations` called runMigrations() under its orchestration lease only, while every
 * process start ran initSchema(), which took session advisory lock 42, so the two never excluded each other, in
 * one process or two. Through a transaction-mode pooler lock 42 did not exclude two initSchema() callers either:
 * a session lock lands on whichever server connection the statement got, and a second caller given the same one
 * takes it again. The probe is test/helpers/schema-lock-probe.ts.
 */
import { describe, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { explicitRun, expectProbeAppliedOnce, probeDatabase, processStart, type Runner } from '../helpers/schema-lock-probe.ts';

const DATABASE_URL = process.env.DATABASE_URL;

const cases: Array<[string, Runner, Runner]> = [
  ['an initSchema start while apply-migrations is inside a step', explicitRun, processStart],
  ['apply-migrations while an initSchema start is inside a step', processStart, explicitRun],
  ['a second initSchema start while the first is inside a step', processStart, processStart],
];

describe.skipIf(!DATABASE_URL)(`schema migrations run once under concurrent runners [${process.env.GBRAIN_TEST_BACKEND ?? 'postgres'}] (E2E)`, () => {
  for (const [label, first, second] of cases) {
    test(label, async () => {
      const db = await probeDatabase(DATABASE_URL!);
      const a = new PostgresEngine();
      const b = new PostgresEngine();
      try {
        await a.connect({ database_url: db.url, poolSize: 4 });
        await b.connect({ database_url: db.url, poolSize: 4 });
        await expectProbeAppliedOnce(a, b, first, second, 3_000);
      } finally {
        await a.disconnect();
        await b.disconnect();
        await db.drop();
      }
    }, 240_000);
  }
});
