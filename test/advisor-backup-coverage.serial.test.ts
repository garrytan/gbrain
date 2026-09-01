/**
 * Tests for src/core/advisor/collect-backup-coverage.ts — the advisor
 * collector that surfaces the monthly backup-coverage verdict.
 *
 * Local runs (ctx.remote === false) recompute through getBackupStatus with
 * real git probes against tmp fixture repos and emit per-asset findings,
 * gated as one batch through backupNagGate. Remote runs (ctx.remote === true)
 * are cache-readers only: one aggregate finding, no source ids, no local
 * paths, and NEVER a nag-state write.
 *
 * Isolation: tmp GBRAIN_HOME (configDir() appends '.gbrain') plus the
 * status-file __set...ForTests path seams, so the real ~/.gbrain is never
 * touched. No mock.module → plain .test.ts (not serial).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectBackupCoverage } from '../src/core/advisor/collect-backup-coverage.ts';
import { COLLECTORS } from '../src/core/advisor/run.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';
import {
  BACKUP_STATUS_SCHEMA_VERSION,
  __setBackupIntervalForTests,
  __setBackupNagStatePathForTests,
  __setBackupStatusPathForTests,
  loadBackupNagState,
  saveBackupStatus,
  type BackupStatus,
} from '../src/core/backup/status-file.ts';

const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_BACKUP_CHECK', 'GBRAIN_BACKUP_CHECK_DAYS'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let statusPath: string;
let nagPath: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gb-adv-bak-')));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp; // configDir() → tmp/.gbrain (receipt, bridge state, config all isolated)
  statusPath = join(tmp, 'backup-status.json');
  nagPath = join(tmp, 'backup-nag-state.json');
  __setBackupStatusPathForTests(statusPath);
  __setBackupNagStatePathForTests(nagPath);
});

afterEach(() => {
  __setBackupStatusPathForTests(null);
  __setBackupNagStatePathForTests(null);
  __setBackupIntervalForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

// ── Fixture helpers ──────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd, stdio: ['ignore', 'ignore', 'ignore'] },
  );
}

/** A git repo with one commit and NO origin remote. */
function makeNoRemoteRepo(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init', '--no-gpg-sign']);
  return dir;
}

