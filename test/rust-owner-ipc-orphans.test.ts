/**
 * Orphaned writes on the Rust engine owner socket (src/core/rust-engine/owner-ipc/server.ts): a write the owner started
 * keeps running after its caller stops waiting (deadline, cancel, closed connection), so it can still commit. The read
 * the error names to confirm it (confirming-reads.ts) must not answer "not there" while the write can still commit.
 *
 * 1. Protects: a caller that follows the advice of a timed-out or cancelled insertFact (run listFactsByEntity, rerun
 *    only when the fact is absent) never inserts the fact twice; a confirming read that cannot wait says the outcome is
 *    still unknown instead of timing out as a retryable `timeout`; members the orphan cannot change still run.
 * 2. Fails on: an owner that starts the confirming read while the orphan still runs (the read sees nothing and the
 *    advice leads to a second insert), or a held read that times out as `not_started` / retryable.
 * 3. Existing coverage: rust-owner-ipc.test.ts checks the advice text of a sent write's timeout and cancel, but its
 *    insertFact ends on abort and nothing reads the facts after it.
 * 4. Seam: none beyond `serveOwnerEngine` / `connectOwner` / `installOwnerClient`; the owner hosts a small fake engine
 *    whose insertFact ignores the abort and commits only when the test opens its gate.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { serveOwnerEngine } from '../src/core/rust-engine/owner-ipc/server.ts';
import { connectOwner, installOwnerClient } from '../src/core/rust-engine/owner-ipc/client.ts';
import { membersWaitingFor } from '../src/core/rust-engine/owner-ipc/confirming-reads.ts';
import { withReadDeadline } from '../src/core/read-deadline.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import type { OperationError } from '../src/core/ops/contract.ts';
import { encodeValue } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { OWNER_IPC_VERSION } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { rawSession } from './helpers/owner-ipc-raw.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

type Fact = { fact: string; entity_slug: string };
/** The members these tests call on a client, typed for the stub owner's facts rather than the full BrainEngine. */
type FactsClient = { insertFact(input: Fact): Promise<unknown>; listFactsByEntity(entity: string): Promise<Fact[]>; getHealth(): Promise<unknown> };

