/**
 * backup-cli.serial.test.ts — pins src/commands/backup.ts runBackupCli:
 * usage surface (--help / unknown subcommand), the status cache policy
 * (fresh ok cache never touches the engine; a fresh warn cache forces a
 * recompute), check's always-compute + --quiet contract, the PGLite-lock
 * fallback (cache-derived exit, fail-open with no cache) including a
 * source-text contract pin on the lock-error literal, non-lock engine
 * failures (reject with no cache, cache fallback otherwise), the
 * GBRAIN_BACKUP_CHECK=0 off switch (check refuses; status is a cache-only
 * reader), the --json recovery/degraded payload, and the warn-path
 * 'status' nag impression.
 *
 * Engine is driven through a stub connect thunk (async () => engineStub)
 * with the executeRaw idiom from test/backup-coverage.serial.test.ts —
 * no real PGLite, no real engine lock.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrainEngine } from '../src/core/engine.ts';
import { runBackupCli } from '../src/commands/backup.ts';
import { DEFAULT_CLI_OPTIONS, setCliOptions, _resetCliOptionsForTest } from '../src/core/cli-options.ts';
import { __resetBackupRefreshForTests } from '../src/core/backup/coverage.ts';
import {
  BACKUP_STATUS_SCHEMA_VERSION,
  __setBackupIntervalForTests,
  __setBackupNagStatePathForTests,
  __setBackupStatusPathForTests,
  loadBackupStatus,
  saveBackupStatus,
  type BackupStatus,
} from '../src/core/backup/status-file.ts';

/** The exact literal thrown by src/core/pglite-engine.ts on lock contention.
 * isLockError in src/commands/backup.ts matches on the leading substring —
 * the source-text contract pin below fails the suite if either side drifts. */
const LOCK_SUBSTRING = 'Could not acquire PGLite lock';
const LOCK_MESSAGE = 'Could not acquire PGLite lock. Another gbrain process is using the database.';

const ENV_KEYS = [
  'GBRAIN_HOME',
  'GBRAIN_BACKUP_CHECK',
  'GBRAIN_BACKUP_CHECK_DAYS',
  'DATABASE_URL',
  'GBRAIN_DATABASE_URL',
  'GBRAIN_SOURCE',
  'GBRAIN_SKIP_STARTUP_HOOKS',
] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let statusPath: string;
let nagPath: string;

const home = () => join(tmp, '.gbrain');

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-bkcli-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp; // configDir() === tmp/.gbrain
  statusPath = join(home(), 'backup-status.json');
  nagPath = join(home(), 'backup-nag-state.json');
  __setBackupStatusPathForTests(statusPath);
  __setBackupNagStatePathForTests(nagPath);
  __resetBackupRefreshForTests();
  _resetCliOptionsForTest();
});

