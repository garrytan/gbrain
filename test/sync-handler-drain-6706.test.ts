/**
 * #6706: the durable `sync` job drains a managed catch-up instead of landing one page per job.
 *
 * Forced probe: the worktree lock is held for ~6 s, so every page write outlives the single-pass 5 s wait. On master the
 * job returned `partial / writer_pending` with no page; with the drain the same job lands every page. Also: a deadline
 * stop with progress queues exactly one continuation; `drain: false` keeps the single pass; a job whose source already
 * has a live sync job skips; the job result carries the CLI's outcome / drain / next fields.
 * Runs on PGLite and, with DATABASE_URL, on an isolated Postgres (the managed-sync-drain.test.ts dual-engine pattern).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { makeSyncHandler } from '../src/core/minions/handlers/sync.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-job-drain-'));
const engines: BrainEngine[] = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function fixture(engine: BrainEngine, count: number) {
  const id = `jobdrain-${randomUUID().replace(/-/g, '').slice(0, 16)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nA durable observation number ${i}.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
const progress: unknown[] = [];
function job(id: number, data: Record<string, unknown>, deadlineAtMs: number | null = Date.now() + 120_000): MinionJobContext {
  return { id, name: 'sync', data, attempts_made: 0, signal: new AbortController().signal, shutdownSignal: new AbortController().signal, deadlineAtMs,
    updateProgress: async (p: unknown) => { progress.push(p); }, updateTokens: async () => undefined, log: async () => undefined,
    isActive: async () => true, readInbox: async () => [] } as unknown as MinionJobContext;
}
/** A real queue row, marked active with a live lock as a worker claim would leave it. */
async function activeJob(engine: BrainEngine, data: Record<string, unknown>, opts: { startedAgoSec?: number; timeoutMs?: number; priority?: number } = {}): Promise<number> {
  const row = await new MinionQueue(engine).add('sync', data, { ...(opts.timeoutMs ? { timeout_ms: opts.timeoutMs } : {}), ...(opts.priority !== undefined ? { priority: opts.priority } : {}) });
  await engine.executeRaw(`UPDATE minion_jobs SET status='active', started_at=now() - make_interval(secs => $2), lock_until=now() + interval '5 minutes', lock_token=$3, claim_generation=claim_generation + 1 WHERE id=$1`,
    [row.id, opts.startedAgoSec ?? 0, `tok-${row.id}`]);
  return row.id;
}
const pageCount = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [id]))[0]!.n;
/** Holds the source's worktree for `ms`, so each admitted page write waits longer than the single-pass 5 s. */
async function holdWorktree(engine: BrainEngine, id: string, ms: number | null) {
  const lock = await acquireWorktree((await getWorktreeBinding(engine, id))!);
  expect(lock).not.toBeNull();
  if (ms !== null) setTimeout(() => { void lock!.release(); }, ms);
  return { release: () => lock!.release() };
}

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]); await engine.disconnect(); }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('forced probe: writes slower than the 5 s single-pass wait all land in one drained job', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    const f = await fixture(engine, 4);
    const hold = await holdWorktree(engine, f.id, 6_500);
    try {
      const result = await makeSyncHandler(engine)(job(910_001, { sourceId: f.id, repoPath: f.root, pull: false, auto_embed_backfill: false })) as Record<string, unknown>;
      expect(result).toMatchObject({ outcome: 'synced', incomplete: false, drain: { outcome: 'synced', remaining: 0 } });
      expect(await pageCount(engine, f.id)).toBe(4);
      expect(progress.length).toBeGreaterThan(0);
    } finally { await hold.release(); await disposePersistenceConsumer(engine); }
  }
}), 240_000);

test('drain:false keeps the single pass: the same slow write returns writer_pending with no page', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    const f = await fixture(engine, 3);
    const hold = await holdWorktree(engine, f.id, null);
    try {
      const result = await makeSyncHandler(engine)(job(910_002, { sourceId: f.id, repoPath: f.root, pull: false, auto_embed_backfill: false, drain: false })) as Record<string, unknown>;
      expect(result).toMatchObject({ status: 'partial', reason: 'writer_pending' });
      expect(result.drain).toBeUndefined();
      expect(result.incomplete).toBeUndefined();
      expect(await pageCount(engine, f.id)).toBe(0);
    } finally { await hold.release(); await disposePersistenceConsumer(engine); }
  }
}), 240_000);

