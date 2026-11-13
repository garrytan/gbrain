/**
 * A brain whose gbrain functions still pin the search_path they pinned before pg_temp (every brain migrated before
 * v277, #7632), upgraded on this code, ends with the same search_path on every function as a brain created fresh here.
 *
 * 1. Protects: every definition now pins pg_temp itself (#7785), while an existing brain gets it only from the
 *    hardening (migration v277 and the end of every migration run, src/core/migrate.ts). Both routes must land on the
 *    same pg_proc.proconfig for every function: the same functions, identity arguments and settings, pg_temp last.
 * 2. Fails when: the hardening is skipped or appends anything but pg_temp, a definition pins a path the hardening would
 *    not produce from the legacy one (pg_temp elsewhere, a schema added or dropped), or an upgrade leaves a function
 *    behind.
 * 3. Existing coverage: test/e2e/function-search-path-postgres.test.ts case 4 compares the count of pinned functions
 *    and the list without pg_temp, on Postgres and through runMigrations only. This file compares every function's
 *    full proconfig, on PGLite and Postgres, through initSchema and runMigrations.
 * 4. Real seams: PGLite cold in-memory brains (no schema snapshot) and, with DATABASE_URL, fresh Postgres databases;
 *    initSchema (the gbrain upgrade and apply-migrations entry) and runMigrations.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { LEGACY_SEARCH_PATH_SETTINGS, PINNED_FUNCTION_NAMES, legacySearchPathFunctions } from '../src/core/function-search-path.ts';
import { v277 } from '../src/core/schema-migrations/v277-function-search-path-pg-temp.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withColdPglite } from './helpers/with-snapshot.ts';

/** Every function outside the system schemas that no extension owns, with its full proconfig. */
const FUNCTIONS_SQL = `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn,
    p.oid::regprocedure::text AS sig, p.proname AS name, COALESCE(p.proconfig, '{}'::text[]) AS config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`;
const PREFIX = 'search_path=';
const PG_TEMP = ', pg_temp';

type Fn = { fn: string; sig: string; name: string; config: string[] };
type Brain = { engine: BrainEngine; close: () => Promise<void> };

async function functions(engine: BrainEngine): Promise<Fn[]> {
  const rows = await engine.executeRaw<Fn>(FUNCTIONS_SQL);
  return rows.map(r => ({ fn: r.fn, sig: r.sig, name: r.name, config: [...r.config] })).sort((a, b) => (a.fn < b.fn ? -1 : a.fn > b.fn ? 1 : 0));
}
const searchPath = (f: Fn) => f.config.find(c => c.startsWith(PREFIX));
const pinned = (fns: Fn[]) => fns.filter(f => searchPath(f) !== undefined);
const shape = (fns: Fn[]) => fns.map(f => ({ fn: f.fn, config: f.config }));
function pgTempLast(setting: string): boolean {
  const schemas = setting.slice(PREFIX.length).split(',').map(s => s.trim());
  return schemas.indexOf('pg_temp') === schemas.length - 1;
}

/** Puts every pinned function back on the setting it had before pg_temp (ALTER only, as the hardening undoes) at 'version'. */
async function rewindToLegacy(engine: BrainEngine, version: number): Promise<void> {
  for (const f of await functions(engine)) {
    const setting = searchPath(f);
    if (!setting?.endsWith(PG_TEMP)) continue;
    await engine.executeRaw(`ALTER FUNCTION ${f.sig} SET search_path = ${setting.slice(PREFIX.length, -PG_TEMP.length)}`);
  }
  await engine.setConfig('version', String(version));
}

async function capturingStderr(fn: () => Promise<unknown>): Promise<string> {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try { await fn(); } finally { process.stderr.write = write; }
  return stderr;
}

const ENTRIES: Array<[string, (engine: BrainEngine) => Promise<unknown>]> = [
  ['initSchema (gbrain upgrade, apply-migrations)', engine => engine.initSchema()],
  ['runMigrations', engine => runMigrations(engine)],
];
const STATES: Array<[string, number]> = [
  ['migrated before v277', v277.version - 1],
  ['at the latest version with every legacy path (nothing pending)', LATEST_VERSION],
];

for (const kind of testBackends()) {
  describe(`an upgraded brain pins the same search_path on every function as a fresh one (${kind})`, () => {
    let fresh: Brain | undefined;
    let upgraded: Brain | undefined;
    let freshFns: Fn[] = [];
    beforeAll(async () => {
      const freshBrain = async (): Promise<Brain> => {
        if (kind === 'postgres') return isolatedPersistencePostgres(process.env.DATABASE_URL!);
        const engine = new PGLiteEngine();
        await withColdPglite(() => engine.connect({}));
        await engine.initSchema();
        return { engine, close: () => engine.disconnect() };
      };
      fresh = await freshBrain();
      upgraded = await freshBrain();
      freshFns = await functions(fresh.engine);
    }, 300_000);
    afterAll(async () => {
      await fresh?.close();
      await upgraded?.close();
    });

    test('a fresh brain pins pg_temp last on every pinned function, and pins only the functions the hardening knows', () => {
      const pins = pinned(freshFns);
      expect(pins.length).toBeGreaterThanOrEqual(35);
      expect(pins.filter(f => !pgTempLast(searchPath(f)!)).map(f => f.fn)).toEqual([]);
      expect(pins.map(f => f.name).filter(name => !(PINNED_FUNCTION_NAMES as readonly string[]).includes(name))).toEqual([]);
    });

    for (const [entry, migrate] of ENTRIES) {
      for (const [state, version] of STATES) {
        test(`a brain ${state}, upgraded through ${entry}, ends with every function's proconfig as on a fresh brain`, async () => {
          const engine = upgraded!.engine;
          await rewindToLegacy(engine, version);
          const legacy = pinned(await functions(engine));
          expect(legacy.length).toBe(pinned(freshFns).length);
          expect(legacy.filter(f => !(LEGACY_SEARCH_PATH_SETTINGS as readonly string[]).includes(searchPath(f)!)).map(f => f.fn)).toEqual([]);
          expect((await legacySearchPathFunctions(engine)).length).toBe(legacy.length);

          const stderr = await capturingStderr(() => migrate(engine));
          expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
          expect(stderr).not.toMatch(/left without pg_temp|pg_temp not restored|not put back/);
          const after = await functions(engine);
          expect(shape(after)).toEqual(shape(freshFns));
          expect(pinned(after).filter(f => !pgTempLast(searchPath(f)!)).map(f => f.fn)).toEqual([]);
        }, 300_000);
      }
    }
  });
}
