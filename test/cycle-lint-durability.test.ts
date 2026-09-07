import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { runPhaseLint } from '../src/core/cycle.ts';
import { runLintCore } from '../src/commands/lint.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A committed git repo carrying the gbrain durability post-commit hook and
 * one page whose only lint issue is fixable (ingested_at without created).
 */
function hardenedRepoWithNote(opts: { hook?: boolean } = {}): { root: string; page: string } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-cycle-lint-durability-'));
  roots.push(root);
  const page = join(root, 'note.md');
  writeFileSync(
    page,
    `---\ntype: note\ntitle: Durable\nstatus: active\ningested_at: '2026-08-30T12:00:00Z'\n---\n\nBody.\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['add', '--', 'note.md'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  if (opts.hook === false) return { root, page };

  const hook = join(root, '.git', 'hooks', 'post-commit');
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  writeFileSync(
    hook,
    '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n',
  );
  chmodSync(hook, 0o755);
  return { root, page };
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

describe('cycle lint durability', () => {
  test('a hardened corpus commits exactly the page lint fixed', async () => {
    const { root } = hardenedRepoWithNote();

    const result = await runPhaseLint(root, false, null);

    expect(result.status).toBe('ok');
    expect(result.details?.fixed).toBe(1);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'log', '-1', '--format=%s')).toBe('gbrain: write-through note');
  });

  test('a single-file target (gbrain lint --fix page.md) probes the page\'s directory for the hook', async () => {
    const { root, page } = hardenedRepoWithNote();

    const result = await runLintCore({ target: page, fix: true });

    expect(result.total_fixed).toBe(1);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'log', '-1', '--format=%s')).toBe('gbrain: write-through note');
  });

  test('a plain git repo without the durability hook repairs but does NOT commit (#4815 regression)', async () => {
    const { root } = hardenedRepoWithNote({ hook: false });

    const result = await runPhaseLint(root, false, null);

    expect(result.details?.fixed).toBe(1);
    expect(git(root, 'status', '--porcelain')).toBe('M note.md'); // trimmed ' M note.md' — repair on disk, uncommitted
    expect(git(root, 'log', '-1', '--format=%s')).toBe('initial');
  });

  test('dry-run repairs nothing and commits nothing', async () => {
    const { root } = hardenedRepoWithNote();

    const result = await runPhaseLint(root, true, null);

    expect(result.details?.fixed).toBe(1);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'log', '-1', '--format=%s')).toBe('initial');
  });
});
