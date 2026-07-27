/**
 * v0.32.7 CJK wave — real-git E2E for core.quotepath=false fix.
 *
 * Hermetic: no DATABASE_URL, no API keys. Spawns real `git` in a tmpdir,
 * commits a markdown file with a CJK filename, and asserts buildSyncManifest
 * receives the UTF-8 path literal — not the octal-escaped form git emits by
 * default. Unit tests pin the args array; this test proves real-CLI behavior.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSyncManifest } from '../../src/core/sync.ts';
import { buildGitInvocation } from '../../src/commands/sync.ts';

let repoPath: string;

beforeAll(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-cjk-git-'));
  execFileSync('git', ['-C', repoPath, 'init', '--quiet']);
  execFileSync('git', ['-C', repoPath, 'config', 'user.email', 'cjk-test@example.com']);
  execFileSync('git', ['-C', repoPath, 'config', 'user.name', 'CJK Test']);
  execFileSync('git', ['-C', repoPath, 'config', 'commit.gpgsign', 'false']);
});

afterAll(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

function gitWithHelper(args: string[]): string {
  // Mirrors the production helper at src/commands/sync.ts:git()
  return execFileSync('git', buildGitInvocation(repoPath, args), {
    encoding: 'utf-8',
    timeout: 30000,
  }).trim();
}

describe('real git emits UTF-8 paths with core.quotepath=false', () => {
  test('Chinese filename round-trips through diff --name-status', () => {
    // Create + commit a Chinese-named markdown file
    const filename = '品牌圣经.md';
    writeFileSync(join(repoPath, filename), '# 测试\n\nbody\n');
    execFileSync('git', ['-C', repoPath, 'add', '--all']);
    execFileSync('git', ['-C', repoPath, 'commit', '--quiet', '-m', 'add chinese file']);

    // Diff against the empty tree (the file is the only thing in the commit)
    const emptyTree = execFileSync('git', ['-C', repoPath, 'hash-object', '-t', 'tree', '--stdin'], {
      input: '',
      encoding: 'utf-8',
    }).trim();
    const diff = gitWithHelper(['diff', '--name-status', '-M', `${emptyTree}..HEAD`]);

    // The literal CJK chars should appear; the octal-escape form (\345\223\201) should NOT
    expect(diff).toContain('品牌圣经.md');
    expect(diff).not.toContain('\\345');

    const manifest = buildSyncManifest(diff);
    expect(manifest.added).toContain('品牌圣经.md');
  });

  test('Japanese filename with spaces (Apple Notes export pattern)', () => {
    // Make sure we have a clean base commit before this case
    const initialHead = gitWithHelper(['rev-parse', 'HEAD']);

    const filename = '2026-04-14 22_38 記録-個人智能体_原文.md';
    mkdirSync(join(repoPath, 'inbox'), { recursive: true });
    writeFileSync(join(repoPath, 'inbox', filename), '# meeting\n');
    execFileSync('git', ['-C', repoPath, 'add', '--all']);
    execFileSync('git', ['-C', repoPath, 'commit', '--quiet', '-m', 'add jp file']);

    const diff = gitWithHelper(['diff', '--name-status', '-M', `${initialHead}..HEAD`]);
    expect(diff).toContain('記録-個人智能体_原文.md');
    expect(diff).not.toMatch(/\\\d{3}/); // no octal-escape sequences anywhere

    const manifest = buildSyncManifest(diff);
    expect(manifest.added.some(p => p.includes('記録-個人智能体_原文.md'))).toBe(true);
  });

  test('rename entry with CJK paths', () => {
    const beforeRename = gitWithHelper(['rev-parse', 'HEAD']);

    // Rename the first file. -M in diff catches it.
    execFileSync('git', ['-C', repoPath, 'mv', '品牌圣经.md', '销售论证文档.md']);
    execFileSync('git', ['-C', repoPath, 'commit', '--quiet', '-m', 'rename chinese file']);

    const diff = gitWithHelper(['diff', '--name-status', '-M', `${beforeRename}..HEAD`]);
    expect(diff).toContain('销售论证文档.md');
    expect(diff).not.toMatch(/\\\d{3}/);

    const manifest = buildSyncManifest(diff);
    expect(manifest.renamed.some(r => r.to === '销售论证文档.md' && r.from === '品牌圣经.md')).toBe(true);
  });
});
