/**
 * `gbrain pglite-repair` command surface (#223 WAL-repair wave) — SERIAL:
 * the happy path does a real persistent-PGLite cold start (create → corrupt
 * pg_wal → repair in place → reconnect), which is too heavy + lock-contended
 * for the parallel unit shards.
 *
 * `runPgliteRepair` is imported directly (no process spawns); stdout/stderr
 * are captured by spying console.log/console.error per test and restored in
 * finally. Every case uses `--path <hermetic tmpdir>` so the user's real
 * brain and config are never touched, and `--json` so assertions parse a
 * machine receipt instead of prose.
 *
 * Refusal-order note (cases 5-7): the fake layout deliberately PASSES
 * `validateWalRepairTarget` (PG_VERSION 17 + base/ + 8192-byte pg_control) so
 * the command reaches its lock gates; an actual repair on the garbage
 * pg_control would fail in resetWal, but all three cases must refuse BEFORE
 * repair — asserting the refused_* codes proves the ordering.
 */
import { describe, test, expect } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { runPgliteRepair } from '../src/commands/pglite-repair.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Fake PG17 layout that passes validateWalRepairTarget (see file header). */
function makeFakeLayout(dir: string): void {
  mkdirSync(join(dir, 'base'), { recursive: true });
  mkdirSync(join(dir, 'global'), { recursive: true });
  mkdirSync(join(dir, 'pg_wal'), { recursive: true });
  writeFileSync(join(dir, 'PG_VERSION'), '17\n');
  writeFileSync(join(dir, 'global', 'pg_control'), Buffer.alloc(8192));
}

