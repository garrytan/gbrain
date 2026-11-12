/**
 * GBRA-467 on PGLite: every path that runs schema migrations takes one lock, so two runners in one process
 * (initSchema() and a direct runMigrations(), as `gbrain apply-migrations` calls it) run a pending migration
 * once. PGLite's datastore lock admits a single process, so the lock is in-process here; the Postgres arms,
 * across connections and through a transaction-mode PgBouncer, are test/e2e/schema-migration-lock-postgres.test.ts.
 *
 * The probe migration is not idempotent (its SQL adds a column without IF NOT EXISTS) and its handler records
 * each run and then sleeps, so the second runner starts while the first is inside the step.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { withEnv } from './helpers/with-env.ts';

const PROBE_VERSION = LATEST_VERSION + 1;
let engine: PGLiteEngine;

// Without the CI schema snapshot: an engine opened from it skips initSchema(), and this file needs the real one.
beforeAll(() => withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}), 120_000);

afterAll(async () => { await engine.disconnect(); });

type Runner = () => Promise<unknown>;
const explicit: Runner = () => runMigrations(engine);
const processStart: Runner = () => engine.initSchema();

describe('GBRA-467 schema migrations run once under concurrent runners (PGLite)', () => {
  for (const [label, first, second] of [
    ['initSchema while a direct runMigrations is inside a step', explicit, processStart],
    ['a direct runMigrations while initSchema is inside a step', processStart, explicit],
    ['two direct runMigrations calls', explicit, explicit],
  ] as Array<[string, Runner, Runner]>) {
    test(label, async () => {
      await engine.executeRaw('DROP TABLE IF EXISTS schema_lock_probe');
      await engine.executeRaw('CREATE TABLE schema_lock_probe (step TEXT NOT NULL)');
      await engine.setConfig('version', String(LATEST_VERSION));
      let entered!: () => void;
      const inside = new Promise<void>(resolve => { entered = resolve; });
      MIGRATIONS.push({
        version: PROBE_VERSION,
        name: 'schema_lock_probe',
        sql: "INSERT INTO schema_lock_probe (step) VALUES ('sql'); ALTER TABLE schema_lock_probe ADD COLUMN applied INTEGER",
        handler: async (e) => {
          entered();
          await e.executeRaw("INSERT INTO schema_lock_probe (step) VALUES ('handler')");
          await Bun.sleep(1_000);
        },
        idempotent: false,
      });
      try {
        const firstRun = first();
        await inside;
        const results = await Promise.allSettled([firstRun, second()]);
        expect(results.map(r => r.status === 'fulfilled' ? 'ok' : (r.reason as Error).message)).toEqual(['ok', 'ok']);
        expect(await engine.executeRaw('SELECT step, count(*)::int AS n FROM schema_lock_probe GROUP BY step ORDER BY step'))
          .toEqual([{ step: 'handler', n: 1 }, { step: 'sql', n: 1 }]);
        expect(await engine.getConfig('version')).toBe(String(PROBE_VERSION));
      } finally {
        MIGRATIONS.splice(MIGRATIONS.findIndex(m => m.version === PROBE_VERSION), 1);
        await engine.setConfig('version', String(LATEST_VERSION));
      }
    }, 60_000);
  }
});
