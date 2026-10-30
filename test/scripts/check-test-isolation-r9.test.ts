/**
 * Fixture tests for rule R9 of scripts/check-test-isolation.sh: a non-serial unit file that installs a process-global
 * hook (the cli-socket output capture, the stdio console redirect, the SIGCHLD reaper) must undo it from an
 * afterEach/afterAll hook. Each one patches console, stderr, a signal listener or a module scope for the rest of the
 * shard process: cli-socket.test.ts left the capture installed and cli-socket-context.test.ts failed in the same shard.
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

function lintOne(contents: string, path = 'global-hook.test.ts'): { status: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lint-isolation-r9-'));
  mkdirSync(join(dir, 'test'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'test', path), contents);
  writeFileSync(join(dir, 'scripts/check-test-isolation.allowlist'), '');
  const r = spawnSync('bash', [LINT_SH, 'test'], { cwd: dir, encoding: 'utf-8' });
  return { status: r.status ?? -1, stdout: r.stdout };
}

const IMPORTS = `import { afterAll, afterEach, test } from 'bun:test';\n`;
const CAPTURE = `test('captured', () => { installOutputCapture(); });\n`;

describe('check-test-isolation.sh R9: a process-global hook must be undone from an after-hook', () => {
  it('bad fixture: the output capture installed with no undo fails, naming the call line and the undo', () => {
    const r = lintOne(IMPORTS + CAPTURE);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('test/global-hook.test.ts');
    expect(r.stdout).toContain('rule R9');
    expect(r.stdout).toContain('_uninstallOutputCaptureForTests');
    expect(r.stdout).toContain("2:test('captured', () => { installOutputCapture(); });");
  });

  it('bad fixture: starting a cli-socket serve installs the capture too', () => {
    const r = lintOne(IMPORTS + `test('serve', async () => { (await startCliSocketServer({} as never))?.close(); });\n`);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('rule R9');
  });

  it('bad fixture: an inline undo in the test body is not an after-hook undo', () => {
    const r = lintOne(IMPORTS + `test('t', () => { try { installOutputCapture(); } finally { _uninstallOutputCaptureForTests(); } });\n`);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('rule R9');
  });

  it('bad fixtures: the stdio redirect reset only inline, and the SIGCHLD reaper with no undo', () => {
    for (const [body, undo] of [
      [`test('serve', () => { runServeStub(); _resetStdoutRedirectForTests(); });\n`, '_resetStdoutRedirectForTests'],
      [`test('redirect', () => { redirectStdoutLoggingToStderr(); });\n`, '_resetStdoutRedirectForTests'],
      [`test('reap', () => { installSigchldHandler(); });\n`, '_uninstallSigchldHandlerForTests'],
    ] as const) {
      const r = lintOne(IMPORTS + body);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('rule R9');
      expect(r.stdout).toContain(undo);
    }
  });

  it('good fixtures: an afterEach or afterAll undo passes, in block, arrow and reference form', () => {
    for (const hook of [
      `afterEach(() => { _uninstallOutputCaptureForTests(); });\n`,
      `afterEach(() => _uninstallOutputCaptureForTests());\n`,
      `afterAll(() => {\n  _uninstallOutputCaptureForTests();\n});\n`,
      `afterEach(_uninstallOutputCaptureForTests);\n`,
    ]) {
      const r = lintOne(IMPORTS + CAPTURE + hook);
      expect(r.stdout).toContain('check-test-isolation: OK');
      expect(r.status).toBe(0);
    }
    expect(lintOne(IMPORTS + `test('reap', () => { installSigchldHandler(); });\nafterAll(() => _uninstallSigchldHandlerForTests());\n`).status).toBe(0);
    expect(lintOne(IMPORTS + `test('serve', () => { redirectStdoutLoggingToStderr(); });\nafterEach(() => _resetStdoutRedirectForTests());\n`).status).toBe(0);
  });

  it('an undo that only appears in a comment does not count', () => {
    for (const undo of [
      `// afterEach(() => _uninstallOutputCaptureForTests()) lives in a sibling file\n`,
      `/**\n * afterAll(_uninstallOutputCaptureForTests) would go here.\n */\n`,
    ]) {
      const r = lintOne(IMPORTS + CAPTURE + undo);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('rule R9');
    }
  });

  it('an installer mention that only appears in a comment is not a call', () => {
    for (const mention of [
      `// installOutputCapture() is what the serve calls\n`,
      `/*\n  installSigchldHandler();\n*/\n`,
    ]) {
      expect(lintOne(mention + `test('u', () => {});\n`).status).toBe(0);
    }
  });

  it('serial files are out of scope for R9', () => {
    expect(lintOne(IMPORTS + CAPTURE, 'global-hook.serial.test.ts').status).toBe(0);
  });
});
