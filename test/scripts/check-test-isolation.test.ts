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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
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

function runLintIn(files: FakeFile[], allowlist: string[] = [], env: Record<string, string> = {}): RunResult {
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
    env: { ...process.env, ...env },
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

    it('batches candidate scans instead of starting grep for every clean file', () => {
      const bin = mkdtempSync(join(tmpdir(), 'lint-grep-count-'));
      const log = join(bin, 'calls');
      writeFileSync(join(bin, 'grep'), `#!/usr/bin/env bash\nprintf 'grep\\n' >> "$GREP_CALL_LOG"\nexec "$REAL_GREP" "$@"\n`, { mode: 0o755 });
      try {
        const files = Array.from({ length: 260 }, (_, i) => ({ path: `clean ${i}.test.ts`, contents: 'if (process.env.TEST_MODE === "yes") {}\n' }));
        const env = { PATH: `${bin}:${process.env.PATH}`, GREP_CALL_LOG: log, REAL_GREP: Bun.which('grep')! };
        const r = runLintIn(
          files,
          [],
          env,
        );
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('260 non-serial unit files scanned');
        expect(readFileSync(log, 'utf8').trim().split('\n').length).toBeLessThan(10);
        const bad = runLintIn([...files, { path: 'z bad.test.ts', contents: `Reflect.set(process.env, 'OOPS', 'bad');\n` }], [], env);
        expect(bad.status).toBe(1);
        expect(bad.stdout).toContain('z bad.test.ts');
        expect(bad.stdout).toContain('rule R1');
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
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

    it('keeps the exact 50-line boundary and reports violations in later candidate files', () => {
      const r = runLintIn([
        { path: 'a clean.test.ts', contents: 'export {};\n' },
        { path: 'b boundary.test.ts', contents: `beforeAll(() => {});\n${'\n'.repeat(49)}new PGLiteEngine();\nafterAll(() => engine.disconnect());\n` },
        { path: 'c outside.test.ts', contents: `beforeAll(() => {});\n${'\n'.repeat(50)}new PGLiteEngine();\nafterAll(() => engine.disconnect());\n` },
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('rule R3');
      expect(r.stdout).toContain('c outside.test.ts');
      expect(r.stdout).not.toContain('b boundary.test.ts');
      expect(r.stdout).toContain('52:new PGLiteEngine();');
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

  describe('R5: a configured gateway must be reset', () => {
    const IMPORTS = `import { afterAll, afterEach, beforeAll, test } from 'bun:test';\n` +
      `import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';\n`;
    const CONFIGURE = `beforeAll(() => configureGateway({ embedding_model: 'litellm:example-embed', env: {} }));\n`;
    const lintOne = (contents: string, path = 'gateway-user.test.ts') => runLintIn([{ path, contents }]);

    it('flags a file that configures the gateway and never resets it, naming the call line', () => {
      const r = lintOne(IMPORTS + CONFIGURE + `test('t', () => {});\n`);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('test/gateway-user.test.ts');
      expect(r.stdout).toContain('rule R5');
      expect(r.stdout).toContain('3:beforeAll(() => configureGateway(');
    });

    it('control: the same file with an afterEach reset passes', () => {
      const r = lintOne(IMPORTS + CONFIGURE + `afterEach(() => resetGateway());\n`);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('check-test-isolation: OK');
    });

    it('flags a call through a dynamic import and a call with a space before the paren', () => {
      for (const call of [
        `test('t', async () => { (await import('../src/core/ai/gateway.ts')).configureGateway({ env: {} }); });\n`,
        `beforeAll(() => configureGateway ({ env: {} }));\n`,
      ]) {
        const r = lintOne(call);
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('rule R5');
      }
    });

    it('a reset that only appears in a comment does not count', () => {
      for (const reset of [
        `// afterAll(() => resetGateway()) is handled by a sibling file\n`,
        `/**\n * The suite would call resetGateway() here.\n */\n`,
        `test('t', () => {}); // TODO resetGateway()\n`,
      ]) {
        const r = lintOne(IMPORTS + CONFIGURE + reset);
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('rule R5');
      }
    });

    it('a configureGateway mention that only appears in a comment is not a call', () => {
      for (const mention of [
        `// configureGateway() is set up by the preload\n`,
        `/*\n  configureGateway({ env: {} });\n*/\n`,
        `test('t', () => {}); // unlike configureGateway(), this needs no reset\n`,
      ]) {
        expect(lintOne(mention + `test('u', () => {});\n`).status).toBe(0);
      }
    });

    it('a URL or a glob on a code line does not hide the reset', () => {
      const r = lintOne(
        IMPORTS + CONFIGURE +
        `const fixtures = 'test/*.json';\n` +
        `afterAll(() => { const u = 'http://localhost:4000'; void u; resetGateway(); });\n`,
      );
      expect(r.status).toBe(0);
    });

    it('the subprocess opt-out exempts a file whose call runs in a child script', () => {
      const body = 'const child = `\n  configureGateway({ env: {} });\n`;\nvoid child;\n';
      expect(lintOne(`// isolation-lint: R5-subprocess-only (runs in the spawned child)\n` + body).status).toBe(0);
      const control = lintOne(body);
      expect(control.status).toBe(1);
      expect(control.stdout).toContain('rule R5');
    });

    it('serial files are out of scope for R5', () => {
      expect(lintOne(IMPORTS + CONFIGURE, 'gateway-user.serial.test.ts').status).toBe(0);
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

describe('check-test-isolation.sh --as-parallel', () => {
  function runAsParallel(files: FakeFile[], targets: string[]): RunResult {
    const dir = mkdtempSync(join(tmpdir(), 'lint-isolation-parallel-'));
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts/check-test-isolation.allowlist'), '');
      for (const f of files) {
        const full = join(dir, 'test', f.path);
        mkdirSync(resolve(full, '..'), { recursive: true });
        writeFileSync(full, f.contents);
      }
      const r = spawnSync('bash', [LINT_SH, '--as-parallel', ...targets.map(t => `test/${t}`)], { cwd: dir, encoding: 'utf-8' });
      return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('lints a serial file as if it ran in the parallel pool', () => {
    const r = runAsParallel([{ path: 'env.serial.test.ts', contents: "process.env.EXAMPLE_FLAG = '1';\n" }], ['env.serial.test.ts']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('ERROR: test/env.serial.test.ts');
    expect(r.stdout).toContain('rule R1');
  });

  it('passes a parallel-safe serial file and lints only the named files', () => {
    const r = runAsParallel([
      { path: 'clean.serial.test.ts', contents: "import { test } from 'bun:test';\ntest('x', () => {});\n" },
      { path: 'other.serial.test.ts', contents: "mock.module('x', () => ({}));\n" },
    ], ['clean.serial.test.ts']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK (1 ');
  });

  it('requires at least one file', () => {
    const r = runAsParallel([], []);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--as-parallel FILE');
  });
});
