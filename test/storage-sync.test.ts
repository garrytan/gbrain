/**
 * Tests for sync.ts manageGitignore() — step 8 of v0.22.3 storage tiering.
 *
 * Issue #2: function was defined but never invoked. Now wired into runSync
 * after a successful sync (skips on dry_run / blocked_by_failures / failure).
 *
 * Tests cover: happy path, idempotency, GBRAIN_NO_GITIGNORE escape hatch,
 * submodule detection, write-error graceful degradation, and the "no
 * config — no-op" path.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { manageGitignore } from '../src/commands/sync.ts';
import { __resetMissingStorageWarning } from '../src/core/storage-config.ts';

let tmp: string;
let warnings: string[];
let originalWarn: typeof console.warn;
let originalEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-mgi-test-'));
  __resetMissingStorageWarning();
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  originalEnv = process.env.GBRAIN_NO_GITIGNORE;
  delete process.env.GBRAIN_NO_GITIGNORE;
});

afterEach(() => {
  console.warn = originalWarn;
  if (originalEnv === undefined) delete process.env.GBRAIN_NO_GITIGNORE;
  else process.env.GBRAIN_NO_GITIGNORE = originalEnv;
  // Restore permissions for cleanup.
  try {
    chmodSync(tmp, 0o755);
  } catch {
    /* ignore */
  }
  rmSync(tmp, { recursive: true, force: true });
});

function writeStorageConfig(): void {
  writeFileSync(
    join(tmp, 'gbrain.yml'),
    `storage:
  db_tracked:
    - people/
  db_only:
    - media/x/
    - media/articles/
`,
  );
}

describe('manageGitignore', () => {
  test('no-op when gbrain.yml is absent', () => {
    manageGitignore(tmp);
    expect(existsSync(join(tmp, '.gitignore'))).toBe(false);
    expect(warnings).toEqual([]);
  });

  test('no-op when storage config has empty db_only', () => {
    writeFileSync(
      join(tmp, 'gbrain.yml'),
      `storage:
  db_tracked:
    - people/
  db_only: []
`,
    );
    manageGitignore(tmp);
    expect(existsSync(join(tmp, '.gitignore'))).toBe(false);
  });

  test('appends db_only directories to .gitignore — happy path', () => {
    writeStorageConfig();
    manageGitignore(tmp);
    const content = readFileSync(join(tmp, '.gitignore'), 'utf-8');
    expect(content).toContain('# Auto-managed by gbrain');
    expect(content).toContain('media/x/');
    expect(content).toContain('media/articles/');
  });

  test('idempotent — running twice does NOT duplicate entries', () => {
    writeStorageConfig();
    manageGitignore(tmp);
    manageGitignore(tmp);
    const content = readFileSync(join(tmp, '.gitignore'), 'utf-8');
    const xCount = (content.match(/^media\/x\/$/gm) || []).length;
    const articlesCount = (content.match(/^media\/articles\/$/gm) || []).length;
    expect(xCount).toBe(1);
    expect(articlesCount).toBe(1);
  });

  test('preserves user-written .gitignore entries', () => {
    writeStorageConfig();
    writeFileSync(join(tmp, '.gitignore'), '# my own rules\n*.swp\nnode_modules/\n');
    manageGitignore(tmp);
    const content = readFileSync(join(tmp, '.gitignore'), 'utf-8');
    expect(content).toContain('# my own rules');
    expect(content).toContain('*.swp');
    expect(content).toContain('node_modules/');
    expect(content).toContain('media/x/');
  });

  test('GBRAIN_NO_GITIGNORE=1 skips entirely', () => {
    writeStorageConfig();
    process.env.GBRAIN_NO_GITIGNORE = '1';
    manageGitignore(tmp);
    expect(existsSync(join(tmp, '.gitignore'))).toBe(false);
  });

  test('skips with actionable warning when repo is a git submodule', () => {
    writeStorageConfig();
    // Submodule: .git is a file containing `gitdir: ...` instead of a directory.
    writeFileSync(join(tmp, '.git'), 'gitdir: ../.git/modules/sub\n');
    manageGitignore(tmp);
    expect(existsSync(join(tmp, '.gitignore'))).toBe(false);
    expect(warnings.some((w) => /submodule/.test(w))).toBe(true);
  });

  test('proceeds when .git is a directory (regular repo)', () => {
    writeStorageConfig();
    mkdirSync(join(tmp, '.git'));
    manageGitignore(tmp);
    expect(existsSync(join(tmp, '.gitignore'))).toBe(true);
    expect(warnings.filter((w) => /submodule/.test(w))).toEqual([]);
  });

  test('warns and skips when .gitignore write fails (read-only filesystem simulation)', () => {
    writeStorageConfig();
    // Create a .gitignore as a directory — write to that path will fail with EISDIR.
    mkdirSync(join(tmp, '.gitignore'));
    manageGitignore(tmp);
    expect(warnings.some((w) => /Could not (read|update)/.test(w))).toBe(true);
  });
});