afterEach(() => {
  __setBackupStatusPathForTests(null);
  __setBackupNagStatePathForTests(null);
  __setBackupIntervalForTests(null);
  __resetBackupRefreshForTests();
  _resetCliOptionsForTest();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function stubEngine(opts: {
  kind?: 'pglite' | 'postgres';
  sources?: unknown[];
  pages?: number;
  sourcesThrow?: boolean;
} = {}): BrainEngine {
  return {
    kind: opts.kind ?? 'pglite',
    executeRaw: async (sql: string) => {
      if (sql.includes('FROM pages')) return [{ n: opts.pages ?? 0 }];
      if (sql.includes('FROM sources')) {
        if (opts.sourcesThrow) throw new Error('sources unreadable');
        return opts.sources ?? [];
      }
      return [];
    },
    disconnect: async () => {},
  } as unknown as BrainEngine;
}

/** Connect thunk that counts calls and resolves the given engine. */
function thunkFor(engine: BrainEngine): { connect: () => Promise<BrainEngine>; calls: () => number } {
  let n = 0;
  return {
    connect: async () => {
      n++;
      return engine;
    },
    calls: () => n,
  };
}

function throwingThunk(err: Error): { connect: () => Promise<BrainEngine>; calls: () => number } {
  let n = 0;
  return {
    connect: async () => {
      n++;
      throw err;
    },
    calls: () => n,
  };
}

/** Hand-built cache verdict that passes loadBackupStatus validation. */
function mkStatus(overall: 'ok' | 'warn', checkedAt: string): BackupStatus {
  const noRemote = overall === 'warn' ? 1 : 0;
  return {
    schema_version: BACKUP_STATUS_SCHEMA_VERSION,
    checked_at: checkedAt,
    gbrain_version: '0.0.0-test',
    interval_days: 30,
    computed_by: 'cli',
    overall,
    totals: {
      assets: noRemote,
      no_remote: noRemote,
      unpushed: 0,
      failing: 0,
      recoverable_repos: 0,
      pages_at_risk: 0,
    },
    assets:
      overall === 'warn'
        ? [{ kind: 'source_repo', id: 'stale-example', state: 'no_remote', fix_argv: null }]
        : [],
  };
}

/** Run runBackupCli with stdout/console.log/console.error captured. */
async function run(
  args: string[],
  connect: () => Promise<BrainEngine>,
): Promise<{ exitCode: 0 | 1 | 2; stdout: string; log: string; stderr: string }> {
  const out: string[] = [];
  const log: string[] = [];
  const errs: string[] = [];
  const origWrite = process.stdout.write;
  const origLog = console.log;
  const origErr = console.error;
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    out.push(String(chunk));
    return true;
  };
  console.log = (...a: unknown[]) => {
    log.push(a.map(String).join(' '));
  };
  console.error = (...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  };
  try {
    const res = await runBackupCli(args, connect);
    return { exitCode: res.exitCode, stdout: out.join(''), log: log.join('\n'), stderr: errs.join('\n') };
  } finally {
    (process.stdout as { write: unknown }).write = origWrite;
    console.log = origLog;
    console.error = origErr;
  }
}

// ── Usage surface ────────────────────────────────────────────────────────────

describe('runBackupCli — usage', () => {
  test('--help → exit 0 with the help text', async () => {
    const { connect, calls } = thunkFor(stubEngine({}));
    const r = await run(['--help'], connect);
    expect(r.exitCode).toBe(0);
    expect(r.log).toContain('gbrain backup <status|check>');
    expect(calls()).toBe(0);
  });

  test('no args → exit 0 with the help text', async () => {
    const { connect, calls } = thunkFor(stubEngine({}));
    const r = await run([], connect);
    expect(r.exitCode).toBe(0);
    expect(r.log).toContain('gbrain backup <status|check>');
    expect(calls()).toBe(0);
  });

  test('unknown subcommand → exit 2 on stderr', async () => {
    const { connect, calls } = thunkFor(stubEngine({}));
    const r = await run(['bogus'], connect);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Unknown backup subcommand: bogus');
    expect(calls()).toBe(0);
  });
});

// ── status cache policy ──────────────────────────────────────────────────────

describe('runBackupCli status — cache policy', () => {
  test('fresh ok cache → exit 0 and the connect thunk is NEVER called', async () => {
    saveBackupStatus(mkStatus('ok', new Date().toISOString()));
    const { connect, calls } = thunkFor(stubEngine({}));

    const r = await run(['status'], connect);

    expect(r.exitCode).toBe(0);
    expect(calls()).toBe(0); // no lock risk: fresh ok cache answers alone
    expect(r.stdout).toContain('backup coverage — ok');
  });

  test('fresh warn cache → recomputes (forceRefresh), exit reflects the NEW verdict', async () => {
    const oldIso = new Date(Date.now() - 60_000).toISOString();
    saveBackupStatus(mkStatus('warn', oldIso));
    // Recompute against an empty brain (no sources, 0 pages) → verdict ok.
    const { connect, calls } = thunkFor(stubEngine({}));

    const r = await run(['status'], connect);

    expect(calls()).toBe(1);
    expect(r.exitCode).toBe(0); // NEW verdict, not the stale warn
    expect(r.stdout).toContain('backup coverage — ok');
    const persisted = loadBackupStatus();
    expect(persisted?.overall).toBe('ok');
    expect(persisted?.checked_at).not.toBe(oldIso);
  });
});

// ── check always computes + --quiet ─────────────────────────────────────────

describe('runBackupCli check', () => {
  test('check always computes, even over a fresh ok cache; exit 0 when ok', async () => {
    const oldIso = new Date(Date.now() - 60_000).toISOString();
    saveBackupStatus(mkStatus('ok', oldIso));
    const { connect, calls } = thunkFor(stubEngine({}));

    const r = await run(['check'], connect);

    expect(calls()).toBe(1);
    expect(r.exitCode).toBe(0);
    expect(loadBackupStatus()?.checked_at).not.toBe(oldIso); // re-persisted
  });

  test('check exits 1 on a warn compute (pglite pages-only brain)', async () => {
    const { connect, calls } = thunkFor(stubEngine({ kind: 'pglite', pages: 42 }));

    const r = await run(['check'], connect);

    expect(calls()).toBe(1);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('WARN');
    expect(loadBackupStatus()?.overall).toBe('warn');
  });

  test('--quiet → exit 0 and no stdout (detached-spawn mode)', async () => {
    setCliOptions({ ...DEFAULT_CLI_OPTIONS, quiet: true });
    const { connect, calls } = thunkFor(stubEngine({ kind: 'pglite', pages: 42 }));

    const r = await run(['check'], connect);

    expect(calls()).toBe(1); // still computes + caches
    expect(r.exitCode).toBe(0); // always 0 in quiet mode, even on warn
    expect(r.stdout).toBe('');
    expect(r.log).toBe('');
    const persisted = loadBackupStatus();
    expect(persisted?.overall).toBe('warn');
    expect(persisted?.computed_by).toBe('spawn'); // quiet stamps spawn
  });
});

// ── PGLite-lock fallback contract ────────────────────────────────────────────

describe('runBackupCli — PGLite lock fallback', () => {
  test('lock error + warn cache → exit 1 with the DB-locked note', async () => {
    saveBackupStatus(mkStatus('warn', new Date(Date.now() - 60_000).toISOString()));
    const { connect, calls } = throwingThunk(new Error(LOCK_MESSAGE));

    const r = await run(['status'], connect);

    expect(calls()).toBe(1);
    expect(r.exitCode).toBe(1); // cache-derived exit, never a crash
    expect(r.stdout).toContain('DB locked by serve');
    expect(r.stdout).toContain('backup coverage — WARN');
  });

  test('lock error + NO cache → exit 0 (unknown, fail-open)', async () => {
    const { connect, calls } = throwingThunk(new Error(LOCK_MESSAGE));

    const r = await run(['status'], connect);

    expect(calls()).toBe(1);
    expect(r.exitCode).toBe(0);
    expect(r.log).toContain('no cached verdict; DB locked by serve');
    expect(existsSync(statusPath)).toBe(false);
  });

  test('source-text contract pin: pglite-engine still throws the literal isLockError matches', () => {
    const engineSrc = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'pglite-engine.ts'), 'utf-8');
    expect(engineSrc).toContain(LOCK_SUBSTRING);
    // And backup.ts matches on exactly that substring — drift on either side
    // silently breaks the serve-cohort fallback, so pin both.
    const backupSrc = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'backup.ts'), 'utf-8');
    expect(backupSrc).toContain(`includes('${LOCK_SUBSTRING}')`);
  });
});

