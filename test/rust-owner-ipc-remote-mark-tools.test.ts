/**
 * A tool call the model chose runs as a remote caller even when no MCP dispatch wraps it (src/core/operation-load.ts
 * finalizeOperation, src/core/remote-caller.ts, src/core/rust-engine/owner-ipc/client.ts).
 *
 * The owner client of a Rust brain keeps a remote caller's writes off the owner socket (`callerIsRemote`). MCP dispatch
 * marks its handlers remote, and a job a remote call queued is remote by its stored authority. A job the local
 * application queued has application authority, though, and the subagent brain tools and SkillOpt's tool registries
 * call operation handlers directly with `remote: true` and no dispatch around them. Every operation handler now runs
 * under the remote mark its context names, so the model's choice is a remote caller wherever the handler is called.
 *
 * 1. Protects: (a) a subagent `put_page` tool call inside a locally queued job sends no write member to the owner and
 *    is refused before anything is sent; (b) the same job's own code still writes through the owner; (c) a SkillOpt
 *    rollout tool and a write-capture tool reach the owner with remote reads only, and the eval-capture write they start
 *    is refused locally; (d) a local caller's handler (`remote: false`) is not marked, and a nested `remote: false`
 *    handler call under a remote one stays remote.
 * 2. Fails on: a handler that runs outside the mark its context names; a mark that a nested local context clears; a
 *    local path whose context or code reads as remote, so its own writes are refused on a Rust brain.
 *    (e) a local caller's own writes still reach the owner: the CLI's operation context, the cycle a local job runs
 *    and `gbrain dream`'s cycle all write through the owner as local callers. (f) `gbrain bootstrap verify` and the
 *    Apple Contacts person-fact sync, which build their own operation context, call the owner as local callers too;
 *    their journaled writes stop at write admission on the `transactions` refusal (admission opens a transaction,
 *    which does not cross the owner socket), never on the remote-caller refusal.
 * 3. Existing coverage: rust-owner-ipc-remote-scope.test.ts covers dispatch and jobs a remote call queued; nothing ran
 *    a model-chosen tool call outside dispatch.
 * 4. Seam: the owner is the real PGLite engine behind a recording proxy on a real socket; the client is a stand-in
 *    engine with the real owner client installed and a recorder on each member; jobs go through the real queue and
 *    worker; the tool registries are the real builders.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { OperationError, type Operation } from '../src/core/ops/contract.ts';
import { finalizeOperation } from '../src/core/operation-load.ts';
import { isRemoteCaller } from '../src/core/remote-caller.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { runRollout } from '../src/core/skillopt/rollout.ts';
import { buildWriteCaptureRegistry } from '../src/core/skillopt/write-capture.ts';
import type { ToolHandler } from '../src/core/ai/gateway.ts';
import type { BenchmarkTask } from '../src/core/skillopt/types.ts';
import { serveOwnerEngine, type OwnerEngineServer } from '../src/core/rust-engine/owner-ipc/server.ts';
import { callerIsRemote, connectOwner, installOwnerClient } from '../src/core/rust-engine/owner-ipc/client.ts';
import { OWNER_IPC_ROUTES, ownerMemberOnlyReads } from '../src/core/rust-engine/owner-ipc/routes.ts';
import { withEnv } from './helpers/with-env.ts';
import { makeContext } from '../src/cli/main.ts';
import { runCycle } from '../src/core/cycle.ts';
import { makeAutopilotCycleHandler } from '../src/core/minions/handlers/autopilot-cycle.ts';
import { verifyWorkspace } from '../src/core/bootstrap/verify.ts';
import { syncPersonFacts } from '../src/core/apple-contacts/person-facts.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'gbrain-owner-remote-mark-'));
const brainHome = join(sandbox, 'home');
let engine: PGLiteEngine;
let owner: OwnerEngineServer;
let undo: () => void;
/** The client engine: a stand-in with the real owner client installed. */
let client: BrainEngine;
/** Members the owner ran for the client. */
const reached: string[] = [];
/** Each member the client was asked for: whether the caller read as remote then, and how the call ended. */
const asked: Array<{ member: string; remote: boolean; outcome: Promise<string> }> = [];

