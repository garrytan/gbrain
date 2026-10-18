/**
 * Fixture tests for rule R7 of scripts/check-test-isolation.sh (#6514): a non-serial unit file that calls
 * `__unconfigureGatewayForTests(` or `_clearGatewayForTests(` must put the preload's baseline gateway back from an
 * afterEach/afterAll hook. The unit lane shares one gateway object per shard process, so an unconfigured gateway left
 * behind by a throw or a `-t` filtered run reaches the next file's `beforeAll`.
 *
 * Same harness as test/scripts/check-test-isolation.test.ts: the lint runs in a tmpdir on hand-written fake files.
 * This file is itself subject to the lint; its fixture strings go verbatim into the tmpdir, never into this process.
 */

import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const LINT_SH = resolve(REPO_ROOT, 'scripts/check-test-isolation.sh');

function lintOne(contents: string, path = 'gateway-unconfigure.test.ts'): { status: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lint-isolation-r7-'));
  mkdirSync(join(dir, 'test'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'test', path), contents);
  writeFileSync(join(dir, 'scripts/check-test-isolation.allowlist'), '');
  const r = spawnSync('bash', [LINT_SH, 'test'], { cwd: dir, encoding: 'utf-8' });
  return { status: r.status ?? -1, stdout: r.stdout };
}

const IMPORTS = `import { afterAll, afterEach, beforeAll, test } from 'bun:test';\n` +
  `import { __unconfigureGatewayForTests, _clearGatewayForTests, resetGateway } from '../src/core/ai/gateway.ts';\n`;
const UNCONFIGURE = `test('unconfigured', () => { __unconfigureGatewayForTests(); });\n`;

describe('check-test-isolation.sh R7: an unconfigured gateway must be restored from an after-hook', () => {
  it('bad fixture: unconfigure with no after-hook restore fails, naming the call line', () => {
    const r = lintOne(IMPORTS + UNCONFIGURE);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('test/gateway-unconfigure.test.ts');
    expect(r.stdout).toContain('rule R7');
    expect(r.stdout).toContain("3:test('unconfigured', () => { __unconfigureGatewayForTests(); });");
  });

  it('bad fixture: an inline restore in the test body is not an after-hook restore', () => {
    const r = lintOne(IMPORTS + `test('unconfigured', () => { try { __unconfigureGatewayForTests(); } finally { resetGateway(); } });\n`);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('rule R7');
  });

  it('bad fixture: _clearGatewayForTests is covered too', () => {
    const r = lintOne(IMPORTS + `test('cleared', () => { _clearGatewayForTests(); });\n`);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('rule R7');
  });

  it('good fixtures: an afterEach or afterAll restore passes, in block, arrow and reference form', () => {
    for (const hook of [
      `afterEach(() => { resetGateway(); });\n`,
      `afterEach(() => resetGateway());\n`,
      `afterAll(() => {\n  resetGateway();\n});\n`,
      `afterEach(resetGateway);\n`,
    ]) {
      const r = lintOne(IMPORTS + UNCONFIGURE + hook);
      expect(r.stdout).toContain('check-test-isolation: OK');
      expect(r.status).toBe(0);
    }
  });

  it('a restore that only appears in a comment does not count', () => {
    for (const reset of [
      `// afterEach(() => resetGateway()) lives in a sibling file\n`,
      `/**\n * afterAll(resetGateway) would go here.\n */\n`,
    ]) {
      const r = lintOne(IMPORTS + UNCONFIGURE + reset);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('rule R7');
    }
  });

  it('an unconfigure mention that only appears in a comment is not a call', () => {
    for (const mention of [
      `// __unconfigureGatewayForTests() is what the fixture should have used\n`,
      `/*\n  _clearGatewayForTests();\n*/\n`,
    ]) {
      expect(lintOne(mention + `test('u', () => {});\n`).status).toBe(0);
    }
  });

  it('serial files are out of scope for R7', () => {
    expect(lintOne(IMPORTS + UNCONFIGURE, 'gateway-unconfigure.serial.test.ts').status).toBe(0);
  });
});
