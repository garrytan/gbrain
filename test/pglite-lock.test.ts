import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, peekLock, type LockHandle } from '../src/core/pglite-lock';

const TEST_DIR = join(tmpdir(), 'gbrain-lock-test-' + process.pid);

describe('pglite-lock', () => {
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('acquires and releases lock', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);
  });

  test('creates missing data directory before acquiring lock', async () => {
    const missingDataDir = join(TEST_DIR, 'missing-data-dir');

    const lock = await acquireLock(missingDataDir);
    expect(lock.acquired).toBe(true);
    expect(existsSync(missingDataDir)).toBe(true);
    expect(existsSync(join(missingDataDir, '.gbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(missingDataDir, '.gbrain-lock'))).toBe(false);
  });

  test('prevents concurrent lock acquisition', async () => {
    const lock1 = await acquireLock(TEST_DIR, { timeoutMs: 2000 });
    expect(lock1.acquired).toBe(true);

    // Second lock attempt should timeout
    await expect(acquireLock(TEST_DIR, { timeoutMs: 1000 })).rejects.toThrow(/Timed out/);

    await releaseLock(lock1);
  });

  test('detects and cleans stale lock from dead process', async () => {
    // Simulate a stale lock from a dead process
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: 999999999, // Non-existent PID
      acquired_at: Date.now(),
      command: 'test',
    }));

    // Should clean up the stale lock and acquire
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    await releaseLock(lock);
  });

  test('skips lock for in-memory (undefined dataDir)', async () => {
    const lock = await acquireLock(undefined);
    expect(lock.acquired).toBe(true);
    expect(lock.lockDir).toBe('');

    // Release should be a no-op
    await releaseLock(lock);
  });

  test('lock file contains PID and command', async () => {
    const lock = await acquireLock(TEST_DIR);
    const lockData = JSON.parse(readFileSync(join(TEST_DIR, '.gbrain-lock', 'lock'), 'utf-8'));

    expect(lockData.pid).toBe(process.pid);
    expect(lockData.acquired_at).toBeDefined();
    expect(lockData.command).toBeDefined();

    await releaseLock(lock);
  });

  test('releases lock on disconnect even if DB close fails', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    // Simulate DB already closed
    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);

    // Second acquisition should work
    const lock2 = await acquireLock(TEST_DIR);
    expect(lock2.acquired).toBe(true);
    await releaseLock(lock2);
  });
});