function writeLockFile(dir: string, lock: Record<string, unknown>): string {
  const lockDir = join(dir, '.gbrain-lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'lock'), JSON.stringify(lock), { mode: 0o644 });
  return lockDir;
}

interface Captured {
  logs: string[];
  errors: string[];
  restore: () => void;
}

/** Spy console.log/console.error; caller MUST call restore() in finally. */
function captureConsole(): Captured {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  return {
    logs,
    errors,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

/** Last parseable JSON object line from captured console.log output. */
function parseJsonLine(logs: string[]): Record<string, any> {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as Record<string, any>;
    } catch { /* not this line — keep looking */ }
  }
  throw new Error(`no JSON line in captured output: ${JSON.stringify(logs)}`);
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

const backupDirsBeside = (dir: string): string[] =>
  readdirSync(join(dir, '..')).filter((n) => n.startsWith(`${basename(dir)}.wal-repair-backup-`));

describe('gbrain pglite-repair — dry-run is strictly read-only', () => {
  test('1. dry-run on a corrupt-ish layout: exit 0, JSON diagnosis, zero mutation', async () => {
    const parent = tmp('gbrain-repair-dry-');
    const dir = join(parent, 'brain.pglite');
    makeFakeLayout(dir);
    writeFileSync(join(dir, 'postmaster.pid'), '99999\n'); // unclean-shutdown marker
    const parentBefore = readdirSync(parent).sort();
    const dirBefore = readdirSync(dir).sort();

    const cap = captureConsole();
    let rc: number;
    try {
      rc = await runPgliteRepair(['--dry-run', '--path', dir, '--json']);
    } finally {
      cap.restore();
    }

    expect(rc).toBe(0);
    const out = parseJsonLine(cap.logs);
    expect(out.status).toBe('ok');
    expect(out.action).toBe('dry-run');
    expect(out.data_dir).toBe(dir);
    expect(out.validation.ok).toBe(true);
    expect(out.diagnosis.verdict).toBeDefined();
    expect(out.diagnosis.verdict).toBe('wal-corruption-likely');

    // Read-only: no backup dirs, no sidecar, nothing added or removed.
    expect(backupDirsBeside(dir)).toEqual([]);
    expect(existsSync(`${dir}.wal-repair-attempt.json`)).toBe(false);
    expect(readdirSync(parent).sort()).toEqual(parentBefore);
    expect(readdirSync(dir).sort()).toEqual(dirBefore);
    expect(existsSync(join(dir, 'postmaster.pid'))).toBe(true);
  });

  test('2. dry-run on a missing path: exit 0, validation.ok false, path NOT created', async () => {
    const missing = join(tmp('gbrain-repair-dry-missing-'), 'never-created.pglite');

    const cap = captureConsole();
    let rc: number;
    try {
      rc = await runPgliteRepair(['--dry-run', '--path', missing, '--json']);
    } finally {
      cap.restore();
    }

    expect(rc).toBe(0);
    const out = parseJsonLine(cap.logs);
    expect(out.status).toBe('ok');
    expect(out.action).toBe('dry-run');
    expect(out.validation.ok).toBe(false);
    expect(out.diagnosis.verdict).toBe('missing');
    expect(existsSync(missing)).toBe(false);
  });
});

describe('gbrain pglite-repair — refusals (validate before lock, never mkdir a typo)', () => {
  test('3. non-dry-run on a missing path: exit 1, refused_missing-dir, path NOT created', async () => {
    const missing = join(tmp('gbrain-repair-missing-'), 'typo.pglite');

    const cap = captureConsole();
    let rc: number;
    try {
      rc = await runPgliteRepair(['--path', missing, '--yes', '--json']);
    } finally {
      cap.restore();
    }

    expect(rc).toBe(1);
    const out = parseJsonLine(cap.logs);
    expect(out.status).toBe('error');
    expect(out.code).toBe('refused_missing-dir');
    // validate-before-lock: acquireLock would have mkdir'd the dir.
    expect(existsSync(missing)).toBe(false);
  });

  test('5. live lock holder: exit 1, refused_locked, no repair attempted', async () => {
    const dir = join(tmp('gbrain-repair-locked-'), 'brain.pglite');
    makeFakeLayout(dir);
    const lockDir = writeLockFile(dir, {
      pid: process.pid, // this test process — provably alive
      acquired_at: Date.now(),
      refreshed_at: Date.now(),
      command: 'gbrain embed',
      subcommand: 'embed',
    });

    const cap = captureConsole();
    let rc: number;
    try {
      rc = await runPgliteRepair(['--path', dir, '--yes', '--json']);
    } finally {
      cap.restore();
      rmSync(lockDir, { recursive: true, force: true });
    }

    expect(rc).toBe(1);
    const out = parseJsonLine(cap.logs);
    expect(out.status).toBe('error');
    expect(out.code).toBe('refused_locked');
    // Refused BEFORE repair: no backup dir, no sidecar.
    expect(backupDirsBeside(dir)).toEqual([]);
    expect(existsSync(`${dir}.wal-repair-attempt.json`)).toBe(false);
  });

  test('6. reaped (dead-PID) lock: exit 1, refused_reaped_lock', async () => {
    const dir = join(tmp('gbrain-repair-reaped-'), 'brain.pglite');
    makeFakeLayout(dir);
    writeLockFile(dir, {
      pid: deadPid(), // provably dead — acquireLock reaps it, then refuses
      acquired_at: Date.now() - 60_000,
      refreshed_at: Date.now() - 60_000,
      command: 'gbrain embed',
      subcommand: 'embed',
    });

    const cap = captureConsole();
    let rc: number;
    try {
      rc = await runPgliteRepair(['--path', dir, '--yes', '--json']);
    } finally {
      cap.restore();
    }

    expect(rc).toBe(1);
    const out = parseJsonLine(cap.logs);
    expect(out.status).toBe('error');
    expect(out.code).toBe('refused_reaped_lock');
    // Refused BEFORE repair: no backup dir, no sidecar.
    expect(backupDirsBeside(dir)).toEqual([]);
    expect(existsSync(`${dir}.wal-repair-attempt.json`)).toBe(false);
  }, 30_000);

  test('7. live serve holder: exit 1, refused_locked names the PID', async () => {
    const dir = join(tmp('gbrain-repair-serve-'), 'brain.pglite');
    makeFakeLayout(dir);
    const lockDir = writeLockFile(dir, {
      pid: process.pid, // alive — the pre-lock diagnosis catches it as 'locked'
      acquired_at: Date.now(),
      refreshed_at: Date.now(),
      command: 'gbrain serve',
      subcommand: 'serve',
    });

    const cap = captureConsole();
    let rc: number;
    try {
      rc = await runPgliteRepair(['--path', dir, '--yes', '--json']);
    } finally {
      cap.restore();
      rmSync(lockDir, { recursive: true, force: true });
    }

    expect(rc).toBe(1);
    const out = parseJsonLine(cap.logs);
    expect(out.status).toBe('error');
    expect(out.code).toBe('refused_locked');
    expect(out.message).toContain(String(process.pid));
    expect(backupDirsBeside(dir)).toEqual([]);
  });
});

describe('gbrain pglite-repair — TTY + config gates', () => {
  test('8. non-TTY without --yes refuses: exit 1, no_tty_no_yes, zero mutation', async () => {
    const dir = join(tmp('gbrain-repair-notty-'), 'brain.pglite');
    makeFakeLayout(dir);

    // Pin stdin to non-TTY: under `bun test` in a terminal stdin can still be
    // a TTY, which would route into the interactive confirm instead.
    const origTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const cap = captureConsole();
    let rc: number;
    try {
      rc = await runPgliteRepair(['--path', dir, '--json']); // no --yes
    } finally {
      cap.restore();
      if (origTty) Object.defineProperty(process.stdin, 'isTTY', origTty);
      else delete (process.stdin as unknown as Record<string, unknown>).isTTY;
    }

    expect(rc).toBe(1);
    const out = parseJsonLine(cap.logs);
    expect(out.status).toBe('error');
    expect(out.code).toBe('no_tty_no_yes');
    // Refused BEFORE any surgery: no backup dir, no sidecar.
    expect(backupDirsBeside(dir)).toEqual([]);
    expect(existsSync(`${dir}.wal-repair-attempt.json`)).toBe(false);
  });

  test('9. no --path with a non-pglite configured engine: exit 1, not_pglite', async () => {
    // Hermetic GBRAIN_HOME (same convention as apply-migrations-pglite-spawn):
    // configDir() appends '.gbrain', so the config lands at <home>/.gbrain/.
    const home = tmp('gbrain-repair-home-');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: 'postgresql://localhost:5432/x' }) + '\n',
    );

    const cap = captureConsole();
    let rc: number;
    try {
      rc = await withEnv({ GBRAIN_HOME: home }, () => runPgliteRepair(['--yes', '--json']));
    } finally {
      cap.restore();
    }

    expect(rc).toBe(1);
    const out = parseJsonLine(cap.logs);
    expect(out.status).toBe('error');
    expect(out.code).toBe('not_pglite');
    expect(out.message).toContain('--path');
  });
});

