/**
 * Fixture tests for rule R8 of scripts/check-test-isolation.sh: a non-serial unit file may not make its scratch
 * directory inside the source tree. test-reads-source-smell walks test/ in the same lane, and import-file.test.ts
 * creating and removing test/.tmp-import-test mid-walk failed it with ENOENT.
 *
 * Same harness as check-test-isolation-r7.test.ts: the lint runs in a tmpdir on hand-written fake files.
 */

import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const LINT_SH = resolve(REPO_ROOT, 'scripts/check-test-isolation.sh');

function lintOne(contents: string, path = 'scratch.test.ts'): { status: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lint-isolation-r8-'));
  mkdirSync(join(dir, 'test'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'test', path), contents);
  writeFileSync(join(dir, 'scripts/check-test-isolation.allowlist'), '');
  const r = spawnSync('bash', [LINT_SH, 'test'], { cwd: dir, encoding: 'utf-8' });
  return { status: r.status ?? -1, stdout: r.stdout };
}

describe('check-test-isolation.sh R8: no scratch directory inside the source tree', () => {
  it('bad fixtures: a .tmp or tmp path joined onto the test directory fails, naming the line', () => {
    for (const line of [
      // Split so this file's own source does not match the rule it tests.
      "const TMP = join(import.meta.dir," + " '.tmp-import-test');",
      'const TMP = join(import.meta.dirname,' + ' ".tmp");',
      "const TMP = path.join(__dirname," + " 'tmp/files');",
    ]) {
      const r = lintOne(`${line}\n`);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('rule R8');
      expect(r.stdout).toContain(`1:${line}`);
    }
  });

  it('good fixtures: a tmpdir scratch directory and fixture paths beside the test pass', () => {
    for (const line of [
      "const TMP = mkdtempSync(join(tmpdir(), 'gbrain-import-file-test-'));",
      "const FIXTURE = join(import.meta.dir, 'fixtures', 'tmpl.md');",
      "const TEMPLATES = join(import.meta.dir, 'templates');",
    ]) {
      const r = lintOne(`${line}\n`);
      expect(r.stdout).toContain('check-test-isolation: OK');
      expect(r.status).toBe(0);
    }
  });

  it('serial files are out of scope for R8', () => {
    expect(lintOne("const TMP = join(import.meta.dir," + " '.tmp-x');\n", 'scratch.serial.test.ts').status).toBe(0);
  });
});
