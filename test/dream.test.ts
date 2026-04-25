/**
 * Unit tests for src/commands/dream.ts — CLI alias over runCycle.
 *
 * dream is intentionally thin. These tests exercise the CLI surface
 * (argv parsing, brainDir resolution, output format, exit codes)
 * against a REAL runCycle + real library calls, backed by an
 * in-memory PGLite engine.
 *
 * Why no mocks: `mock.module` in bun is process-global and leaks
 * across test files (a stub of ../src/commands/orphans.ts breaks
 * every test that imports shouldExclude/deriveDomain/formatOrphansText).
 * Testing against real calls is honest and mock-leak-free.
 *
 * What this test file does NOT cover: the exhaustive dryRun-×-phases-×-
 * lock matrix, which test/core/cycle.test.ts handles (in isolation).
 * Here we only verify that dream.ts routes args correctly.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runDream } from '../src/commands/dream.ts';

// ─── Helpers ───────────────────────────────────────────────────────

/** Make an empty, engine-backed PGLite brain. */
async function makePGLite() {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine;
}

/** Make an empty git repo. Lint/backlinks have nothing to scan → status=clean. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-dream-repo-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email t@t.co', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name t', { cwd: dir, stdio: 'pipe' });
  // Commit an empty .gitkeep so rev-parse HEAD succeeds.
  require('fs').writeFileSync(join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

// ─── brainDir resolution ───────────────────────────────────────────

describe('runDream — brainDir resolution', () => {
  let repo: string;
  let engine: InstanceType<typeof PGLiteEngine>;

  beforeEach(async () => {
    repo = makeGitRepo();
    engine = await makePGLite();
  }, 60_000);

  afterEach(async () => {
    await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  test('explicit --dir takes precedence over engine config', async () => {
    await engine.setConfig('sync.repo_path', '/configured/dir');
    const report = await runDream(engine, ['--dir', repo, '--json']);
    expect(report).toBeTruthy();
    if (report) expect(report.brain_dir).toBe(repo);
  });

  test('no --dir + engine-configured: uses engine.getConfig("sync.repo_path")', async () => {
    await engine.setConfig('sync.repo_path', repo);
    const report = await runDream(engine, ['--json']);
    expect(report).toBeTruthy();
    if (report) expect(report.brain_dir).toBe(repo);
  });

  test('no --dir + engine=null exits 1', async () => {
    const spy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(null, []);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(spy).toHaveBeenCalledWith(1);
    spy.mockRestore();
    errSpy.mockRestore();
  });

  test('--dir pointing at nonexistent path exits 1', async () => {
    const spy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(null, ['--dir', '/does/not/exist/hopefully']);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(spy).toHaveBeenCalledWith(1);
    spy.mockRestore();
    errSpy.mockRestore();
  });
});

// ─── Phase selection (single-phase runs stay fast) ─────────────────

describe('runDream — --phase <name> restricts the cycle', () => {
  let repo: string;
  let engine: InstanceType<typeof PGLiteEngine>;

  beforeEach(async () => {
    repo = makeGitRepo();
    engine = await makePGLite();
  }, 60_000);

  afterEach(async () => {
    await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  test('--phase lint produces a report with exactly one phase = lint', async () => {
    const report = await runDream(engine, ['--dir', repo, '--phase', 'lint', '--json']);
    expect(report).toBeTruthy();
    if (report) {
      expect(report.phases.length).toBe(1);
      expect(report.phases[0].phase).toBe('lint');
    }
  });

  test('--phase orphans produces a report with exactly one phase = orphans', async () => {
    const report = await runDream(engine, ['--dir', repo, '--phase', 'orphans', '--json']);
    expect(report).toBeTruthy();
    if (report) {
      expect(report.phases.length).toBe(1);
      expect(report.phases[0].phase).toBe('orphans');
    }
  });

  test('--phase garbage exits 1 with an error message', async () => {
    const spy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDream(null, ['--dir', repo, '--phase', 'garbage']);
    } catch (e: any) {
      expect(e.message).toBe('EXIT');
    }
    expect(errSpy).toHaveBeenCalled();
    spy.mockRestore();
    errSpy.mockRestore();
  });
});

// ─── Output format ─────────────────────────────────────────────────

describe('runDream — output format', () => {
  let repo: string;
  let engine: InstanceType<typeof PGLiteEngine>;

  beforeEach(async () => {
    repo = makeGitRepo();
    engine = await makePGLite();
  }, 60_000);

  afterEach(async () => {
    await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  test('--json emits parsable CycleReport JSON with schema_version', async () => {
    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(String(msg)); });
    await runDream(engine, ['--dir', repo, '--phase', 'lint', '--json']);
    logSpy.mockRestore();
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.schema_version).toBe('1');
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('phases');
    expect(parsed).toHaveProperty('totals');
  });

  test('human output for clean status mentions "Brain is healthy"', async () => {
    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(String(msg)); });
    // Single-phase lint run on a clean repo → status=clean.
    await runDream(engine, ['--dir', repo, '--phase', 'lint']);
    logSpy.mockRestore();
    expect(lines.join('\n')).toContain('Brain is healthy');
  });
});

// ─── Dry-run propagation ───────────────────────────────────────────

describe('runDream — dry-run propagates through to runCycle', () => {
  let repo: string;
  let engine: InstanceType<typeof PGLiteEngine>;

  beforeEach(async () => {
    repo = makeGitRepo();
    engine = await makePGLite();
  }, 60_000);

  afterEach(async () => {
    await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  test('--dry-run produces a report where no DB-mutating work happened', async () => {
    // Before: empty pages table.
    const { rows: before } = await (engine as any).db.query('SELECT COUNT(*)::int AS n FROM pages');
    expect(before[0].n).toBe(0);

    await runDream(engine, ['--dir', repo, '--dry-run', '--json']);

    // After dry-run: still 0 pages. The cycle ran but wrote nothing.
    const { rows: after } = await (engine as any).db.query('SELECT COUNT(*)::int AS n FROM pages');
    expect(after[0].n).toBe(0);
  });
});

// ─── Exit-code semantics ───────────────────────────────────────────

describe('runDream — exit-code semantics', () => {
  let repo: string;
  let engine: InstanceType<typeof PGLiteEngine>;

  beforeEach(async () => {
    repo = makeGitRepo();
    engine = await makePGLite();
  }, 60_000);

  afterEach(async () => {
    await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  test('clean/ok/partial statuses do not call process.exit', async () => {
    const spy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('UNEXPECTED_EXIT'); });
    await runDream(engine, ['--dir', repo, '--phase', 'lint', '--json']);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