test('a deadline stop with progress queues one continuation on a worker-backed brain; no progress, or PGLite, queues none', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { settleJobDrain, planJobDrain } = await import('../src/core/minions/handlers/sync-job-drain.ts');
  for (const engine of engines) {
    const f = await fixture(engine, 1);
    const data = { sourceId: f.id, repoPath: f.root, pull: false, embed_reason: 'autopilot_freshness' };
    const parentId = await activeJob(engine, data, { timeoutMs: 600_000, priority: 0 });
    const ctx = job(parentId, data, null);
    const plan = await planJobDrain(engine, ctx);
    expect(plan.opts).toMatchObject({ drain: true, lanes: 1 });
    expect(plan.opts.deadlineAtMs!).toBeLessThan(Date.now() + 2 * 600_000);
    const stopped = (processed: number) => ({ status: 'partial' as const, reason: 'timeout' as const, fromCommit: null, toCommit: 'b', added: processed, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0, embedded: 0, pagesAffected: Array.from({ length: 80 }, (_, i) => `p${i}`), managedCursor: { index: processed, total: 10 },
      drain: { outcome: 'resumable' as const, stop_reason: 'deadline' as const, passes: 2, processed, written: processed, waived: 0, remaining: 10 - processed, rate_pages_per_min: null, eta_seconds: null } });
    const none = await settleJobDrain(engine, ctx, stopped(0), f.id, plan);
    expect(none).toMatchObject({ outcome: 'resumable', incomplete: true, continuation_job_id: null, next: { safe_to_loop: true } });
    const out = await settleJobDrain(engine, ctx, stopped(4), f.id, plan);
    expect(out).toMatchObject({ outcome: 'resumable', incomplete: true, drain: { stop_reason: 'deadline', remaining: 6 }, pages_affected_count: 80 });
    expect((out.pagesAffected as string[]).length).toBe(50);
    const followId = out.continuation_job_id as number | null;
    if (engine.kind === 'pglite') {
      expect(followId).toBeNull();
      expect((out.next as { command: string }).command).toContain(`sync --source ${f.id}`);
    } else {
      expect(typeof followId).toBe('number');
      expect(out.next).toMatchObject({ command: `gbrain sources status ${f.id} --json`, safe_to_loop: true, retry_after_ms: 30_000 });
      expect((out.next as Record<string, unknown>).fix).toBeUndefined();
      const [follow] = await engine.executeRaw<{ data: Record<string, unknown> | string; priority: number; timeout_ms: number; status: string }>('SELECT data, priority, timeout_ms, status FROM minion_jobs WHERE id=$1', [followId]);
      expect(typeof follow!.data === 'string' ? JSON.parse(follow!.data) : follow!.data).toMatchObject({ sourceId: f.id, continuation_of: parentId });
      expect(Number(follow!.priority)).toBe(5);
      expect(Number(follow!.timeout_ms)).toBe(600_000);
      expect(follow!.status).toBe('waiting');
      const again = await settleJobDrain(engine, ctx, stopped(5), f.id, plan);
      expect(again.continuation_job_id).toBe(followId);
    }
    await engine.executeRaw("DELETE FROM minion_jobs WHERE name='sync' AND (id=$1 OR data->>'continuation_of'=$2)", [parentId, String(parentId)]);
  }
}), 120_000);

test('a continuation is not skipped by its own parent, which is still active while the worker records its completion', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const engine = engines[0]!;
  const f = await fixture(engine, 1);
  const data = { sourceId: f.id, repoPath: f.root, pull: false, auto_embed_backfill: false };
  const parent = await activeJob(engine, data, { startedAgoSec: 60 });
  const child = await activeJob(engine, { ...data, continuation_of: parent });
  try {
    const result = await makeSyncHandler(engine)(job(child, { ...data, continuation_of: parent })) as Record<string, unknown>;
    expect(result.skipped).toBeUndefined();
    expect(await pageCount(engine, f.id)).toBe(1);
  } finally { await engine.executeRaw('DELETE FROM minion_jobs WHERE id = ANY($1::bigint[])', [[parent, child]]); await disposePersistenceConsumer(engine); }
}), 120_000);

test('a job for a source another live sync job is draining completes as a skip', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const engine = engines[0]!;
  const f = await fixture(engine, 1);
  const data = { sourceId: f.id, repoPath: f.root, pull: false };
  const running = await activeJob(engine, data, { startedAgoSec: 60 });
  const mine = await activeJob(engine, data);
  try {
    const result = await makeSyncHandler(engine)(job(mine, data));
    expect(result).toMatchObject({ skipped: true, reason: 'sync_in_progress', source_id: f.id, running_job_id: running,
      next: { command: `gbrain jobs get ${running} --json`, safe_to_loop: true } });
    expect(await pageCount(engine, f.id)).toBe(0);
  } finally { await engine.executeRaw('DELETE FROM minion_jobs WHERE id = ANY($1::bigint[])', [[running, mine]]); }
}), 120_000);