describe('pglite-lock #2058 heartbeat + steal-grace', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function writeHolder(fields: {
    pid: number;
    acquiredAgoMs: number;
    refreshedAgoMs: number;
    command?: string;
    subcommand?: string;
  }) {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: fields.pid,
      acquired_at: now - fields.acquiredAgoMs,
      refreshed_at: now - fields.refreshedAgoMs,
      command: fields.command ?? 'test holder',
      ...(fields.subcommand === undefined ? {} : { subcommand: fields.subcommand }),
    }));
  }

  test('a live gbrain serve owner with global flags fails fast with a clear explanation', async () => {
    writeHolder({
      pid: process.pid,
      acquiredAgoMs: 60_000,
      refreshedAgoMs: 0,
      command: '/path with spaces/gbrain/src/cli.ts --quiet serve',
      subcommand: 'serve',
    });

    const startedAt = Date.now();
    await expect(acquireLock(TEST_DIR, { timeoutMs: 5_000 })).rejects.toThrow(
      /already open through `gbrain serve`.*`gbrain sync` runs through the live serve automatically.*stop `gbrain serve` and retry.*use its MCP tools instead.*will not remove/s,
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('legacy serve lock metadata is still recognized', async () => {
    writeHolder({
      pid: process.pid,
      acquiredAgoMs: 60_000,
      refreshedAgoMs: 0,
      command: '/path/to/gbrain/src/cli.ts serve',
    });

    await expect(acquireLock(TEST_DIR, { timeoutMs: 5_000 })).rejects.toThrow(
      /already open through `gbrain serve`/,
    );
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('a search for the word serve is not mistaken for the MCP server', async () => {
    writeHolder({
      pid: process.pid,
      acquiredAgoMs: 60_000,
      refreshedAgoMs: 0,
      command: '/compiled/gbrain search serve',
      subcommand: 'search',
    });

    await expect(acquireLock(TEST_DIR, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('a dead gbrain serve owner is still cleaned up automatically', async () => {
    writeHolder({
      pid: 999999999,
      acquiredAgoMs: 60_000,
      refreshedAgoMs: 0,
      command: '/path/to/gbrain/src/cli.ts serve',
      subcommand: 'serve',
    });

    const lock = await acquireLock(TEST_DIR, { timeoutMs: 2_000 });
    expect(lock.acquired).toBe(true);
    await releaseLock(lock);
  });

  test('[REGRESSION] a LIVE holder with a fresh heartbeat is NOT stolen even when the lock is old', async () => {
    // The WAL-corruption bug: a >5min embed used to get its lock force-removed.
    // Now an alive holder that heartbeated recently is left alone regardless of
    // age. acquired 20min ago, but refreshed just now → must wait, not steal.
    writeHolder({ pid: process.pid, acquiredAgoMs: 20 * 60_000, refreshedAgoMs: 0 });

    await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/Timed out/);
    // Holder's lock still present (was never stolen).
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('[REGRESSION #2348] a LIVE PID with a STALE heartbeat is NOT stolen', async () => {
    // The #2348 corruption: a live `gbrain dream`/embed holder whose heartbeat
    // lapsed (the JS event loop is blocked during a long synchronous WASM
    // import) used to get its lock reaped past the grace window — letting a
    // second OS process open the same data dir and corrupt the catalog +
    // pgvector extension state. A live PID is now NEVER stolen, regardless of
    // how stale its heartbeat is. Acquire must time out, not steal.
    writeHolder({ pid: process.pid, acquiredAgoMs: 25 * 60_000, refreshedAgoMs: 20 * 60_000 });

    await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/Timed out/);
    // The live holder's lock is still present — never force-removed.
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('explains live gbrain serve contention is not a sync advisory lock', async () => {
    writeHolder({
      pid: process.pid,
      acquiredAgoMs: 60_000,
      refreshedAgoMs: 0,
      command: 'bun /Users/master/.bun/bin/gbrain serve',
    });

    let message = '';
    try {
      await acquireLock(TEST_DIR, { timeoutMs: 100 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('serve↔sync contention');
    expect(message).toContain('not the `gbrain-sync:*` advisory lock');
    expect(message).toContain('`gbrain sync --break-lock` will not clear a live PGLite holder');
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('[REGRESSION] releaseLock does NOT remove a lock that was stolen + re-acquired by another process', async () => {
    // We acquire, then simulate a steal: another process reaped us past grace
    // and now owns the lock (different pid + acquired_at). Our releaseLock must
    // NOT delete their live lock — doing so would let a third process in
    // alongside the new owner (the #2058 corruption class).
    const lock: LockHandle = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    expect(lock.ownerToken).toBeDefined();
    if (lock.heartbeat) clearInterval(lock.heartbeat); // stop our heartbeat for a deterministic test

    // Overwrite the lock file as if process B re-acquired it.
    const lockFile = join(TEST_DIR, '.gbrain-lock', 'lock');
    const bNow = Date.now() + 1;
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, acquired_at: bNow, refreshed_at: bNow, command: 'process B' }));

    await releaseLock(lock); // our (stale) handle

    // B's lock survives — we did not clobber it.
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    const after = JSON.parse(readFileSync(lockFile, 'utf-8'));
    expect(after.pid).toBe(999999);

    // Cleanup for afterEach.
    rmSync(join(TEST_DIR, '.gbrain-lock'), { recursive: true, force: true });
  });

  test('acquire starts a heartbeat and seeds refreshed_at; release clears it', async () => {
    const lock: LockHandle = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    expect(lock.heartbeat).toBeDefined();
    const data = JSON.parse(readFileSync(join(TEST_DIR, '.gbrain-lock', 'lock'), 'utf-8'));
    expect(data.refreshed_at).toBeDefined();
    expect(typeof data.refreshed_at).toBe('number');

    await releaseLock(lock);
    expect(lock.heartbeat).toBeUndefined();
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);
  });
});

describe('pglite-lock reap classification (WAL-repair wave)', () => {
  // Unique per-test tmpdirs: the reap marker lands at `${dataDir}.lock-reap.json`
  // — a SIBLING of the data dir — so each test gets its own parent to rm.
  function freshDataDir(): { parent: string; dataDir: string } {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-lock-reap-'));
    return { parent, dataDir: join(parent, 'data') };
  }

  /**
   * A PID that provably belongs to no live process: spawn a short-lived child,
   * wait for it (spawnSync reaps it), then verify kill(pid, 0) throws. Retries
   * to dodge instant PID reuse.
   */
  function deadPid(): number {
    for (let attempt = 0; attempt < 5; attempt++) {
      const proc = Bun.spawnSync(['bash', '-c', 'exit 0']);
      const pid = proc.pid;
      try {
        process.kill(pid, 0); // still alive/visible → PID reused, try again
      } catch {
        return pid;
      }
    }
    throw new Error('could not obtain a provably-dead PID after 5 spawns');
  }

  test('corrupt lock file: reaped acquisition + persisted .lock-reap.json marker', async () => {
    const { parent, dataDir } = freshDataDir();
    try {
      const lockDir = join(dataDir, '.gbrain-lock');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'lock'), 'not json {{{'); // holder liveness UNKNOWABLE

      const lock = await acquireLock(dataDir, { timeoutMs: 5000 });
      try {
        expect(lock.acquired).toBe(true);
        expect(lock.reaped).toBe(true);
        // Unknowable-liveness reap is persisted cross-process for the repair gate.
        expect(existsSync(`${dataDir}.lock-reap.json`)).toBe(true);
        const marker = JSON.parse(readFileSync(`${dataDir}.lock-reap.json`, 'utf-8'));
        expect(typeof marker.ts).toBe('number');
        expect(marker.by).toBe(process.pid);
      } finally {
        await releaseLock(lock);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('clean acquisition: reaped falsy, no .lock-reap.json marker', async () => {
    const { parent, dataDir } = freshDataDir();
    try {
      const lock = await acquireLock(dataDir, { timeoutMs: 5000 });
      try {
        expect(lock.acquired).toBe(true);
        expect(lock.reaped).toBeFalsy();
        expect(existsSync(`${dataDir}.lock-reap.json`)).toBe(false);
      } finally {
        await releaseLock(lock);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('dead-PID lock: reaped acquisition but NO marker (affirmative ESRCH verdict)', async () => {
    const { parent, dataDir } = freshDataDir();
    try {
      const lockDir = join(dataDir, '.gbrain-lock');
      mkdirSync(lockDir, { recursive: true });
      const now = Date.now();
      writeFileSync(join(lockDir, 'lock'), JSON.stringify({
        pid: deadPid(),
        acquired_at: now - 60_000,
        refreshed_at: now - 60_000,
        command: 'gbrain embed',
        subcommand: 'embed',
      }));

      const lock = await acquireLock(dataDir, { timeoutMs: 5000 });
      try {
        expect(lock.acquired).toBe(true);
        expect(lock.reaped).toBe(true);
        // Dead-PID reaps deliberately do NOT quarantine the next acquirer.
        expect(existsSync(`${dataDir}.lock-reap.json`)).toBe(false);
      } finally {
        await releaseLock(lock);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('pglite-lock peekLock (pure read, no side effects)', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('no lock dir → not held, and never creates one', () => {
    const result = peekLock(TEST_DIR);
    expect(result.held).toBe(false);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);
  });

  test('a lock file that parses but has no usable pid reads as HELD (unprovable ≠ free, #2348)', () => {
    // Erring the other way corrupted catalogs: a holder whose liveness cannot
    // be proven must be treated as alive. This branch currently rides on
    // isProcessAlive's invalid-pid handling — pinned here so a future cleanup
    // of that function cannot silently flip peekLock to not-held.
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({ acquired_at: 123, command: 'gbrain serve', subcommand: 'serve' }));
    const result = peekLock(TEST_DIR);
    expect(result.held).toBe(true);
    expect(result.pid).toBeUndefined();
  });

  test('live holder, serve subcommand → held, isServe true, pid reported', async () => {
    const lock = await acquireLock(TEST_DIR);
    try {
      const lockPath = join(TEST_DIR, '.gbrain-lock', 'lock');
      const raw = JSON.parse(readFileSync(lockPath, 'utf-8'));
      writeFileSync(lockPath, JSON.stringify({ ...raw, subcommand: 'serve' }));

      const result = peekLock(TEST_DIR);
      expect(result.held).toBe(true);
      expect(result.isServe).toBe(true);
      expect(result.pid).toBe(process.pid);
    } finally {
      await releaseLock(lock);
    }
  });

  test('live holder, non-serve subcommand → held, isServe false', async () => {
    const lock = await acquireLock(TEST_DIR);
    try {
      const result = peekLock(TEST_DIR);
      expect(result.held).toBe(true);
      expect(result.isServe).toBe(false);
    } finally {
      await releaseLock(lock);
    }
  });

  test('dead-pid holder → not held', () => {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    // PID 999999 is essentially guaranteed not to be a live process.
    writeFileSync(
      join(lockDir, 'lock'),
      JSON.stringify({ pid: 999999, acquired_at: Date.now(), command: 'gbrain serve', subcommand: 'serve' }),
    );
    const result = peekLock(TEST_DIR);
    expect(result.held).toBe(false);
  });

  test('corrupt lock file → not held (falls through to a real connect attempt)', () => {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock'), 'not json{{{');
    const result = peekLock(TEST_DIR);
    expect(result.held).toBe(false);
  });

  test('never throws LiveServeLockError, unlike acquireLock', async () => {
    const lock = await acquireLock(TEST_DIR);
    try {
      const lockPath = join(TEST_DIR, '.gbrain-lock', 'lock');
      const raw = JSON.parse(readFileSync(lockPath, 'utf-8'));
      writeFileSync(lockPath, JSON.stringify({ ...raw, subcommand: 'serve' }));
      expect(() => peekLock(TEST_DIR)).not.toThrow();
    } finally {
      await releaseLock(lock);
    }
  });
});

describe('pglite-lock PID-reuse detection', () => {
  // The wedge this covers: a gbrain holder dies, the OS recycles its PID into
  // an unrelated process (docker-proxy, a shell, ...), and kill(pid, 0) keeps
  // saying "alive" — so the stale lock was never reaped and every acquirer
  // timed out until manual cleanup.
  const canProbe = process.platform !== 'win32'; // ps + sleep/bash available
  const isLinux = process.platform === 'linux';

  function currentBootId(): string | null {
    try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim() || null; }
    catch { return null; }
  }

  function currentPidNs(): string | null {
    try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; }
  }

  function writeHolderAt(dataDir: string, pid: number, command: string, opts?: { subcommand?: string; bootId?: string | null; pidNs?: string | null }) {
    const lockDir = join(dataDir, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid,
      acquired_at: now - 60_000,
      refreshed_at: now - 60_000,
      command,
      boot_id: opts?.bootId === undefined ? currentBootId() : opts.bootId,
      pid_ns: opts?.pidNs === undefined ? currentPidNs() : opts.pidNs,
      ...(opts?.subcommand === undefined ? {} : { subcommand: opts.subcommand }),
    }));
  }

  /**
   * Wait until the spawned child has exec'd into its target program. Between
   * spawn and exec, the child's command line still shows the PARENT's argv —
   * which under the repo test runner contains "gbrain" (the checkout path) and
   * would spoof the reuse check. Poll via `ps` until the real args are in place.
   */
  async function waitForExec(pid: number, pattern: RegExp): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
        }).trim();
        if (args.length > 0 && pattern.test(args)) return;
      } catch { /* not exec'd yet — retry */ }
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`child ${pid} never exec'd into ${pattern}`);
  }

  test.skipIf(!canProbe)('reaps a lock whose PID was recycled by an unrelated program', async () => {
    // `sleep` is a live process that is provably NOT the gbrain holder.
    const squatter = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(squatter.pid, /sleep/);
      writeHolderAt(TEST_DIR, squatter.pid, '/home/user/.bun/bin/gbrain serve --http', { subcommand: 'serve' });

      const lock = await acquireLock(TEST_DIR, { timeoutMs: 5000 });
      try {
        expect(lock.acquired).toBe(true);
        expect(lock.reaped).toBe(true);
      } finally {
        await releaseLock(lock);
      }
    } finally {
      squatter.kill();
    }
  }, 15_000);

  test.skipIf(!canProbe)('does NOT reap a live process whose cmdline identifies it as gbrain', async () => {
    // The gbrain marker rides in a REAL argv slot (bash's $0), simulating a
    // live holder without running gbrain itself. Not `exec -a` argv[0]
    // spoofing: on hosts where coreutils is a multicall binary behind shebang
    // wrappers (e.g. sandbox images), the kernel's shebang rewrite destroys
    // the spoofed argv[0]. The compound command keeps bash from exec-replacing
    // itself, so its argv (and the marker) stays visible for the test's life.
    const holder = Bun.spawn(['bash', '-c', 'sleep 60; exit 0', 'gbrain-fake-holder'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(holder.pid, /gbrain-fake-holder/);
      writeHolderAt(TEST_DIR, holder.pid, 'gbrain-fake-holder embed', { subcommand: 'embed' });

      await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/Timed out/);
      // Live holder's lock was never stolen.
      expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    } finally {
      holder.kill();
    }
  }, 15_000);

  test.skipIf(!canProbe)('does NOT reap a live holder whose recorded command is an absolute path but whose cmdline shows the relative bun-run form', async () => {
    // False-steal regression (caught by the harness-lifecycle E2E): a serve
    // spawned as `bun run src/cli.ts serve …` reports a RELATIVE cmdline via
    // ps, while its lock records Bun's ABSOLUTE argv[1]. The literal
    // includes(firstToken) veto never matches and, when the checkout path
    // carries no 'gbrain' substring, the live holder was classified as a
    // recycled PID and its lock stolen — the thief then wrote to a second
    // PGLite instance the live serve never sees. The basename veto
    // ('cli.ts' appears in the cmdline) must keep the holder alive.
    const holder = Bun.spawn(['bash', '-c', 'sleep 60; exit 0', 'bun run src/cli.ts serve --http'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(holder.pid, /cli\.ts/);
      writeHolderAt(TEST_DIR, holder.pid, '/home/user/checkouts/brain-project/src/cli.ts serve --http', { subcommand: 'serve' });

      await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/already open through `gbrain serve`/);
      expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    } finally {
      holder.kill();
    }
  }, 15_000);

  test.skipIf(!isLinux)('does NOT reap on cmdline evidence when the lock belongs to another PID namespace', async () => {
    // #2840 class: a holder in another container shares the data dir; its
    // recorded PID maps to an unrelated process in OUR namespace. The pid_ns
    // mismatch must veto the reap even though the cmdline clearly differs.
    const squatter = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(squatter.pid, /sleep/);
      writeHolderAt(TEST_DIR, squatter.pid, '/home/user/.bun/bin/gbrain serve --http', { subcommand: 'serve', pidNs: 'pid:[1]' });

      await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/already open through `gbrain serve`/);
      expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    } finally {
      squatter.kill();
    }
  }, 15_000);

  test.skipIf(!isLinux)('never cmdline-reaps a LEGACY lock without namespace markers (fail-safe)', async () => {
    // Pre-marker locks carry no pid_ns: their recorded PID may belong to a
    // different namespace, so a cmdline mismatch proves nothing. ESRCH reaps
    // still apply; cmdline reaps must not.
    const squatter = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(squatter.pid, /sleep/);
      writeHolderAt(TEST_DIR, squatter.pid, '/home/user/.bun/bin/gbrain serve --http', { subcommand: 'serve', pidNs: null, bootId: null });

      await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/already open through `gbrain serve`/);
      expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    } finally {
      squatter.kill();
    }
  }, 15_000);

  test.skipIf(!isLinux)('never cmdline-reaps when boot_id is missing even if pid_ns matches (cross-host guard)', async () => {
    // pid_ns inode numbers can collide across hosts sharing a data dir, so on
    // Linux BOTH markers must be present and matching before cmdline evidence
    // is trusted.
    const squatter = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(squatter.pid, /sleep/);
      writeHolderAt(TEST_DIR, squatter.pid, '/home/user/.bun/bin/gbrain serve --http', { subcommand: 'serve', bootId: null });

      await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/already open through `gbrain serve`/);
      expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    } finally {
      squatter.kill();
    }
  }, 15_000);

  test('a lock held by THIS process is never classified as recycled', async () => {
    // Same-process re-acquire: the recorded PID is our own, so the cmdline
    // check must stand down even though `bun test` has no gbrain marker.
    writeHolderAt(TEST_DIR, process.pid, 'test holder');

    await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/Timed out/);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test.skipIf(!canProbe)('concurrent reapers: exactly one reaps, the other never deletes the winner\u2019s fresh lock', async () => {
    // Race regression: two acquirers classify the same recycled-PID victim.
    // Without the atomic rename-aside claim, the slower reaper's rmSync can
    // delete the faster one's freshly installed lock — two writers, one dir.
    const squatter = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(squatter.pid, /sleep/);
      writeHolderAt(TEST_DIR, squatter.pid, '/home/user/.bun/bin/gbrain serve --http', { subcommand: 'serve' });

      const results = await Promise.allSettled([
        acquireLock(TEST_DIR, { timeoutMs: 5000 }),
        acquireLock(TEST_DIR, { timeoutMs: 5000 }),
      ]);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');
      // Exactly one reaps + acquires; the loser must time out against the
      // winner's live lock — never delete it.
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      const lockFile = join(TEST_DIR, '.gbrain-lock', 'lock');
      expect(existsSync(lockFile)).toBe(true);
      const onDisk = JSON.parse(readFileSync(lockFile, 'utf-8'));
      expect(onDisk.pid).toBe(process.pid); // the winner's lock survived intact

      await releaseLock((fulfilled[0] as PromiseFulfilledResult<LockHandle>).value);
    } finally {
      squatter.kill();
    }
  }, 15_000);
});
