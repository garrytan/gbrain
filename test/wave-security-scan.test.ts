/**
 * Exit-code contract tests for scripts/wave-security-scan.sh — the mechanical
 * security sweep RELEASING.md step 5 gates community-PR waves on.
 *
 * Contract: exit 0 = nothing alarm-worthy; exit 1 = alarm (obfuscation in code,
 * secrets, admin/dist change, or a broken secrets lane); exit 2 = usage/env
 * error. Each case runs against a throwaway fixture git repo (same pattern as
 * scripts/changelog-entry.sh's fixture tests in test/release-workflow.test.ts).
 *
 * gitleaks may be absent on a dev box; the script treats that as a broken
 * secrets lane (fail-closed exit 1 with a WARNING) — cases that assert exit 0
 * therefore skip when gitleaks is not installed.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'wave-security-scan.sh');

const HAS_GITLEAKS = (() => {
  try {
    execSync('command -v gitleaks', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function run(cwd: string, args: string[]): { out: string; stdout: string; code: number } {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { out: stdout, stdout, code: 0 };
  } catch (e: any) {
    // Keep stdout separate: on a non-zero exit (e.g. the fail-closed
    // gitleaks-missing lane on CI runners) the script prints a WARNING to
    // stderr, and a concatenated stream would put that line after the JSON.
    return { out: String(e.stdout ?? '') + String(e.stderr ?? ''), stdout: String(e.stdout ?? ''), code: e.status ?? 1 };
  }
}

/** Last JSON object line on stdout — robust to any trailing/leading notices. */
function lastJson(stdout: string): any {
  const line = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.trimStart().startsWith('{'));
  if (!line) throw new Error(`no JSON line in stdout:\n${stdout}`);
  return JSON.parse(line);
}

/** Fixture repo with a base commit; returns its path. Caller adds commits. */
function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-wavescan-'));
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: 'ignore' });
  git('init -q');
  git('config user.email t@example.invalid');
  git('config user.name t');
  git('config commit.gpgsign false'); // don't inherit the machine's signing config under load
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git('add README.md');
  git('commit -qm base');
  return dir;
}

function commitFile(dir: string, rel: string, content: string, msg: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  execSync(`git add ${JSON.stringify(rel)} && git commit -qm ${JSON.stringify(msg)}`, { cwd: dir, stdio: 'ignore' });
}

describe('wave-security-scan.sh exit-code contract', () => {
  test('exit 2: not a resolvable range', () => {
    const dir = fixtureRepo();
    try {
      expect(run(dir, ['not-a-ref..HEAD']).code).toBe(2);
      expect(run(dir, ['HEAD']).code).toBe(2); // missing ..head form
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('exit 0: empty range, --json emits the standard schema', () => {
    const dir = fixtureRepo();
    try {
      const { stdout, code } = run(dir, ['--json', 'HEAD..HEAD']);
      expect(code).toBe(0);
      const parsed = lastJson(stdout);
      expect(parsed.commits).toBe(0);
      expect(parsed.alarm).toBe(0);
      expect(parsed).toHaveProperty('checks');
      expect(parsed).toHaveProperty('admin_dist_changed');
      expect(parsed).toHaveProperty('gitleaks_hits');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test.skipIf(!HAS_GITLEAKS)('exit 0: benign code change', () => {
    const dir = fixtureRepo();
    try {
      commitFile(dir, 'src/util.ts', 'export const add = (a: number, b: number) => a + b;\n', 'benign');
      const { out, code } = run(dir, ['HEAD~1..HEAD']);
      expect(code).toBe(0);
      expect(out).toContain('gitleaks');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('exit 1: eval( in an added code line is an ALARM', () => {
    const dir = fixtureRepo();
    try {
      commitFile(dir, 'src/sneaky.ts', 'export const run = (s: string) => eval(s);\n', 'sneaky');
      const { out, code } = run(dir, ['HEAD~1..HEAD']);
      expect(code).toBe(1);
      expect(out).toContain('obfuscation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('exit 1: admin/dist change is an ALARM even though its content is not grepped', () => {
    const dir = fixtureRepo();
    try {
      commitFile(dir, 'admin/dist/assets/index-XYZ.js', 'var x=1;\n', 'bundle');
      const { out, code } = run(dir, ['HEAD~1..HEAD']);
      expect(code).toBe(1);
      expect(out).toContain('admin/dist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('eval( in a markdown file is NOT an alarm (prose, not payload)', () => {
    const dir = fixtureRepo();
    try {
      commitFile(dir, 'docs/notes.md', 'We never call eval( in production code.\n', 'docs');
      // No exit-code assertion here: on a runner without gitleaks the script
      // fail-closes (exit 1, broken secrets lane) by design — this case only
      // pins that markdown prose never counts as obfuscation.
      const { stdout } = run(dir, ['--json', 'HEAD~1..HEAD']);
      const parsed = lastJson(stdout);
      expect(parsed.checks.obfuscation.total).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
