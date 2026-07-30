/**
 * Guards the bug class that made `gbrain apply-migrations` unusable on Windows.
 *
 * `child_process.execSync` runs its command string through a shell — `/bin/sh`
 * on POSIX, but `cmd.exe` on Windows. cmd.exe does not understand POSIX
 * redirection, so a command written for sh silently misbehaves there.
 *
 * The concrete regression (migrations/v0_12_0.ts, phase E):
 *
 *   execSync('gbrain get_stats --json 2>/dev/null || gbrain stats', { timeout: 30_000 })
 *
 * On Windows cmd.exe tries to create a file literally named `\dev\null`, fails
 * with `Access is denied.`, produces no output, and then burns the ENTIRE
 * declared timeout rather than falling through to the `||` branch. Probed
 * directly it threw `spawnSync cmd.exe ETIMEDOUT` after 30.7s. That made phase E
 * unreachable, so v0.12.0 finished `PARTIAL` on every run — and
 * `MAX_CONSECUTIVE_PARTIALS = 3` then marks the migration WEDGED on the third
 * attempt. Removing it cut a full cascade from 698.3s to 335.3s.
 *
 * Migration orchestrators run on every user's machine during upgrade, so they
 * are the worst place to hide a POSIX-only assumption. Express the fallback in
 * TypeScript (try one command, then the next) and use `stdio` to discard a
 * stream instead of `2>/dev/null`.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoPath } from './helpers/repo-root.ts';

const MIGRATIONS_DIR = repoPath('src', 'commands', 'migrations');

/** Shell constructs cmd.exe either cannot run or runs with different semantics. */
const POSIX_SHELL_CONSTRUCTS: { pattern: RegExp; why: string }[] = [
  { pattern: /2>\s*\/dev\/null/, why: "`2>/dev/null` — cmd.exe writes a file named \\dev\\null (Access is denied). Use stdio: ['ignore','pipe','ignore']." },
  { pattern: />\s*\/dev\/null/, why: '`>/dev/null` — same problem. Use stdio to discard.' },
  { pattern: /\|\|/, why: '`||` fallback — express the fallback in TypeScript so a failure is caught, not shelled.' },
  { pattern: /&&/, why: '`&&` chaining — run the commands as separate calls.' },
  { pattern: /\$\(/, why: '`$(...)` command substitution — not supported by cmd.exe.' },
  { pattern: /(^|[^|])\|([^|]|$)/, why: '`|` pipe — pipe semantics differ; do the filtering in TypeScript.' },
];

/**
 * First string-literal argument of every `execSync(...)` / `runGbrainSubprocess(...)`
 * call in a source file. Only literals — a concatenated or templated command is
 * out of scope for a static check like this.
 */
function subprocessCommandLiterals(source: string): string[] {
  const out: string[] = [];
  const call = /\b(?:execSync|runGbrainSubprocess)\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const m of source.matchAll(call)) out.push(m[2]);
  return out;
}

describe('migration orchestrators — subprocess commands must be cmd.exe-safe', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.ts'));

  test('the migrations directory is actually being scanned', () => {
    // Guards the check itself: a bad path would make every assertion below
    // vacuously pass.
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain('v0_12_0.ts');
  });

  test('no execSync/runGbrainSubprocess literal uses POSIX-only shell syntax', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      for (const cmd of subprocessCommandLiterals(source)) {
        for (const { pattern, why } of POSIX_SHELL_CONSTRUCTS) {
          if (pattern.test(cmd)) violations.push(`${file}: ${JSON.stringify(cmd)}\n    → ${why}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('the scanner detects the exact v0.12.0 regression string', () => {
    // Negative control — proves the matcher would have caught the original.
    const original = `execSync('gbrain get_stats --json 2>/dev/null || gbrain stats', { timeout: 30_000 })`;
    const [cmd] = subprocessCommandLiterals(original);
    expect(cmd).toBe('gbrain get_stats --json 2>/dev/null || gbrain stats');
    expect(POSIX_SHELL_CONSTRUCTS.some(c => c.pattern.test(cmd))).toBe(true);
  });
});
