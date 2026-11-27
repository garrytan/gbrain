/**
 * What the remote-caller scope of the MCP dispatch changes, and what it does not (src/mcp/dispatch.ts,
 * src/core/remote-caller.ts, src/core/minions/submission-authority.ts, src/core/rust-engine/owner-ipc/client.ts).
 *
 * `dispatchToolCall` runs every operation handler inside `withRemoteCaller(ctx.remote !== false, …)`, and the Rust
 * engine owner client keeps a remote caller's writes off the owner socket (`callerIsRemote`).
 *
 * 1. Protects: (a) the scope is only a mark: a handler's result, its write receipt and the error it throws reach the
 *    caller exactly as the handler produced them, with the mark on or off; (b) a job a remote call started is a remote
 *    caller when a worker runs it, even though a worker runs a job outside the dispatch scope, so its writes are refused
 *    on the owner socket; (c) work detached from inside a remote call keeps the mark.
 * 2. Fails on: a wrapper that swallows or rewrites a handler's error or receipt, drops the await, or runs the handler
 *    outside the scope; a worker that runs a remote job without its durable authority; a remote job that is stored with
 *    application authority.
 * 3. Existing coverage: rust-owner-ipc-remote.test.ts checks the mark per engine member and a hand-built authority; it
 *    never compares what dispatch returns with and without the scope, and never runs a job a remote call really queued.
 * 4. Seam: the handler of one registered operation is swapped for a recording one while the dispatcher, the scope and
 *    the PGLite engine are real; jobs go through the real queue and the real worker, and the owner is a recording fake
 *    on a real socket.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import { jobsOperations } from '../src/core/ops/jobs.ts';
import { OperationError, opError, type Operation } from '../src/core/ops/contract.ts';
import { isRemoteCaller } from '../src/core/remote-caller.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { APPLICATION_AUTHORITY, currentSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { publicWriteReceipt, type WriteReceipt } from '../src/core/persistence/types.ts';
import { serveOwnerEngine, type OwnerEngineServer } from '../src/core/rust-engine/owner-ipc/server.ts';
import { callerIsRemote, connectOwner, installOwnerClient } from '../src/core/rust-engine/owner-ipc/client.ts';
import { withEnv } from './helpers/with-env.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'gbrain-owner-remote-scope-'));
const root = join(sandbox, 'repo');
const brainHome = join(sandbox, 'home');
let engine: PGLiteEngine;

const isolated = <T>(fn: () => T | Promise<T>): Promise<T> => withEnv({ GBRAIN_HOME: brainHome, DATABASE_URL: undefined }, fn);

beforeAll(async () => isolated(async () => {
  mkdirSync(root); mkdirSync(brainHome);
  execFileSync('git', ['init', '-q', root]);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}), 120_000);
afterAll(async () => { await engine?.disconnect(); rmSync(sandbox, { recursive: true, force: true }); }, 60_000);

const logger = { info() {}, warn() {}, error() {} };
const remoteOpts = { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], logger };
const localOpts = { remote: false, transport: 'stdio' as const, sourceId: 'default', logger };

/** The JSON body of a tool result, and whether it was an error. */
const bodyOf = (result: { content: Array<{ text: string }>; isError?: boolean }) =>
  ({ isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, unknown> });

/** Swaps one registered operation's handler for `handler` while `fn` runs; the dispatcher, scope and engine stay real. */
async function withHandler<T>(name: string, handler: Operation['handler'], fn: () => Promise<T>): Promise<T> {
  const op = operations.find(o => o.name === name)!;
  const original = op.handler;
  op.handler = handler;
  try { return await fn(); } finally { op.handler = original; }
}

