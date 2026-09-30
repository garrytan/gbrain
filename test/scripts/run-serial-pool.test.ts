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
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, chmodSync, symlinkSync } from 'fs';
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
  for (const s of ['run-serial-tests.sh', 'lib/test-env.sh', 'sharding.ts']) {
    mkdirSync(dirname(join(root, 'scripts', s)), { recursive: true });
    copyFileSync(resolve(REPO_ROOT, 'scripts', s), join(root, 'scripts', s));
  }
  chmodSync(join(root, 'scripts', 'run-serial-tests.sh'), 0o755);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const tools = [
    'bash', 'sh', 'env', 'dirname', 'basename', 'mktemp', 'date', 'sleep',
    'cat', 'tail', 'head', 'rm', 'mkdir', 'grep', 'sed', 'awk', 'wc', 'tr',
    'find', 'sort', 'bun', 'timeout', 'gtimeout', 'pgrep',
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
    const timing = JSON.parse(readFileSync(join(ROOT, '.context/serial-timings.json'), 'utf8'));
    expect(timing).toMatchObject({ version: 1, lane: 'serial', complete: true });
    expect(timing.files).toHaveLength(2);
    for (const file of timing.files) {
      expect(file.status).toBe('pass');
      expect(file.durationMs).toBeGreaterThan(0);
      expect(file.attempts).toHaveLength(1);
    }
    rmSync(join(ROOT, 'test', 'a-ok.serial.test.ts'));
    rmSync(join(ROOT, 'test', 'b-ok.serial.test.ts'));
  });

  it('a failing file fails the run with its full log and a failed-files summary', () => {
    writeFileSync(join(ROOT, 'test', 'a-ok.serial.test.ts'), PASSING);
    writeFileSync(join(ROOT, 'test', 'z-bad.serial.test.ts'), FAILING);
    const coverage = join(ROOT, 'coverage-failure');
    mkdirSync(coverage);
    writeFileSync(join(coverage, 'lane-manifest.json'), JSON.stringify({ complete: true }));
    const r = runScript({ COVERAGE_DIR: coverage });
    expect(r.code).toBe(1);
    expect(existsSync(join(coverage, 'lane-manifest.json'))).toBe(false);
    const timing = JSON.parse(readFileSync(join(ROOT, '.context/serial-timings.json'), 'utf8'));
    expect(timing.complete).toBe(false);
    expect(timing.files.find((file: { file: string }) => file.file.endsWith('z-bad.serial.test.ts')).status).toBe('fail');
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
      const timing = JSON.parse(readFileSync(join(ROOT, '.context/serial-timings.json'), 'utf8'));
      const killed = timing.files.find((file: { file: string }) => file.file.endsWith('k-killed.serial.test.ts'));
      expect(killed.attempts.map((a: { status: string }) => a.status)).toEqual(['external-kill', 'pass']);
      expect(timing.complete).toBe(true);
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

  it('shards weighted files exactly once, with exclusive work only on shard 1 and no SHARD in children', () => {
    const names = ['a-heavy', 'b-mid', 'c-small', 'd-light', 'brain-repo-durability'];
    const files = names.map(name => `test/${name}.serial.test.ts`);
    writeFileSync(join(ROOT, 'fixture-module.ts'), 'export const answer = () => 42;\n');
    const child = `import { it, expect } from 'bun:test'; import { answer } from '../fixture-module.ts'; it('routing is consumed', () => { expect(process.env.SHARD).toBeUndefined(); expect(answer()).toBe(42); });`;
    for (const file of files) writeFileSync(join(ROOT, file), child);
    writeFileSync(join(ROOT, 'scripts/serial-weights.json'), JSON.stringify(Object.fromEntries(files.map((file, i) => [file, 100 - i * 20]))));
    try {
      const collected: string[] = [];
      for (let shard = 1; shard <= 4; shard++) {
        const shardEnv = { ...ENV, SHARD: `${shard}/4` };
        const list = execFileSync('bash', [join(ROOT, 'scripts/run-serial-tests.sh'), '--dry-run-list'], {
          cwd: ROOT, encoding: 'utf8', env: shardEnv,
        }).trim().split('\n').filter(Boolean);
        collected.push(...list);
        expect(list).toEqual([...list].sort());
        expect(list.includes(files[4])).toBe(shard === 1);
        const coverage = join(ROOT, `coverage-${shard}`);
        const result = runScript({ SHARD: `${shard}/4`, COVERAGE_DIR: coverage });
        expect(result.code, result.out).toBe(0);
        const timing = JSON.parse(readFileSync(join(ROOT, '.context/serial-timings.json'), 'utf8'));
        expect(timing.lane).toBe(`serial-${shard}`);
        expect(timing.files.map((file: { file: string }) => file.file).sort()).toEqual(list);
        const manifest = JSON.parse(readFileSync(join(coverage, 'lane-manifest.json'), 'utf8'));
        expect(manifest).toMatchObject({ lane: `serial-${shard}`, lcovCount: list.length, complete: true });
      }
      expect(collected.sort()).toEqual(files.sort());
    } finally {
      for (const file of files) rmSync(join(ROOT, file), { force: true });
      rmSync(join(ROOT, 'fixture-module.ts'), { force: true });
      rmSync(join(ROOT, 'scripts/serial-weights.json'), { force: true });
    }
  }, 60000);

  it('empty shards produce complete empty evidence and malformed SHARD fails', () => {
    writeFileSync(join(ROOT, 'test/a-only.serial.test.ts'), PASSING);
    try {
      const result = runScript({ SHARD: '4/4', COVERAGE_DIR: join(ROOT, 'coverage-empty') });
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain('all 0 file(s) passed');
      const timing = JSON.parse(readFileSync(join(ROOT, '.context/serial-timings.json'), 'utf8'));
      expect(timing).toMatchObject({ lane: 'serial-4', complete: true, files: [] });
      for (const SHARD of ['1', '0/4', '5/4', '1/0', '-1/4', '2/x']) {
        expect(runScript({ SHARD }).code).toBe(2);
      }
    } finally {
      rmSync(join(ROOT, 'test/a-only.serial.test.ts'), { force: true });
    }
  });

  it('cancellation propagates to owned descendants and records incomplete timing', async () => {
    const marker = join(ROOT, 'child.pid');
    writeFileSync(join(ROOT, 'test/cancel.serial.test.ts'), `import { it } from 'bun:test';
import { writeFileSync } from 'fs';
it('keeps a child alive', async () => {
  const child = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)']);
  writeFileSync(${JSON.stringify(marker)}, String(child.pid));
  await new Promise(() => {});
});`);
    const runner = Bun.spawn(['bash', join(ROOT, 'scripts/run-serial-tests.sh')], {
      cwd: ROOT, env: ENV, stdout: 'pipe', stderr: 'pipe',
    });
    let childPid = 0;
    try {
      const deadline = Date.now() + 10000;
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(marker)).toBe(true);
      childPid = Number(readFileSync(marker, 'utf8'));
      runner.kill('SIGTERM');
      expect(await runner.exited).toBe(143);
      // A dead child can briefly remain a zombie before init reaps it.
      const until = Date.now() + 3000;
      const alive = () => {
        try {
          const stat = readFileSync(`/proc/${childPid}/stat`, 'utf8');
          return stat.split(') ')[1]?.[0] !== 'Z';
        } catch { try { process.kill(childPid, 0); return true; } catch { return false; } }
      };
      while (alive() && Date.now() < until) await Bun.sleep(20);
      expect(alive()).toBe(false);
      const timing = JSON.parse(readFileSync(join(ROOT, '.context/serial-timings.json'), 'utf8'));
      expect(timing.complete).toBe(false);
      expect(timing.files[0].status).not.toBe('pass');
    } finally {
      try { runner.kill('SIGKILL'); } catch {}
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
      rmSync(join(ROOT, 'test/cancel.serial.test.ts'), { force: true });
      rmSync(marker, { force: true });
    }
  }, 20000);

  it.each([false, true])('exclusive cancellation allows graceful cleanup and records incomplete timing (rescue: %s)', async (rescue) => {
    const root = stageSandbox();
    const file = 'test/brain-repo-durability.serial.test.ts';
    const marker = join(root, 'exclusive.pid');
    const cleanup = join(root, 'cleanup-complete');
    const coverage = join(root, 'coverage');
    writeFileSync(join(root, file), `import { it } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
it('allows exclusive registration cleanup to finish', async () => {
  const attemptsFile = ${JSON.stringify(join(root, 'attempts'))};
  const attempt = existsSync(attemptsFile) ? Number(readFileSync(attemptsFile, 'utf8')) + 1 : 1;
  writeFileSync(attemptsFile, String(attempt));
  if (${rescue} && attempt === 1) { process.kill(process.pid, 'SIGTERM'); return; }
  let cancelling = false;
  process.on('SIGTERM', () => {
    if (cancelling) return;
    cancelling = true;
    writeFileSync(${JSON.stringify(join(root, 'received-term'))}, 'TERM');
    // Deliberately outlast the pooled runner's one-second escalation grace.
    // Finishing this cleanup proves exclusive work was not force-killed.
    setTimeout(() => {
      writeFileSync(${JSON.stringify(cleanup)}, 'finished');
      process.exit(0);
    }, 1500);
  });
  writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  await new Promise(() => {});
});`);
    const runner = Bun.spawn(['bash', join(root, 'scripts/run-serial-tests.sh')], {
      cwd: root,
      env: { ...ENV, PATH: join(root, 'bin'), SHARD: '1/4', COVERAGE_DIR: coverage },
      stdout: 'ignore', stderr: 'ignore',
    });
    let exclusivePid = 0;
    const alive = () => {
      if (!exclusivePid) return false;
      try {
        if (process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${exclusivePid}/stat`, 'utf8'))) return false;
        process.kill(exclusivePid, 0);
        return true;
      } catch { return false; }
    };
    try {
      const readyDeadline = Date.now() + 10000;
      while (!existsSync(marker) && Date.now() < readyDeadline) await Bun.sleep(20);
      expect(existsSync(marker)).toBe(true);
      exclusivePid = Number(readFileSync(marker, 'utf8'));
      runner.kill('SIGTERM');
      const exitDeadline = Date.now() + 5000;
      while ((runner.exitCode === null || !existsSync(cleanup) || alive()) && Date.now() < exitDeadline) await Bun.sleep(20);
      expect(runner.exitCode).toBe(143);
      expect(readFileSync(join(root, 'received-term'), 'utf8')).toBe('TERM');
      expect(readFileSync(cleanup, 'utf8')).toBe('finished');
      expect(alive()).toBe(false);
      expect(existsSync(join(coverage, 'lane-manifest.json'))).toBe(false);
      const timing = JSON.parse(readFileSync(join(root, '.context/serial-timings.json'), 'utf8'));
      expect(timing).toMatchObject({ lane: 'serial-1', complete: false });
      expect(timing.files).toHaveLength(1);
      expect(timing.files[0].file).toBe(file);
      expect(timing.files[0].status).not.toBe('pass');
      expect(timing.files[0].attempts).toHaveLength(rescue ? 2 : 1);
      if (rescue) expect(timing.files[0].attempts[0].status).toBe('external-kill');
    } finally {
      runner.kill('SIGKILL');
      if (alive()) { try { process.kill(exclusivePid, 'SIGKILL'); } catch { /* already exited */ } }
      await runner.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
