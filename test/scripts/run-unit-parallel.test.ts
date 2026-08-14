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
 * NOT covered behaviorally here: the heartbeat and a real hung Bun process
 * (both timing-sensitive). The timeout escalation wiring is covered as a
 * source contract below and exercised separately by a process-leak smoke.
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
  if (TMPROOT) rmSync(TMPROOT, { recursive: true, force: true });
});

function runWrapper(extraArgs: string[] = []): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    'bash',
    [join(TMPROOT, 'scripts', 'run-unit-parallel.sh'), '--shards', '2', ...extraArgs],
    // Shard-mechanics tests pin explicit --shards behavior with tiny
    // synthetic files; disable mem-adaptation so a RAM-limited runner (CI's
    // ~7GB) can't collapse 2 shards -> 1 and break the shard 1/2 expectations.
    { cwd: TMPROOT, encoding: 'utf-8', env: { ...process.env, GBRAIN_TEST_NO_MEM_ADAPT: '1' } },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
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

describe('run-unit-parallel.sh timeout escalation contract', () => {
  it('gives a timed-out shard 30 seconds after TERM, then forces KILL', () => {
    const source = readFileSync(PARALLEL_SH_SRC, 'utf-8');
    expect(source).toContain('SHARD_KILL_AFTER="${GBRAIN_TEST_SHARD_KILL_AFTER:-30}"');
    expect(source).toContain('--signal=TERM --kill-after="${SHARD_KILL_AFTER}s"');
    expect(source).toContain('sleep "$SHARD_KILL_AFTER" && kill -KILL "$pid"');
  });

  it('marks both ordinary timeout and forced-KILL timeout exits as wedged', () => {
    const source = readFileSync(PARALLEL_SH_SRC, 'utf-8');
    expect(source).toContain('[ "$rc" = "124" ] || [ "$rc" = "137" ]');
  });
});