const isolated = <T>(fn: () => T | Promise<T>): Promise<T> =>
  withEnv({ GBRAIN_HOME: brainHome, DATABASE_URL: undefined, GBRAIN_CONTRIBUTOR_MODE: '1' }, fn);

const outcomeOf = (error: unknown) => error instanceof OperationError ? error.code : `unexpected:${String(error)}`;

beforeAll(async () => isolated(async () => {
  mkdirSync(brainHome);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const recorded = new Proxy(engine, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof key !== 'string' || typeof value !== 'function' || !Object.hasOwn(OWNER_IPC_ROUTES, key)) return value;
      return (...args: unknown[]) => { reached.push(key); return (value as (...a: unknown[]) => unknown).apply(target, args); };
    },
  });
  owner = (await serveOwnerEngine(recorded as unknown as BrainEngine, join(sandbox, 'owner.sock')))!;
  const standIn = { kind: 'rust', capabilities: new Set<string>() };
  undo = installOwnerClient(standIn, await connectOwner(owner.socketPath));
  const record = standIn as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const [member, route] of Object.entries(OWNER_IPC_ROUTES)) {
    if (route === 'local' || typeof record[member] !== 'function') continue;
    const send = record[member]!;
    record[member] = (...args: unknown[]) => {
      const remote = callerIsRemote();
      const call = Promise.resolve().then(() => send.apply(standIn, args));
      asked.push({ member, remote, outcome: call.then(() => 'sent', outcomeOf) });
      return call;
    };
  }
  client = standIn as unknown as BrainEngine;
}), 120_000);
afterAll(async () => {
  undo?.();
  await owner?.close();
  await engine?.disconnect();
  rmSync(sandbox, { recursive: true, force: true });
}, 60_000);
beforeEach(() => { reached.length = 0; asked.length = 0; });

/** The write members the client was asked for and how each ended, once every call has settled. */
async function writesAsked(): Promise<Array<{ member: string; remote: boolean; outcome: string }>> {
  const writes = asked.filter(call => !ownerMemberOnlyReads(call.member));
  return Promise.all(writes.map(async call => ({ member: call.member, remote: call.remote, outcome: await call.outcome })));
}

/** Waits until the client has been asked for `member`, so fire-and-forget work a handler started is in the record. */
async function untilAsked(member: string): Promise<void> {
  for (let i = 0; i < 250 && !asked.some(call => call.member === member); i++) await Bun.sleep(20);
  await Promise.all(asked.map(call => call.outcome));
}

const writesReachedOwner = () => reached.filter(member => !ownerMemberOnlyReads(member));

