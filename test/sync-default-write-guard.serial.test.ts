/**
 * #4583 — `gbrain sync` refuses an UNSCOPED single-source run that would
 * silently land in source 'default' on a bulk-non-default brain.
 *
 * The hermetic + real-PGLite guard suites pin `assessDefaultWriteGuard`
 * itself; this file pins the sync.ts WIRING of that verdict (the refusal at
 * the `seed_default` tier, its exit code, and every documented escape):
 *
 *   - unscoped sync from a non-source cwd → exit 1 + "Refusing unscoped
 *     sync", and NOTHING is written to 'default';
 *   - `--all` (iterates every source, never an unscoped-to-default write) is
 *     exempt and proceeds past the gate;
 *   - `--source default` (tier 'flag', never seed_default) proceeds and the
 *     pages land in 'default' on purpose;
 *   - `GBRAIN_ALLOW_DEFAULT_WRITE=1` (scripted pipelines) proceeds likewise.
 *
 * Serial: owns a real PGLite engine + process.exit spy, and drives the full
 * `runSync` entry (a real git fixture is imported on the pass-through paths).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runSync } from '../src/commands/sync.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
/** An UNREGISTERED git repo (no dotfile, no source local_path) passed via --repo. */
let repo: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-sync-guard-home-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  // Two non-default sources hold ALL the content; 'default' is empty. Their
  // local_paths point nowhere on this host (so `--all --missing-path skip`
  // classifies them instead of syncing). sole_non_default (tier 5.5) cannot
  // fire with two candidates, so an unscoped resolve falls to seed_default.
  for (const id of ['vault-a', 'vault-b']) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2) ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      [id, `/nonexistent/gbrain-sync-guard/${id}`],
    );
  }
  await importFromContent(engine, 'a/one', '---\ntype: note\ntitle: one\n---\n# one\n', { noEmbed: true, sourceId: 'vault-a' });
  await importFromContent(engine, 'a/two', '---\ntype: note\ntitle: two\n---\n# two\n', { noEmbed: true, sourceId: 'vault-a' });
  await importFromContent(engine, 'b/one', '---\ntype: note\ntitle: three\n---\n# three\n', { noEmbed: true, sourceId: 'vault-b' });

  repo = mkdtempSync(join(tmpdir(), 'gbrain-sync-guard-repo-'));
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
  mkdirSync(join(repo, 'topics'), { recursive: true });
  writeFileSync(join(repo, 'topics/guarded.md'), '---\ntype: concept\ntitle: Guarded\n---\n\nbody.\n');
  execSync('git add -A && git commit -m initial', { cwd: repo, stdio: 'pipe' });
}, 60_000);

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

async function pageCountBySource(): Promise<Record<string, number>> {
  const rows = await engine.executeRaw<{ source_id: string; n: number }>(
    `SELECT source_id, COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL GROUP BY source_id`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.source_id] = r.n;
  return out;
}

/** Drive runSync with process.exit / console.error / stderr captured. */
async function runSyncCaptured(args: string[]): Promise<{ exitCode: number | undefined; stderr: string; stdout: string[] }> {
  let exitCode: number | undefined;
  const stderr: string[] = [];
  const stdout: string[] = [];
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.map(String).join(' ')); });
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { stdout.push(a.map(String).join(' ')); });
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: typeof origWrite }).write = ((chunk: unknown): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof origWrite;
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__exit__');
  }) as never);
  try {
    await runSync(engine, args);
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    exitSpy.mockRestore();
    (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { exitCode, stderr: stderr.join('\n'), stdout };
}

const REFUSAL = "Refusing unscoped sync: it would write to source 'default'";

describe('#4583 runSync — unscoped seed_default write refusal', () => {
  test('unscoped sync from a non-source cwd exits 1 with the refusal and writes nothing to default', async () => {
    await withEnv(
      { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined },
      async () => {
        const r = await runSyncCaptured(['--full', '--no-embed', '--no-pull', '--repo', repo]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain(REFUSAL);
        // The refusal names the distribution + every escape hatch.
        expect(r.stderr).toContain('2 non-default source(s)');
        expect(r.stderr).toContain('GBRAIN_ALLOW_DEFAULT_WRITE=1');
        expect(r.stderr).toContain('--source default');
      },
    );
    const counts = await pageCountBySource();
    expect(counts['default'] ?? 0).toBe(0);
    expect(counts['vault-a']).toBe(2);
    expect(counts['vault-b']).toBe(1);
  }, 60_000);

  test('--all is exempt: proceeds past the gate into the per-source fan-out', async () => {
    await withEnv(
      { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined },
      async () => {
        // --missing-path skip: both local_paths are absent on this host, so the
        // fan-out classifies them and returns — proving the run got PAST the
        // gate without needing a real checkout per source.
        const r = await runSyncCaptured(['--all', '--no-embed', '--missing-path', 'skip', '--json']);
        expect(r.stderr).not.toContain(REFUSAL);
        expect(r.exitCode === undefined || r.exitCode === 0).toBe(true);
        const envelope = JSON.parse(r.stdout.find(l => l.trim().startsWith('{'))!);
        expect(envelope.skipped_count).toBe(2);
        expect(envelope.sources.map((s: { status: string }) => s.status)).toEqual([
          'skipped_missing_path', 'skipped_missing_path',
        ]);
      },
    );
  }, 60_000);

  test('--source default is the explicit escape: proceeds and lands the pages in default on purpose', async () => {
    await withEnv(
      { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined },
      async () => {
        const r = await runSyncCaptured(['--full', '--no-embed', '--no-pull', '--repo', repo, '--source', 'default']);
        expect(r.stderr).not.toContain(REFUSAL);
        expect(r.exitCode === undefined || r.exitCode === 0).toBe(true);
      },
    );
    const counts = await pageCountBySource();
    expect(counts['default']).toBeGreaterThan(0);
  }, 60_000);

  test('GBRAIN_ALLOW_DEFAULT_WRITE=1 is the scripted escape: an unscoped sync proceeds', async () => {
    await withEnv(
      { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: '1' },
      async () => {
        const r = await runSyncCaptured(['--full', '--no-embed', '--no-pull', '--repo', repo]);
        expect(r.stderr).not.toContain(REFUSAL);
        expect(r.exitCode === undefined || r.exitCode === 0).toBe(true);
      },
    );
    const counts = await pageCountBySource();
    expect(counts['default']).toBeGreaterThan(0);
  }, 60_000);

  // --dry-run writes nothing, so the gate only WARNS (prefixed so an operator
  // can tell the preview apart from a refusal) and lets the preview run.
  test('--dry-run proceeds past the gate: warns, previews, writes nothing', async () => {
    await withEnv(
      { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined },
      async () => {
        const r = await runSyncCaptured(['--dry-run', '--no-embed', '--no-pull', '--repo', repo]);
        expect(r.exitCode === undefined || r.exitCode === 0).toBe(true);
        expect(r.stderr).toContain('[dry-run] a real run would be refused');
      },
    );
    expect((await pageCountBySource())['default'] ?? 0).toBe(0);
  });
});
