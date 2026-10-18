/**
 * A-31 (GBRA-130): `gbrain migrate --to …` never switches the active engine
 * over open-loop rows the target refused.
 *
 * Protects: an open_loops/loop_suppressions row whose insert the target
 * refuses (type or constraint drift) is recorded with its id, typed code and
 * the database's reason, printed, and blocks the engine switch with exit 1
 * while every other row, fact and page still copies; after the cause clears a
 * re-run copies the row and switches. A run where most rows fail is systemic
 * (item_failures_systemic) and a run-scoped failure (a lost connection, a
 * failed transaction) stops the copy instead of being counted as a refused row.
 * Fails when: the per-row catch counts the failure and discards it, or the
 * cutover gate and the clean-run verdict ignore the loop tables (the config
 * switches and the rows are gone on the active brain).
 * Seams: none in production; the run case wraps the target engine in a Proxy.
 * Serial: runMigrateEngine reads and writes the process-wide config under
 * GBRAIN_HOME and the CLI exit verdict. PGLite source; PGLite target always,
 * Postgres target when DATABASE_URL is set.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { copyMigrationSimpleTable, runMigrateEngine } from '../../src/commands/migrate-engine.ts';
import { loadConfigFileOnly, saveConfig } from '../../src/core/config.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const LOOP_SUMMARIES = ['reply to alice-example', 'send deck to acme-example', 'poison', 'follow up on contract', 'book the review', 'renew the domain'];

async function seedSource(): Promise<PGLiteEngine> {
  const source = new PGLiteEngine();
  await source.connect({});
  await source.initSchema();
  for (const slug of ['notes/one', 'notes/two']) await source.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}`, timeline: '', frontmatter: {} });
  for (const [i, summary] of LOOP_SUMMARIES.entries()) {
    await source.executeRaw(`INSERT INTO open_loops (source_id, dedup_key, loop_type, summary, detector) VALUES ('default', $1, 'commitment_owed_by_me', $2, 'manual')`, [`k${i}`, summary]);
  }
  await source.executeRaw(`INSERT INTO loop_suppressions (source_id, kind, value) VALUES ('default', 'sender', 'noreply@acme-example.com')`);
  return source;
}

interface Target { args: string[]; open: () => Promise<BrainEngine>; configEngine: 'pglite' | 'postgres'; close: () => Promise<void> }

/** The migration target, prepared with `prepare` (a constraint) before the migration connects to it. */
async function makeTarget(databaseUrl: string | undefined, dir: string, prepare: (engine: BrainEngine) => Promise<void>): Promise<Target> {
  if (databaseUrl) {
    const isolated = await isolatedPersistencePostgres(databaseUrl);
    await prepare(isolated.engine);
    await isolated.engine.disconnect();
    return { args: ['--to', 'postgres', '--url', isolated.databaseUrl], configEngine: 'postgres', close: isolated.close,
      open: async () => { const e = new PostgresEngine(); await e.connect({ database_url: isolated.databaseUrl, poolSize: 2 }); return e; } };
  }
  const path = join(dir, 'target.pglite');
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: path });
  await engine.initSchema();
  await prepare(engine);
  await engine.disconnect();
  return { args: ['--to', 'pglite', '--path', path], configEngine: 'pglite', close: async () => {},
    open: async () => { const e = new PGLiteEngine(); await e.connect({ database_path: path }); return e; } };
}

async function migrate(source: BrainEngine, target: Target): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const [log, error, warn] = [console.log, console.error, console.warn];
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  console.warn = () => {};
  try { await runMigrateEngine(source, target.args); } finally { console.log = log; console.error = error; console.warn = warn; }
  return { out: out.join('\n'), err: err.join('\n') };
}