// ── Non-lock engine failures ─────────────────────────────────────────────────

describe('runBackupCli — non-lock connect errors', () => {
  test('no cache → runBackupCli rejects (the failure propagates)', async () => {
    const { connect } = throwingThunk(new Error('engine exploded'));
    await expect(runBackupCli(['check'], connect)).rejects.toThrow('engine exploded');
  });

  test('with cache → falls back to the cached verdict + note', async () => {
    saveBackupStatus(mkStatus('warn', new Date(Date.now() - 60_000).toISOString()));
    const { connect, calls } = throwingThunk(new Error('engine exploded'));

    const r = await run(['status'], connect);

    expect(calls()).toBe(1);
    expect(r.exitCode).toBe(1); // exit from cache
    expect(r.stdout).toContain('engine unavailable — verdict from cache');
  });
});

// ── Off switch (GBRAIN_BACKUP_CHECK=0) ───────────────────────────────────────

describe('runBackupCli — disabled', () => {
  test('check → exit 0 + refusal on stderr, no compute', async () => {
    process.env.GBRAIN_BACKUP_CHECK = '0';
    const { connect, calls } = thunkFor(stubEngine({ kind: 'pglite', pages: 42 }));

    const r = await run(['check'], connect);

    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('backup check is disabled');
    expect(calls()).toBe(0);
    expect(existsSync(statusPath)).toBe(false);
  });

  test('status with warn cache → cache-only reader (thunk never called), exit 0 (cron-safe), no impression', async () => {
    process.env.GBRAIN_BACKUP_CHECK = '0';
    saveBackupStatus(mkStatus('warn', new Date(Date.now() - 60_000).toISOString()));
    const { connect, calls } = thunkFor(stubEngine({}));

    const r = await run(['status'], connect);

    expect(calls()).toBe(0); // disabled silences COMPUTE — no engine touch
    // Disabled means silent for automation too: a stale warn cache that can
    // never refresh must not fail crons with exit 1.
    expect(r.exitCode).toBe(0);
    // The verdict + note text still render unchanged for the human reader…
    expect(r.stdout).toContain('backup coverage — WARN');
    expect(r.stdout).toContain('backup check disabled — verdict from cache only');
    // …but no 'status' nag impression is recorded while disabled.
    expect(existsSync(nagPath)).toBe(false);
  });
});

