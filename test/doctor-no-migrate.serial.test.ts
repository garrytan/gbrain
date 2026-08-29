/**
 * #4364: `gbrain doctor --no-migrate` must be observational. Pre-fix, the
 * doctor branch called connectEngine() WITHOUT probeOnly, whose auto-migrate
 * block ran pending schema migrations — so doctor pointed at a clean DB
 * migrated it 1→latest before the health report, destroying the very
 * pre-migration state it was asked to report on.
 *
 * Spawns `doctor --no-migrate --json` against an UNINITIALIZED PGLite brain,
 * then opens the datadir in-process and asserts the gbrain schema was NOT
 * created. Red pre-fix: the flag was ignored and connectEngine's
 * tryRunPendingMigrations built the full schema.
 *
 * Serial because it spawns a subprocess and writes a tmpdir. Skippable via
 * `GBRAIN_SKIP_SUBPROCESS_TESTS=1` for fast-loop budget control.
 */
import { describe, test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SKIP = process.env.GBRAIN_SKIP_SUBPROCESS_TESTS === '1';

async function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

function makeHome(prefix: string): { home: string; dataDir: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const dataDir = join(home, '.gbrain', 'brain.pglite');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      database_path: dataDir,
      embedding_dimensions: 1536,
    }) + '\n',
  );
  return { home, dataDir, env: { HOME: home, GBRAIN_HOME: home } };
}

/**
 * Open the datadir directly: connectEngine's connect() creates raw pgdata
 * either way, but the gbrain schema (pages et al) only appears if migrations
 * ran. `null` from to_regclass = schema never created.
 */
async function pagesRegclass(dataDir: string): Promise<string | null> {
  const db = await PGlite.create({ dataDir, extensions: { vector, pg_trgm } });
  try {
    const res = await db.query<{ pages: string | null }>(
      "SELECT to_regclass('public.pages')::text AS pages",
    );
    return res.rows[0]?.pages ?? null;
  } finally {
    await db.close();
  }
}

describe('doctor --no-migrate keeps a clean DB unmigrated (#4364)', () => {
  test.skipIf(SKIP)('schema is NOT created by doctor when --no-migrate is passed', async () => {
    const { home, dataDir, env } = makeHome('gbrain-doctor-nomigrate-');
    try {
      // Deliberately NO `init --migrate-only` first: the point is observing
      // what doctor does to a never-initialized brain.
      const doctor = await runCli(['doctor', '--no-migrate', '--json'], env, 180_000);
      // Red pre-fix in two layers: the flag didn't exist (pre-dispatch
      // validator rejected it before connecting — asserted here so the
      // schema check below can't pass vacuously), and without it doctor's
      // connectEngine() auto-migrated the clean DB.
      expect(doctor.stderr).not.toContain('unknown flag');
      // Doctor may exit nonzero here (an uninitialized brain is unhealthy);
      // the contract under test is purely "no mutation", not the verdict.
      expect(await pagesRegclass(dataDir)).toBeNull();
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 300_000);

  test.skipIf(SKIP)('contrast: plain doctor still auto-migrates (detection harness is live)', async () => {
    const { home, dataDir, env } = makeHome('gbrain-doctor-migrate-');
    try {
      await runCli(['doctor', '--json'], env, 180_000);
      // Guards the test above against a vacuous pass: proves this harness
      // observes the schema whenever doctor's connectEngine() migrates.
      expect(await pagesRegclass(dataDir)).toBe('pages');
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 300_000);
});
