import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { runChildJobEntry } from '../src/core/minions/run-child.ts';
import { buildJobContext } from '../src/core/minions/job-context.ts';
import { jobsOperations } from '../src/core/ops/jobs.ts';
import { authorizeLegacyJobs } from '../src/core/minions/authorize-legacy.ts';
import { readSourceFileSync, writeSourceFileSync, withSourceFilesystemLock } from '../src/core/minions/source-filesystem.ts';
import { APPLICATION_AUTHORITY, assertNoUnreviewedJobs, assertRemoteJobControl, authorizeJobExecution, prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'gbrain-job-authority-'));
const root = join(sandbox, 'repo');
const brainHome = join(sandbox, 'home');
const legacyId = '11111111-1111-4111-8111-111111111111';
let engine: PGLiteEngine;
let queue: MinionQueue;
function isolated<T>(fn: () => T | Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: brainHome, DATABASE_URL: undefined }, fn);
}
function ctx(): OperationContext {
  return {
    engine, config: {} as OperationContext['config'], dryRun: false, remote: true, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} },
    auth: { token: 'test-only', clientId: 'client-a', principal: { kind: 'oauth_client', id: 'client-a' }, scopes: ['admin'], sourceId: 'default' },
  };
}
async function submit(name = 'lint', data?: unknown) {
  const accepted = await prepareRemoteJob(ctx(), name, data);
  return queue.add(name, accepted.data, {}, { submissionAuthority: accepted.authority });
}

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
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM oauth_clients');
  await engine.executeRaw('DELETE FROM access_tokens');
  await engine.executeRaw("UPDATE sources SET config = '{}'::jsonb, archived = false, local_path = $1 WHERE id = 'default'", [root]);
  await engine.executeRaw("INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, scope, source_id) VALUES ('client-a', 'test-only', 'example-client', 'admin', 'default')");
}));