describe('the MCP dispatch scope changes nothing a handler returns or throws', () => {
  const receipt: WriteReceipt = { request_id: '30000000-0000-4000-8000-000000000001', state: 'committed', retry_after_ms: null, revision: 'rev-1' };
  const written = { status: 'created_or_updated', slug: 'notes/scope', receipt, trail: [1, { nested: true }] };
  const pending: WriteReceipt = { request_id: '30000000-0000-4000-8000-000000000002', state: 'queued', retry_after_ms: 250 };

  // Value: protects=a read's result and a write's receipt come back from dispatch exactly as the handler returned them, for a remote and a local caller; fails_when=the scope wrapper drops the await, swallows the value or rewrites the receipt; why_new=the existing dispatch test only reads the scope flag inside engine members and never looks at what dispatch returns; seam=handler swap on one registered op; no_claim=notices and _meta
  test('a read result and a write receipt are returned unchanged, for a remote caller and a local one, and the handler sees the matching mark', async () => {
    for (const [label, opts, mark] of [['remote', remoteOpts, true], ['local', localOpts, false]] as const) {
      const seen: boolean[] = [];
      const read = await withHandler('get_page', async () => { seen.push(isRemoteCaller()); return written; }, () => dispatchToolCall(engine, 'get_page', { slug: 'notes/scope' }, opts));
      expect({ label, ...bodyOf(read) }).toEqual({ label, isError: false, body: JSON.parse(JSON.stringify(written)) });
      const write = await withHandler('put_page', async () => { seen.push(isRemoteCaller()); return written; }, () => dispatchToolCall(engine, 'put_page', { slug: 'notes/scope', content: 'x' }, opts));
      const out = bodyOf(write);
      expect({ label, isError: out.isError, receipt: out.body.receipt }).toEqual({ label, isError: false, receipt });
      expect(seen).toEqual([mark, mark]);
    }
    // The mark ends with the call.
    expect(isRemoteCaller()).toBe(false);
  });

  // Value: protects=a handler that throws reaches the caller as the same error, with the same code, message and pending write receipt, for a remote and a local caller; fails_when=the wrapper catches the throw, returns undefined, or rethrows a different error; why_new=no test dispatches a throwing handler and checks the envelope against the thrown error; seam=handler swap on one registered op; no_claim=the wording of hints
  test('a handler that throws surfaces its own code, message and pending receipt, for a remote caller and a local one', async () => {
    const refusal = opError('permission_denied', 'The example write is refused.', 'Ask the brain owner for the example grant.');
    const deferred = Object.assign(opError('write_pending', 'The example write waits behind a refresh.', 'Poll the write request.'),
      { writeRequest: { ...pending, deferred: { refresh_id: 'refresh-1' } } });
    for (const [label, opts] of [['remote', remoteOpts], ['local', localOpts]] as const) {
      const denied = bodyOf(await withHandler('put_page', async () => { throw refusal; }, () => dispatchToolCall(engine, 'put_page', { slug: 'notes/scope', content: 'x' }, opts)));
      expect({ label, isError: denied.isError, error: denied.body.error, message: denied.body.message }).toEqual({ label, isError: true, error: refusal.code, message: refusal.message });
      const later = bodyOf(await withHandler('put_page', async () => { throw deferred; }, () => dispatchToolCall(engine, 'put_page', { slug: 'notes/scope', content: 'x' }, opts)));
      expect({ label, isError: later.isError, status: later.body.status, receipt: later.body.receipt }).toEqual({ label, isError: false, status: 'pending', receipt: publicWriteReceipt(deferred.writeRequest) });
      const crashed = bodyOf(await withHandler('get_page', async () => { throw new Error('disk exploded'); }, () => dispatchToolCall(engine, 'get_page', { slug: 'notes/scope' }, opts)));
      expect({ label, isError: crashed.isError, error: crashed.body.error }).toEqual({ label, isError: true, error: 'internal_error' });
    }
    // Both callers see the same envelope for the same crash.
    const crash = (opts: typeof remoteOpts | typeof localOpts) => withHandler('get_page', async () => { throw new Error('disk exploded'); }, () => dispatchToolCall(engine, 'get_page', { slug: 'notes/scope' }, opts));
    const { body: remoteBody } = bodyOf(await crash(remoteOpts));
    const { body: localBody } = bodyOf(await crash(localOpts));
    expect({ error: remoteBody.error, retryable: remoteBody.retryable }).toEqual({ error: localBody.error, retryable: localBody.retryable });
  });

  // Value: protects=two dispatches running at once each keep their own mark; fails_when=the scope is process-wide state a later call overwrites; why_new=marks were only checked one call at a time; seam=handler swap on one registered op; no_claim=ordering of results
  test('a remote and a local dispatch running at the same time each keep their own mark', async () => {
    const seen: Record<string, boolean[]> = { remote: [], local: [] };
    const gate = Promise.withResolvers<void>();
    await withHandler('get_page', async (_ctx, params) => {
      const who = String((params as { slug: string }).slug);
      seen[who]!.push(isRemoteCaller());
      await gate.promise;
      seen[who]!.push(isRemoteCaller());
      return { slug: who };
    }, async () => {
      const both = Promise.all([
        dispatchToolCall(engine, 'get_page', { slug: 'remote' }, remoteOpts),
        dispatchToolCall(engine, 'get_page', { slug: 'local' }, localOpts),
      ]);
      await Bun.sleep(50);
      gate.resolve();
      await both;
    });
    expect(seen).toEqual({ remote: [true, true], local: [false, false] });
  });
});

