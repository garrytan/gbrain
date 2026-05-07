/**
 * Fixture-driven unit tests for scripts/check-test-isolation.sh.
 *
 * Spawns the script in a tmpdir with hand-crafted fake test files and
 * asserts the lint's exit code + violation messages match expectations.
 * No env mutation, no mock.module, no PGLite — this test file is itself
 * subject to the lint (it ships outside *.serial.test.ts and outside
 * test/e2e/).
 */

import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const LINT_SH = resolve(REPO_ROOT, 'scripts/check-test-isolation.sh');

interface FakeFile {
  /** Path relative to the tmpdir's `test/` directory. */
  path: string;
  contents: string;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runLintIn(files: FakeFile[], allowlist: string[] = []): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'lint-isolation-'));
  mkdirSync(join(dir, 'test'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });

  for (const f of files) {
    const full = join(dir, 'test', f.path);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, f.contents);
  }
  // Empty allowlist file ensures the script reads OUR allowlist, not the
  // real repo's, regardless of git toplevel resolution.
  writeFileSync(
    join(dir, 'scripts/check-test-isolation.allowlist'),
    allowlist.length > 0 ? allowlist.join('\n') + '\n' : '',
  );

  const r = spawnSync('bash', [LINT_SH, 'test'], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe('check-test-isolation.sh', () => {
  describe('clean files', () => {
    it('returns 0 when no test files violate any rule', () => {
      const r = runLintIn([
        {
          path: 'a.test.ts',
          contents: `import { test, expect } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n`,
        },
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('check-test-isolation: OK');
    });
  });

  describe('R1 — env mutation', () => {
    it('flags process.env.X = assignment', () => {
      const r = runLintIn([
        {
          path: 'env-write.test.ts',
          contents: `process.env.OOPS = 'bad';\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R1');
      expect(r.stdout).toContain('env-write.test.ts');
    });

    it('flags process.env[bracket] = assignment', () => {
      const r = runLintIn([
        {
          path: 'env-bracket.test.ts',
          contents: `process.env['OOPS'] = 'bad';\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R1');
    });

    it('flags delete process.env.X', () => {
      const r = runLintIn([
        {
          path: 'env-delete.test.ts',
          contents: `delete process.env.OOPS;\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R1');
    });

    it('flags Object.assign(process.env, ...)', () => {
      const r = runLintIn([
        {
          path: 'env-assign.test.ts',
          contents: `Object.assign(process.env, { OOPS: 'bad' });\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R1');
    });

    it('flags Reflect.set(process.env, ...)', () => {
      const r = runLintIn([
        {
          path: 'env-reflect.test.ts',
          contents: `Reflect.set(process.env, 'OOPS', 'bad');\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R1');
    });

    it('does NOT flag a comparison like process.env.X === ...', () => {
      const r = runLintIn([
        {
          path: 'env-read.test.ts',
          contents: `if (process.env.X === 'y') {}\n`,
        },
      ]);
      expect(r.status).toBe(0);
    });
  });

  describe('R2 — mock.module()', () => {
    it('flags mock.module(...)', () => {
      const r = runLintIn([
        {
          path: 'mocks.test.ts',
          contents: `import { mock } from 'bun:test';\nmock.module('foo', () => ({}));\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R2');
    });
  });

  describe('R3 — new PGLiteEngine() outside beforeAll context', () => {
    it('flags engine created at module top-level', () => {
      const r = runLintIn([
        {
          path: 'pglite-toplevel.test.ts',
          contents: `import { PGLiteEngine } from '../src/core/pglite-engine.ts';\nconst engine = new PGLiteEngine();\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R3');
    });

    it('does NOT flag engine created within ~50 lines of a beforeAll', () => {
      const r = runLintIn([
        {
          path: 'pglite-ok.test.ts',
          contents:
            `import { beforeAll, afterAll, test, expect } from 'bun:test';\n` +
            `import { PGLiteEngine } from '../src/core/pglite-engine.ts';\n` +
            `let engine: PGLiteEngine;\n` +
            `beforeAll(async () => {\n` +
            `  engine = new PGLiteEngine();\n` +
            `  await engine.connect({});\n` +
            `});\n` +
            `afterAll(async () => { await engine.disconnect(); });\n` +
            `test('x', () => expect(1).toBe(1));\n`,
        },
      ]);
      expect(r.status).toBe(0);
    });
  });

  describe('R4 — afterAll/disconnect pairing', () => {
    it('flags engine creation without afterAll{disconnect}', () => {
      const r = runLintIn([
        {
          path: 'pglite-no-disconnect.test.ts',
          contents:
            `import { beforeAll, test, expect } from 'bun:test';\n` +
            `import { PGLiteEngine } from '../src/core/pglite-engine.ts';\n` +
            `let engine: PGLiteEngine;\n` +
            `beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); });\n` +
            `test('x', () => expect(1).toBe(1));\n`,
        },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('R4');
    });
  });

  describe('scope', () => {
    it('skips *.serial.test.ts files entirely', () => {
      const r = runLintIn([
        {
          path: 'naughty.serial.test.ts',
          contents: `process.env.OOPS = 'bad';\nimport { mock } from 'bun:test';\nmock.module('foo', () => ({}));\n`,
        },
      ]);
      expect(r.status).toBe(0);
    });

    it('skips test/e2e/ subtree', () => {
      const r = runLintIn([
        {
          path: 'e2e/leak.test.ts',
          contents: `process.env.OOPS = 'bad';\n`,
        },
      ]);
      expect(r.status).toBe(0);
    });
  });

  describe('allowlist', () => {
    it('skips files listed in the allowlist', () => {
      const r = runLintIn(
        [
          {
            path: 'legacy.test.ts',
            contents: `process.env.OOPS = 'bad';\n`,
          },
        ],
        ['test/legacy.test.ts'],
      );
      expect(r.status).toBe(0);
    });

    it('still flags files NOT in the allowlist when allowlist is non-empty', () => {
      const r = runLintIn(
        [
          {
            path: 'allowed.test.ts',
            contents: `process.env.X = 'a';\n`,
          },
          {
            path: 'fresh.test.ts',
            contents: `process.env.Y = 'b';\n`,
          },
        ],
        ['test/allowed.test.ts'],
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('fresh.test.ts');
      expect(r.stdout).not.toContain('allowed.test.ts');
    });

    it('treats # comments and blank lines in allowlist as no-ops', () => {
      const r = runLintIn(
        [
          {
            path: 'legacy.test.ts',
            contents: `process.env.OOPS = 'bad';\n`,
          },
        ],
        ['# legacy file', '', 'test/legacy.test.ts'],
      );
      expect(r.status).toBe(0);
    });
  });
});
