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
 * Also covered:
 *   (e) Derived shard cap: the wallclock cap is computed from
 *       files-per-shard × per-file budget rather than hardcoded, so it stops
 *       rotting as the suite grows or the host speed changes. Probed via the
 *       --dry-run banner, so these cases are hermetic and instant.
 *   (f) Stall watchdog: a shard that stops writing to its log is killed on a
 *       progress signal rather than riding the (deliberately generous)
 *       wallclock cap for hours.
 *
 * NOT covered here: the heartbeat (timing-sensitive, not load-bearing for
 * correctness) and the WEDGED wallclock path (would require burning the full
 * cap). Those rely on the live smoke tests captured in CHANGELOG
 * measurements.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
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
  if (!TMPROOT) return;
  // Windows holds a directory handle for a moment after a process that was
  // cwd'd there dies — and this suite deliberately kills shards — so a single
  // rmSync races the OS and throws EBUSY. Retry briefly; never fail teardown
  // over a temp dir (a leftover in the OS temp dir is harmless, a failed
  // afterAll masks real results).
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(TMPROOT, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(200);
    }
  }
});

function runWrapper(
  extraArgs: string[] = [],
  env: Record<string, string | undefined> = {},
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    'bash',
    [join(TMPROOT, 'scripts', 'run-unit-parallel.sh'), '--shards', '2', ...extraArgs],
    { cwd: TMPROOT, encoding: 'utf-8', env: { ...process.env, ...env } },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * The wrapper prints its resolved caps to stderr BEFORE spawning any shard,
 * and --dry-run exits right after. That makes the banner a cheap, hermetic
 * probe of cap resolution: no tests actually run.
 *
 * Banner shape:
 *   [unit-parallel] N=2 shards | --max-concurrency=4 |
 *     timeout=600s (floor 600s) | stall=600s | logs=...
 */
function bannerFor(env: Record<string, string | undefined> = {}): {
  code: number;
  banner: string;
  stderr: string;
} {
  const r = runWrapper(['--dry-run'], env);
  const banner = r.stderr.split('\n').find((l) => l.includes('[unit-parallel]')) ?? '';
  return { code: r.code, banner, stderr: r.stderr };
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
    //
    // The wrapper derives it with `cd … && pwd`, which under MSYS2 / Git Bash
    // / Cygwin prints the POSIX view (/tmp/gbrain-parallel-test-xxxx) of the
    // very same directory Node names C:\Users\…\AppData\Local\Temp\…. Both are
    // correct and absolute, so accept either notation — the contract under
    // test is "absolute and pasteable", not "spelled the way Node spells it".
    const winPath = join(TMPROOT, '.context', 'test-failures.log');
    const posixPath = `${TMPROOT.replace(/\\/g, '/')}/.context/test-failures.log`;
    const msysAbsolute = /(?:^|\s)\/\S*\/\.context\/test-failures\.log/m;
    const ok =
      r.stderr.includes(winPath) ||
      r.stderr.includes(posixPath) ||
      msysAbsolute.test(r.stderr);
    expect(ok).toBe(true);
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

/**
 * Creating a symlink on Windows needs SeCreateSymbolicLinkPrivilege (admin or
 * Developer Mode); without it `symlinkSync` throws EPERM. The fallback suite
 * below builds its curated PATH out of symlinks, so on an unprivileged Windows
 * host its `beforeAll` throws — which not only reports a spurious failure but
 * aborts the hook mid-way and perturbs sibling suites in the same file. Probe
 * the capability once and skip the suite outright when it is absent, so the
 * coverage still runs everywhere it can (CI, macOS, Linux) and an unprivileged
 * Windows box reports a skip rather than a red herring.
 */
const CAN_SYMLINK = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'gbrain-symlink-probe-'));
  try {
    symlinkSync(process.execPath, join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe.skipIf(!CAN_SYMLINK)('run-unit-parallel.sh no-timeout-binary fallback (rc from shard wait, not watchdog teardown)', () => {
  // Forces the no-gtimeout/no-timeout branch by running the wrapper under a
  // curated PATH that has every tool the scripts call EXCEPT timeout
  // binaries (real `bun` symlinked in), so the fallback executes even on
  // hosts with coreutils installed.
  //
  // Regression pinned here: the shard's sentinel .exit file must record the
  // exit code read right after `wait $pid` (the shard's own rc). The
  // watchdog subshell is killed with SIGTERM and reports 143; reading `$?`
  // after that teardown stamped rc=143 into every shard's sentinel — the
  // wrapper exited non-zero with rc=143 summaries even when every test
  // passed.
  let FROOT: string;
  let FENV: Record<string, string>;

  beforeAll(() => {
    FROOT = mkdtempSync(join(tmpdir(), 'gbrain-parallel-fallback-'));
    mkdirSync(join(FROOT, 'scripts'), { recursive: true });
    mkdirSync(join(FROOT, 'test'), { recursive: true });
    for (const s of ['run-unit-parallel.sh', 'run-unit-shard.sh', 'run-serial-tests.sh']) {
      copyFileSync(resolve(REPO_ROOT, 'scripts', s), join(FROOT, 'scripts', s));
      chmodSync(join(FROOT, 'scripts', s), 0o755);
    }
    const passing = `import { describe, it, expect } from 'bun:test';
describe('passing', () => {
  it('arithmetic works', () => { expect(1 + 1).toBe(2); });
});`;
    writeFileSync(join(FROOT, 'test', 'a-pass.test.ts'), passing);
    writeFileSync(join(FROOT, 'test', 'b-pass.test.ts'), passing);

    const bin = join(FROOT, 'bin');
    mkdirSync(bin);
    for (const tool of ['bash', 'sh', 'env', 'dirname', 'basename', 'mktemp', 'date', 'sleep', 'cat', 'tail', 'head', 'rm', 'mkdir', 'pkill', 'grep', 'sed', 'awk', 'wc', 'tr', 'seq', 'find', 'sort', 'bun']) {
      const p = Bun.which(tool);
      if (p) symlinkSync(p, join(bin, tool));
    }
    FENV = {
      PATH: bin,
      HOME: process.env.HOME ?? FROOT,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      GBRAIN_TEST_SHARD_TIMEOUT: '300',
    };
  });

  afterAll(() => {
    if (FROOT) rmSync(FROOT, { recursive: true, force: true });
  });

  function runFallbackWrapper(): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(
      'bash',
      [join(FROOT, 'scripts', 'run-unit-parallel.sh'), '--shards', '2'],
      { cwd: FROOT, encoding: 'utf-8', env: FENV },
    );
    return {
      code: result.status ?? -1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  it('exits zero with rc=0 shard sentinels when all shards pass', () => {
    const r = runFallbackWrapper();
    const summary = readFileSync(join(FROOT, '.context', 'test-summary.txt'), 'utf-8');
    expect(summary).toMatch(/shard 1\/2: pass=\d+ fail=0 skip=0 rc=0/);
    expect(summary).toMatch(/shard 2\/2: pass=\d+ fail=0 skip=0 rc=0/);
    expect(summary).not.toContain('rc=143');
    expect(r.code).toBe(0);
  });

  it('propagates a failing shard rc as the test runner rc (1), not the watchdog 143', () => {
    const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2', () => { expect(1).toBe(2); });
});`;
    writeFileSync(join(FROOT, 'test', 'z-fail.test.ts'), failing);
    try {
      const r = runFallbackWrapper();
      expect(r.code).not.toBe(0);
      const summary = readFileSync(join(FROOT, '.context', 'test-summary.txt'), 'utf-8');
      expect(summary).toMatch(/shard \d\/2: pass=\d+ fail=1 skip=0 rc=1/);
      expect(summary).not.toContain('rc=143');
      const failureLog = readFileSync(join(FROOT, '.context', 'test-failures.log'), 'utf-8');
      expect(failureLog).toContain('failing-on-purpose');
    } finally {
      rmSync(join(FROOT, 'test', 'z-fail.test.ts'), { force: true });
    }
  });
});

/**
 * (e) Derived per-shard wallclock cap.
 *
 * The cap used to be a hardcoded constant, which encodes a snapshot of
 * (suite size × host speed) and rots whenever either moves. It rotted twice:
 * 900s was sized for the 8-shard/~80-file split and false-killed the
 * 4-shard/159-file split; its 1500s successor was calibrated at ~6s/file on
 * Apple Silicon and false-killed all four shards on a Windows box where
 * per-file cost is several times higher.
 *
 * These pin the replacement: cap = files-per-shard × per-file budget, with a
 * floor, and explicit overrides. The scaling case is the load-bearing one —
 * it is what stops the same bug recurring as the suite grows.
 */
describe('run-unit-parallel.sh derived shard cap (e)', () => {
  it('falls back to the floor for a tiny file set', () => {
    // 4 fixture files / 2 shards = 2 files/shard. Any sane per-file budget
    // lands far under the floor, so the floor must win — otherwise a small
    // or filtered run would get a handful of seconds and false-kill itself.
    const { code, banner } = bannerFor();
    expect(code).toBe(0);
    expect(banner).toContain('timeout=600s');
    expect(banner).toContain('(floor 600s)');
  });

  it('scales the cap with files-per-shard once it clears the floor', () => {
    // 2 files/shard × 400s = 800s > 600s floor.
    const { code, banner } = bannerFor({ GBRAIN_TEST_SECONDS_PER_FILE: '400' });
    expect(code).toBe(0);
    expect(banner).toContain('timeout=800s');
    expect(banner).toContain('(2 files/shard × 400s)');
  });

  it('grows the cap when the suite grows (the anti-rot property)', () => {
    // The whole point of deriving: adding files must widen the cap on its
    // own, with nobody editing a constant. 4 extra files -> 8 total -> 4 per
    // shard -> 4 × 400 = 1600s.
    const extra = ['e', 'f', 'g', 'h'];
    const passing = `import { describe, it, expect } from 'bun:test';
describe('extra', () => { it('works', () => { expect(1).toBe(1); }); });`;
    for (const n of extra) writeFileSync(join(TMPROOT, 'test', `${n}-pass.test.ts`), passing);
    try {
      const { code, banner } = bannerFor({ GBRAIN_TEST_SECONDS_PER_FILE: '400' });
      expect(code).toBe(0);
      expect(banner).toContain('(4 files/shard × 400s)');
      expect(banner).toContain('timeout=1600s');
    } finally {
      for (const n of extra) rmSync(join(TMPROOT, 'test', `${n}-pass.test.ts`), { force: true });
    }
  });

  it('lets GBRAIN_TEST_SHARD_TIMEOUT pin the cap outright', () => {
    const { code, banner } = bannerFor({ GBRAIN_TEST_SHARD_TIMEOUT: '4242' });
    expect(code).toBe(0);
    expect(banner).toContain('timeout=4242s');
    expect(banner).toContain('(env GBRAIN_TEST_SHARD_TIMEOUT)');
  });

  it('names the derivation in the banner so a WEDGED shard is actionable', () => {
    // Printing the value alone tells you nothing about which knob to turn.
    const { banner } = bannerFor({ GBRAIN_TEST_SECONDS_PER_FILE: '400' });
    expect(banner).toMatch(/timeout=\d+s \(\d+ files\/shard × \d+s\)/);
  });

  it('rejects a non-numeric per-file budget instead of deriving nonsense', () => {
    // A garbage budget would otherwise produce a 0s cap and kill every shard
    // instantly. Assert on the process status directly (never through a pipe,
    // which would report the pipe's exit code instead).
    const r = runWrapper(['--dry-run'], { GBRAIN_TEST_SECONDS_PER_FILE: 'abc' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('GBRAIN_TEST_SECONDS_PER_FILE must be a positive integer');
  });

  it('rejects a non-numeric explicit timeout', () => {
    const r = runWrapper(['--dry-run'], { GBRAIN_TEST_SHARD_TIMEOUT: 'soon' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('GBRAIN_TEST_SHARD_TIMEOUT must be a positive integer');
  });
});

/**
 * (f) Stall watchdog.
 *
 * A generous wallclock cap is a safe backstop but a terrible hang detector —
 * a genuinely stuck shard would ride it for hours. The watchdog keys on
 * forward progress (shard log growth) instead of elapsed time, the same
 * instrument gbrain uses for sync's GBRAIN_SYNC_STALL_ABORT_SECONDS.
 */
describe('run-unit-parallel.sh stall watchdog (f)', () => {
  it('surfaces the stall window in the banner', () => {
    const { banner } = bannerFor();
    expect(banner).toContain('stall=600s');
  });

  it('reports stall=off when disabled', () => {
    const { code, banner } = bannerFor({ GBRAIN_TEST_SHARD_STALL_SECONDS: '0' });
    expect(code).toBe(0);
    expect(banner).toContain('stall=off');
  });

  it('rejects a non-numeric stall window', () => {
    const r = runWrapper(['--dry-run'], { GBRAIN_TEST_SHARD_STALL_SECONDS: 'never' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('GBRAIN_TEST_SHARD_STALL_SECONDS must be a non-negative integer');
  });

  it('kills a shard that stops producing output, and says so', () => {
    // The hang is at module top level, NOT inside a test body: bun's
    // --timeout only bounds individual tests, so a load-time hang is exactly
    // the case the wallclock cap alone would let run for hours.
    writeFileSync(
      join(TMPROOT, 'test', 'z-hang.test.ts'),
      `import { describe, it, expect } from 'bun:test';
await new Promise(() => {});
describe('never runs', () => { it('unreachable', () => { expect(1).toBe(1); }); });`,
    );
    try {
      const started = Date.now();
      // Short stall window so the test is quick; the cap stays huge so we
      // prove the STALL path fired and not the wallclock path.
      const r = runWrapper([], {
        GBRAIN_TEST_SHARD_STALL_SECONDS: '15',
        GBRAIN_TEST_SHARD_TIMEOUT: '9000',
      });
      const elapsedMs = Date.now() - started;

      expect(r.code).not.toBe(0);
      const failures = readFileSync(join(TMPROOT, '.context/test-failures.log'), 'utf-8');
      expect(failures).toContain('STALLED');
      expect(failures).toContain('no log output for 15s');
      const summary = readFileSync(join(TMPROOT, '.context/test-summary.txt'), 'utf-8');
      expect(summary).toMatch(/shard \d\/2: STALLED after 15s with no output/);

      // Must have been the watchdog, not the 9000s cap. Bound generously —
      // stall window + 10s poll granularity + 5s kill grace + bun startup.
      expect(elapsedMs).toBeLessThan(180_000);
    } finally {
      rmSync(join(TMPROOT, 'test', 'z-hang.test.ts'), { force: true });
    }
  }, 240_000);
});