describe('work detached from inside a remote dispatch keeps the remote mark', () => {
  // Value: protects=a timer, a microtask, an unawaited promise chain or an immediate that a remote handler starts and leaves running after dispatch returned still reads as a remote caller; fails_when=the mark is held only while the handler's own stack runs; why_new=no test checks async work that outlives the dispatch; seam=handler swap on one registered op; no_claim=work started by another process
  test('timers, microtasks, immediates and unawaited promises started by a remote handler see a remote caller after the call has returned; the same work started outside a scope does not', async () => {
    const seen = new Map<string, boolean>();
    const finished: Promise<void>[] = [];
    const start = () => {
      finished.push(new Promise<void>(resolve => setTimeout(() => { seen.set('timer', isRemoteCaller()); resolve(); }, 20)));
      finished.push(new Promise<void>(resolve => setImmediate(() => { seen.set('immediate', isRemoteCaller()); resolve(); })));
      finished.push(new Promise<void>(resolve => queueMicrotask(() => { seen.set('microtask', isRemoteCaller()); resolve(); })));
      finished.push((async () => { await Bun.sleep(40); seen.set('unawaited', isRemoteCaller()); })());
    };
    await withHandler('get_page', async () => { start(); return { slug: 'detached' }; }, () => dispatchToolCall(engine, 'get_page', { slug: 'detached' }, remoteOpts));
    // The call has returned; the work has not finished.
    expect(seen.has('unawaited')).toBe(false);
    await Promise.all(finished);
    expect(Object.fromEntries(seen)).toEqual({ timer: true, immediate: true, microtask: true, unawaited: true });
    // Control: the same work started outside any scope reads false, so the answers above come from the scope.
    seen.clear(); finished.length = 0;
    start();
    await Promise.all(finished);
    expect(Object.fromEntries(seen)).toEqual({ timer: false, immediate: false, microtask: false, unawaited: false });
  });
});