describe('run-unit-parallel.sh no-timeout-binary fallback (rc from shard wait, not watchdog teardown)', () => {
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
      // Same rationale as runWrapper: explicit-shard mechanics under test.
      GBRAIN_TEST_NO_MEM_ADAPT: '1',
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

describe('run-unit-parallel.sh OOM rescue lane', () => {
  // A fixture that fails WITH the WASM out-of-memory signature on its first
  // run (no sentinel file yet) and passes once the sentinel exists — exactly
  // the phantom-failure shape: dies under parallel memory pressure, passes
  // serially. The runner must (1) detect the signature, (2) re-run the file
  // at --max-concurrency 1, (3) exit 0 with an oom_rescued note.
  let OROOT: string;

  beforeAll(() => {
    OROOT = mkdtempSync(join(tmpdir(), 'gbrain-parallel-oom-'));
    mkdirSync(join(OROOT, 'scripts'), { recursive: true });
    mkdirSync(join(OROOT, 'test'), { recursive: true });
    for (const s of ['run-unit-parallel.sh', 'run-unit-shard.sh', 'run-serial-tests.sh']) {
      copyFileSync(resolve(REPO_ROOT, 'scripts', s), join(OROOT, 'scripts', s));
      chmodSync(join(OROOT, 'scripts', s), 0o755);
    }
    const passing = `import { describe, it, expect } from 'bun:test';
describe('passing', () => {
  it('arithmetic works', () => { expect(1 + 1).toBe(2); });
});`;
    const oomOnce = `import { describe, it, expect } from 'bun:test';
import { existsSync, writeFileSync } from 'fs';
describe('oom-once', () => {
  it('fails with the WASM OOM signature on first run, passes on retry', () => {
    const sentinel = new URL('./oom-sentinel.txt', import.meta.url).pathname;
    if (!existsSync(sentinel)) {
      writeFileSync(sentinel, 'ran-once');
      console.error('Original error: Out of memory');
      throw new Error('Out of memory (simulated PGLite WASM connect failure)');
    }
    expect(1).toBe(1);
  });
});`;
    writeFileSync(join(OROOT, 'test', 'a-pass.test.ts'), passing);
    writeFileSync(join(OROOT, 'test', 'b-oom-once.test.ts'), oomOnce);
  });

  afterAll(() => {
    if (OROOT) rmSync(OROOT, { recursive: true, force: true });
  });

  function runOom(env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
    rmSync(join(OROOT, 'test', 'oom-sentinel.txt'), { force: true });
    const result = spawnSync(
      'bash',
      [join(OROOT, 'scripts', 'run-unit-parallel.sh'), '--shards', '2'],
      { cwd: OROOT, encoding: 'utf-8', env: { ...process.env, GBRAIN_TEST_NO_MEM_ADAPT: '1', ...env } },
    );
    return { code: result.status ?? -1, stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  it('rescues an OOM-signature failure serially and exits 0 with an oom_rescued note', () => {
    const r = runOom();
    expect(r.stdout + r.stderr).toContain('OOM rescue pass');
    expect(r.stderr).toContain('oom_rescued=');
    expect(r.code).toBe(0);
  }, 120_000);

  it('GBRAIN_TEST_NO_OOM_FALLBACK=1 disables the rescue lane (stays red)', () => {
    const r = runOom({ GBRAIN_TEST_NO_OOM_FALLBACK: '1' });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain('OOM rescue pass');
  }, 120_000);

  it('memory-aware sizing is advertised in the banner (mem-ok or mem-adapted)', () => {
    // The one test that needs adaptation ON — override the harness-wide
    // NO_MEM_ADAPT base (which keeps the shard-mechanics tests deterministic
    // on RAM-limited CI runners).
    const r = runOom({ GBRAIN_TEST_NO_MEM_ADAPT: '0' });
    expect(r.stderr).toMatch(/mem-(ok|adapted)/);
  }, 120_000);

  it('mixed run: a plain assertion failure stays red even when the OOM phantom rescues green', () => {
    // The NON_OOM_FAIL gate — the branch that stops the rescue lane from
    // absolving real failures that happened to share a run with phantoms.
    const realFail = `import { describe, it, expect } from 'bun:test';
describe('real-failure', () => {
  it('expects 1 to equal 2', () => { expect(1).toBe(2); });
});`;
    writeFileSync(join(OROOT, 'test', 'c-real-fail.test.ts'), realFail);
    try {
      const r = runOom();
      expect(r.code).not.toBe(0);
    } finally {
      rmSync(join(OROOT, 'test', 'c-real-fail.test.ts'), { force: true });
    }
  }, 120_000);

  it('a deterministic failure carrying the OOM signature re-fails serially and stays red', () => {
    // The oom_rescue_failed lane: signature match queues the file, but the
    // serial re-run confirms the failure is real — run must stay red.
    const alwaysOom = `import { describe, it } from 'bun:test';
describe('oom-always', () => {
  it('always fails with the signature', () => {
    console.error('Original error: Out of memory');
    throw new Error('Out of memory (deterministic)');
  });
});`;
    writeFileSync(join(OROOT, 'test', 'd-oom-always.test.ts'), alwaysOom);
    try {
      const r = runOom();
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('oom_rescue_failed=');
      expect(r.stdout + r.stderr).toContain('oom-rescue (serial, confirmed real)');
    } finally {
      rmSync(join(OROOT, 'test', 'd-oom-always.test.ts'), { force: true });
    }
  }, 120_000);
});

describe('run-unit-parallel.sh external-kill rescue contract', () => {
  // An externally-killed shard (sibling workspace pkill, memory jetsam)
  // presents as rc 143/137 well before the shard timeout. Simulating a
  // mid-run external kill deterministically in a fixture is flaky, so this
  // pins the load-bearing structure instead: the early-death detector, the
  // 80%-of-timeout threshold that separates external kills from real wedges,
  // and the rescue-queue routing for both the wedged and non-wedged branches.
  it('detects early SIGTERM/SIGKILL deaths against the 80% timeout threshold', () => {
    const source = readFileSync(PARALLEL_SH_SRC, 'utf-8');
    expect(source).toContain('[ "$rc" = "143" ] || [ "$rc" = "137" ]');
    expect(source).toContain('$((SHARD_TIMEOUT * 80 / 100))');
    expect(source).toContain('shard_external_kill=1');
  });

  it('routes externally-killed shards into the serial rescue queue, not the red path', () => {
    const source = readFileSync(PARALLEL_SH_SRC, 'utf-8');
    const killBranches = source.split('shard_external_kill" = "1"').length - 1;
    expect(killBranches).toBeGreaterThanOrEqual(2); // wedged + non-wedged branch
    expect(source).toContain('KILLED externally after ${s_elapsed}s');
  });

  it('stamps per-shard start/end epochs so early death is measurable', () => {
    const source = readFileSync(PARALLEL_SH_SRC, 'utf-8');
    expect(source).toContain('date +%s > "$LOG_DIR/shard-$i.start"');
    expect(source).toContain('date +%s > "$LOG_DIR/shard-$i.end"');
  });
});