describe('a locally queued job: the model-chosen write is remote, the job\'s own write is not', () => {
  // Value: protects=a subagent put_page tool call inside a job the local application queued sends no write member to the owner, and the job's own write still goes through; fails_when=a brain tool handler runs without the remote mark, so callerIsRemote reads the job's application authority and the model's write runs on the owner with the owner's authority; why_new=no test ran a model-chosen tool call outside MCP dispatch; seam=real queue, worker and buildBrainTools on an owner-client stand-in, real PGLite owner behind a recording proxy; no_claim=what put_page does on an owner that allows it
  test('a subagent put_page tool call is refused before any write reaches the owner; the job\'s own putPage still reaches it', () => isolated(async () => {
    await engine.executeRaw('DELETE FROM minion_jobs');
    const queue = new MinionQueue(engine);
    const job = await queue.add('remote-mark-probe', {});
    expect((await queue.getJob(job.id))?.submission_authority?.kind).toBe('application');
    const seen: Record<string, unknown> = {};
    const worker = new MinionWorker(engine, { pollInterval: 10, healthCheckInterval: 0, stalledInterval: 60_000 });
    worker.register('remote-mark-probe', async running => {
      seen.jobIsRemote = callerIsRemote();
      const [putPage] = buildBrainTools({ subagentId: running.id, engine: client, config: {} as never, allowedNames: new Set(['put_page']) });
      try {
        await putPage!.execute({ slug: `wiki/agents/${running.id}/note`, content: '---\ntitle: Note\n---\nA note the model chose to write.\n' }, { engine: client, jobId: running.id, remote: true });
        seen.tool = 'written';
      } catch (error) { seen.tool = error instanceof OperationError ? error.code : (error as Error).message; }
      seen.toolWrites = await writesAsked();
      seen.toolWritesAtOwner = writesReachedOwner();
      asked.length = 0; reached.length = 0;
      // The job's own code (not a model's choice) writes as the local application it is.
      seen.ownWrite = await (client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).setConfig!('remote_mark_probe', 'own')
        .then(() => 'sent', outcomeOf);
      seen.ownWritesAtOwner = writesReachedOwner();
    });
    const run = worker.start();
    try {
      for (let i = 0; i < 300 && !('ownWritesAtOwner' in seen); i++) await Bun.sleep(20);
    } finally { await worker.stop(); await run; }

    expect(seen.jobIsRemote).toBe(false);
    expect(seen.tool).toBe('engine_capability_missing');
    const toolWrites = seen.toolWrites as Array<{ member: string; remote: boolean; outcome: string }>;
    // The trunk's owner runs whole operations (owner-ipc/whole-op.ts): a remote caller's put_page is refused before a member is asked, so none may be listed.
    expect(toolWrites.filter(call => !call.remote || call.outcome !== 'engine_capability_missing')).toEqual([]);
    expect(seen.toolWritesAtOwner).toEqual([]);
    expect(seen.ownWrite).toBe('sent');
    expect(seen.ownWritesAtOwner).toEqual(['setConfig']);
  }), 60_000);
});

describe('SkillOpt tool calls are remote callers', () => {
  async function rolloutHandlers(): Promise<Map<string, ToolHandler>> {
    let captured: Map<string, ToolHandler> | undefined;
    const task: BenchmarkTask = { task_id: 'remote-mark', task: 'search the brain', judge: { kind: 'rule', checks: [] } };
    await runRollout({
      engine: client, skillText: 'skill', task, targetModel: 'openai:gpt-6.1-sol', allowedTools: new Set(['search']),
      toolLoopFn: (async (o: { toolHandlers: Map<string, ToolHandler> }) => {
        captured = o.toolHandlers;
        return { messages: [], totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, totalTurns: 1, stopReason: 'end' };
      }) as never,
    });
    return captured!;
  }

  // Value: protects=a SkillOpt rollout tool and a write-capture tool reach the owner with remote reads only, and the eval-capture write the search starts is refused on the client; fails_when=a SkillOpt registry calls a handler without the remote mark, so the optimizer's choice writes through the owner; why_new=no test runs a SkillOpt tool on an owner client; seam=real runRollout (stubbed tool loop) and buildWriteCaptureRegistry on an owner-client stand-in; no_claim=search ranking
  for (const [label, handlers] of [
    ['rollout', rolloutHandlers],
    ['write-capture', async () => buildWriteCaptureRegistry(client).handlers],
  ] as const) {
    test(`${label}: brain_search sends only remote reads, and its eval-capture write is refused before it is sent`, () => isolated(async () => {
      const search = (await handlers()).get('brain_search')!;
      await search.execute({ query: 'remote mark example' }, new AbortController().signal);
      await untilAsked('logEvalCandidate');
      const writes = await writesAsked();
      expect(writes.map(call => call.member)).toContain('logEvalCandidate');
      expect(writes.filter(call => !call.remote || call.outcome !== 'engine_capability_missing')).toEqual([]);
      expect(writesReachedOwner()).toEqual([]);
    }), 60_000);
  }
});

