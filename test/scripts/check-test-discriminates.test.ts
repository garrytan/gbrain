import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const helper = join(import.meta.dir, '../../scripts/check-test-discriminates.sh');
const source = 'subject.ts';
const regression = 'subject.test.ts';
const patched = 'export const label = "fixed";\n';

function withRun(preFix: string | undefined, check: (result: { status: number | null; stdout: string; stderr: string }) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-discriminates-'));
  try {
    const env = {
      HOME: dir,
      TMPDIR: dir,
      PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      NO_COLOR: '1',
    };
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', timeout: 5_000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git('init', '--quiet');
    if (preFix !== undefined) {
      writeFileSync(join(dir, source), preFix);
      git('add', '--', source);
    }
    const base = git('write-tree');
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(helper, join(dir, 'scripts/check-test-discriminates.sh'));
    writeFileSync(join(dir, source), patched);
    writeFileSync(join(dir, regression), `import { expect, test } from 'bun:test';
import { label } from './subject';
test('returns the expected label', () => expect(label).toBe('fixed'));
`);
    git('add', '--', source);

    const result = spawnSync('bash', ['scripts/check-test-discriminates.sh', `./${regression}`, source], {
      cwd: dir, env: { ...env, DISCRIMINATE_BASE: base }, encoding: 'utf8', timeout: 5_000,
    });
    expect(readFileSync(join(dir, source), 'utf8')).toBe(patched);
    check(result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the helper rejects an import crash when the reverted module did not exist', () => {
  withRun(undefined, result => {
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toContain('VACUOUS FAILURE');
    expect(result.stderr).toContain('reverting the fix commonly leaves a test import unresolved');
    expect(result.stdout).toBe('');
  });
});

test('the helper accepts a real failing assertion with the fix reverted', () => {
  withRun('export const label = "before";\n', result => {
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('0 pass / 1 fail');
  });
});
