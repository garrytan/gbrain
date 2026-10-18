/**
 * #4960 (wave 18b 1.2): doctor sync_freshness keeps freshness and sync outcome
 * apart for a source with no successful sync (last_sync_at NULL).
 *
 *  - a live first sync inside the staleness ceiling is WARN
 *    (`sync_first_run_in_progress`, fix `next: wait`), never fresh;
 *  - no lock is FAIL with the last attempt (time, result, held) read from the
 *    newest sync job, or "no attempt recorded", and a fix for that state;
 *  - a lock held past the ceiling stays FAIL; an unchanged quiet repo stays OK.
 *
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSyncFreshness } from '../src/commands/doctor/checks/extraction-sync.ts';
import { syncLockId } from '../src/core/db-lock.ts';
import { chunkerStamp } from '../src/core/chunkers/code.ts';
import { cliRenderContext, renderAction, type Action } from '../src/core/agent-output.ts';
import { readLastSyncAttempt } from '../src/core/sync-attempt.ts';
import { CODES } from '../src/core/error-registry.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);
beforeEach(async () => {
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
  await engine.executeRaw("DELETE FROM minion_jobs WHERE name = 'sync'");
});

async function addSource(id: string, lastSyncAt: Date | null, extra: { localPath?: string; lastCommit?: string | null } = {}) {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, last_sync_at, last_commit, chunker_version, config)
     VALUES ($1, $1, $2, $3, $4, $5, '{"federated":true}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET last_sync_at = EXCLUDED.last_sync_at, local_path = EXCLUDED.local_path,
       last_commit = EXCLUDED.last_commit, chunker_version = EXCLUDED.chunker_version`,
    [id, extra.localPath ?? `/tmp/${id}`, lastSyncAt, extra.lastCommit ?? null, chunkerStamp()],
  );
}

async function holdLock(sourceId: string, acquiredMinutesAgo = 1) {
  await engine.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
     VALUES ($1, 4242, 'testhost', now() - ($2 || ' minutes')::interval, now() + interval '30 minutes', now())`,
    [syncLockId(sourceId), String(acquiredMinutesAgo)],
  );
}

async function addSyncJob(sourceId: string, status: string, result: Record<string, unknown> | null): Promise<number> {
  const job = await new MinionQueue(engine).add('sync', { sourceId }, { queue: 'default' }, { allowProtectedSubmit: true });
  const done = ['completed', 'failed', 'dead'].includes(status);
  await engine.executeRaw(
    `UPDATE minion_jobs SET status=$2, result=$3::text::jsonb, started_at=now() - interval '20 minutes',
       finished_at=CASE WHEN $4::boolean THEN now() - interval '10 minutes' END, attempts_started=1, attempts_made=CASE WHEN $4::boolean THEN 1 ELSE 0 END
     WHERE id=$1`,
    [job.id, status, result ? JSON.stringify(result) : null, done],
  );
  return Number(job.id);
}

const next = (fix: unknown) => renderAction(fix as Action, cliRenderContext()).next;
const counted = (d: Record<string, unknown> | undefined) =>
  Number(d?.unchanged_count) + Number(d?.synced_recently_count) + Number(d?.stale_count) + Number(d?.writer_owned_count ?? 0);

describe('#4960 sync_freshness: a source with no successful sync', () => {
  test('a live first sync inside the ceiling is warn, not fresh, with a wait fix', async () => {
    await addSource('wiki', null);
    await holdLock('wiki');
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('warn');
    expect(result.message).toContain("Source 'wiki': first sync running (pid 4242 on testhost), no successful sync yet");
    expect(result.message).not.toContain('Run `gbrain sync --source <id>`');
    expect(result.details?.code).toBe('sync_first_run_in_progress');
    expect(result.details?.stale_count).toBe(1);
    expect(result.details?.synced_recently_count).toBe(0);
    expect(counted(result.details)).toBe(1);
    expect(next(result.fix)).toBe('wait');
    expect((result.fix as Action).verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'sync_freshness', '--json']);
  });

  test('a first sync lock held past the staleness ceiling stays fail (wedged)', async () => {
    await addSource('wiki', null);
    await holdLock('wiki', 10 * 24 * 60);
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('has held the sync lock for');
  });

  test('no lock and no attempt is fail: "no successful sync recorded; no attempt recorded" and a retry fix', async () => {
    await addSource('wiki', null);
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('fail');
    expect(result.message).toBe("Source 'wiki': no successful sync recorded; no attempt recorded; run `gbrain sync --source wiki`");
    expect(result.message).not.toContain('never been synced');
    expect(result.details?.code).toBe('sync_no_successful_sync');
    const [entry] = result.details?.no_successful_sync as Array<Record<string, unknown>>;
    expect(entry).toMatchObject({ source_id: 'wiki', reason: 'no_attempt', last_attempt_at: null, result: null, held: 0 });
    expect((result.fix as Action).argv).toEqual(['gbrain', 'sync', '--source', 'wiki']);
    expect(next(result.fix)).toBe('run');
  });

  test('a partial last attempt names its time, result and held count, and inspects the job before retrying', async () => {
    await addSource('wiki', null);
    const jobId = await addSyncJob('wiki', 'completed', { status: 'partial', failedFiles: 3 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/^Source 'wiki': no successful sync recorded; last attempt \d{4}-\d\d-\d\dT[\d:.]+Z, result completed \(partial\), 3 held; run `gbrain sync --source wiki`$/);
    const [entry] = result.details?.no_successful_sync as Array<Record<string, unknown>>;
    expect(entry).toMatchObject({ reason: 'last_attempt_unsuccessful', result: 'completed (partial)', held: 3, job_id: jobId });
    const fix = result.fix as Action;
    expect(fix.argv).toEqual(['gbrain', 'jobs', 'get', String(jobId), '--json']);
    expect(fix.then?.argv).toEqual(['gbrain', 'sync', '--source', 'wiki']);
  });

  test('a queued sync job is a wait, not a retry', async () => {
    await addSource('wiki', null);
    await addSyncJob('wiki', 'waiting', null);
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('result waiting, 0 held; wait for the queued sync');
    expect(next(result.fix)).toBe('wait');
  });

  test('another source\'s job is not this source\'s attempt', async () => {
    await addSource('wiki', null);
    await addSyncJob('other', 'failed', null);
    const result = await checkSyncFreshness(engine);
    expect(result.message).toContain('no attempt recorded');
  });

  test('a managed read (readSyncStatus) on a source with nothing recorded is "no attempt", not unreadable', async () => {
    await addSource('wiki', null);
    const attempt = await readLastSyncAttempt(engine, 'wiki', true);
    expect(attempt.unreadable).toBeUndefined();
    expect(attempt.state).toBe('no_attempt');
  });

  test('both codes are registered', () => {
    expect(CODES.sync_first_run_in_progress.class).toBe('retryable');
    expect(CODES.sync_no_successful_sync.reasons).toEqual(['no_attempt', 'attempt_queued', 'holds_pending', 'last_attempt_unsuccessful']);
  });
});

describe('#4960 sync_freshness: fresh sources keep their verdict', () => {
  function quietRepo(): { dir: string; head: string } {
    const dir = mkdtempSync(join(tmpdir(), 'sync-outcome-quiet-'));
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
    writeFileSync(join(dir, 'note.md'), '# note\n');
    execSync('git add -A && git commit -qm seed', { cwd: dir });
    return { dir, head: execSync('git rev-parse HEAD', { cwd: dir }).toString().trim() };
  }

  test('an unchanged quiet repo synced long ago stays ok', async () => {
    const { dir, head } = quietRepo();
    await addSource('quiet', new Date(Date.now() - 30 * 24 * 3600_000), { localPath: dir, lastCommit: head });
    const result = await checkSyncFreshness(engine, { localOnly: true });
    expect(result.status).toBe('ok');
    expect(result.details?.unchanged_count).toBe(1);
    expect(result.fix).toBeUndefined();
  });

  test('a synced source with a live lock still reads in progress (ok)', async () => {
    await addSource('wiki', new Date(Date.now() - 3600_000));
    await holdLock('wiki');
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('ok');
    expect(result.message).toContain('sync in progress');
  });
});