describe('the mark each handler runs under', () => {
  const ctx = (remote: boolean | undefined) => ({ engine, config: {}, remote, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;

  // Value: protects=a handler reads the mark its own context names (remote unless strictly false), a nested remote:false call under a remote one stays remote, and the mark ends with the call; fails_when=the wrapper ignores ctx.remote, a nested local context clears an outer remote mark, or the mark leaks past the call; why_new=the mark was only set by dispatch; seam=finalizeOperation on a fixture operation; no_claim=dispatch behavior
  test('remote: true and an unset remote mark the handler; remote: false does not, unless an outer handler is remote', async () => {
    const seen: Array<[string, boolean]> = [];
    const inner = { name: 'remote_mark_inner', description: 'fixture', params: {}, scope: 'read',
      handler: async (c: OperationContext) => { seen.push([`inner:${String(c.remote)}`, isRemoteCaller()]); return null; } } as unknown as Operation;
    const outer = { name: 'remote_mark_outer', description: 'fixture', params: {}, scope: 'read',
      handler: async (c: OperationContext) => { seen.push([`outer:${String(c.remote)}`, isRemoteCaller()]); await inner.handler(ctx(false), {}); return null; } } as unknown as Operation;
    finalizeOperation(inner);
    finalizeOperation(outer);
    await inner.handler(ctx(true), {});
    await inner.handler(ctx(undefined), {});
    await inner.handler(ctx(false), {});
    await outer.handler(ctx(true), {});
    await outer.handler(ctx(false), {});
    expect(seen).toEqual([
      ['inner:true', true], ['inner:undefined', true], ['inner:false', false],
      ['outer:true', true], ['inner:false', true],
      ['outer:false', false], ['inner:false', false],
    ]);
    expect(isRemoteCaller()).toBe(false);
  });

  // Value: protects=a handler from the shipped operations table runs its engine calls under the mark its context names; fails_when=an operation is added to the table without finalizeOperation; why_new=nothing checked the table's handlers carry the mark; seam=the real get_page handler on the PGLite engine behind a proxy that records the mark at each engine call; no_claim=operations loaded outside the table
  test('the real get_page handler reads the engine as a remote caller for a remote context and as a local one for a local context', async () => {
    const marks: boolean[] = [];
    const watched = new Proxy(engine, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { marks.push(isRemoteCaller()); return (value as (...a: unknown[]) => unknown).apply(target, args); };
      },
    });
    const getPage = operations.find(o => o.name === 'get_page')!;
    // finalizeOperation is idempotent: the table's handler is already wrapped once.
    const wrapped = getPage.handler;
    finalizeOperation(getPage);
    expect(getPage.handler).toBe(wrapped);
    for (const remote of [true, false]) {
      marks.length = 0;
      await getPage.handler({ ...ctx(remote), engine: watched as unknown as BrainEngine, takesHoldersAllowList: ['world'] } as OperationContext, { slug: 'notes/remote-mark-missing' }).catch(() => null);
      expect({ remote, called: marks.length > 0, marks: [...new Set(marks)] }).toEqual({ remote, called: true, marks: [remote] });
    }
  });
});

