/**
 * scripts/check-test-discriminates.sh — the per-PR discrimination helper.
 *
 * Protects its exit-code contract on a throwaway git repo with a real
 * `bun test` run: 0 when a test that ran fails pre-fix, 1 when the test is
 * green both ways, 3 when the pre-fix run fails without any test failing.
 * Regression it catches: a fix that adds a new module whose test imports it.
 * Reverting removes the module, bun reports `0 pass / 1 fail / 1 error` for
 * the unresolved import, and a summary-count parser read that as OK.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'check-test-discriminates.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** A repo whose HEAD~1 holds `before` and HEAD holds `after` (path -> content; null = absent). */
function repo(before: Record<string, string>, after: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), 'discriminate-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(SCRIPT, join(dir, 'scripts', 'check-test-discriminates.sh'));
  const write = (files: Record<string, string | null>) => {
    for (const [rel, body] of Object.entries(files)) {
      if (body === null) { rmSync(join(dir, rel), { force: true }); continue; }
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
  };
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'fixture@example.com');
  git(dir, 'config', 'user.name', 'fixture');
  git(dir, 'config', 'core.autocrlf', 'false');
  write(before);
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'before');
  write(after);
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'fix');
  return dir;
}

function discriminate(dir: string, testFile: string, ...sources: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, DISCRIMINATE_BASE: 'HEAD~1' };
  delete env.DATABASE_URL; delete env.GBRAIN_DATABASE_URL;
  const r = spawnSync('bash', [join(dir, 'scripts', 'check-test-discriminates.sh'), testFile, ...sources], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const TEST = "import { expect, test } from 'bun:test';\nimport { two } from '../lib/two.ts';\ntest('returns two', () => expect(two()).toBe(2));\n";

describe('check-test-discriminates.sh exit codes', () => {
  test('a test that ran and failed pre-fix discriminates (exit 0), and the source is restored', () => {
    const dir = repo({ 'lib/two.ts': 'export const two = () => 1;\n' }, { 'lib/two.ts': 'export const two = () => 2;\n', 'test/two.test.ts': TEST });
    const r = discriminate(dir, 'test/two.test.ts', 'lib/two.ts');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('→ 0 pass / 1 fail');
    expect(readFileSync(join(dir, 'lib/two.ts'), 'utf8')).toBe('export const two = () => 2;\n');
  }, 120_000);

  test('a test green both ways does not discriminate (exit 1)', () => {
    const dir = repo({ 'lib/two.ts': 'export const two = () => 2;\n' }, { 'lib/two.ts': 'export const two = () => 2; // touched\n', 'test/two.test.ts': TEST });
    expect(discriminate(dir, 'test/two.test.ts', 'lib/two.ts').code).toBe(1);
  }, 120_000);

  test('a reverted fix that removes the module the test imports is vacuous (exit 3), not OK', () => {
    const dir = repo({ 'lib/keep.ts': 'export const keep = 1;\n' }, { 'lib/two.ts': 'export const two = () => 2;\n', 'test/two.test.ts': TEST });
    const r = discriminate(dir, 'test/two.test.ts', 'lib/two.ts');
    expect(r.code, r.stderr).toBe(3);
    expect(r.stderr).toContain('VACUOUS FAILURE');
    expect(r.stderr).toContain('unhandled error');
    expect(r.stdout).not.toContain('Discrimination test:');
    expect(existsSync(join(dir, 'lib/two.ts'))).toBe(true);
  }, 120_000);
});
