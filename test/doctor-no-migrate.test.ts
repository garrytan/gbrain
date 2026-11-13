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
 * `GBRAIN_TEST_SKIP_SUBPROCESS=1` for fast-loop budget control.
 */
import { describe, test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createEngine } from '../src/core/engine-factory.ts';
import { upsertChronicleRow } from '../src/core/chronicle/ledger.ts';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SKIP = process.env.GBRAIN_TEST_SKIP_SUBPROCESS === '1';

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

  test.skipIf(SKIP)('Chronicle sees the database-selected chat model without startup maintenance', async () => {
    const { home, dataDir, env } = makeHome('gbrain-doctor-chronicle-');
    try {
      const engine = await createEngine({ engine: 'pglite', database_path: dataDir });
      await engine.connect({ database_path: dataDir });
      try {
        await engine.initSchema();
        await engine.setConfig('chat_model', 'ollama:legacy-model-pin');
        await engine.setConfig('models.chat', 'fixture-local');
        const page = await engine.putPage('meetings/doctor-chronicle', {
          type: 'meeting', title: 'Doctor fixture', compiled_truth: 'Synthetic meeting text.', timeline: '',
        });
        await upsertChronicleRow(engine, {
          sourceId: 'default', pageId: page.id, slug: page.slug, contentHash: page.content_hash!,
          state: 'pending', trigger: 'auto', reason: null, nextAttemptAt: null,
        });
      } finally { await engine.disconnect(); }
      let requests = 0;
      const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
        requests++;
        return new Response('Unexpected model request', { status: 500 });
      } });
      try {
        const result = await runCli(['doctor', '--no-migrate', '--only', 'auto_chronicle', '--json'],
          { ...env, OLLAMA_BASE_URL: String(endpoint.url) }, 180_000);
        expect(result.exitCode).toBe(0);
        const check = JSON.parse(result.stdout).checks.find((row: { name: string }) => row.name === 'auto_chronicle');
        expect(check).toMatchObject({ status: 'ok', details: { chat_available: true, pending: 1, auto_calls_24h: 0 } });
        expect(requests).toBe(0);
        const update = await createEngine({ engine: 'pglite', database_path: dataDir });
        await update.connect({ database_path: dataDir });
        try {
          await update.setConfig('models.chat', 'deepseek:deepseek-flash');
          await update.setConfig('deepseek_api_key', 'synthetic-local-fixture');
        } finally { await update.disconnect(); }
        const legacy = await runCli(['doctor', '--no-migrate', '--only', 'auto_chronicle', '--json'],
          { ...env, DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: String(endpoint.url) }, 180_000);
        expect(legacy.exitCode).toBe(0);
        expect(JSON.parse(legacy.stdout).checks.find((row: { name: string }) => row.name === 'auto_chronicle'))
          .toMatchObject({ status: 'ok', details: { chat_available: true, pending: 1, auto_calls_24h: 0 } });
        expect(legacy.stdout).not.toContain('synthetic-local-fixture');
        const invalid = await createEngine({ engine: 'pglite', database_path: dataDir });
        await invalid.connect({ database_path: dataDir });
        try { await invalid.setConfig('models.chat', 'ollama:'); }
        finally { await invalid.disconnect(); }
        const malformed = await runCli(['doctor', '--no-migrate', '--only', 'auto_chronicle', '--json'], env, 180_000);
        expect(JSON.parse(malformed.stdout).checks.find((row: { name: string }) => row.name === 'auto_chronicle'))
          .toMatchObject({ status: 'warn', details: { chat_available: false } });
        expect(requests).toBe(0);
      } finally { endpoint.stop(true); }
    } finally { rmSync(home, { recursive: true, force: true }); }
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