describe('a local caller\'s own writes on a Rust brain still reach the owner', () => {
  /** Every write member the client was asked for went out as a local call, was sent, and reached the owner. */
  async function expectLocalWritesSent(): Promise<string[]> {
    const writes = await writesAsked();
    // The trunk classes the cycle's own calls as reads or runs them locally, so a cycle may ask no write member; it must
    // still have reached the owner, and as a local caller.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter(call => call.remote)).toEqual([]);
    expect(writes.filter(call => call.remote || call.outcome !== 'sent')).toEqual([]);
    expect(writesReachedOwner().length).toBe(writes.length);
    return writes.map(call => call.member);
  }

  // Value: protects=a CLI command's operation call on a Rust brain writes through the owner, because the CLI's context says remote: false, while the same handler with no remote field is refused (an unset remote reads as remote); fails_when=makeContext stops naming remote: false, or the mark treats an unset remote as local; why_new=the mark used to come only from dispatch, so the CLI's handlers never ran under it; seam=the real makeContext and log_ingest handler on an owner-client stand-in; no_claim=commands that need a transaction, which no second process can run
  test('the CLI: an operation called with the CLI\'s context writes through the owner; the same call with remote unset is refused', () => isolated(async () => {
    const ctx = await makeContext(client, {});
    expect(ctx.remote).toBe(false);
    const logIngest = operations.find(o => o.name === 'log_ingest')!;
    await logIngest.handler(ctx, { source_type: 'cli', source_ref: 'remote-mark', pages_updated: [], summary: 'a local CLI write' });
    expect(await expectLocalWritesSent()).toContain('logIngest');

    asked.length = 0; reached.length = 0;
    const { remote: _dropped, ...unset } = ctx;
    const refused = await logIngest.handler(unset as OperationContext, { source_type: 'cli', source_ref: 'remote-mark', pages_updated: [], summary: 'no remote field' })
      .then(() => 'sent', outcomeOf);
    expect(refused).toBe('engine_capability_missing');
    expect((await writesAsked()).filter(call => call.member === 'logIngest')).toEqual([{ member: 'logIngest', remote: true, outcome: 'engine_capability_missing' }]);
    expect(writesReachedOwner()).toEqual([]);
  }), 60_000);

  // Value: protects=a locally queued autopilot-cycle job (the real handler on the real worker) runs its cycle on a Rust brain with every write going through the owner; fails_when=the worker, the handler or the cycle runs its own engine calls under a remote mark or a remote job authority; why_new=no test ran a real minion handler on an owner client; seam=the real queue, worker and makeAutopilotCycleHandler on an owner-client stand-in, real PGLite owner; no_claim=phases that need a checkout or a transaction
  test('a minion handler: a locally queued autopilot-cycle job writes through the owner as a local caller', () => isolated(async () => {
    await engine.executeRaw('DELETE FROM minion_jobs');
    const queue = new MinionQueue(engine);
    const job = await queue.add('autopilot-cycle', { phases: ['orphans'] });
    expect((await queue.getJob(job.id))?.submission_authority?.kind).toBe('application');
    const worker = new MinionWorker(engine, { pollInterval: 10, healthCheckInterval: 0, stalledInterval: 60_000 });
    const cycle = makeAutopilotCycleHandler(client);
    let result: unknown;
    worker.register('autopilot-cycle', async running => { result = await cycle(running); return result; });
    const run = worker.start();
    try {
      for (let i = 0; i < 500 && result === undefined; i++) await Bun.sleep(20);
    } finally { await worker.stop(); await run; }
    expect(result).toMatchObject({ status: 'clean' });
    await expectLocalWritesSent();
  }), 60_000);

  // Value: protects=the cycle `gbrain dream` runs on a Rust brain writes through the owner; fails_when=runCycle runs its engine calls under a remote mark; why_new=no test ran the cycle on an owner client; seam=the real runCycle on an owner-client stand-in, real PGLite owner; no_claim=phases that need a checkout or a transaction
  test('the cycle: runCycle writes through the owner as a local caller', () => isolated(async () => {
    const report = await runCycle(client, { brainDir: null, phases: ['orphans'] });
    expect(report.status).toBe('clean');
    await expectLocalWritesSent();
  }), 60_000);

  /** Every member the client was asked for went out as a local call; none was refused as a remote caller's. */
  async function expectNoRemoteCall(): Promise<Array<{ member: string; remote: boolean; outcome: string }>> {
    const all = await Promise.all(asked.map(async call => ({ member: call.member, remote: call.remote, outcome: await call.outcome })));
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter(call => call.remote)).toEqual([]);
    return all;
  }

  /** The refusal a journaled write meets on a client today: write admission opens a transaction, which does not cross the socket. */
  const admissionRefusal = { member: 'transaction', remote: false, outcome: 'engine_capability_missing' };

  // Value: protects=`gbrain bootstrap verify` on a Rust brain's second process calls the owner as a local caller (its localCtx says remote: false), so every check runs and the roundtrip fails only on the transactions refusal; fails_when=localCtx stops naming remote: false, or the mark reads an explicit local context as remote; why_new=the review of the remote mark named verify.ts as a caller that builds its own context and was not checked; seam=the real verifyWorkspace on an owner-client stand-in, real PGLite owner on a real socket; no_claim=a passing roundtrip, which needs journaled writes to reach the owner
  test('bootstrap verify: every check calls the owner as a local caller; the roundtrip stops on the transactions refusal, not the remote one', () => isolated(async () => {
    const ws = join(sandbox, 'verify-ws');
    mkdirSync(join(ws, 'brain'), { recursive: true });
    const report = await verifyWorkspace(client, ws, { sourceId: 'default', skipHooksSmoke: true, gbrainHomeDir: brainHome, sweepBudgetMs: 2_000 });
    expect(report.checks.find(c => c.id === 'doctor_green')).toMatchObject({ ok: true });
    const roundtrip = report.checks.find(c => c.id === 'roundtrip');
    expect(roundtrip?.ok).toBe(false);
    // Master's client stops at write admission (`transaction`); the trunk's whole-operation forward stops the journaled write first (`runOperation`). Neither is the remote-caller refusal.
    expect(roundtrip?.detail).toMatch(/(transaction|runOperation) cannot run from a second process/);
    expect(roundtrip?.detail).not.toContain('remote caller');
    const calls = await expectNoRemoteCall();
    expect(calls.filter(call => call.outcome !== 'sent' && !['transaction', 'runOperation'].includes(call.member))).toEqual([]);
    expect(writesReachedOwner()).not.toContain('transaction');
    // The refusal a client's write meets says it cannot run from this process; it no longer claims the write is sent.
    const refusal = await client.transaction(async () => undefined).then(() => null, (error: unknown) => error as OperationError);
    expect(refusal?.why).toContain('cannot run from this process yet');
    expect(refusal?.why).not.toContain('sent to the owner as one request');
  }), 60_000);

  // Value: protects=the Apple Contacts person-fact sync on a Rust brain's second process calls `remember` as a local caller (its context says remote: false), so the write stops on the transactions refusal and writes no fact; fails_when=the sync's context stops naming remote: false, or the mark reads an explicit local context as remote; why_new=the review of the remote mark named person-facts.ts as a caller that builds its own context and was not checked; seam=the real syncPersonFacts and remember handler on an owner-client stand-in, real PGLite owner on a real socket; no_claim=a written fact, which needs journaled writes to reach the owner
  test('Apple Contacts person facts: remember is called as a local caller and stops on the transactions refusal, not the remote one', () => isolated(async () => {
    const slug = 'people/alice-example';
    await engine.putPage(slug, { type: 'person', title: 'Alice Example', compiled_truth: 'A person.', timeline: '' } as never);
    asked.length = 0; reached.length = 0;
    const ended = await syncPersonFacts(client, 'contacts-a', { source_id: 'default', slug }, ['Works at Acme Example'], () => {})
      .then(() => 'written', (error: unknown) => error as { reason?: string; message?: string });
    expect(ended).toMatchObject({ reason: 'transactions' });
    expect((ended as { message: string }).message).toContain('transaction cannot run from a second process');
    const calls = await expectNoRemoteCall();
    expect(calls).toContainEqual(admissionRefusal);
    expect(await engine.executeRaw(`SELECT fact FROM facts WHERE entity_slug = $1`, [slug])).toEqual([]);
  }), 60_000);
});