/** A repo with an origin (local bare), pushed, then one commit ahead. */
function makeUnpushedRepo(name: string): string {
  const dir = makeNoRemoteRepo(name);
  const bare = join(tmp, `${name}-origin.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  git(dir, ['remote', 'add', 'origin', bare]);
  git(dir, ['push', '-q', '-u', 'origin', 'main']);
  writeFileSync(join(dir, 'extra.md'), 'ahead\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'ahead', '--no-gpg-sign']);
  return dir;
}

interface SourceFixture {
  id: string;
  local_path: string;
}

/** Minimal engine stub: sources + pages queries via executeRaw. */
function makeEngine(opts: { sources?: SourceFixture[]; pageCount?: number } = {}) {
  const calls: string[] = [];
  const engine = {
    kind: 'pglite',
    executeRaw: async (sql: string) => {
      calls.push(sql);
      if (/from\s+sources/i.test(sql)) {
        return (opts.sources ?? []).map((s) => ({
          id: s.id,
          name: s.id,
          local_path: s.local_path,
          last_commit: null,
          last_sync_at: null,
          config: {},
          created_at: new Date('2026-01-01T00:00:00Z'),
          archived: false,
          newest_content_at: null,
        }));
      }
      if (/from\s+pages/i.test(sql)) return [{ n: opts.pageCount ?? 0 }];
      return [];
    },
  };
  return { engine: engine as unknown as AdvisorContext['engine'], calls };
}

function ctx(
  engine: AdvisorContext['engine'],
  over: Partial<AdvisorContext> = {},
): AdvisorContext {
  return {
    engine,
    config: {} as AdvisorContext['config'],
    version: '0.0.0',
    workspace: null,
    skillsDir: null,
    now: new Date('2026-06-01T00:00:00Z'),
    remote: false,
    ...over,
  };
}

/** A crafted warn cache for the remote (cache-reader) tests. */
function warnCache(over: Partial<BackupStatus> = {}): BackupStatus {
  return {
    schema_version: BACKUP_STATUS_SCHEMA_VERSION,
    checked_at: '2026-06-01T00:00:00Z',
    gbrain_version: '0.0.0',
    interval_days: 30,
    computed_by: 'cli',
    overall: 'warn',
    totals: { assets: 5, no_remote: 2, unpushed: 0, failing: 0, recoverable_repos: 3, pages_at_risk: 0 },
    assets: [
      {
        kind: 'source_repo',
        id: 'xylophone-secret-source-991',
        state: 'no_remote',
        detail: 'lives at /tmp/zzz-secret-local-path/notes',
        fix_argv: null,
      },
      {
        kind: 'source_repo',
        id: 'quux-secret-source-992',
        state: 'no_remote',
        detail: 'fix: git remote add origin <url>',
        fix_argv: null,
      },
    ],
    ...over,
  };
}

// ── 1. Local ctx (remote:false) — per-asset findings ─────────────────────────

describe('collectBackupCoverage local (remote:false)', () => {
  test('no-remote source repo → backup_source_no_remote:<id> warn with the recipe; unpushed repo → backup_unpushed_work info', async () => {
    const noRemote = makeNoRemoteRepo('zebra-repo');
    const unpushed = makeUnpushedRepo('yak-repo');
    const { engine } = makeEngine({
      sources: [
        { id: 'zebra-no-remote-src', local_path: noRemote },
        { id: 'yak-unpushed-src', local_path: unpushed },
      ],
      pageCount: 0,
    });

    const findings = await collectBackupCoverage.collect(ctx(engine));

    const noRemoteFinding = findings.find((f) => f.id === 'backup_source_no_remote:zebra-no-remote-src');
    expect(noRemoteFinding).toBeDefined();
    expect(noRemoteFinding?.severity).toBe('warn');
    expect(noRemoteFinding?.title).toContain('zebra-no-remote-src');
    // The recipe detail (plain repo, not bootstrap-initialized → argv null).
    expect(noRemoteFinding?.detail).toContain('git remote add origin <url>');
    expect(noRemoteFinding?.detail).toContain('gbrain sources harden');
    expect(noRemoteFinding?.fix.command_argv).toBeNull();

    const unpushedFinding = findings.find((f) => f.id === 'backup_unpushed_work');
    expect(unpushedFinding).toBeDefined();
    expect(unpushedFinding?.severity).toBe('info');
    expect(unpushedFinding?.title).toContain('1 repo(s)');
    expect(unpushedFinding?.detail).toContain('yak-unpushed-src');
    expect(unpushedFinding?.detail).toContain('1 commit(s) ahead of origin/main');

    // Batch discipline: every finding is ask_user + collector-stamped.
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.ask_user).toBe(true);
      expect(f.collector).toBe('backup-coverage');
    }
  });

  test('receipt-less DB-only brain (pages, no sources, no workspace) → backup_db_content_unbacked warn', async () => {
    const { engine } = makeEngine({ sources: [], pageCount: 42 });

    const findings = await collectBackupCoverage.collect(ctx(engine));

    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.id).toBe('backup_db_content_unbacked');
    expect(f.severity).toBe('warn');
    expect(f.detail).toContain('42 pages');
    expect(f.fix.command_argv).toEqual(['gbrain', 'bootstrap', 'repo']);
    expect(f.ask_user).toBe(true);
    expect(f.collector).toBe('backup-coverage');
  });
});

// ── 2 + 3. Remote ctx (remote:true) — cache-reader, aggregate-only ───────────

describe('collectBackupCoverage remote (remote:true)', () => {
  test('warn cache → exactly ONE aggregate finding; no source ids, no local paths, no nag-state write', async () => {
    saveBackupStatus(warnCache());
    // Remote must never touch the engine (cache-only read).
    const engine = {
      executeRaw: async () => {
        throw new Error('remote collect must not query the engine');
      },
    } as unknown as AdvisorContext['engine'];

    const findings = await collectBackupCoverage.collect(ctx(engine, { remote: true }));

    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.id).toBe('backup_coverage_aggregate');
    expect(f.severity).toBe('warn');
    expect(f.title).toContain('2 of 5');
    expect(f.fix.command_argv).toBeNull();
    expect(f.ask_user).toBe(true);
    expect(f.collector).toBe('backup-coverage');

    // amendment-29 discipline: aggregate wording ONLY — never a source id or
    // a local path from the cached verdict.
    const blob = JSON.stringify(findings);
    expect(blob).not.toContain('xylophone-secret-source-991');
    expect(blob).not.toContain('quux-secret-source-992');
    expect(blob).not.toContain('/tmp/zzz-secret-local-path');
    expect(blob).not.toContain('zzz-secret-local-path');

    // No nag writes on remote — the state file must not exist.
    expect(existsSync(nagPath)).toBe(false);
  });

  test('ok cache → zero findings and still no nag write', async () => {
    saveBackupStatus(
      warnCache({
        overall: 'ok',
        totals: { assets: 1, no_remote: 0, unpushed: 0, failing: 0, recoverable_repos: 1, pages_at_risk: 0 },
        assets: [{ kind: 'source_repo', id: 'fine-src', state: 'ok' }],
      }),
    );
    const { engine } = makeEngine();
    const findings = await collectBackupCoverage.collect(ctx(engine, { remote: true }));
    expect(findings).toEqual([]);
    expect(existsSync(nagPath)).toBe(false);
  });

  test('NO cache → zero findings', async () => {
    expect(existsSync(statusPath)).toBe(false);
    const { engine } = makeEngine();
    const findings = await collectBackupCoverage.collect(ctx(engine, { remote: true }));
    expect(findings).toEqual([]);
    expect(existsSync(nagPath)).toBe(false);
  });
});

// ── 4. Nag ceiling — 3 surfaced batches per verdict, then quiet ──────────────

describe('collectBackupCoverage nag ceiling', () => {
  test('4 runs spaced +25h in the same month: 3 surfaced batches, then []', async () => {
    const noRemote = makeNoRemoteRepo('ceiling-repo');
    const { engine } = makeEngine({
      sources: [{ id: 'ceiling-src', local_path: noRemote }],
      pageCount: 0,
    });

    const t0 = Date.parse('2026-06-01T00:00:00Z');
    const hour = 60 * 60 * 1000;
    const runs: number[] = [];
    for (let i = 0; i < 4; i++) {
      // +25h between runs clears the 24h cross-channel dampener while every
      // run stays inside June (same global month bucket) and inside the 30d
      // cache interval (one compute, constant verdict fingerprint).
      const now = new Date(t0 + i * 25 * hour);
      const findings = await collectBackupCoverage.collect(ctx(engine, { now }));
      runs.push(findings.length);
    }

    expect(runs[0]).toBeGreaterThan(0);
    expect(runs[1]).toBeGreaterThan(0);
    expect(runs[2]).toBeGreaterThan(0);
    // Per-channel ceiling (3 per pseudo-version) AND the 3/month global cap
    // are both spent — the 4th call is gate-suppressed.
    expect(runs[3]).toBe(0);

    // The per-channel entry confirms suppression rather than an accident.
    const state = loadBackupNagState();
    const entry = state.entries.find((e) => e.pack_name === 'advisor');
    expect(entry).toBeDefined();
    expect(entry?.declined_count).toBe(3);
    expect(entry?.suppressed).toBe(true);
    expect(state.global_shown_count).toBe(3);
    expect(state.global_month).toBe('2026-06');
  });
});

// ── Workspace + db_only findings (local branch) ──────────────────────────────

/** Install receipt at configDir()/bootstrap/receipt.json (readReceipt shape). */
function writeReceipt(ws: string, extra: Record<string, unknown> = {}): void {
  const dir = join(tmp, '.gbrain', 'bootstrap');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'receipt.json'),
    JSON.stringify(
      {
        receipt_version: 1,
        workspace_dir: ws,
        source_id: 'workspace',
        agent_name: 'agent-example',
        created_at: new Date().toISOString(),
        created_by: 'test',
        brain_created_by_bootstrap: false,
        created_paths: [],
        registrations: [],
        ...extra,
      },
      null,
      2,
    ),
  );
}

describe('collectBackupCoverage local — workspace and db_only findings', () => {
  test('receipt without repo_url → backup_workspace_no_repo warn, no single-command fix (ambiguous between repo/attach)', async () => {
    const ws = join(tmp, 'ws-no-repo');
    mkdirSync(ws, { recursive: true });
    writeReceipt(ws); // no repo_url → bootstrap_workspace no_remote asset

    const { engine } = makeEngine({ sources: [], pageCount: 0 });
    const findings = await collectBackupCoverage.collect(ctx(engine));

    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.id).toBe('backup_workspace_no_repo');
    expect(f.severity).toBe('warn');
    expect(f.title).toContain('workspace has no private repo');
    expect(f.detail).toContain('no private repo yet');
    // No default fallback: this check can't tell an empty origin (needs
    // `bootstrap repo`) from an already-pushed out-of-band one (needs
    // `bootstrap attach`) without a git subprocess — see coverage.ts.
    expect(f.fix.command_argv).toBeNull();
    expect(f.ask_user).toBe(true);
    expect(f.collector).toBe('backup-coverage');
  });

  test('db_only source alongside a no-remote repo → backup_db_only_caveat info rides the warn batch', async () => {
    const noRemote = makeNoRemoteRepo('plain-repo');
    const tiered = makeNoRemoteRepo('tiered-repo');
    writeFileSync(join(tiered, 'gbrain.yml'), 'storage:\n  db_only:\n    - private/\n');

    const { engine } = makeEngine({
      sources: [
        { id: 'plain-src', local_path: noRemote },
        { id: 'tiered-src', local_path: tiered },
      ],
      pageCount: 0,
    });
    const findings = await collectBackupCoverage.collect(ctx(engine));

    const caveat = findings.find((f) => f.id === 'backup_db_only_caveat');
    expect(caveat).toBeDefined();
    expect(caveat?.severity).toBe('info');
    expect(caveat?.title).toContain('db_only');
    expect(caveat?.detail).toContain('undeclared_db_only_pages');
    expect(caveat?.fix.command_argv).toBeNull();
    // The warn batch it rides on is present too (both repos lack an origin).
    expect(findings.some((f) => f.id === 'backup_source_no_remote:plain-src')).toBe(true);
    expect(findings.some((f) => f.id === 'backup_source_no_remote:tiered-src')).toBe(true);
  });
});

// ── Kill switch: disabled → [] on BOTH branches ──────────────────────────────

describe('collectBackupCoverage — GBRAIN_BACKUP_CHECK=0', () => {
  test('disabled → [] on local AND remote branches even with a warn cache; engine untouched, no nag write', async () => {
    process.env.GBRAIN_BACKUP_CHECK = '0';
    saveBackupStatus(warnCache()); // a stale warn cache must go silent too

    // Any engine touch (compute attempt) blows the test up.
    const throwing = {
      executeRaw: async () => {
        throw new Error('disabled collect must not query the engine');
      },
    } as unknown as AdvisorContext['engine'];

    const local = await collectBackupCoverage.collect(ctx(throwing));
    expect(local).toEqual([]);

    const remote = await collectBackupCoverage.collect(ctx(throwing, { remote: true }));
    expect(remote).toEqual([]);

    expect(existsSync(nagPath)).toBe(false); // no nag-state write on either branch
  });
});

// ── 5. COLLECTORS registration pin ───────────────────────────────────────────

describe('advisor registration', () => {
  test('COLLECTORS includes backup-coverage', () => {
    expect(COLLECTORS.some((c) => c.id === 'backup-coverage')).toBe(true);
    expect(collectBackupCoverage.id).toBe('backup-coverage');
  });
});
