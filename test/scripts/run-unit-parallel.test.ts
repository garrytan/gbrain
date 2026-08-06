/**
 * Regression tests (a) + (d) for scripts/run-unit-parallel.sh:
 *   (a) Exit-code propagation: a failing test in any shard MUST cause the
 *       wrapper to exit non-zero. The hardest contract to silently break
 *       in a fan-out wrapper (`for ... &; wait` returns the LAST child's
 *       status, not any failure's).
 *   (d) Failure-log contract: when any test fails, the wrapper writes
 *       extracted failure block(s) to .context/test-failures.log with
 *       `--- shard $i:` prefixes, and prints a loud stderr banner with
 *       the absolute path. Empty log ⇔ exit 0.
 *
 * The wrapper takes ~1.5 minutes against the real test suite. To keep
 * this regression test fast and hermetic, we point it at a tiny tempdir
 * containing one passing and one failing test, override the discovery
 * roots via env-vars, and run with --shards=2.
 *
 * NOT covered here: the heartbeat (timing-sensitive and not load-bearing
 * for correctness). Timeout / WEDGED behavior uses a hermetic fake shard.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const PARALLEL_SH_SRC = resolve(REPO_ROOT, 'scripts/run-unit-parallel.sh');
const SHARD_SH_SRC = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');
const SERIAL_SH_SRC = resolve(REPO_ROOT, 'scripts/run-serial-tests.sh');

let TMPROOT: string;

beforeAll(() => {
  // Build a tiny repo-shaped tempdir with the wrapper scripts copied in
  // and 4 fixture test files (3 pass, 1 fail). The wrapper's `find test`
  // expression will pick them up via cwd.
  TMPROOT = mkdtempSync(join(tmpdir(), 'gbrain-parallel-test-'));
  mkdirSync(join(TMPROOT, 'scripts'), { recursive: true });
  mkdirSync(join(TMPROOT, 'test'), { recursive: true });

  copyFileSync(PARALLEL_SH_SRC, join(TMPROOT, 'scripts', 'run-unit-parallel.sh'));
  copyFileSync(SHARD_SH_SRC, join(TMPROOT, 'scripts', 'run-unit-shard.sh'));
  copyFileSync(SERIAL_SH_SRC, join(TMPROOT, 'scripts', 'run-serial-tests.sh'));
  chmodSync(join(TMPROOT, 'scripts', 'run-unit-parallel.sh'), 0o755);
  chmodSync(join(TMPROOT, 'scripts', 'run-unit-shard.sh'), 0o755);
  chmodSync(join(TMPROOT, 'scripts', 'run-serial-tests.sh'), 0o755);

  // 3 passing + 1 failing test file. Round-robin sharding will land
  // them across 2 shards so we exercise the multi-shard merge path.
  const passing = `import { describe, it, expect } from 'bun:test';
describe('passing', () => {
  it('arithmetic works', () => { expect(1 + 1).toBe(2); });
});`;
  const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2 (this should fail)', () => { expect(1).toBe(2); });
});`;

  writeFileSync(join(TMPROOT, 'test', 'a-pass.test.ts'), passing);
  writeFileSync(join(TMPROOT, 'test', 'b-pass.test.ts'), passing);
  writeFileSync(join(TMPROOT, 'test', 'c-pass.test.ts'), passing);
  writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), failing);
});

afterAll(() => {
  if (TMPROOT) rmSync(TMPROOT, { recursive: true, force: true });
});

function runWrapper(extraArgs: string[] = []): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    'bash',
    [join(TMPROOT, 'scripts', 'run-unit-parallel.sh'), '--shards', '2', ...extraArgs],
    { cwd: TMPROOT, encoding: 'utf-8', env: { ...process.env } },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function pidIsAlive(pid: number, expectedCommand?: string): boolean {
  try {
    process.kill(pid, 0);
    // kill(0) also succeeds for zombies. In a minimal Docker PID namespace
    // without a subreaping init, an already-terminated descendant can remain
    // as Z until the container exits; it is no longer a live worker and
    // cannot consume CPU or handle signals.
    const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf-8',
    });
    if (state.status === 0 && state.stdout.trim().startsWith('Z')) return false;
    if (state.error && process.platform === 'linux') {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        const rest = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
        if (rest[0]?.startsWith('Z')) return false;
      } catch {
        return false;
      }
    }
    // Under a busy suite the kernel can reuse a terminated child's PID
    // before this assertion polls again. Never classify or kill a reused,
    // unrelated PID as the original fixture process.
    if (expectedCommand) {
      const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf-8',
      });
      if (command.status === 0 && !command.stdout.includes(expectedCommand)) return false;
      if (command.error && process.platform === 'linux') {
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
            .replaceAll('\0', ' ')
            .trim();
          if (!cmdline.includes(expectedCommand)) return false;
        } catch {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe('run-unit-parallel.sh exit-code propagation (a)', () => {
  it('exits non-zero when any shard contains a failing test', () => {
    const r = runWrapper();
    expect(r.code).not.toBe(0);
  });

  it('exits zero when all shards pass (after removing the failing fixture)', () => {
    rmSync(join(TMPROOT, 'test', 'd-fail.test.ts'));
    try {
      const r = runWrapper();
      expect(r.code).toBe(0);
    } finally {
      // Restore the failing fixture for any downstream tests in the same
      // describe block (afterAll cleans the whole tempdir; this is belt-
      // and-suspenders).
      const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2', () => { expect(1).toBe(2); });
});`;
      writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), failing);
    }
  });
});

describe('run-unit-parallel.sh failure-log contract (d)', () => {
  it('writes failures to .context/test-failures.log with --- shard prefix on failure', () => {
    const r = runWrapper();
    expect(r.code).not.toBe(0);

    const failureLog = join(TMPROOT, '.context/test-failures.log');
    expect(existsSync(failureLog)).toBe(true);
    const contents = readFileSync(failureLog, 'utf-8');
    expect(contents.length).toBeGreaterThan(0);
    expect(contents).toMatch(/--- shard \d+:/);
    expect(contents).toContain('failing-on-purpose');
  });

  it('prints loud stderr banner with absolute failure-log path on failure', () => {
    const r = runWrapper();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('TEST FAILURES');
    // Banner includes the absolute path so users can `cat` it directly.
    expect(r.stderr).toContain(join(TMPROOT, '.context', 'test-failures.log'));
  });

  it('clears .context/test-failures.log to empty when all shards pass', () => {
    // Pre-seed a stale failure log to prove it gets cleared.
    mkdirSync(join(TMPROOT, '.context'), { recursive: true });
    writeFileSync(join(TMPROOT, '.context', 'test-failures.log'), 'STALE\n');
    rmSync(join(TMPROOT, 'test', 'd-fail.test.ts'));
    try {
      const r = runWrapper();
      expect(r.code).toBe(0);
      const contents = readFileSync(join(TMPROOT, '.context', 'test-failures.log'), 'utf-8');
      expect(contents).toBe('');
    } finally {
      const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2', () => { expect(1).toBe(2); });
});`;
      writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), failing);
    }
  });

  it('writes per-shard summary lines to .context/test-summary.txt', () => {
    runWrapper();
    const summary = readFileSync(join(TMPROOT, '.context', 'test-summary.txt'), 'utf-8');
    // Format: `shard 1/2: pass=N fail=N skip=N rc=N`
    expect(summary).toMatch(/shard 1\/2: pass=\d+ fail=\d+ skip=\d+ rc=\d+/);
    expect(summary).toMatch(/shard 2\/2: pass=\d+ fail=\d+ skip=\d+ rc=\d+/);
  });
});

function runAdaptiveDryRun(
  probes: {
    cpus: number;
    memAvailableMb: number;
    psiFullX100: number;
    swapFreePct: number;
    loadPerCpuX100: number;
  },
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(
    'bash',
    [join(TMPROOT, 'scripts', 'run-unit-parallel.sh'), ...extraArgs, '--dry-run'],
    {
      cwd: TMPROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        SHARDS: '',
        GBRAIN_TEST_MAX_CONCURRENCY: '',
        GBRAIN_TEST_BATCH_SIZE: '',
        GBRAIN_TEST_SHARD_TIMEOUT: '',
        GBRAIN_TEST_RESOURCE_CPUS: String(probes.cpus),
        GBRAIN_TEST_RESOURCE_MEM_AVAILABLE_MB: String(probes.memAvailableMb),
        GBRAIN_TEST_RESOURCE_PSI_FULL_X100: String(probes.psiFullX100),
        GBRAIN_TEST_RESOURCE_SWAP_FREE_PCT: String(probes.swapFreePct),
        GBRAIN_TEST_RESOURCE_LOAD_PER_CPU_X100: String(probes.loadPerCpuX100),
        ...extraEnv,
      },
    },
  );
}

describe('run-unit-parallel.sh adaptive resource profiles', () => {
  it('selects critical under active memory and scheduler pressure', () => {
    const result = runAdaptiveDryRun({
      cpus: 8,
      memAvailableMb: 3500,
      psiFullX100: 600,
      swapFreePct: 2,
      loadPerCpuX100: 160,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('profile=critical');
    expect(result.stderr).toContain('N=1 shards');
    expect(result.stderr).toContain('--max-concurrency=1');
    expect(result.stderr).toContain('batch-size=1');
    expect(result.stderr).toContain('timeout=1800s');
  });

  it('selects busy when headroom is constrained but not critical', () => {
    const result = runAdaptiveDryRun({
      cpus: 8,
      memAvailableMb: 6000,
      psiFullX100: 50,
      swapFreePct: 40,
      loadPerCpuX100: 40,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('profile=busy');
    expect(result.stderr).toContain('N=1 shards');
    expect(result.stderr).toContain('--max-concurrency=1');
    expect(result.stderr).toContain('batch-size=10');
    expect(result.stderr).toContain('timeout=1200s');
  });

  it('selects balanced with moderate idle headroom', () => {
    const result = runAdaptiveDryRun({
      cpus: 8,
      memAvailableMb: 12000,
      psiFullX100: 20,
      swapFreePct: 60,
      loadPerCpuX100: 40,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('profile=balanced');
    expect(result.stderr).toContain('N=2 shards');
    expect(result.stderr).toContain('--max-concurrency=1');
    expect(result.stderr).toContain('batch-size=10');
    expect(result.stderr).toContain('timeout=900s');
  });

  it('does not treat stale full swap as active pressure when RAM and PSI are healthy', () => {
    const result = runAdaptiveDryRun({
      cpus: 8,
      memAvailableMb: 32768,
      psiFullX100: 20,
      swapFreePct: 2,
      loadPerCpuX100: 40,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('profile=balanced');
    expect(result.stderr).toContain('N=2 shards');
  });

  it('selects high-headroom only with abundant idle resources', () => {
    const result = runAdaptiveDryRun({
      cpus: 16,
      memAvailableMb: 32768,
      psiFullX100: 10,
      swapFreePct: 80,
      loadPerCpuX100: 20,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('profile=high-headroom');
    expect(result.stderr).toContain('N=2 shards');
    expect(result.stderr).toContain('--max-concurrency=2');
    expect(result.stderr).toContain('batch-size=20');
    expect(result.stderr).toContain('timeout=900s');
  });

  it('fails closed to busy when swap, PSI, or load signals are unknown', () => {
    const result = runAdaptiveDryRun({
      cpus: 16,
      memAvailableMb: 32768,
      psiFullX100: -1,
      swapFreePct: -1,
      loadPerCpuX100: -1,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('profile=busy');
    expect(result.stderr).toContain('N=1 shards');
  });

  it('keeps explicit per-setting overrides authoritative', () => {
    const result = runAdaptiveDryRun(
      {
        cpus: 8,
        memAvailableMb: 3500,
        psiFullX100: 600,
        swapFreePct: 2,
        loadPerCpuX100: 160,
      },
      ['--shards=2', '--max-concurrency=3', '--batch-size=4', '--timeout=333'],
      {
        SHARDS: '7',
        GBRAIN_TEST_MAX_CONCURRENCY: '8',
        GBRAIN_TEST_BATCH_SIZE: '9',
        GBRAIN_TEST_SHARD_TIMEOUT: '999',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('profile=critical');
    expect(result.stderr).toContain('N=2 shards');
    expect(result.stderr).toContain('--max-concurrency=3');
    expect(result.stderr).toContain('batch-size=4');
    expect(result.stderr).toContain('timeout=333s');
    const src = readFileSync(PARALLEL_SH_SRC, 'utf-8');
    expect(src.match(/--batch-size="\$BATCH_SIZE"/g)).toHaveLength(1);
    expect(src.match(/--batch-size="\$batch_size"/g)).toHaveLength(1);
  });

  it('keeps environment per-setting overrides authoritative', () => {
    const result = runAdaptiveDryRun(
      {
        cpus: 8,
        memAvailableMb: 3500,
        psiFullX100: 600,
        swapFreePct: 2,
        loadPerCpuX100: 160,
      },
      [],
      {
        SHARDS: '3',
        GBRAIN_TEST_MAX_CONCURRENCY: '2',
        GBRAIN_TEST_BATCH_SIZE: '7',
        GBRAIN_TEST_SHARD_TIMEOUT: '777',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('profile=critical');
    expect(result.stderr).toContain('N=3 shards');
    expect(result.stderr).toContain('--max-concurrency=2');
    expect(result.stderr).toContain('batch-size=7');
    expect(result.stderr).toContain('timeout=777s');
  });

  it('uses effective cgroup v2 CPU and memory headroom', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'gbrain-cgroup-v2-'));
    const cgroupRoot = join(fixtureRoot, 'cgroup');
    const scopeDir = join(cgroupRoot, 'ci.scope');
    const selfCgroup = join(fixtureRoot, 'self.cgroup');
    mkdirSync(scopeDir, { recursive: true });
    writeFileSync(selfCgroup, '0::/ci.scope\n');
    writeFileSync(join(scopeDir, 'cpu.max'), '200000 100000\n');
    writeFileSync(join(scopeDir, 'memory.max'), '4294967296\n');
    writeFileSync(join(scopeDir, 'memory.current'), '1073741824\n');

    try {
      const result = runAdaptiveDryRun(
        {
          cpus: 64,
          memAvailableMb: 65536,
          psiFullX100: 0,
          swapFreePct: 100,
          loadPerCpuX100: 0,
        },
        [],
        {
          GBRAIN_TEST_RESOURCE_CPUS: '',
          GBRAIN_TEST_RESOURCE_MEM_AVAILABLE_MB: '',
          GBRAIN_TEST_CGROUP_ROOT: cgroupRoot,
          GBRAIN_TEST_PROC_SELF_CGROUP: selfCgroup,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('resources=cpus:2,mem:3072MiB');
      expect(result.stderr).toContain('profile=critical');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('uses effective cgroup v1 CPU and memory headroom', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'gbrain-cgroup-v1-'));
    const cgroupRoot = join(fixtureRoot, 'cgroup');
    const cpuDir = join(cgroupRoot, 'cpu,cpuacct', 'docker', 'ci');
    const memoryDir = join(cgroupRoot, 'memory', 'docker', 'ci');
    const selfCgroup = join(fixtureRoot, 'self.cgroup');
    mkdirSync(cpuDir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(selfCgroup, '2:cpu,cpuacct:/docker/ci\n3:memory:/docker/ci\n');
    writeFileSync(join(cpuDir, 'cpu.cfs_quota_us'), '200000\n');
    writeFileSync(join(cpuDir, 'cpu.cfs_period_us'), '100000\n');
    writeFileSync(join(memoryDir, 'memory.limit_in_bytes'), '4294967296\n');
    writeFileSync(join(memoryDir, 'memory.usage_in_bytes'), '1073741824\n');

    try {
      const result = runAdaptiveDryRun(
        {
          cpus: 64,
          memAvailableMb: 65536,
          psiFullX100: 0,
          swapFreePct: 100,
          loadPerCpuX100: 0,
        },
        [],
        {
          GBRAIN_TEST_RESOURCE_CPUS: '',
          GBRAIN_TEST_RESOURCE_MEM_AVAILABLE_MB: '',
          GBRAIN_TEST_CGROUP_ROOT: cgroupRoot,
          GBRAIN_TEST_PROC_SELF_CGROUP: selfCgroup,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('resources=cpus:2,mem:3072MiB');
      expect(result.stderr).toContain('profile=critical');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('returns usage error 2 for a missing option value', () => {
    const result = spawnSync(
      'bash',
      [join(TMPROOT, 'scripts', 'run-unit-parallel.sh'), '--shards'],
      {
        cwd: TMPROOT,
        encoding: 'utf-8',
        env: {
          ...process.env,
          GBRAIN_TEST_RESOURCE_CPUS: '8',
          GBRAIN_TEST_RESOURCE_MEM_AVAILABLE_MB: '12000',
          GBRAIN_TEST_RESOURCE_PSI_FULL_X100: '20',
          GBRAIN_TEST_RESOURCE_SWAP_FREE_PCT: '60',
          GBRAIN_TEST_RESOURCE_LOAD_PER_CPU_X100: '40',
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing value for --shards');
  });

  it('returns usage error 2 for explicitly empty option values', () => {
    for (const option of [
      '--shards=',
      '--max-concurrency=',
      '--batch-size=',
      '--timeout=',
      '--shard-timeout=',
    ]) {
      const result = runAdaptiveDryRun(
        {
          cpus: 8,
          memAvailableMb: 12000,
          psiFullX100: 20,
          swapFreePct: 60,
          loadPerCpuX100: 40,
        },
        [option],
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`missing value for ${option.slice(0, -1)}`);
    }
  });
});

describe('run-unit-parallel.sh session-safety guards', () => {
  it('refuses a symlink lock without touching its target', () => {
    const safetyRoot = mkdtempSync(join(tmpdir(), 'gbrain-lock-symlink-'));
    const scriptsDir = join(safetyRoot, 'scripts');
    const contextDir = join(safetyRoot, '.context');
    const victimDir = join(safetyRoot, 'victim');
    const wrapperScript = join(scriptsDir, 'run-unit-parallel.sh');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(join(safetyRoot, 'test'), { recursive: true });
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(victimDir, { recursive: true });
    copyFileSync(PARALLEL_SH_SRC, wrapperScript);
    chmodSync(wrapperScript, 0o755);
    writeFileSync(join(scriptsDir, 'run-unit-shard.sh'), `#!/usr/bin/env bash
if [ "\${1:-}" = "--dry-run-list" ]; then echo test/fake.test.ts; exit 0; fi
exit 0
`);
    chmodSync(join(scriptsDir, 'run-unit-shard.sh'), 0o755);
    writeFileSync(join(victimDir, 'pid'), '99999999\n');
    symlinkSync(victimDir, join(contextDir, 'unit-parallel.lock'));

    try {
      const result = spawnSync('bash', [wrapperScript, '--shards=1'], {
        cwd: safetyRoot,
        encoding: 'utf-8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unsafe symbolic test lock');
      expect(readFileSync(join(victimDir, 'pid'), 'utf-8')).toBe('99999999\n');
    } finally {
      rmSync(safetyRoot, { recursive: true, force: true });
    }
  });

  it('refuses a lock that is still initializing', () => {
    const safetyRoot = mkdtempSync(join(tmpdir(), 'gbrain-lock-initializing-'));
    const scriptsDir = join(safetyRoot, 'scripts');
    const contextDir = join(safetyRoot, '.context');
    const lockDir = join(contextDir, 'unit-parallel.lock');
    const wrapperScript = join(scriptsDir, 'run-unit-parallel.sh');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(join(safetyRoot, 'test'), { recursive: true });
    mkdirSync(lockDir, { recursive: true });
    copyFileSync(PARALLEL_SH_SRC, wrapperScript);
    chmodSync(wrapperScript, 0o755);
    writeFileSync(join(scriptsDir, 'run-unit-shard.sh'), `#!/usr/bin/env bash
if [ "\${1:-}" = "--dry-run-list" ]; then echo test/fake.test.ts; exit 0; fi
exit 0
`);
    chmodSync(join(scriptsDir, 'run-unit-shard.sh'), 0o755);

    try {
      const result = spawnSync('bash', [wrapperScript, '--shards=1'], {
        cwd: safetyRoot,
        encoding: 'utf-8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('test lock is initializing or invalid');
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      rmSync(safetyRoot, { recursive: true, force: true });
    }
  });

  it('traps session-ending signals and terminates shard process trees', () => {
    const src = readFileSync(PARALLEL_SH_SRC, 'utf-8');
    expect(src).toContain('trap on_signal HUP INT TERM');
    expect(src).toContain('terminate_pid_tree "$shard_pid"');
    expect(src).toContain('cleanup_children');
    expect(src).toContain('--kill-after=5s');
  });

  it('acquires the single-run lock before clearing active-run artifacts', () => {
    const src = readFileSync(PARALLEL_SH_SRC, 'utf-8');
    const acquire = src.indexOf('printf \'%s\\n\' "$$" > "$RUN_LOCK_DIR/pid"');
    const clear = src.indexOf('rm -f "$LOG_DIR"/shard-*.log');
    expect(acquire).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(acquire);
    expect(src).toContain('ERROR: unit test suite already running');
  });

  it('terminates a live shard descendant and releases the lock on SIGTERM', async () => {
    const safetyRoot = mkdtempSync(join(tmpdir(), 'gbrain-signal-safety-'));
    const scriptsDir = join(safetyRoot, 'scripts');
    const contextDir = join(safetyRoot, '.context');
    const shardScript = join(scriptsDir, 'run-unit-shard.sh');
    const wrapperScript = join(scriptsDir, 'run-unit-parallel.sh');
    const childPidFile = join(contextDir, 'fake-child.pid');
    let childPid = 0;

    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(join(safetyRoot, 'test'), { recursive: true });
    copyFileSync(PARALLEL_SH_SRC, wrapperScript);
    chmodSync(wrapperScript, 0o755);
    writeFileSync(shardScript, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--dry-run-list" ]; then
  echo test/fake.test.ts
  exit 0
fi
sleep 300 &
child_pid=$!
mkdir -p .context
echo "$child_pid" > .context/fake-child.pid
wait "$child_pid"
`);
    chmodSync(shardScript, 0o755);

    const wrapper = spawn('bash', [wrapperScript, '--shards', '1'], {
      cwd: safetyRoot,
      env: { ...process.env, GBRAIN_TEST_SHARD_TIMEOUT: '300' },
      stdio: 'ignore',
    });

    try {
      await waitUntil(() => existsSync(childPidFile), 12_000);
      childPid = Number(readFileSync(childPidFile, 'utf-8').trim());
      expect(Number.isInteger(childPid)).toBe(true);
      expect(pidIsAlive(childPid, 'sleep 300')).toBe(true);

      const overlapping = spawnSync('bash', [wrapperScript, '--shards', '1'], {
        cwd: safetyRoot,
        env: { ...process.env, GBRAIN_TEST_SHARD_TIMEOUT: '300' },
        encoding: 'utf-8',
      });
      expect(overlapping.status).toBe(2);
      expect(overlapping.stderr).toContain('unit test suite already running');

      wrapper.kill('SIGTERM');
      await waitUntil(() => wrapper.exitCode !== null, 12_000);
      await waitUntil(() => !pidIsAlive(childPid, 'sleep 300'), 12_000);

      expect(wrapper.exitCode).toBe(130);
      expect(existsSync(join(contextDir, 'unit-parallel.lock'))).toBe(false);
    } finally {
      if (childPid > 0 && pidIsAlive(childPid, 'sleep 300')) process.kill(childPid, 'SIGKILL');
      if (wrapper.exitCode === null) wrapper.kill('SIGKILL');
      rmSync(safetyRoot, { recursive: true, force: true });
    }
  }, 40_000);

  it('does not label a legitimate shard exit 124 as wedged', () => {
    const safetyRoot = mkdtempSync(join(tmpdir(), 'gbrain-legitimate-124-'));
    const scriptsDir = join(safetyRoot, 'scripts');
    const binDir = join(safetyRoot, 'bin');
    const contextDir = join(safetyRoot, '.context');
    const wrapperScript = join(scriptsDir, 'run-unit-parallel.sh');
    const shardScript = join(scriptsDir, 'run-unit-shard.sh');
    const timeoutScript = join(binDir, 'timeout');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(safetyRoot, 'test'), { recursive: true });
    copyFileSync(PARALLEL_SH_SRC, wrapperScript);
    chmodSync(wrapperScript, 0o755);
    writeFileSync(shardScript, `#!/usr/bin/env bash
if [ "\${1:-}" = "--dry-run-list" ]; then echo test/fake.test.ts; exit 0; fi
exit 124
`);
    chmodSync(shardScript, 0o755);
    writeFileSync(timeoutScript, `#!/usr/bin/env bash
shift 2
"$@"
`);
    chmodSync(timeoutScript, 0o755);

    try {
      const result = spawnSync('bash', [wrapperScript, '--shards=1'], {
        cwd: safetyRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          GBRAIN_TEST_RESOURCE_CPUS: '8',
          GBRAIN_TEST_RESOURCE_MEM_AVAILABLE_MB: '12000',
          GBRAIN_TEST_RESOURCE_PSI_FULL_X100: '20',
          GBRAIN_TEST_RESOURCE_SWAP_FREE_PCT: '60',
          GBRAIN_TEST_RESOURCE_LOAD_PER_CPU_X100: '40',
        },
      });

      expect(result.status).toBe(1);
      expect(readFileSync(join(contextDir, 'test-shards', 'shard-1.exit'), 'utf-8').trim()).toBe('124');
      expect(existsSync(join(contextDir, 'test-shards', 'shard-1.wedged'))).toBe(false);
    } finally {
      rmSync(safetyRoot, { recursive: true, force: true });
    }
  });

  it('normalizes the no-timeout-binary fallback to 124 and kills descendants', () => {
    const safetyRoot = mkdtempSync(join(tmpdir(), 'gbrain-timeout-fallback-'));
    const scriptsDir = join(safetyRoot, 'scripts');
    const contextDir = join(safetyRoot, '.context');
    const wrapperScript = join(scriptsDir, 'run-unit-parallel.sh');
    const shardScript = join(scriptsDir, 'run-unit-shard.sh');

    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(join(safetyRoot, 'test'), { recursive: true });
    copyFileSync(PARALLEL_SH_SRC, wrapperScript);
    chmodSync(wrapperScript, 0o755);
    writeFileSync(shardScript, `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "--dry-run-list" ]; then
  echo test/fake.test.ts
  exit 0
fi
bash -c 'trap "" TERM; while :; do sleep 1; done' &
child_pid=$!
mkdir -p .context
echo "$child_pid" > .context/fallback-child.pid
wait "$child_pid"
`);
    chmodSync(shardScript, 0o755);

    try {
      const result = spawnSync(
        'bash',
        [wrapperScript, '--shards=1', '--timeout=1'],
        {
          cwd: safetyRoot,
          encoding: 'utf-8',
          timeout: 10000,
          env: {
            ...process.env,
            GBRAIN_TEST_DISABLE_TIMEOUT_BIN: '1',
            GBRAIN_TEST_RESOURCE_CPUS: '8',
            GBRAIN_TEST_RESOURCE_MEM_AVAILABLE_MB: '12000',
            GBRAIN_TEST_RESOURCE_PSI_FULL_X100: '20',
            GBRAIN_TEST_RESOURCE_SWAP_FREE_PCT: '60',
            GBRAIN_TEST_RESOURCE_LOAD_PER_CPU_X100: '40',
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(contextDir, 'test-shards', 'shard-1.exit'), 'utf-8').trim()).toBe('124');
      expect(existsSync(join(contextDir, 'test-shards', 'shard-1.wedged'))).toBe(true);
      const childPid = Number(readFileSync(join(contextDir, 'fallback-child.pid'), 'utf-8').trim());
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      rmSync(safetyRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