describe('gbrain pglite-repair — the happy path (real PGLite)', () => {
  test('4. corrupt pg_wal → repair in place → data survives, no auto-repair on reconnect', async () => {
    const dir = join(tmp('gbrain-repair-happy-'), 'brain.pglite');

    // 1) Real brain with a probe row, closed cleanly.
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dir });
    try {
      await engine.executeRaw('CREATE TABLE repair_probe(id int)');
      await engine.executeRaw('INSERT INTO repair_probe VALUES (42)');
    } finally {
      await engine.disconnect();
    }

    // 2) Corrupt every WAL segment with garbage.
    const walDir = join(dir, 'pg_wal');
    const segments = readdirSync(walDir).filter((f) => /^[0-9A-F]{24}$/.test(f));
    expect(segments.length).toBeGreaterThan(0); // sanity: there IS WAL to corrupt
    for (const seg of segments) {
      writeFileSync(join(walDir, seg), Buffer.alloc(1024, 0xff));
    }

    // 3) Repair in place.
    const cap = captureConsole();
    let rc: number;
    try {
      rc = await runPgliteRepair(['--path', dir, '--yes', '--json']);
    } finally {
      cap.restore();
    }
    expect(rc).toBe(0);
    const receipt = parseJsonLine(cap.logs);
    expect(receipt.status).toBe('ok');
    expect(receipt.action).toBe('repaired');
    expect(receipt.data_dir).toBe(dir);
    expect(receipt.reset_segment).toMatch(/^[0-9A-F]{24}$/);
    expect(existsSync(receipt.backup_path)).toBe(true);
    expect(existsSync(join(receipt.backup_path, 'pg_wal'))).toBe(true);

    // 4) The repaired dir opens WITHOUT auto-repair firing, data intact.
    const engine2 = new PGLiteEngine();
    await engine2.connect({ database_path: dir });
    try {
      expect(engine2.walRepairReceipt).toBeNull();
      const rows = await engine2.executeRaw<{ id: number }>('SELECT id FROM repair_probe');
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(42);
    } finally {
      await engine2.disconnect();
    }
  }, 180_000);
});

