/**
 * E2E: real SIGKILL mid-sync on Postgres (test-plan F7).
 *
 * The in-process, simulated-kill coverage of op_checkpoint_paths lives in
 * test/op-checkpoint.test.ts (PGLite CRUD/union semantics). This file adds the
 * two things a simulation cannot prove, against a live Postgres:
 *
 *   1. A REAL `bun src/cli.ts sync` child killed with SIGKILL mid-import
 *      leaves a durable partial checkpoint (0 < bankedFiles < total) and does
 *      NOT advance the per-source `sources.last_commit` bookmark.
 *   2. SIGKILL is untrappable, so process-cleanup never runs and the
 *      per-source `gbrain_cycle_locks` row is STRANDED: holder pid dead, TTL
 *      still live, heartbeat recent. Lock-reclaim mechanics under test
 *      (src/core/db-lock.ts:tryAcquireDbLock):
 *        - a fresh strand is NOT stealable — the upsert's ON CONFLICT gate
 *          requires ttl_expires_at < NOW() AND last_refreshed_at older than
 *          the steal grace (GBRAIN_LOCK_STEAL_GRACE_SECONDS, default derived
 *          ~600s at 30-min TTL), and the same-host dead-PID fallback (#1780
 *          Gap 3) requires lock age >= 60s (HOLDER_TAKEOVER_GRACE_MS). So an
 *          immediate second sync is refused (SyncLockBusyError, exit 1).
 *        - a dead holder ages out: it stops refreshing, its TTL lapses, and
 *          last_refreshed_at drifts past the grace — at which point the
 *          upsert steal branch takes the row. The default windows (30-min
 *          TTL) are too long for a test, so we simulate the age-out by
 *          backdating the stranded row's timestamps and shrink the grace via
 *          the documented GBRAIN_LOCK_STEAL_GRACE_SECONDS env knob, driving
 *          the second sync through the exact production steal predicate.
 *   3. The second sync resumes from the banked checkpoint (never re-imports
 *      banked paths), converges — every file imported exactly once (page
 *      count == file count, no duplicate slugs), last_commit advances to the
 *      pinned target, checkpoint rows clear, and the lock row is released.
 *
 * DETERMINISM (CEO Finding 11): the kill point is derived by POLLING the DB
 * for the first banked op_checkpoint_paths row (GBRAIN_SYNC_CHECKPOINT_EVERY=1
 * banks after the first file), THEN sending SIGKILL. Never sleep-then-kill.
 *
 * Shared-DB etiquette: everything is scoped to a unique random source id; no
 * table is truncated; afterAll deletes only this suite's rows.
 *
 * Run: DATABASE_URL=... GBRAIN_TEST_ALLOW_DATABASE_URL=1 \
 *        bun test --timeout=180000 test/e2e/sync-sigkill-resume-postgres.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir, hostname } from 'os';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { loadOpCheckpoint, syncFingerprint } from '../../src/core/op-checkpoint.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.log('Skipping E2E sync SIGKILL tests (DATABASE_URL not set)');
}

const CLI = join(import.meta.dir, '..', '..', 'src', 'cli.ts');

/** Unique per-run source id: 1-32 lowercase alnum + interior hyphens. */
const SRC_ID = `sigkill-e2e-${Math.random().toString(36).slice(2, 10)}`;
const LOCK_KEY = `gbrain-sync:${SRC_ID}`;
/** New files added in commit B (the incremental range the kill lands in). */
const NEW_FILES = 30;
/** Total pages after convergence: the commit-A seed page + the 30 new files. */
const TOTAL_PAGES = NEW_FILES + 1;

let home: string;
let repoDir: string;
let engine: PostgresEngine;
let commitA = '';
let commitB = '';
let ckptFingerprint = '';
let killedPid = 0;
let bankedAfterKill = 0;
/** Live child handle so afterAll can reap a leak if an assertion throws first. */
let liveChild: ReturnType<typeof Bun.spawn> | null = null;

// ── helpers ─────────────────────────────────────────────────────────────

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Ambient knobs must not leak into the children — each spawn sets its own.
  for (const k of [
    'GBRAIN_SYNC_CHECKPOINT_EVERY', 'GBRAIN_SYNC_CHECKPOINT_SECONDS',
    'GBRAIN_SYNC_MAX_CHECKPOINT_FAILURES', 'GBRAIN_SYNC_YIELD_EVERY',
    'GBRAIN_SYNC_STALL_ABORT_SECONDS', 'GBRAIN_LOCK_STEAL_GRACE_SECONDS',
    'GBRAIN_SOURCE', 'GBRAIN_BRAIN_ID',
  ]) delete env[k];
  env.GBRAIN_HOME = home;
  return { ...env, ...extra };
}