/** An owner whose insertFact ignores its abort and commits only after `open()`; reads answer at once. */
async function gatedFactsOwner(maxQueued?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-orphans-'));
  const facts: Fact[] = [];
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  let opened = false;
  const owner = {
    kind: 'pglite', capabilities: new Set<string>(),
    insertFact: async (input: Fact) => { await gate; facts.push(input); return { id: facts.length }; },
    listFactsByEntity: async (entity: string) => facts.filter(f => f.entity_slug === entity),
    getHealth: async () => ({ ok: true }),
  } as unknown as BrainEngine;
  const server = await serveOwnerEngine(owner, join(dir, 'owner.sock'), { permits: 4, ...(maxQueued === undefined ? {} : { maxQueued }) });
  if (!server) throw new Error('no socket');
  cleanups.push(async () => { open(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { server, facts, open: () => { opened = true; open(); }, get opened() { return opened; } };
}

async function clientOf(socketPath: string) {
  const connection = await connectOwner(socketPath);
  const engine = { kind: 'rust', capabilities: new Set<string>() } as unknown as FactsClient;
  const close = installOwnerClient(engine as unknown as BrainEngine, connection);
  cleanups.push(() => close());
  return engine;
}

const fact: Fact = { fact: 'likes tea', entity_slug: 'people/alice-example' };

/** Polls `done` every 10 ms for up to 2 s; the caller asserts the state it waited for. */
async function until(done: () => boolean): Promise<void> { for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(10); }

describe('a write whose caller stopped waiting while the owner still runs it', () => {
  // Value: protects=following the advice of a timed-out or cancelled insertFact never inserts the fact twice;
  // fails_when=the owner answers listFactsByEntity while the orphaned insertFact can still commit (empty read, rerun,
  // two facts); why_new=finding 3 of the last review: a negative confirming read was taken as proof of "not applied";
  // seam=none; no_claim=how the Rust store orders commits
  for (const how of ['timeout', 'cancel'] as const) {
    test(`after a ${how}, the advised read waits for the write, sees it, and the caller does not insert it again`, async () => {
      const owner = await gatedFactsOwner();
      const engine = await clientOf(owner.server.socketPath);
      const controller = new AbortController();
      const first = how === 'timeout'
        ? withReadDeadline(Date.now() + 100, () => engine.insertFact(fact)).then(() => null, e => e as OperationError)
        : withRequestSignal(controller.signal, () => engine.insertFact(fact)).then(() => null, e => e as OperationError);
      await until(() => owner.server.stats().active === 1);
      if (how === 'cancel') controller.abort();
      const error = await first;
      expect(error).toMatchObject({ code: 'owner_unavailable', reason: 'outcome_unknown', retryable: false });
      expect(error!.suggestion).toContain('run listFactsByEntity for that entity');
      expect(error!.suggestion).toContain('only after the earlier insertFact call has ended');
      // Follow the advice: read, and rerun only when the fact is absent.
      let readAt = 0;
      const followed = engine.listFactsByEntity(fact.entity_slug).then(async rows => {
        readAt = Date.now();
        if ((rows as Fact[]).length === 0) await engine.insertFact(fact);
        return rows as Fact[];
      });
      await Bun.sleep(150);
      expect(readAt).toBe(0);
      const openedAt = Date.now();
      owner.open();
      const rows = await followed;
      expect(readAt).toBeGreaterThanOrEqual(openedAt);
      expect(rows).toEqual([fact]);
      expect(owner.facts).toEqual([fact]);
    });
  }

  // Value: protects=a confirming read that cannot wait for the orphan says the outcome is still unknown;
  // fails_when=it times out as a retryable `timeout` / `not_started`, or runs and answers empty; why_new=the
  // earlier_call_running reason is new; seam=none; no_claim=how long an orphan runs
  test('a held read that reaches its own deadline ends earlier_call_running, not retryable, and never ran', async () => {
    const owner = await gatedFactsOwner();
    const engine = await clientOf(owner.server.socketPath);
    await withReadDeadline(Date.now() + 80, () => engine.insertFact(fact)).catch(() => undefined);
    const held = await withReadDeadline(Date.now() + 120, () => engine.listFactsByEntity(fact.entity_slug)).then(() => null, e => e as OperationError);
    expect(held).toMatchObject({ code: 'owner_unavailable', reason: 'earlier_call_running', retryable: false });
    expect(held!.message).toContain('earlier insertFact call still runs');
    expect(held!.suggestion).toContain('Do not rerun insertFact before that read answers');
    expect(String(held!.detail)).toContain('earlier=insertFact');
    expect(String(held!.detail)).toContain('ran=false');
    owner.open();
    await until(() => owner.server.stats().active === 0);
    // Once the orphan settles the same read runs and its answer is final.
    expect(await engine.listFactsByEntity(fact.entity_slug)).toEqual([fact]);
    expect(owner.server.stats()).toMatchObject({ active: 0, queued: 0, inflightBytes: 0 });
  });

  // Value: protects=the hold covers only members that confirm the orphan, so the rest of the brain keeps serving;
  // fails_when=an orphan blocks every call; why_new=the hold is new; seam=none; no_claim=fairness between held calls
  test('a member the orphan cannot change still runs while it is held', async () => {
    const owner = await gatedFactsOwner();
    const engine = await clientOf(owner.server.socketPath);
    await withReadDeadline(Date.now() + 80, () => engine.insertFact(fact)).catch(() => undefined);
    expect(await withReadDeadline(Date.now() + 500, () => engine.getHealth())).toEqual({ ok: true });
    owner.open();
  });

  // Value: protects=reads held behind an orphan count against maxQueued even with permits free, so a stalled write
  // cannot make the owner hold any number of calls; fails_when=the queue cap is checked only when every permit is
  // taken; why_new=the hold queues calls while permits are free; seam=none; no_claim=the inflight byte bound
  test('reads held behind an orphan fill maxQueued with permits free: the next one is refused queue_full', async () => {
    const owner = await gatedFactsOwner(2);
    const engine = await clientOf(owner.server.socketPath);
    await withReadDeadline(Date.now() + 80, () => engine.insertFact(fact)).catch(() => undefined);
    const held = [engine.listFactsByEntity(fact.entity_slug), engine.listFactsByEntity(fact.entity_slug)];
    await until(() => owner.server.stats().queued === 2);
    expect(owner.server.stats()).toMatchObject({ active: 1, queued: 2 });
    const refused = await engine.listFactsByEntity(fact.entity_slug).then(() => null, e => e as OperationError);
    expect(refused).toMatchObject({ code: 'owner_busy', reason: 'queue_full', retryable: true });
    owner.open();
    expect(await Promise.all(held)).toEqual([[fact], [fact]]);
    expect(owner.facts).toEqual([fact]);
  });

  // Value: protects=a confirming read on another connection cannot overtake a cancel the owner has not read yet;
  // fails_when=the hold covers only writes the owner already knows were abandoned, so the read answers empty while
  // the write still runs and the advice leads to a second insert; why_new=fix-check finding: the client gives up as
  // soon as it sends its cancel; seam=none (a write whose caller still waits stands in for an unread cancel);
  // no_claim=socket delivery order
  test('a read on another connection waits for a started write even before the owner sees its cancel', async () => {
    const owner = await gatedFactsOwner();
    const writer = await clientOf(owner.server.socketPath);
    const reader = await clientOf(owner.server.socketPath);
    const write = writer.insertFact(fact);
    await until(() => owner.server.stats().active === 1);
    let answered = false;
    const read = reader.listFactsByEntity(fact.entity_slug).then(rows => { answered = true; return rows; });
    await until(() => owner.server.stats().queued === 1);
    await Bun.sleep(100);
    expect(answered).toBe(false);
    expect(owner.server.stats()).toMatchObject({ active: 1, queued: 1 });
    owner.open();
    expect(await read).toEqual([fact]);
    await write;
    expect(owner.facts).toEqual([fact]);
  });

  // Value: protects=a write whose connection closed is held the same way; fails_when=a closed connection's started
  // write is forgotten and the read runs at once; why_new=the hold is new; seam=raw frames for the closed connection;
  // no_claim=none
  test('a write whose connection closed holds the read on another connection until it settles', async () => {
    const owner = await gatedFactsOwner();
    const raw = rawSession(owner.server.socketPath);
    await raw.send({ t: 'hello', version: OWNER_IPC_VERSION });
    await raw.next(frame => frame.t === 'hello');
    await raw.send({ t: 'call', id: 1, member: 'insertFact', args: encodeValue([fact]) });
    await until(() => owner.server.stats().active === 1);
    raw.destroy();
    await Bun.sleep(50);
    const engine = await clientOf(owner.server.socketPath);
    let answered = false;
    const read = engine.listFactsByEntity(fact.entity_slug).then(rows => { answered = true; return rows; });
    await Bun.sleep(150);
    expect(answered).toBe(false);
    owner.open();
    expect(await read).toEqual([fact]);
  });
});

describe('which members an orphan holds back', () => {
  // Value: protects=the hold follows the confirming read each write names; fails_when=executeRaw (whose read is a
  // SELECT through executeRaw) holds nothing, or a write whose rerun repeats nothing holds anything; why_new=new;
  // seam=none; no_claim=key-level precision (the hold is by member)
  test('the confirming read members, the write itself for executeRaw, and nothing for a no-op rerun', () => {
    expect([...membersWaitingFor('insertFact')]).toEqual(['listFactsByEntity']);
    expect([...membersWaitingFor('executeRaw')]).toEqual(['executeRaw']);
    expect([...membersWaitingFor('importFromContent')]).toEqual(['getPage']);
    expect([...membersWaitingFor('importManagedFiles')]).toEqual(['getPage']);
    expect([...membersWaitingFor('sweepSegments')]).toEqual([]);
    expect([...membersWaitingFor('lockPageKeys')]).toEqual([]);
  });
});
