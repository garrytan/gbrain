/**
 * Serve-delegated sync job runner pins (core/serve-sync-runner.ts).
 *
 * What these tests protect:
 *   - single-flight: a second start while a job runs answers `busy` fast;
 *     correctness still rests on the gbrain-sync row lock inside performSync.
 *   - clientToken attach: a lost-ack retry finds its OWN job (running → same
 *     jobId; retained terminal → completed:true) instead of duplicate-running.
 *   - abort → typed partial → checkpoint resume: the abort/resume story the
 *     delegation UX promises ("progress is checkpointed — re-run to resume").
 *   - shutdownDelegatedSync is an idempotent shared promise (both serve
 *     shutdown paths race here on every signal).
 *   - delegated jobs always defer embeds and flag the drain backlog.
 *
 * Marked .serial.test.ts: spawns git subprocesses and shares one PGLite
 * engine across tests.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  __deferredEmbedsPendingForTests,
  __resetDelegatedSyncForTests,
  abortDelegatedSync,
  delegatedSyncSettleMs,
  getDelegatedSyncStatus,
  isDelegatedSyncRunning,
  shutdownDelegatedSync,
  startDelegatedSync,
} from '../src/core/serve-sync-runner.ts';

let engine: PGLiteEngine;
let repoPath: string;

function gitInit(repo: string): void {
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
}

function writeNote(name: string, title: string): void {
  writeFileSync(join(repoPath, `topics/${name}.md`), [
    '---',
    'type: concept',
    `title: ${title}`,
    '---',
    '',
    `Content for ${title}.`,
  ].join('\n'));
}

/** Poll the job until it reaches a terminal state (bounded). */
async function waitForTerminal(jobId: string, timeoutMs = 30_000): Promise<ReturnType<typeof getDelegatedSyncStatus>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = getDelegatedSyncStatus(jobId);
    if (!s.ok) return s;
    if (s.state === 'done' || s.state === 'error') return s;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms (state=${s.state})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('serve-sync-runner delegated jobs', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    __resetDelegatedSyncForTests();
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-ssr-'));
    gitInit(repoPath);
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeNote('alpha', 'Alpha Example');
    writeNote('beta', 'Beta Example');
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
    // Delegated jobs never carry repoPath on the wire — performSync reads the
    // source row's local_path (a fresh initSchema seeds 'default' with null).
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [repoPath]);
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('start → status polls → done with a real WireSyncResult; embeds deferred', async () => {
    const start = startDelegatedSync(
      engine,
      { sourceId: 'default', noPull: true, timeoutSeconds: 120 },
      'token-happy',
    );
    expect(start.ok).toBe(true);
    expect(start.jobId).toBeTruthy();
    expect(isDelegatedSyncRunning()).toBe(true);

    const s = await waitForTerminal(start.jobId!);
    expect(s.ok).toBe(true);
    expect(s.state).toBe('done');
    expect(s.sourceId).toBe('default');
    expect(s.result).toBeDefined();
    expect(s.result!.added).toBe(2);
    // first_sync's full-import path reports pagesAffected: [] by design;
    // the truncation invariant (total === untruncated length) is what the
    // wire must preserve here.
    expect(s.result!.pagesAffectedTotal).toBe(s.result!.pagesAffected.length);
    // The wire result must never claim embeds happened — they are deferred.
    expect(s.result!.embedded).toBe(0);
    expect(__deferredEmbedsPendingForTests()).toBe(true);
    expect(isDelegatedSyncRunning()).toBe(false);
    // The imported pages are really in the brain.
    expect(await engine.getPage('topics/alpha')).not.toBeNull();
  }, 60_000);

  test('single-flight: a different token while running answers busy with the jobId', () => {
    const first = startDelegatedSync(engine, { noPull: true, timeoutSeconds: 60, sourceId: 'default' }, 'token-a');
    expect(first.ok).toBe(true);
    // Same tick — the async job body has not settled, so the guard must hold.
    const second = startDelegatedSync(engine, { noPull: true, timeoutSeconds: 60, sourceId: 'default' }, 'token-b');
    expect(second.ok).toBe(false);
    expect(second.error).toBe('busy');
    expect(second.jobId).toBe(first.jobId);
  });

  test('clientToken attach: running retry returns the SAME job; terminal retry returns completed', async () => {
    const first = startDelegatedSync(engine, { noPull: true, timeoutSeconds: 60, sourceId: 'default' }, 'token-attach');
    const retry = startDelegatedSync(engine, { noPull: true, timeoutSeconds: 60, sourceId: 'default' }, 'token-attach');
    expect(retry.ok).toBe(true);
    expect(retry.jobId).toBe(first.jobId);
    expect(retry.completed).toBeUndefined();

    await waitForTerminal(first.jobId!);
    const afterDone = startDelegatedSync(engine, { noPull: true, timeoutSeconds: 60, sourceId: 'default' }, 'token-attach');
    expect(afterDone.ok).toBe(true);
    expect(afterDone.jobId).toBe(first.jobId);
    expect(afterDone.completed).toBe(true);
    // A DIFFERENT token after terminal starts a fresh run (the retained job is replaced).
    const fresh = startDelegatedSync(engine, { noPull: true, timeoutSeconds: 60, sourceId: 'default' }, 'token-next');
    expect(fresh.ok).toBe(true);
    expect(fresh.jobId).not.toBe(first.jobId);
    await waitForTerminal(fresh.jobId!);
  }, 60_000);

  test('abort → typed partial; a second delegated sync resumes from the checkpoint', async () => {
    const first = startDelegatedSync(engine, { noPull: true, timeoutSeconds: 120, sourceId: 'default' }, 'token-abort');
    expect(first.ok).toBe(true);
    // Abort before the job body reaches the import loop — the pre-bookmark
    // signal checks turn this into a typed partial, never a throw.
    const ab = abortDelegatedSync(first.jobId!);
    expect(ab.ok).toBe(true);
    const s = await waitForTerminal(first.jobId!);
    expect(s.state).toBe('done');
    expect(s.result!.status).toBe('partial');
    expect(['timeout', 'pull_timeout', 'stall_timeout']).toContain(s.result!.reason!);

    // Resume: a fresh delegated run completes the remainder.
    const second = startDelegatedSync(engine, { noPull: true, timeoutSeconds: 120, sourceId: 'default' }, 'token-resume');
    const s2 = await waitForTerminal(second.jobId!);
    expect(s2.state).toBe('done');
    expect(['first_sync', 'synced', 'up_to_date']).toContain(s2.result!.status);
    expect(await engine.getPage('topics/alpha')).not.toBeNull();
    expect(await engine.getPage('topics/beta')).not.toBeNull();
  }, 60_000);

  test('unknown jobId: status and abort answer unknown_job (serve restarted mid-sync)', () => {
    expect(getDelegatedSyncStatus('nope')).toEqual({ ok: false, protocol: 2, error: 'unknown_job' });
    expect(abortDelegatedSync('nope')).toEqual({ ok: false, protocol: 2, error: 'unknown_job' });
  });

  test('options are validated at the runner boundary (smuggled keys refuse)', () => {
    const r = startDelegatedSync(engine, { repoPath: '/tmp/evil', timeoutSeconds: 60 }, 'token-x');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_options:repoPath');
    expect(isDelegatedSyncRunning()).toBe(false);
  });

  test('bound-source mismatch refuses before any work starts', () => {
    const r = startDelegatedSync(
      engine,
      { sourceId: 'other', timeoutSeconds: 60 },
      'token-y',
      { boundSourceId: 'default' },
    );
    expect(r).toEqual({ ok: false, protocol: 2, error: 'source_mismatch' });
  });

  test('shutdownDelegatedSync aborts the job, settles bounded, is idempotent, and refuses new starts', async () => {
    const first = startDelegatedSync(engine, { noPull: true, timeoutSeconds: 120, sourceId: 'default' }, 'token-shutdown');
    expect(first.ok).toBe(true);
    const p1 = shutdownDelegatedSync(5_000);
    const p2 = shutdownDelegatedSync(5_000);
    // Idempotent shared promise: both racing shutdown paths await the SAME settle.
    expect(p1).toBe(p2);
    await p1;
    const s = getDelegatedSyncStatus(first.jobId!);
    expect(s.ok).toBe(true);
    expect(['done', 'error']).toContain(s.state!);
    const refused = startDelegatedSync(engine, { noPull: true, timeoutSeconds: 60 }, 'token-late');
    expect(refused).toEqual({ ok: false, protocol: 2, error: 'shutting_down' });
  }, 60_000);

  test('dry runs never flag the deferred-embed backlog', async () => {
    const start = startDelegatedSync(
      engine,
      { sourceId: 'default', noPull: true, dryRun: true, timeoutSeconds: 60 },
      'token-dry',
    );
    await waitForTerminal(start.jobId!);
    expect(__deferredEmbedsPendingForTests()).toBe(false);
  }, 60_000);

  test('settle bound resolver clamps and defaults sanely', () => {
    expect(delegatedSyncSettleMs({})).toBe(3000);
    expect(delegatedSyncSettleMs({ GBRAIN_SERVE_SYNC_SETTLE_MS: '8000' })).toBe(8000);
    expect(delegatedSyncSettleMs({ GBRAIN_SERVE_SYNC_SETTLE_MS: '-5' })).toBe(3000);
    expect(delegatedSyncSettleMs({ GBRAIN_SERVE_SYNC_SETTLE_MS: 'junk' })).toBe(3000);
    expect(delegatedSyncSettleMs({ GBRAIN_SERVE_SYNC_SETTLE_MS: '999999' })).toBe(60_000);
  });
});
