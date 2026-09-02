/**
 * #4583 ship-review fix — the unscoped-sync default-write refusal must not
 * fire under --dry-run. A preview writes nothing, so refusing it only hides
 * the preview from the operator who is trying to see what a sync WOULD do.
 * The guard still speaks (the operator learns that a real run would be
 * refused, with the same routing guidance) but does not exit.
 *
 * Real PGLite + a real git repo, through the CLI entry (`runSync`), because
 * the refusal is a `process.exit(1)` at the command layer — there is no
 * lower seam that can observe it.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let repoPath: string;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-dryrun-guard-home-'));
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-dryrun-guard-repo-'));
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
  mkdirSync(join(repoPath, 'topics'), { recursive: true });
  writeFileSync(
    join(repoPath, 'topics/foo.md'),
    '---\ntype: concept\ntitle: Foo\n---\n\nbaseline.\n',
  );
  execSync('git add -A && git commit -q -m initial', { cwd: repoPath, stdio: 'pipe' });
  // Bulk-non-default brain: one non-default source WITHOUT a local_path (so
  // the sole_non_default tier cannot claim the unscoped sync — it falls to
  // seed_default) holding every page; 'default' is empty but anchored at the
  // repo so the preview has a path to walk.
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('teamvault', 'Team vault') ON CONFLICT (id) DO NOTHING`,
  );
  for (let i = 0; i < 3; i++) {
    await engine.putPage(
      `wiki/page-${i}`,
      { type: 'concept', title: `P${i}`, compiled_truth: `body ${i}` },
      { sourceId: 'teamvault' },
    );
  }
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('default', 'default', $1)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [repoPath],
  );
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function runSyncCapturing(args: string[]): Promise<{ exitCode: number | undefined; stderr: string }> {
  const { runSync } = await import('../src/commands/sync.ts');
  const origWrite = process.stderr.write.bind(process.stderr);
  const origErr = console.error;
  const captured: string[] = [];
  (process.stderr as unknown as { write: typeof origWrite }).write = ((chunk: unknown): boolean => {
    captured.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof origWrite;
  console.error = (...a: unknown[]) => {
    captured.push(a.map(String).join(' ') + '\n');
  };
  const origExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error('__exit__');
  }) as typeof process.exit;
  try {
    await withEnv(
      { GBRAIN_HOME: home, GBRAIN_ALLOW_DEFAULT_WRITE: undefined, GBRAIN_SOURCE: undefined },
      () => runSync(engine, args),
    );
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    process.exit = origExit;
    console.error = origErr;
    (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
  }
  return { exitCode, stderr: captured.join('') };
}

describe('#4583 ship-review — unscoped sync refusal vs --dry-run', () => {
  test('control: a real unscoped sync on a bulk-non-default brain is refused (exit 1)', async () => {
    const { exitCode, stderr } = await runSyncCapturing(['--no-embed']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Refusing unscoped sync');
    expect(stderr).not.toContain('would be refused');
  }, 60_000);

  test('--dry-run is NOT refused: the preview runs, the guard only warns, nothing lands in default', async () => {
    const { exitCode, stderr } = await runSyncCapturing(['--dry-run', '--no-embed']);
    expect(exitCode === undefined || exitCode === 0).toBe(true);
    // The warning survives, prefixed so the operator knows it is advisory here...
    expect(stderr).toContain('[dry-run] a real run would be refused');
    // ...and carries the same routing guidance as the refusal.
    expect(stderr).toContain('gbrain sync --source <id>');
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'default'`,
    );
    expect(Number(rows[0].n)).toBe(0);
  }, 60_000);
});