const loopRows = async (engine: BrainEngine) => (await engine.executeRaw<{ id: string | number; summary: string }>('SELECT id, summary FROM open_loops ORDER BY id'))
  .map(r => ({ id: Number(r.id), summary: r.summary }));

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-31 migrate open-loop rows (${backend} target)`, () => {
    afterEach(() => _resetCliExitVerdictForTests());

    async function scenario(prepare: (engine: BrainEngine) => Promise<void>, run: (ctx: { source: PGLiteEngine; target: Target; dir: string }) => Promise<void>) {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-a31-'));
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const source = await seedSource();
        const target = await makeTarget(databaseUrl, dir, prepare);
        saveConfig(target.configEngine === 'pglite' ? { engine: 'postgres', database_url: 'postgresql://unused/guard-only' } : { engine: 'pglite', database_path: join(dir, 'source.pglite') });
        try { await run({ source, target, dir }); } finally { await source.disconnect(); await target.close(); }
      });
      rmSync(dir, { recursive: true, force: true });
    }

    test('A-31 item: a refused open_loops row is printed with its id and code and blocks the switch; the rest copies; a re-run after the fix switches', async () => {
      await scenario(e => e.executeRaw("ALTER TABLE open_loops ADD CONSTRAINT patho_no_poison CHECK (summary <> 'poison')").then(() => undefined), async ({ source, target }) => {
        const poison = (await loopRows(source)).find(r => r.summary === 'poison')!;
        const before = await snapshotItems(source, 'default');
        const { err } = await expectUnitNotAborted(() => migrate(source, target));
        expect(currentExitCode()).toBe(1);
        expect(loadConfigFileOnly()?.engine).not.toBe(target.configEngine);
        const line = err.split('\n').find(l => l.startsWith('  - open_loops id '));
        const parsed = /^ {2}- (open_loops) id (\d+) \((\w+)\): (.+)$/.exec(line ?? '');
        expect(parsed).not.toBeNull();
        const fix = /then re-run: (gbrain migrate .+)$/m.exec(err)?.[1];
        expectItemFailure({ key: `${parsed![1]}:${parsed![2]}`, code: parsed![3], fix }, { key: `open_loops:${poison.id}`, code: 'invalid_data', fix: new RegExp(`^gbrain migrate --to ${target.configEngine}`) });
        expect(parsed![4]).toContain('patho_no_poison');
        expectOthersUnchanged(before, await snapshotItems(source, 'default'));
        const copied = await target.open();
        try {
          expect((await loopRows(copied)).map(r => r.summary)).toEqual(LOOP_SUMMARIES.filter(s => s !== 'poison'));
          expect(await copied.executeRaw('SELECT count(*)::int AS n FROM loop_suppressions')).toEqual([{ n: 1 }]);
          expect((await copied.executeRaw<{ slug: string }>('SELECT slug FROM pages ORDER BY slug')).map(r => r.slug)).toEqual(['notes/one', 'notes/two']);
          await copied.executeRaw('ALTER TABLE open_loops DROP CONSTRAINT patho_no_poison');
        } finally { await copied.disconnect(); }

        _resetCliExitVerdictForTests();
        await expectUnitNotAborted(() => migrate(source, target));
        expect(currentExitCode()).toBe(0);
        expect(loadConfigFileOnly()?.engine).toBe(target.configEngine);
        const after = await target.open();
        try { expect((await loopRows(after)).map(r => r.summary)).toEqual(LOOP_SUMMARIES); } finally { await after.disconnect(); }
      });
    }, 180_000);

    test('A-31 breaker: when most rows are refused the copy stops item_failures_systemic and the engine is not switched', async () => {
      await scenario(e => e.executeRaw("ALTER TABLE open_loops ADD CONSTRAINT patho_none CHECK (summary = 'never')").then(() => undefined), async ({ source, target }) => {
        let thrown: unknown;
        try { await migrate(source, target); } catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(OperationError);
        expect((thrown as OperationError).code).toBe('item_failures_systemic');
        expect(loadConfigFileOnly()?.engine).not.toBe(target.configEngine);
      });
    }, 180_000);

    for (const injected of runScopedErrors().filter(e => e.name === 'connection lost' || e.name === 'failed transaction (25P02)')) {
      test(`A-31 run: a run-scoped error (${injected.name}) inserting a row stops the copy and records no refused row`, async () => {
        await scenario(async () => {}, async ({ source, target }) => {
          const real = await target.open();
          try {
            const error = injected.error();
            let inserts = 0;
            const failing = new Proxy(real, { get(t, prop) {
              const value = Reflect.get(t, prop, t);
              if (prop === 'executeRaw') return (sql: string, params?: unknown[]) => sql.startsWith('INSERT INTO open_loops') && ++inserts === 3 ? Promise.reject(error) : (value as Function).call(t, sql, params);
              return typeof value === 'function' ? value.bind(t) : value;
            } }) as BrainEngine;
            let thrown: unknown;
            try { await copyMigrationSimpleTable(source, failing, 'open_loops'); } catch (e) { thrown = e; }
            expect(thrown).toBe(error);
            expect(inserts).toBe(3);
          } finally { await real.disconnect(); }
        });
      }, 180_000);
    }
  });
}
