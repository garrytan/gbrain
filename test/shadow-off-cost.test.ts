/**
 * Shadow mode OFF costs nothing on PGLite: the write path is the primary's own code, byte for byte.
 * Postgres twin: test/e2e/shadow-off-cost.test.ts. Probe: test/helpers/shadow-off-cost-probe.ts.
 *
 * Protects: createEngine() (src/core/engine-factory.ts) wraps the engine in the shadow Proxy (src/shadow/wrapper.ts, which
 * carries the follow hook from src/shadow/follow.ts) only when `gbrain engine shadow start` turned shadow on for the brain.
 * A brain that never did gets the plain engine, and a putPage / addLink / deletePage / transaction on it sends the database
 * exactly the statements a directly constructed engine sends.
 *
 * What it pins, on a real PGLite brain opened through the production factory with no shadow state under GBRAIN_HOME:
 *   1. The engine is not a Proxy and is the same kind of object as a directly constructed PGLite engine (same prototype, same own fields,
 *      no shadow or follow name anywhere on it). The only field the factory adds is its own `disconnect`.
 *   2. None of attach.ts, wrapper.ts, follow.ts, follower.ts, invalidations.ts is loaded in the process, checked in a fresh
 *      process through a module-load recorder. A shadow-ON control proves the recorder sees them when they are loaded.
 *   3. For a fixed batch of writes, the client messages the driver sends (every SQL text and every bound parameter, in
 *      order) are identical between the factory engine and a direct engine, captured below the engine at the driver.
 *
 * Why this also means no added per-write allocation, with no heap measuring: an allocation on the write path could only come
 * from a wrapper object around each call (point 1 rules out any wrapper: the engine is the class instance itself, not a Proxy
 * that builds a capture per call) or from hook code running in the process (point 2 rules it out: the code that would
 * allocate is never loaded). Heap numbers are noisy, these two facts are exact.
 *
 * Controls: the last test runs the same pins against factory engines whose home has shadow ON (one unseeded, one seeded so
 * the follow hook runs) and requires each pin to throw, so no pin can go green by looking at the wrong engine.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expectControlsAreCaught, expectNoHookModules, expectSameEngineObject, expectSameSql, runProbe, tempHome, turnShadowOn } from './helpers/shadow-off-cost.ts';

const homes: string[] = [];
function home(): string { const dir = tempHome(); homes.push(dir); return dir; }
afterAll(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const runs = (async () => {
  const offHome = home();
  const directHome = home();
  const unseededHome = home();
  const seededHome = home();
  const unseededPath = join(unseededHome, 'brain.pglite');
  const seededPath = join(seededHome, 'brain.pglite');
  turnShadowOn(unseededHome, { engine: 'pglite', database_path: unseededPath });
  turnShadowOn(seededHome, { engine: 'pglite', database_path: seededPath }, { seeded: true });
  const [off, direct, onUnseeded, onSeeded] = await Promise.all([
    runProbe('factory', 'pglite', { GBRAIN_HOME: offHome, PROBE_DB_PATH: join(offHome, 'brain.pglite') }),
    runProbe('direct', 'pglite', { GBRAIN_HOME: directHome, PROBE_DB_PATH: join(directHome, 'brain.pglite') }),
    runProbe('factory', 'pglite', { GBRAIN_HOME: unseededHome, PROBE_DB_PATH: unseededPath }),
    runProbe('factory', 'pglite', { GBRAIN_HOME: seededHome, PROBE_DB_PATH: seededPath }),
  ]);
  return { off, direct, onUnseeded, onSeeded, offHome };
})();
runs.catch(() => undefined); // surfaced by each test's await; keeps an early failure from also being an unhandled rejection

describe('shadow mode off costs nothing (PGLite)', () => {
  test('the brain has no shadow state and the factory engine is the primary engine itself, not a Proxy', async () => {
    const { off, direct, offHome } = await runs;
    expect(existsSync(join(offHome, '.gbrain', 'shadow'))).toBe(false);
    expect(off.constructorName).toBe('PGLiteEngine');
    expectSameEngineObject(off, direct);
  }, 180_000);

  test('no hook module is loaded in the process, only the factory\'s own state.ts check', async () => {
    expectNoHookModules((await runs).off);
  }, 180_000);

  test('a fixed batch of writes sends the database the same statements as a direct engine', async () => {
    const { off, direct } = await runs;
    expectSameSql(off, direct);
  }, 180_000);

  test('the shadow-ON controls trip the same pins, so none of them can pass by looking at the wrong engine', async () => {
    expectControlsAreCaught(await runs);
  }, 180_000);
});
