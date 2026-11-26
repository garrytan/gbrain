/**
 * Remote job visibility: a remote caller sees and steers only the jobs it submitted.
 *
 * 1. Protects: a remote job records the submitting credential and the end user it declared as the job's owner key
 *    (submission_authority.grant.owner / .endUser). get_job, wait_job, list_jobs (both pages), get_job_progress,
 *    cancel_job, pause_job, send_job_message and retry_job answer a remote caller only for jobs with its own owner key,
 *    admin scope included, so neither another credential nor another end user behind the same credential can read a
 *    job's prompt, data or result. The local CLI and an owner-bound admin keep the whole-queue view.
 * 2. Fails when: a remote admin lists or reads a job another credential or end user submitted, the owner key is not
 *    recorded, or the local CLI loses its view.
 * 3. Real seams: PGLite, prepareRemoteJob on a real Git source, the jobs operations.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { jobsOperations } from '../src/core/ops/jobs.ts';
import { jobOwnerKey, parseSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'gbrain-job-owner-'));
const root = join(sandbox, 'repo');
const brainHome = join(sandbox, 'home');
let engine: PGLiteEngine;
let queue: MinionQueue;
const isolated = <T>(fn: () => T | Promise<T>) => withEnv({ GBRAIN_HOME: brainHome, DATABASE_URL: undefined }, fn);
const op = (name: string) => jobsOperations.find(o => o.name === name)!;

function remote(clientId: string, endUser?: string): OperationContext {
  return {
    engine, config: {} as OperationContext['config'], dryRun: false, remote: true, sourceId: 'default', transport: 'http',
    logger: { info() {}, warn() {}, error() {} },
    auth: { token: 'test-only', clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: 'default' },
    ...(endUser ? { endUser } : {}),
  } as OperationContext;
}
const local = (): OperationContext => ({ ...remote('x'), remote: false, auth: undefined } as OperationContext);
const submit = async (ctx: OperationContext) => (await op('submit_job').handler(ctx, { name: 'lint', data: {} })) as { id: number };

beforeAll(async () => isolated(async () => {
  mkdirSync(root); mkdirSync(brainHome);
  execFileSync('git', ['init', '-q', root]);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}), 60_000);
afterAll(async () => { await engine?.disconnect(); rmSync(sandbox, { recursive: true, force: true }); }, 60_000);
beforeEach(async () => isolated(async () => {
  await engine.executeRaw('DELETE FROM minion_inbox');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM oauth_clients');
  await engine.executeRaw("UPDATE sources SET config = '{}'::jsonb, archived = false, local_path = $1 WHERE id = 'default'", [root]);
  for (const id of ['client-a', 'client-b']) {
    await engine.executeRaw("INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, scope, source_id) VALUES ($1, 'test-only', 'example-client', 'admin', 'default')", [id]);
  }
}));

describe('remote job ownership', () => {
  test('a remote submission records the credential and declared end user as its owner', () => isolated(async () => {
    const { id } = await submit(remote('client-a', 'alice@example.com'));
    const row = await queue.getJob(id);
    const a = parseSubmissionAuthority(row?.submission_authority);
    expect(a?.kind).toBe('remote_generic');
    const grant = (a as { grant: { owner?: string; endUser?: string } }).grant;
    expect(grant.owner).toBe('client-a|end_user:alice@example.com');
    expect(grant.endUser).toBe('alice@example.com');
    expect(jobOwnerKey({ clientId: 'client-a', principal: { kind: 'oauth_client', id: 'client-a' } })).toBe('client-a');
    expect(jobOwnerKey({ principal: { kind: 'legacy_token', id: 't1' } } as never, 'bob')).toBe('legacy_token:t1|end_user:bob');
    expect(jobOwnerKey(undefined, 'bob')).toBeNull();
  }));

  test('another credential, and another end user behind the same credential, cannot read the job', () => isolated(async () => {
    const alice = remote('client-a', 'alice@example.com');
    const bob = remote('client-a', 'bob@example.com');
    const other = remote('client-b');
    const { id } = await submit(alice);
    const bobsJob = await submit(bob);

    expect(((await op('get_job').handler(alice, { id })) as { id: number }).id).toBe(id);
    for (const caller of [bob, other]) {
      await expect(op('get_job').handler(caller, { id })).rejects.toThrow(/not found/i);
      await expect(op('wait_job').handler(caller, { id, timeout_s: 0 })).rejects.toThrow(/not found/i);
      await expect(op('get_job_progress').handler(caller, { id })).rejects.toThrow(/not found/i);
      await expect(op('pause_job').handler(caller, { id })).rejects.toThrow(/not found/i);
      await expect(op('send_job_message').handler(caller, { id, payload: { x: 1 } })).rejects.toThrow(/not found/i);
      await expect(op('cancel_job').handler(caller, { id })).rejects.toThrow(/Cannot cancel/);
    }
    const listed = (await op('list_jobs').handler(alice, {})) as Array<{ id: number }>;
    expect(listed.map(j => j.id)).toEqual([id]);
    expect(((await op('list_jobs').handler(bob, {})) as Array<{ id: number }>).map(j => j.id)).toEqual([bobsJob.id]);
    expect((await op('list_jobs').handler(other, {})) as unknown[]).toEqual([]);
    expect((await queue.getJob(id))?.status).toBe('waiting');
  }));

  test('finished-since pages and retry follow the same owner', () => isolated(async () => {
    const alice = remote('client-a', 'alice@example.com');
    const bob = remote('client-a', 'bob@example.com');
    const { id } = await submit(alice);
    await engine.executeRaw("UPDATE minion_jobs SET status = 'failed', finished_at = now() WHERE id = $1", [id]);
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const forAlice = (await op('list_jobs').handler(alice, { finished_since: since })) as { jobs: Array<{ id: number }> };
    const forBob = (await op('list_jobs').handler(bob, { finished_since: since })) as { jobs: Array<{ id: number }> };
    expect(forAlice.jobs.map(j => j.id)).toEqual([id]);
    expect(forBob.jobs).toEqual([]);
    await expect(op('retry_job').handler(bob, { id })).rejects.toThrow(/submitting principal/);
  }));

  test('local operator jobs are hidden from remote callers; the local CLI and an owner-bound admin see everything', () => isolated(async () => {
    const operator = await queue.add('maintenance', { prompt: 'operator-only' });
    const { id } = await submit(remote('client-a'));
    expect((await op('list_jobs').handler(remote('client-a'), {}) as Array<{ id: number }>).map(j => j.id)).toEqual([id]);
    await expect(op('get_job').handler(remote('client-a'), { id: operator.id })).rejects.toThrow(/not found/i);
    const all = (await op('list_jobs').handler(local(), {})) as Array<{ id: number }>;
    expect(all.map(j => j.id).sort()).toEqual([operator.id, id].sort());
    const owner = (await withCallerAccess({ owner: true }, () => op('list_jobs').handler(remote('client-b'), {}))) as unknown[];
    expect(owner.length).toBe(2);
  }));
});
