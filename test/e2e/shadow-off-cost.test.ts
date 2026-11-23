/**
 * Postgres twin of test/shadow-off-cost.test.ts: shadow mode OFF costs nothing on a real Postgres brain opened through the
 * production factory. Same three pins (not a Proxy and the same kind of object as `new PostgresEngine()`; no shadow hook
 * module loaded in the process; the same SQL for the same writes) and the same shadow-ON controls, so read the header of
 * that file for the reasoning, including why "no per-write allocation" follows from the first two.
 *
 * The SQL is captured below the engine at the driver: the bytes the `postgres` driver writes to its socket
 * (test/helpers/shadow-off-cost-probe.ts decodes Parse, Bind and Query messages). Each arm runs in its own process against
 * its own freshly cloned database, so no arm sees the other's rows.
 * Needs DATABASE_URL (GBRAIN_TEST_ALLOW_DATABASE_URL=1 for a non-default test database); skips without it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { expectControlsAreCaught, expectNoHookModules, expectSameEngineObject, expectSameSql, runProbe, tempHome, turnShadowOn } from '../helpers/shadow-off-cost.ts';

const d = hasDatabase() ? describe : describe.skip;
const homes: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freshDatabase(): Promise<string> {
  const db = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  closers.push(db.close);
  return db.databaseUrl;
}

async function arms() {
  const [offUrl, directUrl, unseededUrl, seededUrl] = await Promise.all([freshDatabase(), freshDatabase(), freshDatabase(), freshDatabase()]);
  const [offHome, directHome, unseededHome, seededHome] = [tempHome(), tempHome(), tempHome(), tempHome()];
  homes.push(offHome, directHome, unseededHome, seededHome);
  turnShadowOn(unseededHome, { engine: 'postgres', database_url: unseededUrl });
  turnShadowOn(seededHome, { engine: 'postgres', database_url: seededUrl }, { seeded: true });
  const [off, direct, onUnseeded, onSeeded] = await Promise.all([
    runProbe('factory', 'postgres', { GBRAIN_HOME: offHome, DATABASE_URL: offUrl }),
    runProbe('direct', 'postgres', { GBRAIN_HOME: directHome, DATABASE_URL: directUrl }),
    runProbe('factory', 'postgres', { GBRAIN_HOME: unseededHome, DATABASE_URL: unseededUrl }),
    runProbe('factory', 'postgres', { GBRAIN_HOME: seededHome, DATABASE_URL: seededUrl }),
  ]);
  return { off, direct, onUnseeded, onSeeded, offHome };
}

let runs: ReturnType<typeof arms> | undefined;
const getRuns = () => (runs ??= arms());

d('shadow mode off costs nothing (Postgres)', () => {
  test('the brain has no shadow state and the factory engine is the primary engine itself, not a Proxy', async () => {
    const { off, direct, offHome } = await getRuns();
    expect(existsSync(join(offHome, '.gbrain', 'shadow'))).toBe(false);
    expect(off.constructorName).toBe('PostgresEngine');
    expectSameEngineObject(off, direct);
  }, 300_000);

  test('no hook module is loaded in the process, only the factory\'s own state.ts check', async () => {
    expectNoHookModules((await getRuns()).off);
  }, 300_000);

  test('a fixed batch of writes sends the database the same statements as a direct engine', async () => {
    const { off, direct } = await getRuns();
    expectSameSql(off, direct);
  }, 300_000);

  test('the shadow-ON controls trip the same pins, so none of them can pass by looking at the wrong engine', async () => {
    expectControlsAreCaught(await getRuns());
  }, 300_000);
});
