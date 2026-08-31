/**
 * Behavioral tests for scripts/run-serial-tests.sh's POOLED execution:
 *
 *   1. All-pass: pooled files run concurrently, one-line PASS summaries,
 *      exit 0.
 *   2. One failing file: exit 1, full log echoed, failed-files summary.
 *   3. Hung file: killed by the per-file wall-clock timeout (exit 124/137
 *      surfaced with a timeout note) — the exit-hang class containment.
 *      Skipped when no timeout/gtimeout binary exists on the host.
 *
 * The missing-sentinel(=failure) and EXCLUSIVE_FILES growth guards are
 * source-pinned in test/scripts/serial-files.test.ts; these tests exercise
 * the live pool in a minimal-PATH sandbox (same pattern as
 * run-unit-parallel.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, chmodSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');

let ROOT: string;
let ENV: Record<string, string>;
let hasTimeoutBin = false;

function stageSandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-serial-pool-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  for (const s of ['run-serial-tests.sh', 'lib/test-env.sh']) {
    mkdirSync(dirname(join(root, 'scripts', s)), { recursive: true });
    copyFileSync(resolve(REPO_ROOT, 'scripts', s), join(root, 'scripts', s));
  }
  chmodSync(join(root, 'scripts', 'run-serial-tests.sh'), 0o755);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const tools = [
    'bash', 'sh', 'env', 'dirname', 'basename', 'mktemp', 'date', 'sleep',
    'cat', 'tail', 'head', 'rm', 'mkdir', 'grep', 'sed', 'awk', 'wc', 'tr',
    'find', 'sort', 'bun', 'timeout', 'gtimeout',
  ];
  for (const tool of tools) {
    const p = Bun.which(tool);
    if (p) {
      symlinkSync(p, join(bin, tool));
      if (tool === 'timeout' || tool === 'gtimeout') hasTimeoutBin = true;
    }
  }
  return root;
}

function runScript(extraEnv: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [join(ROOT, 'scripts', 'run-serial-tests.sh')], {
      cwd: ROOT,
      encoding: 'utf-8',
      env: { ...ENV, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const PASSING = `import { describe, it, expect } from 'bun:test';
describe('passing', () => { it('works', () => { expect(1 + 1).toBe(2); }); });`;

const FAILING = `import { describe, it, expect } from 'bun:test';
describe('failing', () => { it('POOL_SENTINEL_ASSERTION breaks', () => { expect(1).toBe(2); }); });`;

const HANGING = `import { it } from 'bun:test';
it('hangs forever', async () => { await new Promise(() => {}); });`;

beforeAll(() => {
  ROOT = stageSandbox();
  ENV = {
    PATH: join(ROOT, 'bin'),
    HOME: process.env.HOME ?? ROOT,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    // Sandbox has no package.json — skip the snapshot build path entirely.
    GBRAIN_NO_SNAPSHOT: '1',
    GBRAIN_SERIAL_POOL: '2',
  };
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('pooled serial runner', () => {
  it('runs pooled files and passes with one-line summaries', () => {
    writeFileSync(join(ROOT, 'test', 'a-ok.serial.test.ts'), PASSING);
    writeFileSync(join(ROOT, 'test', 'b-ok.serial.test.ts'), PASSING);
    const r = runScript();
    expect(r.code).toBe(0);
    expect(r.out).toContain('PASS');
    expect(r.out).toContain('test/a-ok.serial.test.ts');
    expect(r.out).toContain('test/b-ok.serial.test.ts');
    expect(r.out).toContain('all 2 file(s) passed');
    expect(r.out).toContain('pool=2');
    rmSync(join(ROOT, 'test', 'a-ok.serial.test.ts'));
    rmSync(join(ROOT, 'test', 'b-ok.serial.test.ts'));
  });

  it('a failing file fails the run with its full log and a failed-files summary', () => {
    writeFileSync(join(ROOT, 'test', 'a-ok.serial.test.ts'), PASSING);
    writeFileSync(join(ROOT, 'test', 'z-bad.serial.test.ts'), FAILING);
    const r = runScript();
    expect(r.code).toBe(1);
    // Full bun log of the failing file is echoed (its assertion name shows).
    expect(r.out).toContain('POOL_SENTINEL_ASSERTION');
    expect(r.out).toContain('1 file(s) failed');
    expect(r.out).toContain('test/z-bad.serial.test.ts');
    // The passing sibling still reports PASS (pool completes, no fail-fast).
    expect(r.out).toContain('PASS');
    rmSync(join(ROOT, 'test', 'a-ok.serial.test.ts'));
    rmSync(join(ROOT, 'test', 'z-bad.serial.test.ts'));
  });

  it('--dry-run-list lists every serial file without running anything', () => {
    writeFileSync(join(ROOT, 'test', 'a-ok.serial.test.ts'), PASSING);
    const out = execFileSync(
      'bash',
      [join(ROOT, 'scripts', 'run-serial-tests.sh'), '--dry-run-list'],
      { cwd: ROOT, encoding: 'utf-8', env: ENV },
    );
    expect(out.trim().split('\n')).toEqual(['test/a-ok.serial.test.ts']);
    rmSync(join(ROOT, 'test', 'a-ok.serial.test.ts'));
  });

  it('an externally-SIGTERMed file is rescued by a sequential re-run (phantom stays green)', () => {
    // Self-kills with SIGTERM on first run (exit 143 — the external-kill
    // class: sibling-workspace cleanup, memory jetsam), passes on the
    // rescue re-run. Mirrors run-unit-parallel's oom-once fixture.
    const sentinel = join(ROOT, 'test', 'killed-once.sentinel');
    const KILLED_ONCE = `import { it, expect } from 'bun:test';
import { existsSync, writeFileSync } from 'fs';
it('passes after one external SIGTERM', () => {
  const sentinel = ${JSON.stringify(sentinel)};
  if (!existsSync(sentinel)) {
    writeFileSync(sentinel, '1');
    process.kill(process.pid, 'SIGTERM');
  }
  expect(1).toBe(1);
});`;
    writeFileSync(join(ROOT, 'test', 'k-killed.serial.test.ts'), KILLED_ONCE);
    try {
      const r = runScript();
      // (The "queued for serial rescue" line goes to stderr, which the
      // success path of runScript doesn't capture — the stdout rescue
      // marker + exit 0 are the contract.)
      expect(r.out).toContain('rescued: external-kill phantom');
      expect(r.code).toBe(0);
    } finally {
      rmSync(join(ROOT, 'test', 'k-killed.serial.test.ts'), { force: true });
      rmSync(sentinel, { force: true });
    }
  }, 60000);

  it('a hung file is killed by the per-file wall-clock timeout', () => {
    if (!hasTimeoutBin) return; // macOS without coreutils: no wrapper, documented
    writeFileSync(join(ROOT, 'test', 'h-hang.serial.test.ts'), HANGING);
    const r = runScript({ GBRAIN_SERIAL_FILE_TIMEOUT: '3' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('per-file timeout');
    expect(r.out).toContain('test/h-hang.serial.test.ts');
    rmSync(join(ROOT, 'test', 'h-hang.serial.test.ts'));
  }, 60000);

  it('dispatches heaviest-first from serial-weights.json (LPT); --dry-run-list stays discovery-ordered', () => {
    // The aggregation loop prints PASS lines in pool_files order, so stdout
    // order IS dispatch order regardless of pool width. Weights are advisory:
    // the sort must reorder dispatch without touching the discovery list.
    writeFileSync(join(ROOT, 'test', 'a-light.serial.test.ts'), PASSING);
    writeFileSync(join(ROOT, 'test', 'm-mid.serial.test.ts'), PASSING);
    writeFileSync(join(ROOT, 'test', 'z-heavy.serial.test.ts'), PASSING);
    writeFileSync(join(ROOT, 'scripts', 'serial-weights.json'), JSON.stringify({
      'test/a-light.serial.test.ts': 1,
      'test/m-mid.serial.test.ts': 10,
      'test/z-heavy.serial.test.ts': 30,
    }));
    try {
      const dry = execFileSync(
        'bash',
        [join(ROOT, 'scripts', 'run-serial-tests.sh'), '--dry-run-list'],
        { cwd: ROOT, encoding: 'utf-8', env: ENV },
      );
      expect(dry.trim().split('\n')).toEqual([
        'test/a-light.serial.test.ts',
        'test/m-mid.serial.test.ts',
        'test/z-heavy.serial.test.ts',
      ]);
      const r = runScript();
      expect(r.code).toBe(0);
      const passOrder = [...r.out.matchAll(/\] PASS \d+s (\S+)/g)].map((m) => m[1]);
      expect(passOrder).toEqual([
        'test/z-heavy.serial.test.ts',
        'test/m-mid.serial.test.ts',
        'test/a-light.serial.test.ts',
      ]);
    } finally {
      rmSync(join(ROOT, 'test', 'a-light.serial.test.ts'), { force: true });
      rmSync(join(ROOT, 'test', 'm-mid.serial.test.ts'), { force: true });
      rmSync(join(ROOT, 'test', 'z-heavy.serial.test.ts'), { force: true });
      rmSync(join(ROOT, 'scripts', 'serial-weights.json'), { force: true });
    }
  }, 60000);

  it('a corrupt serial-weights.json falls back to discovery order (fail-soft)', () => {
    writeFileSync(join(ROOT, 'test', 'a-first.serial.test.ts'), PASSING);
    writeFileSync(join(ROOT, 'test', 'b-second.serial.test.ts'), PASSING);
    // Truncated JSON that, if a lenient parser ever "recovered" it, would put
    // b-second FIRST (weight 99) — so this test distinguishes the fail-soft
    // branch from an accidentally-parsed sort, not just from a crash.
    writeFileSync(
      join(ROOT, 'scripts', 'serial-weights.json'),
      '{"test/b-second.serial.test.ts": 99, "test/a-first.serial.test.ts": 1',
    );
    try {
      const r = runScript();
      expect(r.code).toBe(0);
      const passOrder = [...r.out.matchAll(/\] PASS \d+s (\S+)/g)].map((m) => m[1]);
      expect(passOrder).toEqual([
        'test/a-first.serial.test.ts',
        'test/b-second.serial.test.ts',
      ]);
    } finally {
      rmSync(join(ROOT, 'test', 'a-first.serial.test.ts'), { force: true });
      rmSync(join(ROOT, 'test', 'b-second.serial.test.ts'), { force: true });
      rmSync(join(ROOT, 'scripts', 'serial-weights.json'), { force: true });
    }
  }, 60000);
});