test('an accepted remote sync job drains through the handler: worker drain controls pass the remote option allowlist', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { prepareRemoteJob, withSubmissionAuthority } = await import('../src/core/minions/submission-authority.ts');
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    const f = await fixture(engine, 3);
    const clientId = `sync-client-${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
      VALUES($1,'example-client','test-only','admin',$2,ARRAY['submit_job'])`, [clientId, f.id]);
    const ctx = { engine, remote: true, sourceId: f.id, auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: f.id, allowedOperations: ['submit_job'] } } as unknown as import('../src/core/ops/contract.ts').OperationContext;
    const accepted = await prepareRemoteJob(ctx, 'sync', { noPull: true });
    const remoteJob = { ...job(910_100, { ...accepted.data, lanes: 8, drain: false }), submission_authority: accepted.authority } as MinionJobContext;
    try {
      // #6712 PR 4b (design v3.2 §5): a remote caller admits its one-sided work and never stamps; the pass ends
      // reconcile_host_required, so the job ends for the owner host with every page it admitted standing.
      progress.length = 0;
      const run = withSubmissionAuthority(accepted.authority, () => makeSyncHandler(engine)({ ...remoteJob, data: accepted.data } as MinionJobContext));
      await expect(run).rejects.toThrow(`Managed sync of source ${f.id} is blocked(reconcile_host_required, 0 entries left)`);
      expect(progress.at(-1)).toMatchObject({ blocked: true, outcome: 'blocked', drain: { outcome: 'blocked', stop_reason: 'reconcile_host_required' } });
      expect(await pageCount(engine, f.id)).toBe(3);
      expect((await engine.executeRaw<{ c: string | null }>('SELECT last_commit AS c FROM sources WHERE id=$1', [f.id]))[0]!.c).toBeNull();
      const { planJobDrain } = await import('../src/core/minions/handlers/sync-job-drain.ts');
      // Drain controls in a remote job's data are never read: lanes stay 1 and drain stays on.
      expect((await planJobDrain(engine, remoteJob)).opts).toMatchObject({ drain: true, lanes: 1 });
    } finally { await disposePersistenceConsumer(engine); await engine.executeRaw('DELETE FROM oauth_clients WHERE client_id=$1', [clientId]); }
  }
}), 240_000);

test('a remote sync job cannot switch off the capacity preflight: the parameter is refused at submission and the worker always runs it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { prepareRemoteJob, withSubmissionAuthority } = await import('../src/core/minions/submission-authority.ts');
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    const f = await fixture(engine, 3);
    const clientId = `sync-client-${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
      VALUES($1,'example-client','test-only','admin',$2,ARRAY['submit_job'])`, [clientId, f.id]);
    const ctx = { engine, remote: true, sourceId: f.id, auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: f.id, allowedOperations: ['submit_job'] } } as unknown as import('../src/core/ops/contract.ts').OperationContext;
    const requests = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1', [f.id]))[0]!.n;
    try {
      for (const capacityPreflight of [false, true]) {
        await expect(prepareRemoteJob(ctx, 'sync', { noPull: true, capacityPreflight })).rejects.toThrow('unsupported remote job parameter');
      }
      const accepted = await prepareRemoteJob(ctx, 'sync', { noPull: true });
      // Three files and room for one more request id: the preflight refuses before any admission, even with a forged off switch in the job data.
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '1');
      for (const data of [accepted.data, { ...accepted.data, capacityPreflight: false }]) {
        const run = withSubmissionAuthority(accepted.authority, () => makeSyncHandler(engine)({ ...job(910_200, data), submission_authority: accepted.authority } as MinionJobContext));
        await expect(run).rejects.toMatchObject({ code: 'write_quota_insufficient', reason: 'lifetime_ids' });
        expect(await requests()).toBe(0);
        expect(await pageCount(engine, f.id)).toBe(0);
      }
    } finally {
      await engine.unsetConfig('persistence.limits.principal_lifetime_ids');
      await disposePersistenceConsumer(engine); await engine.executeRaw('DELETE FROM oauth_clients WHERE client_id=$1', [clientId]);
    }
  }
}), 240_000);

test('a live sync job reads as the source\'s live drain in movement, and a lapsed one does not', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { readSourceMovement, liveSyncJob } = await import('../src/core/persistence/sync-movement.ts');
  for (const engine of engines) {
    const f = await fixture(engine, 1);
    const id = await activeJob(engine, { sourceId: f.id, repoPath: f.root, pull: false });
    try {
      expect(await liveSyncJob(engine, f.id)).toBe(id);
      const [m] = await readSourceMovement(engine, { sourceIds: [f.id] });
      expect(m!.live).toMatchObject({ drain: true, drain_pid: null, drain_job_id: id });
      await engine.executeRaw(`UPDATE minion_jobs SET lock_until=now() - interval '1 minute' WHERE id=$1`, [id]);
      expect(await liveSyncJob(engine, f.id)).toBeNull();
      const [lapsed] = await readSourceMovement(engine, { sourceIds: [f.id] });
      expect(lapsed!.live).toMatchObject({ drain: false, drain_job_id: null });
    } finally { await engine.executeRaw('DELETE FROM minion_jobs WHERE id=$1', [id]); }
  }
}), 120_000);