interface RunResult { exitCode: number; stdout: string; stderr: string; }

async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: ['bun', CLI, ...args],
    env: baseEnv(extraEnv),
    cwd: home, // isolate from repo-root dotfiles / bun .env autoload
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, stdio: 'pipe' }).toString().trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A few KB of chunkable markdown per file so the import drain has real per-file cost. */
function fileBody(i: number): string {
  const lines = [
    '---',
    `title: SIGKILL Fixture ${i}`,
    'type: note',
    '---',
    '',
  ];
  for (let p = 0; p < 12; p++) {
    lines.push(`## Section ${p} of fixture ${i}`);
    lines.push('');
    lines.push(
      `Fixture file ${i}, paragraph ${p}. This content exists to give the sync ` +
      `import drain measurable per-file work — chunking, hashing, and several ` +
      `chunk inserts against a live Postgres — so a SIGKILL lands mid-range ` +
      `deterministically after the first checkpoint bank. Marker token ` +
      `sigkill-fixture-${i}-${p} keeps every chunk distinct across files.`.repeat(2),
    );
    lines.push('');
  }
  return lines.join('\n');
}

async function bankedCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM op_checkpoint_paths WHERE op = 'sync' AND fingerprint = $1`,
    [ckptFingerprint],
  );
  return Number(rows[0]?.n ?? 0);
}

interface LockRow {
  holder_pid: number;
  holder_host: string;
  ttl_expired: boolean;
  age_ms: number;
  last_refreshed_at: unknown;
}

async function lockRow(): Promise<LockRow | null> {
  const rows = await engine.executeRaw<LockRow>(
    `SELECT holder_pid::int AS holder_pid, holder_host,
            (ttl_expires_at < NOW()) AS ttl_expired,
            (EXTRACT(EPOCH FROM (NOW() - acquired_at)) * 1000)::float8 AS age_ms,
            last_refreshed_at
       FROM gbrain_cycle_locks WHERE id = $1`,
    [LOCK_KEY],
  );
  return rows[0] ?? null;
}

async function sourceLastCommit(): Promise<string | null> {
  const rows = await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id = $1`,
    [SRC_ID],
  );
  return rows[0]?.last_commit ?? null;
}

// ── suite ───────────────────────────────────────────────────────────────

