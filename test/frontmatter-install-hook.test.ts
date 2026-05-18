import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { installHook, uninstallHook } from '../src/commands/frontmatter-install-hook.ts';

function gitInit(dir: string) {
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
}

describe('frontmatter install-hook (B13)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fm-hook-'));
    gitInit(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('installHook writes executable .githooks/pre-commit and sets core.hooksPath', () => {
    const result = installHook(tmp, false);
    expect(result).toBe('installed');
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    expect(existsSync(hookPath)).toBe(true);
    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('gbrain frontmatter');
    expect(content).toContain('git diff --cached');
    // Configured hooksPath
    const hooksPath = execFileSync('git', ['-C', tmp, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
    expect(hooksPath).toBe('.githooks');
  });

  test('installHook refuses to clobber existing hook without --force', () => {
    const hooksDir = join(tmp, '.githooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"');
    const result = installHook(tmp, false);
    expect(result).toBe('skipped_existing');
    // Original survives.
    expect(readFileSync(hookPath, 'utf8')).toContain('user hook');
    expect(existsSync(hookPath + '.bak')).toBe(false);
  });

  test('installHook with force overwrites and saves .bak', () => {
    const hooksDir = join(tmp, '.githooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"');
    const result = installHook(tmp, true);
    expect(result).toBe('installed');
    expect(existsSync(hookPath + '.bak')).toBe(true);
    expect(readFileSync(hookPath + '.bak', 'utf8')).toContain('user hook');
    expect(readFileSync(hookPath, 'utf8')).toContain('gbrain frontmatter');
  });

  test('installHook on existing gbrain hook refreshes silently (no .bak)', () => {
    installHook(tmp, false);
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    expect(existsSync(hookPath + '.bak')).toBe(false);
    // Re-run; should be 'unchanged' (banner already present).
    const second = installHook(tmp, false);
    expect(second).toBe('unchanged');
  });

  test('uninstallHook removes the gbrain hook and restores .bak when present', () => {
    const hooksDir = join(tmp, '.githooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"');
    installHook(tmp, true);
    expect(existsSync(hookPath + '.bak')).toBe(true);

    const removed = uninstallHook(tmp);
    expect(removed).toBe(true);
    // .bak content restored as the active hook.
    expect(readFileSync(hookPath, 'utf8')).toContain('user hook');
    expect(existsSync(hookPath + '.bak')).toBe(false);
  });

  test('uninstallHook on a non-gbrain hook returns false (does not remove user hook)', () => {
    const hooksDir = join(tmp, '.githooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"');
    const removed = uninstallHook(tmp);
    expect(removed).toBe(false);
    expect(readFileSync(hookPath, 'utf8')).toContain('user hook');
  });
});