describe('generic remote job authority', () => {
  test('controlled migration drains active work, preserves legacy rows and excludes old binaries', () => isolated(async () => {
    const { rehearseMinionAuthorityUpgrade } = await import('./helpers/minion-authority-upgrade.ts');
    await rehearseMinionAuthorityUpgrade(engine);
  }));
  test('exactly four jobs normalize source, paths and no paid descendants', () => isolated(async () => {
    const sync = await prepareRemoteJob(ctx(), 'sync', {});
    expect(sync.data).toEqual({ repoPath: root, sourceId: 'default', noPull: false, noEmbed: true, noExtract: true, auto_embed_backfill: false });
    expect((await prepareRemoteJob(ctx(), 'sync', { noPull: true })).data.noPull).toBe(true);
    expect((await prepareRemoteJob(ctx(), 'import', {})).data).toEqual({ dir: root, sourceId: 'default', noEmbed: true });
    for (const name of ['lint', 'lint-fix']) expect((await prepareRemoteJob(ctx(), name, {})).data).toEqual({ dir: root, sourceId: 'default' });
    for (const name of ['embed', 'shell', 'extract', 'subagent', 'sync-retry-failed']) await expect(prepareRemoteJob(ctx(), name, {})).rejects.toThrow('only sync');
    for (const [name, data] of [['sync', { noExtract: false }], ['sync', { github_item: {} }], ['sync', { sourceId: 'other' }], ['sync', { pull: true, noPull: false }], ['import', { dir: '/tmp' }], ['lint-fix', { fix: false }]] as const) {
      await expect(prepareRemoteJob(ctx(), name, data)).rejects.toThrow();
    }
  }));

  test('connector/unknown kind, stdio, missing source and revoked admission fail closed', () => isolated(async () => {
    for (const kind of ['google', 'github', 'future-kind']) {
      await engine.executeRaw('UPDATE sources SET config = $1::jsonb WHERE id = $2', [{ kind }, 'default']);
      await expect(prepareRemoteJob(ctx(), 'sync', {})).rejects.toThrow('filesystem source');
    }
    const stdio = { ...ctx(), auth: undefined, transport: 'stdio' as const };
    await expect(prepareRemoteJob(stdio, 'lint', {})).rejects.toThrow('persistent principal');
    await engine.executeRaw("UPDATE sources SET config = '{}'::jsonb, local_path = NULL WHERE id = 'default'");
    await expect(prepareRemoteJob(ctx(), 'lint', {})).rejects.toThrow('registered filesystem root');
  }));

  test('nested source defaults no-pull and rejects explicit whole-worktree mutation', () => isolated(async () => {
    const nested = join(root, 'nested'); mkdirSync(nested, { recursive: true });
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [nested]);
    expect((await prepareRemoteJob(ctx(), 'sync', {})).data.noPull).toBe(true);
    await expect(prepareRemoteJob(ctx(), 'sync', { pull: true })).rejects.toThrow('nested');
  }));

  test('original payload and current client/source policy must both authorize execution', () => isolated(async () => {
    const job = await submit();
    expect((await authorizeJobExecution(engine, job)).kind).toBe('remote_generic');
    // Accepted OAuth work is client-bound, not tied to a short-lived credential row.
    await engine.executeRaw('DELETE FROM oauth_tokens');
    await authorizeJobExecution(engine, job);
    await expect(authorizeJobExecution(engine, { ...job, data: { ...job.data, dir: sandbox } })).rejects.toThrow('differs');
    await engine.executeRaw("UPDATE oauth_clients SET scope = 'read' WHERE client_id = 'client-a'");
    await expect(authorizeJobExecution(engine, job)).rejects.toThrow('current principal');
    await engine.executeRaw("UPDATE oauth_clients SET scope = 'admin', bound_slug_prefixes = ARRAY['wiki/*'] WHERE client_id = 'client-a'");
    await expect(authorizeJobExecution(engine, job)).rejects.toThrow('slug-bound');
    await engine.executeRaw("UPDATE oauth_clients SET bound_slug_prefixes = NULL, deleted_at = now() WHERE client_id = 'client-a'");
    await expect(authorizeJobExecution(engine, job)).rejects.toThrow('revoked');
  }));

  test('current operation profiles and the submitted ceiling both authorize generic jobs', () => isolated(async () => {
    const narrowed = ctx(); narrowed.auth!.allowedOperations = ['get_page'];
    await expect(prepareRemoteJob(narrowed, 'lint', {})).rejects.toThrow('operation grants');
    const allowed = ctx(); allowed.auth!.allowedOperations = ['submit_job'];
    const accepted = await prepareRemoteJob(allowed, 'lint', {});
    const job = await queue.add('lint', accepted.data, {}, { submissionAuthority: accepted.authority });
    expect(job.submission_authority?.kind === 'remote_generic' && job.submission_authority.grant.allowedOperations).toEqual(['submit_job']);
    await engine.executeRaw("UPDATE oauth_clients SET allowed_operations=ARRAY['get_page'] WHERE client_id='client-a'");
    await expect(authorizeJobExecution(engine, job)).rejects.toThrow('operation grants');
    await expect(prepareRemoteJob(ctx(), 'lint', {})).rejects.toThrow('operation grants');
  }));

  test('legacy principal is UUID: names cannot transfer authority and revocation blocks retry', () => isolated(async () => {
    await engine.executeRaw('INSERT INTO access_tokens (id, name, token_hash, permissions, scopes) VALUES ($1, $2, $3, $4::jsonb, ARRAY[\'admin\'])', [legacyId, 'same-name', 'test-hash-a', { source_id: 'default' }]);
    const legacy = ctx(); legacy.auth = { ...legacy.auth!, principal: { kind: 'legacy_token', id: legacyId }, clientId: 'same-name' };
    const accepted = await prepareRemoteJob(legacy, 'lint', {});
    const job = await queue.add('lint', accepted.data, {}, { submissionAuthority: accepted.authority });
    await engine.executeRaw("UPDATE minion_jobs SET status = 'failed' WHERE id = $1", [job.id]);
    await engine.executeRaw('UPDATE access_tokens SET revoked_at = now() WHERE id = $1', [legacyId]);
    await engine.executeRaw("INSERT INTO access_tokens (name, token_hash, scopes) VALUES ('same-name', 'test-hash-b', ARRAY['admin'])");
    await expect(queue.retryJob(job.id)).rejects.toThrow('revoked');
  }));

  test('retry/resume/replay retain authority; remote overrides and other principals cannot restart', () => isolated(async () => {
    const job = await submit();
    await engine.executeRaw("UPDATE minion_jobs SET status = 'failed' WHERE id = $1", [job.id]);
    const retry = await queue.retryJob(job.id); expect(retry?.submission_authority).toEqual(job.submission_authority);
    await queue.pauseJob(job.id);
    expect((await queue.resumeJob(job.id))?.submission_authority).toEqual(job.submission_authority);
    await engine.executeRaw("UPDATE minion_jobs SET status = 'completed' WHERE id = $1", [job.id]);
    const replay = await queue.replayJob(job.id); expect(replay?.submission_authority).toEqual(job.submission_authority);
    await expect(queue.replayJob(job.id, { dir: sandbox })).rejects.toThrow('cannot override');
    const foreign = ctx(); foreign.auth = { ...foreign.auth!, principal: { kind: 'oauth_client', id: 'client-b' } };
    await expect(assertRemoteJobControl(foreign, job)).rejects.toThrow('submitting principal');
    await expect(assertRemoteJobControl(ctx(), await queue.add('lint', {}))).rejects.toThrow('submitting principal');
  }));

  test('idempotency and backpressure never return an application job to remote authority', () => isolated(async () => {
    const accepted = await prepareRemoteJob(ctx(), 'lint', {});
    await queue.add('lint', accepted.data, { idempotency_key: 'same-key' });
    await expect(queue.add('lint', accepted.data, { idempotency_key: 'same-key' }, { submissionAuthority: accepted.authority })).rejects.toThrow('coalescing across');
    await expect(queue.add('lint', accepted.data, { maxPending: 1 }, { submissionAuthority: accepted.authority })).rejects.toThrow('coalescing across');
    await expect(queue.add('lint', accepted.data, { maxWaiting: 1 }, { submissionAuthority: accepted.authority })).rejects.toThrow('coalescing across');
  }));

  test('remote descendants fail even without parent id; internal maintenance remains available', () => isolated(async () => {
    const accepted = await prepareRemoteJob(ctx(), 'lint', {});
    await expect(withSubmissionAuthority(accepted.authority, () => queue.add('embed', {}))).rejects.toThrow('descendant');
    const parent = await queue.add('lint', accepted.data, {}, { submissionAuthority: accepted.authority });
    await expect(queue.add('embed', {}, { parent_job_id: parent.id })).rejects.toThrow('descendant');
    expect((await withSubmissionAuthority(APPLICATION_AUTHORITY, () => queue.add('maintenance', {}))).submission_authority?.kind).toBe('application');
  }));

  test('operation admission ignores forged authority and never returns private authority metadata', () => isolated(async () => {
    const operation = jobsOperations.find(op => op.name === 'submit_job')!;
    await expect(operation.handler(ctx(), { name: 'lint', data: { submission_authority: APPLICATION_AUTHORITY } })).rejects.toThrow('unsupported');
    const result = await operation.handler(ctx(), { name: 'lint', data: {} }) as Record<string, unknown>;
    expect(result.submission_authority).toBeUndefined();
    expect((await queue.getJob(result.id as number))?.submission_authority?.kind).toBe('remote_generic');
    const get = jobsOperations.find(op => op.name === 'get_job')!;
    expect((await get.handler(ctx(), { id: result.id }) as Record<string, unknown>).submission_authority).toBeUndefined();
    const local = await queue.add('maintenance', {});
    await engine.executeRaw("UPDATE minion_jobs SET status = 'failed' WHERE id = $1", [local.id]);
    await expect(jobsOperations.find(op => op.name === 'retry_job')!.handler(ctx(), { id: local.id })).rejects.toThrow('submitting principal');
  }));

  test('legacy preview is inert, CAS detects changes, exact IDs retain scheduling and dependencies', () => isolated(async () => {
    const parent = await queue.add('maintenance', {});
    const child = await queue.add('lint', { dir: root }, { parent_job_id: parent.id, delay: 5000 });
    await engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL WHERE id = ANY($1::int[])', [[parent.id, child.id]]);
    await expect(assertNoUnreviewedJobs(engine)).rejects.toThrow('legacy jobs');
    const preview = await authorizeLegacyJobs(engine, [parent.id]);
    expect(preview.applied).toBe(false);
    expect((await queue.getJob(parent.id))?.submission_authority).toBeNull();
    await engine.executeRaw('UPDATE minion_jobs SET priority = priority + 1 WHERE id = $1', [parent.id]);
    await expect(authorizeLegacyJobs(engine, [parent.id], preview.snapshot_digest, true)).rejects.toThrow('snapshot changed');
    const reviewed = await authorizeLegacyJobs(engine, [parent.id]);
    await authorizeLegacyJobs(engine, [parent.id], reviewed.snapshot_digest, true);
    expect((await queue.getJob(child.id))?.submission_authority).toBeNull();
    await expect(assertNoUnreviewedJobs(engine)).rejects.toThrow('legacy jobs');
    const childPreview = await authorizeLegacyJobs(engine, [child.id]);
    await authorizeLegacyJobs(engine, [child.id], childPreview.snapshot_digest, true);
    const restored = await queue.getJob(child.id);
    expect(restored?.parent_job_id).toBe(parent.id);
    expect(restored?.delay_until).toEqual(child.delay_until);
    expect(restored?.status).toBe('delayed');
    await assertNoUnreviewedJobs(engine);
  }));

  test('inline and isolated worker entry points revalidate revoked authority before handlers', () => isolated(async () => {
    let calls = 0;
    const job = await submit();
    await engine.executeRaw("UPDATE oauth_clients SET deleted_at = now() WHERE client_id = 'client-a'");
    const worker = new MinionWorker(engine, { pollInterval: 10, healthCheckInterval: 0, stalledInterval: 60000 });
    worker.register('lint', async () => { calls++; });
    const running = worker.start();
    for (let i = 0; i < 100; i++) {
      if ((await queue.getJob(job.id))?.attempts_made) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await worker.stop(); await running;
    expect(calls).toBe(0);
    await engine.executeRaw("UPDATE minion_jobs SET status = 'active', claim_generation = claim_generation + 1, lock_token = 'child-test' WHERE id = $1", [job.id]);
    const resultPath = join(sandbox, 'child-outcome.json');
    await runChildJobEntry(engine, { jobId: job.id, lockToken: 'child-test', resultPath, parentPid: 0 }, { resolveHandler: () => async () => { calls++; } });
    expect(calls).toBe(0);
    expect(readFileSync(resultPath, 'utf8')).toContain('revoked');
  }));

  test('delegated jobs retain owner, source, tool and slug ceilings through queue execution', () => isolated(async () => {
    await engine.executeRaw("UPDATE oauth_clients SET scope = 'read agent', bound_tools = ARRAY['search','get_page'], bound_slug_prefixes = ARRAY['direct-only/'], delegated_namespace = 'prefixes', delegated_slug_prefixes = ARRAY['wiki/'], bound_source_id = 'default', federated_read = ARRAY['default'], bound_max_concurrent = 3 WHERE client_id = 'client-a'");
    const caller = ctx(); caller.auth!.scopes = ['read', 'agent'];
    const submitAgent = jobsOperations.find(op => op.name === 'submit_agent')!;
    const result = await submitAgent.handler(caller, { prompt: 'Fixture task', allowed_tools: ['search'], allowed_slug_prefixes: ['wiki/example/'] }) as { id: number };
    const job = (await queue.getJob(result.id))!;
    expect(job.submission_authority?.kind).toBe('remote_agent');
    await authorizeJobExecution(engine, job);
    await expect(withSubmissionAuthority(job.submission_authority!, () => queue.add('maintenance', {}))).rejects.toThrow('descendant');
    await expect(authorizeJobExecution(engine, { ...job, data: { ...job.data, allowed_tools: ['put_page'] } })).rejects.toThrow('differs');
    await engine.executeRaw("UPDATE oauth_clients SET bound_tools = ARRAY['get_page'] WHERE client_id = 'client-a'");
    await expect(authorizeJobExecution(engine, job)).rejects.toThrow('submitted_grant_no_longer_usable');
    await engine.executeRaw("UPDATE oauth_clients SET bound_tools = ARRAY['search','get_page'], delegated_slug_prefixes = ARRAY['other/'] WHERE client_id = 'client-a'");
    await expect(authorizeJobExecution(engine, job)).rejects.toThrow('submitted_grant_no_longer_usable');
    await engine.executeRaw("UPDATE oauth_clients SET delegated_slug_prefixes = ARRAY['wiki/'], scope = 'read' WHERE client_id = 'client-a'");
    await expect(authorizeJobExecution(engine, job)).rejects.toThrow('agent_scope_missing');
    await engine.executeRaw("UPDATE oauth_clients SET scope = 'read agent', deleted_at = now() WHERE client_id = 'client-a'");
    await expect(authorizeJobExecution(engine, job)).rejects.toThrow('revoked');
    expect((await queue.getJob(job.id))?.data.allowed_tools).toEqual(['search']);
  }));

  test('narrowing a job namespace to its concrete job preserves execution and retry only for that job', () => isolated(async () => {
    await engine.executeRaw("UPDATE oauth_clients SET scope = 'read agent', bound_tools = ARRAY['search'], delegated_namespace = 'job', delegated_slug_prefixes = NULL, bound_source_id = 'default', federated_read = ARRAY['default'], bound_max_concurrent = 3 WHERE client_id = 'client-a'");
    const caller = ctx(); caller.auth!.scopes = ['read', 'agent'];
    const submitAgent = jobsOperations.find(op => op.name === 'submit_agent')!;
    const first = await submitAgent.handler(caller, { prompt: 'First fixture task' }) as { id: number };
    const second = await submitAgent.handler(caller, { prompt: 'Second fixture task' }) as { id: number };
    const job = (await queue.getJob(first.id))!;
    const other = (await queue.getJob(second.id))!;
    await engine.executeRaw("UPDATE oauth_clients SET delegated_namespace = 'prefixes', delegated_slug_prefixes = ARRAY[$1] WHERE client_id = 'client-a'", [`wiki/agents/${job.id}/*`]);

    await expect(authorizeJobExecution(engine, job)).resolves.toEqual(job.submission_authority!);
    await expect(authorizeJobExecution(engine, other)).rejects.toThrow('submitted_grant_no_longer_usable');
    await engine.executeRaw("UPDATE minion_jobs SET status = 'failed' WHERE id = $1", [job.id]);
    // Replay creates a different job, so the existing job's path grant is insufficient.
    await expect(queue.replayJob(job.id)).rejects.toThrow('submitted_grant_no_longer_usable');
    const retried = await queue.retryJob(job.id);
    expect(retried?.status).toBe('waiting');
    expect(retried?.data).toEqual(job.data);
    expect(retried?.submission_authority).toEqual(job.submission_authority);
  }));

  test('future or malformed non-NULL authority is never authorized as legacy work', () => isolated(async () => {
    const job = await queue.add('maintenance', {});
    await engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL WHERE id = $1', [job.id]);
    const preview = await authorizeLegacyJobs(engine, [job.id]);
    for (const value of [{ version: 2, kind: 'application' }, { version: 1, kind: 'remote_generic' }, null]) {
      if (value === null) {
        // JSON null is not SQL NULL, even though both drivers decode it to null.
        await engine.executeRaw("UPDATE minion_jobs SET submission_authority = 'null'::jsonb WHERE id = $1", [job.id]);
      } else {
        await engine.executeRaw('UPDATE minion_jobs SET submission_authority = $1::jsonb WHERE id = $2', [value, job.id]);
      }
      const [before] = await engine.executeRaw<{ authority: string }>('SELECT submission_authority::text AS authority FROM minion_jobs WHERE id = $1', [job.id]);
      await expect(assertNoUnreviewedJobs(engine)).rejects.toThrow('unsupported authority');
      await expect(authorizeLegacyJobs(engine, [job.id])).rejects.toThrow('SQL NULL');
      await expect(authorizeLegacyJobs(engine, [job.id], preview.snapshot_digest, true)).rejects.toThrow('SQL NULL');
      const [after] = await engine.executeRaw<{ authority: string }>('SELECT submission_authority::text AS authority FROM minion_jobs WHERE id = $1', [job.id]);
      expect(after.authority).toBe(before.authority);
    }
  }));

  test('NULL-authority local review covers the whole recursive graph', () => isolated(async () => {
    const parent = await queue.add('maintenance', {});
    const child = await queue.add('maintenance-child', {}, { parent_job_id: parent.id });
    const grandchild = await queue.add('maintenance-grandchild', { revision: 1 }, { parent_job_id: child.id });
    await engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL WHERE id = $1', [parent.id]);
    await expect(assertNoUnreviewedJobs(engine)).rejects.toThrow('unsupported authority');
    await expect(queue.handleWaitingTTL()).rejects.toThrow('unsupported authority');
    const preview = await authorizeLegacyJobs(engine, [parent.id]);
    expect(preview.dependencies.map(row => row.id)).toContain(grandchild.id);
    await engine.executeRaw('UPDATE minion_jobs SET data = $1::jsonb WHERE id = $2', [{ revision: 2 }, grandchild.id]);
    await expect(authorizeLegacyJobs(engine, [parent.id], preview.snapshot_digest, true)).rejects.toThrow('snapshot changed');
    const next = await authorizeLegacyJobs(engine, [parent.id]);
    await authorizeLegacyJobs(engine, [parent.id], next.snapshot_digest, true);
    await assertNoUnreviewedJobs(engine);
    expect((await queue.getJob(grandchild.id))?.data).toEqual({ revision: 2 });
  }));

  test('upgraded database rejects old producers and every old-style claim', () => isolated(async () => {
    await expect(engine.executeRaw("INSERT INTO minion_jobs (name) VALUES ('old-worker')")).rejects.toThrow('protocol 1');
    const job = await queue.add('maintenance', {});
    const oldClaim = () => engine.executeRaw("UPDATE minion_jobs SET status = 'active', lock_token = 'old' WHERE id = $1", [job.id]);
    await expect(oldClaim()).rejects.toThrow('old workers');
    expect((await queue.claim('new-first', 30000, 'default', ['maintenance']))?.id).toBe(job.id);
    await engine.executeRaw("UPDATE minion_jobs SET status = 'waiting', lock_token = NULL WHERE id = $1", [job.id]);
    await expect(oldClaim()).rejects.toThrow('old workers');
    expect((await queue.claim('new-second', 30000, 'default', ['maintenance']))?.id).toBe(job.id);
  }));

  test('abort after lock acquisition prevents the next source read and write', () => isolated(async () => {
    const accepted = await prepareRemoteJob(ctx(), 'lint-fix', {});
    const controller = new AbortController();
    const page = join(root, 'cancelled.md'); writeFileSync(page, 'before');
    await expect(withSubmissionAuthority(accepted.authority, () => withSourceFilesystemLock(engine, root, async () => {
      expect(readSourceFileSync(page, 'utf8')).toBe('before');
      controller.abort(new Error('fixture cancelled'));
      expect(() => readSourceFileSync(page)).toThrow('fixture cancelled');
      writeSourceFileSync(page, 'after');
    }), controller.signal)).rejects.toThrow('fixture cancelled');
    expect(readFileSync(page, 'utf8')).toBe('before');
  }));

  test('an unrenewed cooperative filesystem lease aborts before the next write', () => isolated(async () => {
    const { withRefreshingLock } = await import('../src/core/db-lock.ts');
    const accepted = await prepareRemoteJob(ctx(), 'lint-fix', {});
    const controller = new AbortController();
    const page = join(root, 'lease-lost.md'); writeFileSync(page, 'before');
    let failure: unknown;
    try {
      await withRefreshingLock(engine, 'fixture-short-filesystem-lease', async () => {
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(controller.signal.aborted).toBe(true);
        return withSubmissionAuthority(accepted.authority, () => writeSourceFileSync(page, 'after'), controller.signal);
      }, { ttlMinutes: 0.0005, onLockLost: reason => controller.abort(reason) });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/stolen|lock lease lost/);
    expect(readFileSync(page, 'utf8')).toBe('before');
  }));

  test('real import/lint/sync handlers retain the scalar source and enqueue no descendants', () => isolated(async () => {
    const source = 'job-source';
    await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [source, root]);
    await engine.executeRaw("UPDATE oauth_clients SET source_id = $1 WHERE client_id = 'client-a'", [source]);
    const scoped = ctx(); scoped.sourceId = source; scoped.auth = { ...scoped.auth!, sourceId: source };
    const page = join(root, 'example.md');
    writeFileSync(page, '---\ntype: note\ntitle: Example\n---\n\n# Example\n\nA deterministic fixture for source-scoped background import.\n');
    execFileSync('git', ['-C', root, 'add', '--', 'example.md']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'test fixture', '--', 'example.md']);
    const { registerBuiltinHandlers } = await import('../src/commands/jobs.ts');
    const worker = new MinionWorker(engine);
    await registerBuiltinHandlers(worker, engine, { quiet: true });
    for (const name of ['import', 'lint', 'lint-fix', 'sync']) {
      const accepted = await prepareRemoteJob(scoped, name, name === 'sync' ? { noPull: true } : {});
      const job = await queue.add(name, accepted.data, {}, { submissionAuthority: accepted.authority });
      const token = `fixture-${name}`;
      const claimed = await queue.claim(token, 30000, 'default', [name]);
      expect(claimed?.id).toBe(job.id);
      const authority = await authorizeJobExecution(engine, claimed!);
      const context = buildJobContext(engine, queue, claimed!, token, new AbortController().signal, new AbortController().signal);
      await withSubmissionAuthority(authority, () => worker.getHandler(name)!(context));
      await queue.completeJob(job.id, token);
    }
    expect(await engine.getPage('example', { sourceId: source })).not.toBeNull();
    expect(await engine.getPage('example', { sourceId: 'default' })).toBeNull();
    const names = (await queue.getJobs()).map(job => job.name).sort();
    expect(names).toEqual(['import', 'lint', 'lint-fix', 'sync']);
    await engine.executeRaw("UPDATE oauth_clients SET source_id = 'default' WHERE client_id = 'client-a'");
    await engine.executeRaw('DELETE FROM sources WHERE id = $1', [source]);
  }));

  test('source reads/writes reject escaping and in-root symlinks and use the retained descriptor', () => isolated(async () => {
    const accepted = await prepareRemoteJob(ctx(), 'lint-fix', {});
    const page = join(root, 'page.md'), outside = join(sandbox, 'outside.md'), link = join(root, 'link.md');
    writeFileSync(page, 'before'); writeFileSync(outside, 'private fixture');
    symlinkSync(outside, link);
    try {
      withSubmissionAuthority(accepted.authority, () => {
        expect(readSourceFileSync(page, 'utf8')).toBe('before');
        writeSourceFileSync(page, 'after');
        expect(readSourceFileSync(page, 'utf8')).toBe('after');
        expect(() => readSourceFileSync(outside)).toThrow('escapes');
        expect(() => readSourceFileSync(link)).toThrow('symlink');
        expect(() => writeSourceFileSync(link, 'changed')).toThrow('symlink');
      });
      expect(readFileSync(outside, 'utf8')).toBe('private fixture');
    } finally { rmSync(link); }
    // Reentrant sync -> full import shares the canonical root lock.
    await withSourceFilesystemLock(engine, root, () => withSourceFilesystemLock(engine, root, async () => undefined));
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const first = withSourceFilesystemLock(engine, root, async () => { entered(); await hold; });
    await started;
    try {
      await expect(withSourceFilesystemLock(engine, join(root, 'nested'), async () => undefined, { waitMs: 0 })).rejects.toThrow('held');
    } finally { release(); await first; }
  }));

  test('overlapping registered non-Git roots and nested Git roots share one writer lock', () => isolated(async () => {
    const parent = join(sandbox, 'overlap'); const child = join(parent, 'nested');
    mkdirSync(child, { recursive: true });
    await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2), ($3, $3, $4)', ['overlap-parent', parent, 'overlap-child', child]);
    try {
      for (const gitNested of [false, true]) {
        if (gitNested) execFileSync('git', ['init', '-q', child]);
        let release!: () => void, entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        const childWriter = withSourceFilesystemLock(engine, child, async () => { entered(); await held; });
        await started;
        try {
          await expect(withSourceFilesystemLock(engine, parent, async () => undefined, { waitMs: 0 })).rejects.toThrow('held');
        } finally { release(); await childWriter; }
        await withSourceFilesystemLock(engine, parent, () => withSourceFilesystemLock(engine, child, async () => undefined));
      }
    } finally {
      await engine.executeRaw("DELETE FROM sources WHERE id IN ('overlap-parent', 'overlap-child')");
    }
  }));
});
