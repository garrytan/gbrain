// v0.41.37.0 #1605 — migration schema phases run IN-PROCESS (was a
// `gbrain init --migrate-only` subprocess that died with getaddrinfo ENOTFOUND
// on Windows+bun+Supabase). runMigrateOnlyCore is the single in-process path;
// runGbrainSubprocess captures child stderr for the remaining backfill spawns.
import { describe, test, expect } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import {
  runMigrateOnlyCore,
  runGbrainSubprocess,
  MigrateOnlyError,
} from '../src/commands/migrations/in-process.ts';

const MIGRATION_DIR = join(import.meta.dir, '..', 'src', 'commands', 'migrations');
const SCHEMA_PHASE_FILES = [
  'v0_11_0', 'v0_12_0', 'v0_12_2', 'v0_13_0', 'v0_16_0',
  'v0_18_0', 'v0_18_1', 'v0_21_0', 'v0_29_1',
];

describe('#1605 runMigrateOnlyCore (in-process schema)', () => {
  test('brings a fresh PGLite brain to head without spawning', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mip-'));
    const dataDir = join(home, 'data');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: dataDir }),
    );

    const result = await withEnv(
      { GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      () => runMigrateOnlyCore(),
    );
    expect(result.engine).toBe('pglite');

    // Verify schema landed: reconnect a fresh engine to the same data dir and
    // confirm a core table exists (proves initSchema ran in-process).
    const verify = new PGLiteEngine();
    await verify.connect({ database_path: dataDir });
    try {
      const rows = await verify.executeRaw<{ t: string | null }>(
        "SELECT to_regclass('public.pages')::text AS t",
      );
      expect(rows[0]?.t).toBe('pages');
    } finally {
      await verify.disconnect();
    }
  });

  // Regression coverage for #2775: `gbrain init --migrate-only` (this
  // function, in-process) failed with `column "event_page_id" does not
  // exist` on any PGLite brain whose schema predates migration v121, because
  // `PGLiteEngine#initSchema` replayed the embedded schema blob — which
  // indexes `timeline_entries.event_page_id` — BEFORE `runMigrations()` had
  // a chance to add that column. The fix (forward-reference bootstrap probe
  // for `timeline_entries.event_page_id`) already shipped in #2735 (closing
  // #2724, the Postgres-side report of the same ordering bug) ahead of this
  // test. `test/bootstrap.test.ts` and `test/schema-bootstrap-coverage.test.ts`
  // already cover the bootstrap contract at the engine-method level; this
  // test closes the remaining gap by exercising the exact CLI-facing entry
  // point (`runMigrateOnlyCore`, i.e. `gbrain init --migrate-only`) so a
  // future regression in the wiring between the CLI and `initSchema()` would
  // still be caught even if the lower-level bootstrap contract stayed intact.
  test('brings a pre-v121 PGLite brain (missing timeline_entries.event_page_id) to head without spawning (#2775)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mip-pre121-'));
    const dataDir = join(home, 'data');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: dataDir }),
    );

    await withEnv(
      { GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      async () => {
        // Bring the brain to LATEST first (fresh install), then simulate a
        // pre-v121 brain by stripping the forward-referenced column/indexes
        // migration v121 added and rolling `config.version` back to a
        // pre-v121 value — the same down-mutation pattern used by
        // test/bootstrap.test.ts's "pre-v121 timeline shape" case.
        await runMigrateOnlyCore();

        const rollback = new PGLiteEngine();
        await rollback.connect({ database_path: dataDir });
        try {
          await (rollback as any).db.exec(`
            DROP INDEX IF EXISTS idx_timeline_event_page;
            DROP INDEX IF EXISTS idx_timeline_event_dedup;
            ALTER TABLE timeline_entries DROP CONSTRAINT IF EXISTS timeline_entries_event_page_id_fkey;
            ALTER TABLE timeline_entries DROP COLUMN IF EXISTS event_page_id;
          `);
          await rollback.setConfig('version', '97');
        } finally {
          await rollback.disconnect();
        }

        // The literal repro from #2775: re-running the `gbrain init
        // --migrate-only` code path against the downgraded brain must NOT
        // throw `column "event_page_id" does not exist` — it must bring the
        // schema back to LATEST_VERSION.
        const result = await runMigrateOnlyCore();
        expect(result.engine).toBe('pglite');
      },
    );

    const verify = new PGLiteEngine();
    await verify.connect({ database_path: dataDir });
    try {
      const versionStr = await verify.getConfig('version');
      expect(parseInt(versionStr || '0', 10)).toBe(LATEST_VERSION);
      const rows = await verify.executeRaw<{ t: string | null }>(
        "SELECT to_regclass('public.idx_timeline_event_page')::text AS t",
      );
      expect(rows[0]?.t).toBe('idx_timeline_event_page');
    } finally {
      await verify.disconnect();
    }
  });

  test('throws MigrateOnlyError when no brain is configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mip-noconf-'));
    await expect(
      withEnv(
        { GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
        () => runMigrateOnlyCore(),
      ),
    ).rejects.toBeInstanceOf(MigrateOnlyError);
  });
});

describe('#1605 runGbrainSubprocess (stderr capture)', () => {
  test('folds child stderr into the thrown error', () => {
    let msg = '';
    try {
      runGbrainSubprocess("sh -c 'echo BOOM_STDERR 1>&2; exit 1'");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('BOOM_STDERR');
  });

  test('returns child stdout on success', () => {
    const out = runGbrainSubprocess("sh -c 'echo hello-stdout'");
    expect(out).toContain('hello-stdout');
  });
});

describe('#1605 structural guard: schema phases are in-process', () => {
  test('no schema phase still execSyncs `gbrain init --migrate-only`', () => {
    for (const f of SCHEMA_PHASE_FILES) {
      const src = readFileSync(join(MIGRATION_DIR, `${f}.ts`), 'utf-8');
      expect(src).not.toContain("execSync('gbrain init --migrate-only'");
    }
  });

  test('every schema phase calls runMigrateOnlyCore + is awaited', () => {
    for (const f of SCHEMA_PHASE_FILES) {
      const src = readFileSync(join(MIGRATION_DIR, `${f}.ts`), 'utf-8');
      expect(src).toContain('runMigrateOnlyCore()');
      // phaseASchema must be async + awaited at its call site.
      expect(src).toContain('async function phaseASchema');
      const awaited = src.includes('await phaseASchema(opts)') ||
        src.includes('push(await phaseASchema(opts))');
      expect(awaited).toBe(true);
    }
  });

  test('NO migration orchestrator anywhere spawns `gbrain init --migrate-only`', () => {
    // All-files invariant (not just the 9): the subprocess spawn is the
    // Windows-ENOTFOUND bug class. Other files (v0_22_4, v0_28_0, v0_31_0,
    // v0_14_0, v0_32_2) define an in-process phaseASchema that never spawned —
    // those are fine. We only ban the spawn literal.
    const files = readdirSync(MIGRATION_DIR).filter(n => /^v\d/.test(n) && n.endsWith('.ts'));
    for (const n of files) {
      const src = readFileSync(join(MIGRATION_DIR, n), 'utf-8');
      expect(src).not.toContain("execSync('gbrain init --migrate-only'");
    }
  });
});
