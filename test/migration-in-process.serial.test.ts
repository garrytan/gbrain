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