describeE2E('E2E: real SIGKILL mid-sync on Postgres — checkpoint bank, stranded lock, exactly-once resume', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!);

    home = mkdtempSync(join(tmpdir(), 'gbrain-sigkill-home-'));
    repoDir = mkdtempSync(join(tmpdir(), 'gbrain-sigkill-repo-'));

    // Fixture repo, commit A: one seed file (establishes last_commit so the
    // killed run takes the INCREMENTAL checkpointed path, not first_sync).
    git('init', repoDir);
    git('config user.email "test@test.com"', repoDir);
    git('config user.name "Test"', repoDir);
    mkdirSync(join(repoDir, 'notes'), { recursive: true });
    writeFileSync(join(repoDir, 'notes/seed.md'), [
      '---', 'title: Seed Page', 'type: note', '---', '', 'Commit-A seed content.',
    ].join('\n'));
    execSync('git add -A && git commit -m "commit A: seed"', { cwd: repoDir, stdio: 'pipe' });
    commitA = git('rev-parse HEAD', repoDir);

    // gbrain-owned config for the children: temp GBRAIN_HOME against the live
    // Postgres (same pattern as test/e2e/thin-client.test.ts).
    const init = await runCli(['init', '--non-interactive', '--no-embedding', '--url', DATABASE_URL!]);
    if (init.exitCode !== 0) throw new Error(`init failed: ${init.stderr || init.stdout}`);

    const add = await runCli(['sources', 'add', SRC_ID, '--path', repoDir, '--no-federated']);
    if (add.exitCode !== 0) throw new Error(`sources add failed: ${add.stderr || add.stdout}`);

    // Parent poll/assert connection (schema already at latest via init above).
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
  }, 120_000);

  afterAll(async () => {
    if (liveChild && liveChild.exitCode === null && liveChild.signalCode === null) {
      try { liveChild.kill('SIGKILL'); await liveChild.exited; } catch { /* best-effort */ }
    }
    // Shared DB: delete ONLY this suite's rows. facts FK to sources is ON
    // DELETE RESTRICT, so clear it before the source row (cascades pages →
    // chunks, and ingest_log).
    if (engine) {
      const cleanups: Array<[string, unknown[]]> = [
        [`DELETE FROM facts WHERE source_id = $1`, [SRC_ID]],
        [`DELETE FROM op_checkpoints WHERE op IN ('sync', 'sync-target') AND fingerprint = $1`, [ckptFingerprint || 'none']],
        [`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [LOCK_KEY]],
        [`DELETE FROM sources WHERE id = $1`, [SRC_ID]],
      ];
      for (const [sql, params] of cleanups) {
        try { await engine.executeRaw(sql, params); } catch { /* best-effort */ }
      }
      await engine.disconnect();
    }
    if (home) rmSync(home, { recursive: true, force: true });
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  }, 60_000);

  test('baseline: first sync converges and pins last_commit at commit A', async () => {
    const r = await runCli(['sync', '--source', SRC_ID, '--no-embed', '--no-pull']);
    expect(r.exitCode).toBe(0);
    expect(await sourceLastCommit()).toBe(commitA);
    const pages = await engine.executeRaw<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM pages WHERE source_id = $1`, [SRC_ID],
    );
    expect(Number(pages[0].n)).toBe(1);
  }, 120_000);

  test('SIGKILL after the first banked row: partial checkpoint, bookmark frozen, lock stranded', async () => {
    // Commit B: 30 new files — the incremental range the kill lands inside.
    for (let i = 1; i <= NEW_FILES; i++) {
      writeFileSync(join(repoDir, `notes/f${String(i).padStart(2, '0')}.md`), fileBody(i));
    }
    execSync('git add -A && git commit -m "commit B: 30 files"', { cwd: repoDir, stdio: 'pipe' });
    commitB = git('rev-parse HEAD', repoDir);

    // Checkpoint key = (op, syncFingerprint(sourceId, lastCommit)) — lastCommit
    // is the commit-A bookmark, fixed across kill + resume (#1794).
    ckptFingerprint = syncFingerprint({ sourceId: SRC_ID, lastCommit: commitA });

    const proc = Bun.spawn({
      cmd: ['bun', CLI, 'sync', '--source', SRC_ID, '--no-embed', '--no-pull'],
      env: baseEnv({
        GBRAIN_SYNC_CHECKPOINT_EVERY: '1',   // bank after the FIRST file (F7 spec)
        GBRAIN_SYNC_CHECKPOINT_SECONDS: '1', // time-based flush floor
        GBRAIN_SYNC_YIELD_EVERY: '1',        // yield per file: heartbeat fires, drain slows
      }),
      cwd: home,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    liveChild = proc;
    killedPid = proc.pid;
    // Consume pipes from the start so the child can never block on a full pipe.
    const stdoutP = new Response(proc.stdout).text();
    const stderrP = new Response(proc.stderr).text();

    // DETERMINISM RULE: poll the DB for the first banked op_checkpoint_paths
    // row, THEN SIGKILL — never sleep-then-kill.
    const t0 = Date.now();
    let polls = 0;
    let banked = 0;
    while (Date.now() - t0 < 60_000) {
      if (proc.exitCode !== null || proc.signalCode !== null) break;
      banked = await bankedCount();
      polls++;
      if (banked >= 1) break;
      await sleep(5);
    }
    const msToFirstBank = Date.now() - t0;
    if (banked < 1 || proc.exitCode !== null || proc.signalCode !== null) {
      const [so, se] = await Promise.all([stdoutP, stderrP]);
      throw new Error(
        `child was not killable mid-import (banked=${banked}, exit=${proc.exitCode}, ` +
        `signal=${proc.signalCode}, polls=${polls}, ${msToFirstBank}ms)\n` +
        `stdout:\n${so}\nstderr:\n${se}`,
      );
    }
    proc.kill('SIGKILL');
    await proc.exited;
    await Promise.all([stdoutP, stderrP]); // drain pipes
    liveChild = null;
    // Widened re-read: TS narrowed proc.signalCode to null at the guard above
    // and doesn't invalidate that across proc.kill()/await.
    expect(proc.signalCode as NodeJS.Signals | null).toBe('SIGKILL');
    console.log(
      `[f7] first banked row after ${msToFirstBank}ms (${polls} polls, banked=${banked} at kill dispatch)`,
    );

    // (1) Partial checkpoint: >0 banked (poll guaranteed) and < total (the
    // kill landed mid-range) — and the pinned target row names commit B.
    bankedAfterKill = await bankedCount();
    console.log(`[f7] banked after kill: ${bankedAfterKill}/${NEW_FILES}`);
    expect(bankedAfterKill).toBeGreaterThan(0);
    expect(bankedAfterKill).toBeLessThan(NEW_FILES);
    const target = await loadOpCheckpoint(engine, { op: 'sync-target', fingerprint: ckptFingerprint });
    expect(target).toEqual([commitB]);

    // (1) Bookmark frozen: last_commit did NOT advance.
    expect(await sourceLastCommit()).toBe(commitA);

    // (2) The per-source lock row is STRANDED: held by the dead child's pid on
    // this host, TTL still live (30-min default), heartbeat recorded — SIGKILL
    // bypassed process-cleanup's release.
    const lock = await lockRow();
    expect(lock).not.toBeNull();
    expect(lock!.holder_pid).toBe(killedPid);
    expect(lock!.holder_host).toBe(hostname());
    expect(lock!.ttl_expired).toBe(false);
    expect(lock!.last_refreshed_at).not.toBeNull();
    // The holder really is dead (proc.exited resolved above reaps the child,
    // so a signal-0 probe gets ESRCH, not a zombie's success).
    let probeErr: NodeJS.ErrnoException | null = null;
    try { process.kill(killedPid, 0); } catch (e) { probeErr = e as NodeJS.ErrnoException; }
    expect(probeErr?.code).toBe('ESRCH');

    // Grace semantics, fail-closed half: a FRESH strand (TTL live, heartbeat
    // recent, age < the 60s dead-PID takeover grace) must NOT be stolen — the
    // immediate retry is refused with the lock-busy error. Guard the premise
    // first so a pathologically slow runner fails loudly instead of flipping
    // the refusal into a reclaim.
    expect(lock!.age_ms).toBeLessThan(40_000);
    const busy = await runCli(['sync', '--source', SRC_ID, '--no-embed', '--no-pull']);
    expect(busy.exitCode).toBe(1);
    expect(busy.stderr).toContain('Another sync is in progress');
    expect(busy.stderr).toContain(String(killedPid));
    // The refused run changed nothing.
    expect(await sourceLastCommit()).toBe(commitA);
    expect((await lockRow())!.holder_pid).toBe(killedPid);
  }, 120_000);

  test('second sync reclaims the aged-out stranded lock via TTL + steal grace and converges exactly-once', async () => {
    expect(bankedAfterKill).toBeGreaterThan(0); // depends on the kill test

    // Simulate the dead holder aging out (a killed process never refreshes:
    // its TTL lapses and last_refreshed_at drifts). Backdating the row is the
    // time-warp for the 30-min TTL; the steal grace is shrunk for real via the
    // documented env knob so the reclaim goes through tryAcquireDbLock's
    // production ON CONFLICT predicate:
    //   ttl_expires_at < NOW() AND last_refreshed_at < NOW() - grace.
    await engine.executeRaw(
      `UPDATE gbrain_cycle_locks
          SET ttl_expires_at = NOW() - INTERVAL '1 second',
              last_refreshed_at = NOW() - INTERVAL '10 minutes',
              acquired_at = acquired_at - INTERVAL '10 minutes'
        WHERE id = $1`,
      [LOCK_KEY],
    );

    const r = await runCli(
      ['sync', '--source', SRC_ID, '--no-embed', '--no-pull'],
      { GBRAIN_LOCK_STEAL_GRACE_SECONDS: '60' },
    );
    expect(r.exitCode).toBe(0);
    // It RESUMED the banked checkpoint (did not restart): the resume banner
    // reports exactly the rows banked before the kill.
    const combined = r.stdout + r.stderr;
    expect(combined).toContain('resuming checkpoint');
    const m = combined.match(/resuming checkpoint: (\d+) file\(s\) already done/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(bankedAfterKill);

    // (3a) Converged exactly once: page count equals file count, no duplicate
    // slugs, and every commit-B file landed.
    const agg = await engine.executeRaw<{ total: number | string; distinct_slugs: number | string; new_files: number | string }>(
      `SELECT count(*)::int AS total,
              count(DISTINCT slug)::int AS distinct_slugs,
              count(*) FILTER (WHERE slug LIKE 'notes/f%')::int AS new_files
         FROM pages WHERE source_id = $1`,
      [SRC_ID],
    );
    expect(Number(agg[0].total)).toBe(TOTAL_PAGES);
    expect(Number(agg[0].distinct_slugs)).toBe(TOTAL_PAGES);
    expect(Number(agg[0].new_files)).toBe(NEW_FILES);

    // (3b) last_commit NOW advanced to the pinned target (commit B).
    expect(await sourceLastCommit()).toBe(commitB);

    // (3c) Checkpoint fully cleared on completion (parents cascade the paths).
    expect(await bankedCount()).toBe(0);
    const parents = await engine.executeRaw<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM op_checkpoints WHERE op IN ('sync', 'sync-target') AND fingerprint = $1`,
      [ckptFingerprint],
    );
    expect(Number(parents[0].n)).toBe(0);

    // (3d) The reclaimed lock was released by withRefreshingLock's finally.
    expect(await lockRow()).toBeNull();
  }, 120_000);
});
