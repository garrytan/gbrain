/**
 * `gbrain cache` CLI (src/commands/cache.ts) — clear / prune / arg-parsing
 * reality, end-to-end through the command's OWN loadConfig → createEngine
 * path (runCache builds its own engine; there is no injection seam).
 *
 * Setup: a disk-backed PGLite brain behind GBRAIN_HOME (the in-memory
 * snapshot fast path can't be shared with runCache's separately-constructed
 * engine, and PGLite is single-connection per data dir). Each step therefore
 * does a connect → act → disconnect dance: seed with our own engine,
 * disconnect, let runCache connect, then reconnect to verify. initSchema
 * replays the full migration set ONCE in beforeAll; later connects reopen
 * the existing data dir without replay.
 *
 * No mock.module, env via withEnv → safe as a non-serial file.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCache } from '../src/commands/cache.ts';
import { withEnv } from './helpers/with-env.ts';

let home: string;
let dataDir: string;
let engine: PGLiteEngine;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'cache-cli-home-'));
  const gbrainDir = join(home, '.gbrain');
  mkdirSync(gbrainDir, { recursive: true });
  dataDir = join(gbrainDir, 'brain.pglite');
  writeFileSync(
    join(gbrainDir, 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dataDir }) + '\n',
  );
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dataDir });
  await engine.initSchema();
  // Release the data-dir lock so runCache's own engine can attach; withDb()
  // reconnects this same instance for seed/verify steps.
  await engine.disconnect();
}, 180_000);

afterAll(async () => {
  await engine.disconnect(); // idempotent no-op when already disconnected
  rmSync(home, { recursive: true, force: true });
});

/** Reconnect the file's engine → run → disconnect (frees the dir lock for runCache). */
async function withDb<T>(fn: (e: PGLiteEngine) => Promise<T>): Promise<T> {
  await engine.connect({ engine: 'pglite', database_path: dataDir });
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

interface SeedRow {
  id: string;
  source: string;
  /** Seconds in the past for created_at (0 = fresh now). */
  ageSeconds?: number;
  /** Row TTL; default 3600 (matches production default). */
  ttl?: number;
}

/** Wipe query_cache and insert the given rows (embedding stays NULL — clear/prune never read it). */
async function seed(rows: SeedRow[]): Promise<void> {
  await withDb(async (engine) => {
    await engine.executeRaw(`DELETE FROM query_cache`);
    for (const r of rows) {
      await engine.executeRaw(
        `INSERT INTO query_cache (id, query_text, source_id, ttl_seconds, created_at)
         VALUES ($1, $2, $3, $4, now() - ($5::text || ' seconds')::interval)`,
        [r.id, `query for ${r.id}`, r.source, r.ttl ?? 3600, String(r.ageSeconds ?? 0)],
      );
    }
  });
}

async function remainingIds(): Promise<string[]> {
  return withDb(async (engine) => {
    const rows = await engine.executeRaw<{ id: string }>(`SELECT id FROM query_cache ORDER BY id`);
    return rows.map((r) => r.id);
  });
}

interface RunResult {
  stdout: string;
  stderr: string;
  /** undefined = command returned without calling process.exit (success path). */
  exitCode: number | undefined;
}

/** Drive runCache with captured console + throwing process.exit stub. */
async function runCacheCli(args: string[], homeOverride?: string): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  (process.exit as unknown) = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('__EXIT__');
  }) as never;
  try {
    await withEnv(
      {
        GBRAIN_HOME: homeOverride ?? home,
        DATABASE_URL: undefined,
        GBRAIN_DATABASE_URL: undefined,
      },
      () => runCache(args),
    );
  } catch (e) {
    if (!(e instanceof Error) || e.message !== '__EXIT__') throw e;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

const THREE_ROWS: SeedRow[] = [
  { id: 'row-a1', source: 'a' },
  { id: 'row-a2', source: 'a' },
  { id: 'row-b1', source: 'b' },
];

describe('gbrain cache clear', () => {
  test('bare clear (no --yes) exits 1 and deletes NOTHING', async () => {
    await seed(THREE_ROWS);
    const r = await runCacheCli(['clear']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('refusing to wipe without --yes');
    // The exit fires BEFORE cache.clear() — all rows survive.
    expect(await remainingIds()).toEqual(['row-a1', 'row-a2', 'row-b1']);
  }, 60_000);

  test('clear --yes deletes all rows across every source', async () => {
    await seed(THREE_ROWS);
    const r = await runCacheCli(['clear', '--yes']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Cleared 3 cache row(s).');
    expect(await remainingIds()).toEqual([]);
  }, 60_000);

  test('clear --yes --source a deletes only source a rows', async () => {
    await seed(THREE_ROWS);
    const r = await runCacheCli(['clear', '--yes', '--source', 'a']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Cleared 2 cache row(s) (source=a).');
    expect(await remainingIds()).toEqual(['row-b1']);
  }, 60_000);

  test('ordering footgun: clear --source --yes silently binds sourceId="--yes" (pins current parser reality)', async () => {
    // The parser takes args[indexOf('--source') + 1] verbatim, so the literal
    // string '--yes' becomes the source filter. Reality today: the command
    // SUCCEEDS (exit 0 path), reports the bogus source in its output, and
    // deletes zero real rows because no row has source_id='--yes'. Nothing is
    // wiped — but nothing is cleared either, and the user gets no error. If
    // the parser ever learns to reject flag-shaped values (or to treat this
    // as "no source given" and wipe everything), this test MUST be updated
    // deliberately — that would be a behavior change either way.
    await seed(THREE_ROWS);
    const r = await runCacheCli(['clear', '--source', '--yes']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Cleared 0 cache row(s) (source=--yes).');
    expect(await remainingIds()).toEqual(['row-a1', 'row-a2', 'row-b1']);
  }, 60_000);
});

describe('gbrain cache prune', () => {
  test('prune removes only past-TTL rows and leaves fresh ones', async () => {
    await seed([
      { id: 'fresh-row', source: 'a', ageSeconds: 0, ttl: 3600 },
      { id: 'stale-row', source: 'a', ageSeconds: 7200, ttl: 3600 },
      { id: 'edge-fresh', source: 'b', ageSeconds: 60, ttl: 3600 },
    ]);
    const r = await runCacheCli(['prune']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Pruned 1 stale cache row(s).');
    expect(await remainingIds()).toEqual(['edge-fresh', 'fresh-row']);
  }, 60_000);
});

describe('gbrain cache — dispatch edges', () => {
  test('bogus subcommand exits 1 with a pointer to --help', async () => {
    const r = await runCacheCli(['bogus']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unknown subcommand "bogus"');
    expect(r.stderr).toContain('--help');
  }, 60_000);

  test('--help prints usage without touching config or DB', async () => {
    // Help path returns before loadConfig — works even with an empty home.
    const emptyHome = mkdtempSync(join(tmpdir(), 'cache-cli-empty-'));
    try {
      const r = await runCacheCli(['--help'], emptyHome);
      expect(r.exitCode).toBeUndefined();
      expect(r.stdout).toContain('gbrain cache stats');
      expect(r.stdout).toContain('Requires --yes');
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  test('no brain configured exits 1 with the init hint', async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'cache-cli-nobrain-'));
    try {
      const r = await runCacheCli(['prune'], emptyHome);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('no brain configured');
      expect(r.stderr).toContain('gbrain init');
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