describe('a job a remote call queued is a remote caller when the worker runs it', () => {
  let owner: OwnerEngineServer;
  let ownerDir: string;
  let client: Record<string, (...args: unknown[]) => Promise<unknown>>;
  let undo: () => void;
  const reached: string[] = [];
  let queue: MinionQueue;

  beforeAll(async () => {
    ownerDir = mkdtempSync(join(tmpdir(), 'gbrain-owner-remote-scope-owner-'));
    const fake = {
      kind: 'pglite', capabilities: new Set<string>(),
      putPage: async (slug: unknown) => { reached.push(`putPage:${String(slug)}`); return { slug }; },
    } as unknown as BrainEngine;
    owner = (await serveOwnerEngine(fake, join(ownerDir, 'owner.sock')))!;
    const standIn = { kind: 'rust', capabilities: new Set<string>() };
    undo = installOwnerClient(standIn, await connectOwner(owner.socketPath));
    client = standIn as unknown as typeof client;
    queue = new MinionQueue(engine);
  });
  afterAll(async () => { undo?.(); await owner?.close(); rmSync(ownerDir, { recursive: true, force: true }); });
  beforeEach(async () => isolated(async () => {
    reached.length = 0;
    await engine.executeRaw('DELETE FROM minion_jobs');
    await engine.executeRaw('DELETE FROM oauth_clients');
    await engine.executeRaw("UPDATE sources SET config = '{}'::jsonb, archived = false, local_path = $1 WHERE id = 'default'", [root]);
    await engine.executeRaw("INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, scope, source_id) VALUES ('client-a', 'test-only', 'example-client', 'admin', 'default')");
  }));

  const adminAuth = { token: 'test-only', clientId: 'client-a', principal: { kind: 'oauth_client' as const, id: 'client-a' }, scopes: ['admin'], sourceId: 'default' };

  /** Runs the real worker until each named job has reached its handler; the handler records what the job's code can see. */
  async function runJobs(handlerNames: string[], jobIds: number[]) {
    const seen = new Map<number, { jobScope: boolean; authority: string | null; callerIsRemote: boolean; write: string }>();
    const worker = new MinionWorker(engine, { pollInterval: 10, healthCheckInterval: 0, stalledInterval: 60_000 });
    for (const name of handlerNames) {
      worker.register(name, async job => {
        let write = 'sent';
        try { await client.putPage!(`job/${job.id}`, {}); } catch (error) { write = error instanceof OperationError ? error.code : `unexpected:${String(error)}`; }
        seen.set(job.id, { jobScope: isRemoteCaller(), authority: currentSubmissionAuthority()?.kind ?? null, callerIsRemote: callerIsRemote(), write });
      });
    }
    const running = worker.start();
    try {
      for (let i = 0; i < 300 && !jobIds.every(id => seen.has(id)); i++) await Bun.sleep(20);
    } finally { await worker.stop(); await running; }
    return seen;
  }

  // Value: protects=a lint job queued through a remote submit_job is stored with remote authority and, run by the real worker, reads as a remote caller (callerIsRemote) although the worker's scope is not the dispatch's, so its owner-socket write is refused, while an application job on the same worker still writes; fails_when=the remote job is stored or run with application authority, the worker drops the authority around the job, or callerIsRemote ignores it; why_new=rust-owner-ipc-remote.test.ts uses a hand-built authority and never runs a job a remote call queued; seam=a recording fake owner on a real socket and a stand-in handler for the lint job
  test('a lint job queued by a remote submit_job runs as a remote caller and its owner-socket write is refused; an application job on the same worker is not and writes', () => isolated(async () => {
    const submitted = bodyOf(await dispatchToolCall(engine, 'submit_job', { name: 'lint', data: {} }, { ...remoteOpts, transport: 'http', auth: adminAuth }));
    expect(submitted.isError).toBe(false);
    const remoteId = Number(submitted.body.id);
    const appJob = await queue.add('lint', { dir: root, sourceId: 'default' });
    // Stored authority: what a remote call leaves behind versus what code with no caller leaves.
    expect((await queue.getJob(remoteId))?.submission_authority?.kind).toBe('remote_generic');
    expect((await queue.getJob(appJob.id))?.submission_authority).toEqual(APPLICATION_AUTHORITY);

    const seen = await runJobs(['lint'], [remoteId, appJob.id]);
    // A worker runs a job outside the dispatch scope, so the dispatch flag alone would read false here.
    expect(seen.get(remoteId)).toEqual({ jobScope: false, authority: 'remote_generic', callerIsRemote: true, write: 'engine_capability_missing' });
    expect(seen.get(appJob.id)).toEqual({ jobScope: false, authority: 'application', callerIsRemote: false, write: 'sent' });
    expect(reached).toEqual([`putPage:job/${appJob.id}`]);
  }));

  // Value: protects=a delegated agent job queued through a remote submit_agent is stored with remote_agent authority and reads as a remote caller in the worker; fails_when=the agent job is run under application authority; why_new=the lint job above covers remote_generic only; seam=a stand-in handler for the subagent job, real submit_agent and worker
  test('a subagent job queued by a remote submit_agent runs as a remote caller and its owner-socket write is refused', () => isolated(async () => {
    await engine.executeRaw("UPDATE oauth_clients SET scope = 'read agent', bound_tools = ARRAY['search','get_page'], delegated_namespace = 'prefixes', delegated_slug_prefixes = ARRAY['wiki/'], bound_source_id = 'default', federated_read = ARRAY['default'], bound_max_concurrent = 3 WHERE client_id = 'client-a'");
    const submitAgent = jobsOperations.find(op => op.name === 'submit_agent')!;
    const caller = { engine, config: {} as never, dryRun: false, remote: true, sourceId: 'default', logger, auth: { ...adminAuth, scopes: ['read', 'agent'] } };
    const result = await submitAgent.handler(caller, { prompt: 'Fixture task', allowed_tools: ['search'], allowed_slug_prefixes: ['wiki/example/'] }) as { id: number };
    expect((await queue.getJob(result.id))?.submission_authority?.kind).toBe('remote_agent');
    const seen = await runJobs(['subagent'], [result.id]);
    expect(seen.get(result.id)).toEqual({ jobScope: false, authority: 'remote_agent', callerIsRemote: true, write: 'engine_capability_missing' });
    expect(reached).toEqual([]);
  }));
});