// ── --json payload ───────────────────────────────────────────────────────────

describe('runBackupCli --json', () => {
  test('recovery field carries recoverable_repos / pages_at_risk / statement', async () => {
    const { connect } = thunkFor(stubEngine({}));

    const r = await run(['check', '--json'], connect);

    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      overall: string;
      recovery: { recoverable_repos: number; pages_at_risk: number; statement: string };
    };
    expect(payload.overall).toBe('ok');
    expect(payload.recovery.recoverable_repos).toBe(0);
    expect(payload.recovery.pages_at_risk).toBe(0);
    expect(payload.recovery.statement).toContain('What survives a disk loss today');
  });

  test('degraded compute passes degraded:true through and is never persisted', async () => {
    // sources query throws, pages query works → computeBackupCoverage marks
    // the verdict degraded; with no prior cache it is returned but NOT cached.
    const { connect, calls } = thunkFor(stubEngine({ sourcesThrow: true, pages: 5 }));

    const r = await run(['check', '--json'], connect);

    expect(calls()).toBe(1);
    const payload = JSON.parse(r.stdout) as { degraded?: boolean };
    expect(payload.degraded).toBe(true);
    expect(existsSync(statusPath)).toBe(false); // degraded verdicts never persist
    expect(r.exitCode).toBe(0); // degraded suppresses the db_content warn
  });
});

// ── Nag impression on warn ───────────────────────────────────────────────────

describe('runBackupCli — nag impression', () => {
  test("a warn verdict records a 'status' impression in backup-nag-state.json", async () => {
    const { connect } = thunkFor(stubEngine({ kind: 'pglite', pages: 42 }));

    const r = await run(['check'], connect);
    expect(r.exitCode).toBe(1);

    expect(existsSync(nagPath)).toBe(true);
    const nag = JSON.parse(readFileSync(nagPath, 'utf-8')) as {
      schema_version: string;
      entries: Array<{ pack_name: string; source_id: string }>;
      last_shown_at?: string;
      global_shown_count?: number;
    };
    expect(nag.schema_version).toBe('gbrain-backup-nag-v1');
    expect(nag.entries.some((e) => e.pack_name === 'status' && e.source_id === 'backup')).toBe(true);
    expect(nag.last_shown_at).toBeDefined();
    expect(nag.global_shown_count).toBe(1);
  });

  test('an ok verdict records nothing', async () => {
    const { connect } = thunkFor(stubEngine({}));
    const r = await run(['check'], connect);
    expect(r.exitCode).toBe(0);
    expect(existsSync(nagPath)).toBe(false);
  });
});