describe('gbrain pglite-repair — argument + quarantine hardening (adversarial fixes)', () => {
  test('unknown flag is rejected (exit 2), not silently ignored on a destructive command', async () => {
    const cap = captureConsole();
    let rc: number;
    try {
      rc = await runPgliteRepair(['--dry-rnu', '--yes', '--json']);
    } finally {
      cap.restore();
    }
    expect(rc).toBe(2);
    expect(parseJsonLine(cap.logs).code).toBe('unknown_flag');
  });

  test('--path with no value is rejected (does NOT retarget the default brain)', async () => {
    const cap = captureConsole();
    let rc: number;
    try {
      rc = await runPgliteRepair(['--yes', '--json', '--path']);
    } finally {
      cap.restore();
    }
    expect(rc).toBe(2);
    expect(parseJsonLine(cap.logs).code).toBe('unknown_flag');
  });

  test('the command honors the cross-process reap quarantine (F3: a second --yes cannot bypass it)', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'pgrepaircmd-')), 'brain.pglite');
    makeFakeLayout(dir);
    // A fresh corrupt-lock reap marker from a prior run — the possibly-live
    // writer it protects must not be repaired under.
    writeFileSync(`${dir}.lock-reap.json`, JSON.stringify({ ts: Date.now(), by: 999999 }), { mode: 0o644 });
    const cap = captureConsole();
    let rc: number;
    try {
      rc = await runPgliteRepair(['--path', dir, '--yes', '--json']);
    } finally {
      cap.restore();
    }
    expect(rc).toBe(1);
    expect(parseJsonLine(cap.logs).code).toBe('refused_reap_quarantine');
    // No surgery: no backup dir created.
    expect(readdirSync(join(dir, '..')).some((f) => f.includes('.wal-repair-backup-'))).toBe(false);
  });
});

describe('gbrain pglite-repair — interactive confirm wiring (#4318 residual)', () => {
  test('uses the shared confirm-prompt helper, not a local reimplementation', () => {
    // This file's own inline `promptYesNo` had the same close-before-resolve
    // race that #4318 fixed in sync-cost-gate.ts/reindex-code.ts: `rl.close()`
    // fired inside the answer callback synchronously triggered an unguarded
    // `rl.on('close', () => resolve(false))`, so a typed "y" was silently
    // read as decline. This pins the fix at the source level — a future
    // change that reintroduces a local `promptYesNo`/`createInterface` here
    // (rather than importing the shared, race-free helper) fails this test,
    // even though `test/confirm-prompt.test.ts` cannot see this file at all.
    // test-reads-source-ok: pins that the local reimplementation stays gone
    // and the shared helper is wired with the exact stderr-preserving args —
    // there's no exported/injectable seam to assert this behaviorally.
    const src = readFileSync(join(import.meta.dir, '../src/commands/pglite-repair.ts'), 'utf8');
    expect(src).toContain("import { promptYesNo } from '../core/confirm-prompt.ts';");
    expect(src).not.toMatch(/\bfunction promptYesNo\b/);
    expect(src).not.toContain("from 'readline'");
    // The call site itself must keep the prompt on stderr — confirm-prompt's
    // default `output` is stdout, and `--json` callers depend on stdout
    // staying machine-readable-only. Checking the import above isn't enough:
    // dropping `{ output: process.stderr }` from this call would still pass
    // that assertion while leaking the prompt into --json output.
    expect(src).toContain("await promptYesNo('Repair now? [y/N] ', { output: process.stderr });");
    expect(src).not.toContain("from 'node:readline'");
  });
});
