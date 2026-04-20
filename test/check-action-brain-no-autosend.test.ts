import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { join } from 'path';

const REPO = join(__dirname, '..');
const SCRIPT = join(REPO, 'scripts', 'check-action-brain-no-autosend.sh');
const FIXTURES = join(REPO, 'test', 'fixtures', 'check-no-autosend');

function run(targetPath: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [SCRIPT, targetPath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString?.() ?? '',
      stderr: err.stderr?.toString?.() ?? '',
    };
  }
}

describe('check-action-brain-no-autosend.sh', () => {
  test('passes on clean fixture', () => {
    const cleanDir = join(FIXTURES, 'clean');
    const result = run(cleanDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: no auto-send wording found');
  });

  test('fails on planted autosend violation fixture', () => {
    const badDir = join(FIXTURES, 'violation');
    const result = run(badDir);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('autosend');
    expect(result.stderr).toContain('Found forbidden auto-send wording');
  });

  test('exits 2 on nonexistent directory', () => {
    const result = run('/nonexistent/path-does-not-exist');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('does not exist');
  });
});
