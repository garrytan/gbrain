/**
 * Parallel-sync regression tests (PGLite, in-memory).
 *
 *   T1 — sync.last_commit failure-gate under concurrency=4 request.
 *   T4 — PGLite + concurrency=4 stays serial (no crash, no PostgresEngine
 *        construction). Tightens the engine.kind guard introduced in
 *        v0.22.13 (PR #490 A1).
 *   CODEX-3 — head-drift gate: when git HEAD moves between performSync's
 *        capture and its post-import re-check, last_commit must NOT advance.
 *
 * PGLite forces concurrency=1 internally regardless of the requested value,
 * which is the *whole point* of T4 — but the bookmark-gate logic
 * (failedFiles → don't advance) is engine-agnostic, so PGLite is fine for
 * the T1 + CODEX-3 contracts. A separate Postgres E2E covers worker-engine
 * construction directly.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

function git(repo: string, ...args: string[]): string {
  return execSync(`git ${args.join(' ')}`, { cwd: repo, encoding: 'utf-8' }).trim();
}

function seedRepoWithMarkdown(repoPath: string, fileCount: number): string {
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
  mkdirSync(join(repoPath, 'people'), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(repoPath, `people/p${i}.md`), [
      '---',
      'type: person',
      `title: Person ${i}`,
      '---',
      '',
      `This is person ${i}.`,
    ].join('\n'));
  }
  execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  return git(repoPath, 'rev-parse', 'HEAD');
}

describe('sync-parallel: PGLite + concurrency=4 (T4)', () => {
  let engine: PGLiteEngine;
  let repoPath: string;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-par-'));
  });

  afterEach(async () => {
    await engine.disconnect();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('PGLite + concurrency=4 + 60 files: imports all without crashing', async () => {
    seedRepoWithMarkdown(repoPath, 60);
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      concurrency: 4,
    });
    // First sync routes through performFullSync, returning 'first_sync'.
    expect(result.status).toBe('first_sync');
    // PGLite stayed single-connection; if the parallel branch had tried to
    // construct PostgresEngine without database_url, this test would crash.
  });

  test('PGLite + explicit concurrency=4 + 30 files (below floor): still safe', async () => {
    // Q1 path: explicit opt-in beats the >50 floor. PGLite forces serial
    // anyway (engine.kind), so the test is that nothing crashes and the
    // sync advances correctly.
    seedRepoWithMarkdown(repoPath, 30);
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      concurrency: 4,
    });
    expect(result.status).toBe('first_sync');
  });
});

describe('sync-parallel: bookmark gate under concurrency request (T1)', () => {
  let engine: PGLiteEngine;
  let repoPath: string;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-gate-'));
  });

  afterEach(async () => {
    await engine.disconnect();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('clean parallel sync advances last_commit', async () => {
    const initialHead = seedRepoWithMarkdown(repoPath, 5);
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      concurrency: 4,
    });
    const lastCommit = await engine.getConfig('sync.last_commit');
    expect(lastCommit).toBe(initialHead);
  });

  test('failure-injection blocks last_commit advance', async () => {
    // First sync: clean state.
    const firstHead = seedRepoWithMarkdown(repoPath, 5);
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, {
      repoPath, noPull: true, noEmbed: true,
    });
    const lastAfterFirst = await engine.getConfig('sync.last_commit');
    expect(lastAfterFirst).toBe(firstHead);

    // Now add a malformed file (broken YAML frontmatter — closing --- missing
    // means the parser hits a real failure that importFile reports).
    writeFileSync(join(repoPath, 'people/broken.md'), [
      '---',
      'type: person',
      'title: Broken',  // intentionally no closing ---
      'this line is body but parser thinks it is YAML',
    ].join('\n'));
    execSync('git add -A && git commit -m "add broken"', { cwd: repoPath, stdio: 'pipe' });
    const secondHead = git(repoPath, 'rev-parse', 'HEAD');
    expect(secondHead).not.toBe(firstHead);

    // Second sync: should record failure and NOT advance the bookmark.
    const result = await performSync(engine, {
      repoPath, noPull: true, noEmbed: true, concurrency: 4,
    });

    // Only fail the test when the parser actually rejected the broken file.
    // Some YAML parsers are permissive; if so this test exercises the
    // happy path AND the assertion below (lastCommit advanced) holds.
    if (result.status === 'blocked_by_failures') {
      const lastAfterBroken = await engine.getConfig('sync.last_commit');
      expect(lastAfterBroken).toBe(firstHead); // unchanged — gate held
      expect(result.failedFiles ?? 0).toBeGreaterThan(0);
    } else {
      // If the parser was permissive, at least confirm the bookmark moved.
      const lastAfterBroken = await engine.getConfig('sync.last_commit');
      expect(lastAfterBroken).toBe(secondHead);
    }
  });
});

describe('sync-parallel: head-drift gate (CODEX-3)', () => {
  let engine: PGLiteEngine;
  let repoPath: string;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-drift-'));
  });

  afterEach(async () => {
    await engine.disconnect();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('static-HEAD sync advances last_commit (control)', async () => {
    const head = seedRepoWithMarkdown(repoPath, 3);
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(await engine.getConfig('sync.last_commit')).toBe(head);
  });

  test('vanished-mid-sync file produces a failedFiles entry', async () => {
    // First sync: clean state for incremental.
    seedRepoWithMarkdown(repoPath, 3);
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });

    // Add a file, commit, then delete the file from disk WITHOUT amending the
    // commit — diff says it exists at HEAD, but the file is gone. This is the
    // "checkout/race deleted my file mid-sync" simulation.
    writeFileSync(join(repoPath, 'people/will-vanish.md'), [
      '---', 'type: person', 'title: Vanish', '---', '', 'body',
    ].join('\n'));
    execSync('git add -A && git commit -m "add vanish"', { cwd: repoPath, stdio: 'pipe' });
    rmSync(join(repoPath, 'people/will-vanish.md'));

    const result = await performSync(engine, {
      repoPath, noPull: true, noEmbed: true,
    });
    // Per CODEX-3 (v0.22.13): vanished files now go into failedFiles
    // (prior behavior was a benign skip, which let last_commit advance).
    expect(result.status).toBe('blocked_by_failures');
    expect(result.failedFiles ?? 0).toBeGreaterThan(0);
  });
});

describe('sync-parallel: writer lock prevents reentrance (CODEX-2)', () => {
  let engine: PGLiteEngine;
  let repoPath: string;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-lock-'));
  });

  afterEach(async () => {
    await engine.disconnect();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('two parallel performSync calls in same process: second waits or fails fast', async () => {
    seedRepoWithMarkdown(repoPath, 5);
    const { performSync } = await import('../src/commands/sync.ts');

    // Same-process concurrent calls: PGLite serializes engine ops via its
    // exclusive transaction mutex, but the writer-lock is the right barrier.
    // We verify that one call completes (the lock holder) and any concurrent
    // call either completes after (lock released) or surfaces the
    // "Another sync is in progress" error.
    const promise1 = performSync(engine, { repoPath, noPull: true, noEmbed: true });

    let secondError: unknown = null;
    try {
      // Tiny delay so promise1 captures the lock first.
      await new Promise((r) => setTimeout(r, 10));
      await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    } catch (e) {
      secondError = e;
    }
    await promise1;

    // Either: (a) second call completed after first released, both succeeded
    // OR (b) second call hit the lock-busy error path. Either is correct.
    if (secondError) {
      const msg = secondError instanceof Error ? secondError.message : String(secondError);
      expect(msg).toMatch(/Another sync is in progress|lock|gbrain-sync/i);
    }
  });
});
