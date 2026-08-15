/**
 * #2426 (bug 1) — write-through reaches git on durability-hardened repos.
 *
 * Bug class: `put_page` / capture / enrichment wrote `.md` into
 * `sync.repo_path` but NOTHING ever committed it. The post-commit hook only
 * fires after a commit — and write-through never made one — so write-through
 * content accumulated uncommitted forever: never pushed, `last_sync_at`
 * frozen (HEAD never moved), and silently deleted by a later `sync --full`
 * delete-reconcile.
 *
 * Fix: `writePageThrough` best-effort commits the artifact (path-limited)
 * when the repo carries the gbrain durability post-commit hook (i.e. the
 * user opted in via `gbrain sources harden`); the hook then background-pushes.
 * Unhardened repos keep the old write-only behavior.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { writePageThrough } from '../src/core/write-through.ts';

let engine: PGLiteEngine;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
}

/** Install a hook file carrying the gbrain durability banner (the detection
 *  key `isDurabilityHardened` looks for) with a no-op body so tests never
 *  attempt a real push. */
function installFakeDurabilityHook(repoPath: string): void {
  const hooksDir = join(repoPath, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'post-commit');
  writeFileSync(hookPath, [
    '#!/usr/bin/env bash',
    '# gbrain brain-durability post-commit hook (v0.42.44+)',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(hookPath, 0o755);
}

async function seedPage(slug: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'concept',
    title: 'Write-through page',
    compiled_truth: 'Content that must reach git.',
    timeline: '',
    frontmatter: { type: 'concept' },
  });
}

describe('#2426 — writePageThrough auto-commit', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    repo = mkdtempSync(join(tmpdir(), 'gbrain-wt-'));
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'seed.md'), 'seed\n');
    execSync('git add -A && git commit -m init', { cwd: repo, stdio: 'pipe' });
    await engine.setConfig('sync.repo_path', repo);
  });

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test('on a hardened repo, the write-through artifact is committed (path-limited)', async () => {
    installFakeDurabilityHook(repo);
    // Unrelated dirty edit — must NOT be swept into the write-through commit.
    writeFileSync(join(repo, 'seed.md'), 'dirty unrelated edit\n');

    await seedPage('notes/hello');
    const result = await writePageThrough(engine, 'notes/hello');

    expect(result.written).toBe(true);
    expect(result.committed).toBe(true);
    // The artifact is committed…
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('gbrain: write-through notes/hello');
    expect(git(repo, 'log', '-1', '--name-only', '--format=')).toBe('notes/hello.md');
    expect(git(repo, 'status', '--porcelain', 'notes/hello.md')).toBe('');
    // …and the unrelated edit stays uncommitted (explicit-path discipline).
    expect(git(repo, 'status', '--porcelain', 'seed.md')).not.toBe('');
  }, 60_000);

  test('on an unhardened repo, the file is written but NOT committed (no behavior change)', async () => {
    await seedPage('notes/plain');
    const result = await writePageThrough(engine, 'notes/plain');

    expect(result.written).toBe(true);
    expect(result.committed).toBeUndefined();
    // Untracked, uncommitted — the pre-existing contract.
    expect(git(repo, 'status', '--porcelain', 'notes/plain.md')).toContain('?? notes/plain.md');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('init');
  }, 60_000);
});
