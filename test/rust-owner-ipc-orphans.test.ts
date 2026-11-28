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
import { requestSignal, withRequestSignal } from '../src/core/request-signal.ts';
import type { OperationError } from '../src/core/ops/contract.ts';
import { encodeValue } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { OWNER_IPC_VERSION } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { rawSession } from './helpers/owner-ipc-raw.ts';
import { readFileSync } from 'node:fs';
import { OWNER_IPC_CONFIRMING_READS } from '../src/core/rust-engine/owner-ipc/confirming-reads.ts';
import { confirmingReadAdvice } from '../src/core/rust-engine/owner-ipc/routes.ts';

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

/**
 * An owner whose every insertFact ignores its abort and waits on its own gate, named by the fact text, and notes when
 * the owner aborts it (the owner read its cancel). Reads answer at once, except listFactsByEntity for `slowEntity`,
 * which waits on the gate `read:<entity>`.
 */
async function perFactGatedOwner(opts: { permits?: number; slowEntity?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-orphans-'));
  const facts: Fact[] = [];
  const gates = new Map<string, () => void>();
  const aborted = new Set<string>();
  const reads: string[] = [];
  const gated = (name: string) => new Promise<void>(resolve => { gates.set(name, resolve); });
  const owner = {
    kind: 'pglite', capabilities: new Set<string>(),
    insertFact: async (input: Fact) => {
      requestSignal()?.addEventListener('abort', () => { aborted.add(input.fact); }, { once: true });
      await gated(input.fact);
      facts.push(input);
      return { id: facts.length };
    },
    listFactsByEntity: async (entity: string) => {
      reads.push(entity);
      if (entity === opts.slowEntity) await gated(`read:${entity}`);
      return facts.filter(f => f.entity_slug === entity);
    },
    getHealth: async () => ({ ok: true }),
  } as unknown as BrainEngine;
  const server = await serveOwnerEngine(owner, join(dir, 'owner.sock'), { permits: opts.permits ?? 4 });
  if (!server) throw new Error('no socket');
  const releaseAll = () => { for (const open of gates.values()) open(); };
  cleanups.push(async () => { releaseAll(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  /** Waits until the owner runs the insertFact for `text`, then lets it commit. */
  const release = async (text: string) => { await until(() => gates.has(text)); gates.get(text)!(); };
  return {
    server, facts, release, aborted, reads,
    running: (text: string) => gates.has(text) && !facts.some(f => f.fact === text),
  };
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

type Nudge = { sourceId: string; takeId: number; nudgePattern: string; waveVersion: string };
type NudgeRow = { id: number; source_id: string; take_id: number; nudge_pattern: string; wave_version: string };
type NudgeClient = { insertTakeNudge(n: Nudge): Promise<number>; listTakeNudges(f: { sourceId: string; takeId?: number; nudgePattern?: string; waveVersion?: string }): Promise<NudgeRow[]> };

/** An owner whose insertTakeNudge ignores its abort and logs the nudge only after `open()`; listTakeNudges answers at once. */
async function gatedNudgeOwner() {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-nudges-'));
  const rows: NudgeRow[] = [];
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const owner = {
    kind: 'pglite', capabilities: new Set<string>(),
    insertTakeNudge: async (n: Nudge) => { await gate; rows.push({ id: rows.length + 1, source_id: n.sourceId, take_id: n.takeId, nudge_pattern: n.nudgePattern, wave_version: n.waveVersion }); return rows.length; },
    listTakeNudges: async (f: { sourceId: string; takeId?: number }) => rows.filter(r => r.source_id === f.sourceId && (f.takeId === undefined || r.take_id === f.takeId)),
  } as unknown as BrainEngine;
  const server = await serveOwnerEngine(owner, join(dir, 'owner.sock'), { permits: 4 });
  if (!server) throw new Error('no socket');
  cleanups.push(async () => { open(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { server, rows, open };
}

describe('a nudge write whose reply was lost, then replayed by a caller that follows the advice', () => {
  // Value: protects=a take nudge whose insertTakeNudge forward timed out or was cancelled is logged once when the caller reads
  // the nudges the advice names and replays it only when its row is missing; fails_when=insertTakeNudge has no confirming read
  // entry, so the owner answers the (unnamed) read at once while the orphaned insert is still running, the caller sees no row,
  // replays, and the log holds the nudge twice; why_new=insertTakeNudge was one of the four members the port left unclassed;
  // seam=none; no_claim=how the Rust store orders commits
  for (const how of ['timeout', 'cancel'] as const) {
    test(`after a ${how}, the nudge is logged once`, async () => {
      const owner = await gatedNudgeOwner();
      const connection = await connectOwner(owner.server.socketPath);
      const engine = { kind: 'rust', capabilities: new Set<string>() } as unknown as NudgeClient;
      cleanups.push(installOwnerClient(engine as unknown as BrainEngine, connection));
      const nudge: Nudge = { sourceId: 'default', takeId: 7, nudgePattern: 'stale-take', waveVersion: 'v9.9.9.0' };
      const controller = new AbortController();
      const first = how === 'timeout'
        ? withReadDeadline(Date.now() + 100, () => engine.insertTakeNudge(nudge)).then(() => null, e => e as OperationError)
        : withRequestSignal(controller.signal, () => engine.insertTakeNudge(nudge)).then(() => null, e => e as OperationError);
      await until(() => owner.server.stats().active === 1);
      if (how === 'cancel') controller.abort();
      const error = await first;
      expect(error).toMatchObject({ code: 'owner_unavailable', reason: 'outcome_unknown', retryable: false });
      // Follow the advice: read the source's nudges for that take, replay only when the pattern and wave are not there. The
      // gate opens 150 ms later, as the orphaned write finishes; a read the owner does not hold back finds nothing before that.
      setTimeout(owner.open, 150);
      const followed = engine.listTakeNudges({ sourceId: nudge.sourceId, takeId: nudge.takeId }).then(async rows => {
        if (!rows.some(r => r.nudge_pattern === nudge.nudgePattern && r.wave_version === nudge.waveVersion)) await engine.insertTakeNudge(nudge);
        return rows;
      });
      const seen = await followed;
      await until(() => owner.server.stats().active === 0);
      expect(owner.rows.map(r => [r.source_id, r.take_id, r.nudge_pattern, r.wave_version])).toEqual([['default', 7, 'stale-take', 'v9.9.9.0']]);
      expect(seen).toHaveLength(1);
      expect(error!.suggestion).toContain('run listTakeNudges for that source and the take or proposal the call named (look for that pattern and wave, fired since the call began)');
      expect(error!.suggestion).toContain('only after the earlier insertTakeNudge call has ended');
    });
  }
});

type RollupDelta = { kind: string; source_id: string; day: string; cost_usd: number };
type RollupClient = { upsertExtractRollupDay(d: RollupDelta): Promise<void> };

/** An owner whose upsertExtractRollupDay ignores its abort and adds the delta only after `open()`; `calls` counts every call it received. */
async function gatedRollupOwner() {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-rollup-'));
  const added: RollupDelta[] = [];
  const calls: RollupDelta[] = [];
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const owner = {
    kind: 'pglite', capabilities: new Set<string>(),
    upsertExtractRollupDay: async (d: RollupDelta) => { calls.push(d); await gate; added.push(d); },
  } as unknown as BrainEngine;
  const server = await serveOwnerEngine(owner, join(dir, 'owner.sock'), { permits: 4 });
  if (!server) throw new Error('no socket');
  cleanups.push(async () => { open(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { server, added, calls, open };
}

describe('an extract rollup add whose reply was lost (Ember ruling B, option 2)', () => {
  // Value: protects=upsertExtractRollupDay is classed on the owner socket with a read of the day's row and the note that this
  // read cannot confirm one delta, in the advice and in docs/designs/RUST_ENGINE.md, and the socket never resends the call by
  // itself after a deadline or a cancel (one owner call, error retryable false, nothing sent again while the caller waits);
  // fails_when=the entry or its note is dropped, the advice says the call is safe to rerun, or the client replays a lost-reply
  // write (the owner then holds two calls and the day is counted twice); why_new=the member was the one the port left
  // unclassed; seam=none; no_claim=the generic no-resend of every write (rust-owner-ipc.test.ts covers insertFact's cancel and
  // deadline, and this file the insertFact and insertTakeNudge replays by a caller that follows the advice)
  test('the classing and its note are pinned', () => {
    expect(OWNER_IPC_CONFIRMING_READS.upsertExtractRollupDay).toContain('extract_rollup_7d row for that kind and source');
    const advice = confirmingReadAdvice('upsertExtractRollupDay');
    expect(advice).toContain('rerun it only if it did not');
    expect(advice).toContain('Parallel extractions add to the same row, so that read cannot confirm this one delta, and a rerun can double-count the day');
    expect(advice).toContain('report-only cache that the JSONL audit can rebuild');
    expect(advice).toContain('never reruns a call whose reply was lost');
    const design = readFileSync(join(import.meta.dir, '..', 'docs', 'designs', 'RUST_ENGINE.md'), 'utf8');
    expect(design).toContain('parallel extractions share that row, so the read cannot confirm one delta and a rerun can double-count a report-only cache that the JSONL audit can rebuild');
    const todos = readFileSync(join(import.meta.dir, '..', 'TODOS.md'), 'utf8');
    expect(todos).toContain('extract-rollup-confirming-read');
  });

  for (const how of ['timeout', 'cancel'] as const) {
    test(`after a ${how} the owner is not called again by the client, and the error says a rerun is not safe`, async () => {
      const owner = await gatedRollupOwner();
      const connection = await connectOwner(owner.server.socketPath);
      const engine = { kind: 'rust', capabilities: new Set<string>() } as unknown as RollupClient;
      cleanups.push(installOwnerClient(engine as unknown as BrainEngine, connection));
      const delta: RollupDelta = { kind: 'facts', source_id: 'default', day: '2026-11-22', cost_usd: 0.5 };
      const controller = new AbortController();
      const first = how === 'timeout'
        ? withReadDeadline(Date.now() + 100, () => engine.upsertExtractRollupDay(delta)).then(() => null, e => e as OperationError)
        : withRequestSignal(controller.signal, () => engine.upsertExtractRollupDay(delta)).then(() => null, e => e as OperationError);
      await until(() => owner.server.stats().active === 1);
      if (how === 'cancel') controller.abort();
      const error = await first;
      expect(error).toMatchObject({ code: 'owner_unavailable', reason: 'outcome_unknown', retryable: false });
      expect(error!.suggestion).toContain('Before you rerun upsertExtractRollupDay');
      expect(error!.suggestion).toContain('cannot confirm this one delta');
      // The client sends nothing more: wait past any retry timer, then let the orphaned call finish. One call reached the owner and one add landed.
      await Bun.sleep(300);
      expect(owner.calls).toEqual([delta]);
      owner.open();
      await until(() => owner.server.stats().active === 0);
      expect(owner.calls).toEqual([delta]);
      expect(owner.added).toEqual([delta]);
    });
  }
});

describe('a read held behind running writes, with two or more writers taking turns', () => {
  const entity = 'people/alice-example';
  const factOf = (text: string): Fact => ({ fact: text, entity_slug: entity });

  // Value: protects=a read on the owner socket answers while writers keep overlapping, instead of waiting until all
  // writing stops; fails_when=the hold counts every started write, including writes admitted after the read, so with
  // two overlapping writers the read never runs (measured 0.8 s at 8 writers, ~2 s at 32 and 80, switch off);
  // why_new=lane L2 item 4 found the starvation; seam=none (a fake owner whose writes each wait on their own gate);
  // no_claim=latency numbers (the probe measures them), the store's own thread pool
  test('a write admitted after the read no longer holds the read', async () => {
    const owner = await perFactGatedOwner();
    const writer = await clientOf(owner.server.socketPath);
    const reader = await clientOf(owner.server.socketPath);
    const writes: Promise<unknown>[] = [];
    const write = (text: string) => { const p = writer.insertFact(factOf(text)); p.catch(() => undefined); writes.push(p); };
    write('w1');
    await until(() => owner.server.stats().active === 1);
    let answered = false;
    const read = reader.listFactsByEntity(entity).then(rows => { answered = true; return rows; });
    // A failed run closes the owner under these calls; their rejections must not land on the next test.
    read.catch(() => undefined);
    await until(() => owner.server.stats().queued === 1);
    // Writes admitted after the read take turns: one always runs while the next starts.
    write('w2');
    await until(() => owner.server.stats().active === 2);
    expect(answered).toBe(false);
    await owner.release('w1');
    // Only w1 came before the read, so the read answers now, while w2 still runs.
    await until(() => answered);
    expect(answered).toBe(true);
    expect(await read).toEqual([factOf('w1')]);
    expect(owner.running('w2')).toBe(true);
    for (let k = 3; k <= 5; k++) {
      write(`w${k}`);
      await until(() => owner.server.stats().active === 2);
      await owner.release(`w${k - 1}`);
    }
    await owner.release('w5');
    await Promise.all(writes);
    expect(owner.facts.map(f => f.fact)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5']);
    expect(owner.server.stats()).toMatchObject({ active: 0, queued: 0, inflightBytes: 0 });
  });

  // Value: protects=read-your-write for the confirming caller: its read, sent after its own orphaned write, still
  // waits for that write and sees it, so following the advice never inserts the fact twice, while other callers'
  // later writes no longer hold it; fails_when=the confirming read answers before its own write settles (empty
  // read, second insert), or it waits for writes admitted after it; why_new=the fair hold of lane L2 item 4;
  // seam=none; no_claim=a read admitted before the write it means to confirm (a caller never sends one)
  test('the confirming read still waits for its own earlier write, but not for writes admitted after it', async () => {
    const owner = await perFactGatedOwner();
    const caller = await clientOf(owner.server.socketPath);
    const others = await clientOf(owner.server.socketPath);
    const mine = factOf('mine');
    const controller = new AbortController();
    const first = withRequestSignal(controller.signal, () => caller.insertFact(mine)).then(() => null, e => e as OperationError);
    await until(() => owner.running('mine'));
    expect(owner.running('mine')).toBe(true);
    controller.abort();
    const error = await first;
    expect(error).toMatchObject({ code: 'owner_unavailable', reason: 'outcome_unknown', retryable: false });
    let answered = false;
    const followed = caller.listFactsByEntity(entity).then(async rows => {
      answered = true;
      if ((rows as Fact[]).every(f => f.fact !== 'mine')) await caller.insertFact(mine);
      return rows as Fact[];
    });
    // A failed run closes the owner under these calls; their rejections must not land on the next test.
    followed.catch(() => undefined);
    await until(() => owner.server.stats().queued === 1);
    const later = [others.insertFact(factOf('o1')), others.insertFact(factOf('o2'))];
    for (const p of later) p.catch(() => undefined);
    await until(() => owner.server.stats().active === 3);
    await Bun.sleep(100);
    // Its own write still runs, so the read waits.
    expect(answered).toBe(false);
    await owner.release('mine');
    await until(() => answered);
    expect(answered).toBe(true);
    expect(await followed).toEqual([mine]);
    expect(owner.running('o1') && owner.running('o2')).toBe(true);
    await owner.release('o1');
    await owner.release('o2');
    await Promise.all(later);
    expect(owner.facts.filter(f => f.fact === 'mine')).toEqual([mine]);
  });
  // Value: protects=a write admitted after the read whose caller already stopped waiting still holds the read, so a
  // confirming read on another connection that the owner admitted first cannot answer "not there" once the owner has
  // read that write's cancel; fails_when=the fair hold drops every later write, including an orphan (review finding
  // F1 of the fair-hold plan); why_new=the fair hold is new; seam=none; no_claim=the window before the owner reads the
  // cancel (the server header names it)
  test('a later write whose caller stopped waiting still holds the read', async () => {
    const owner = await perFactGatedOwner();
    const writer = await clientOf(owner.server.socketPath);
    const caller = await clientOf(owner.server.socketPath);
    const reader = await clientOf(owner.server.socketPath);
    const unrelated = writer.insertFact({ fact: 'w0', entity_slug: 'people/charlie-example' });
    unrelated.catch(() => undefined);
    await until(() => owner.running('w0'));
    let answered = false;
    const read = reader.listFactsByEntity(entity).then(rows => { answered = true; return rows; });
    read.catch(() => undefined);
    await until(() => owner.server.stats().queued === 1);
    // The write the read means to confirm arrives after it, starts, and its caller gives up.
    const controller = new AbortController();
    const lost = withRequestSignal(controller.signal, () => caller.insertFact(factOf('late'))).then(() => null, e => e as OperationError);
    await until(() => owner.running('late'));
    controller.abort();
    expect(await lost).toMatchObject({ code: 'owner_unavailable', reason: 'outcome_unknown' });
    await until(() => owner.aborted.has('late'));
    expect(owner.aborted.has('late')).toBe(true);
    await owner.release('w0');
    await unrelated;
    await Bun.sleep(100);
    expect(answered).toBe(false);
    await owner.release('late');
    expect(await read).toEqual([factOf('late')]);
  });

  // Value: protects=a read that waits only for capacity, with no earlier write running, reaches its deadline as a
  // retryable `timeout` / `not_started`, not `earlier_call_running`; fails_when=the deadline paths keep counting a
  // write admitted after the read; why_new=review finding F2 of the fair-hold plan; seam=none; no_claim=how long
  // capacity waits last
  test('a read queued only for capacity, behind a later write, times out not_started', async () => {
    const owner = await perFactGatedOwner({ permits: 2, slowEntity: 'people/slow-example' });
    const writer = await clientOf(owner.server.socketPath);
    const reader = await clientOf(owner.server.socketPath);
    const writes = [writer.insertFact(factOf('w0'))];
    await until(() => owner.running('w0'));
    const slow = reader.listFactsByEntity('people/slow-example');
    slow.catch(() => undefined);
    await until(() => owner.server.stats().queued === 1);
    const target = withReadDeadline(Date.now() + 400, () => reader.listFactsByEntity(entity)).then(() => null, e => e as OperationError);
    await until(() => owner.server.stats().queued === 2);
    writes.push(writer.insertFact(factOf('w1')));
    for (const p of writes) p.catch(() => undefined);
    await until(() => owner.running('w1'));
    expect(owner.server.stats()).toMatchObject({ active: 2, queued: 2 });
    // w0 ends: the slow read takes its permit, and the target waits for capacity while only w1 (admitted later) runs.
    await owner.release('w0');
    await until(() => owner.reads.includes('people/slow-example'));
    expect(owner.server.stats()).toMatchObject({ active: 2, queued: 1 });
    const error = await target;
    expect(error).toMatchObject({ code: 'timeout', reason: 'not_started', retryable: true });
    expect(owner.reads).not.toContain(entity);
    await owner.release('read:people/slow-example');
    await owner.release('w1');
    await Promise.all([slow, ...writes]);
    await until(() => owner.server.stats().active === 0);
    expect(owner.server.stats()).toMatchObject({ active: 0, queued: 0, inflightBytes: 0 });
  });
});

describe('which members an orphan holds back', () => {
  // Value: protects=the hold follows the confirming read each write names; fails_when=executeRaw (whose read is a
  // SELECT through executeRaw) holds nothing, or a write whose rerun repeats nothing holds anything; why_new=new;
  // seam=none; no_claim=key-level precision (the hold is by member)
  test('the confirming read members, the write itself for executeRaw, and nothing for a no-op rerun', () => {
    expect([...membersWaitingFor('insertFact')]).toEqual(['listFactsByEntity']);
    expect([...membersWaitingFor('insertTakeNudge')]).toEqual(['listTakeNudges']);
    expect([...membersWaitingFor('executeRaw')]).toEqual(['executeRaw']);
    expect([...membersWaitingFor('importFromContent')]).toEqual(['getPage']);
    expect([...membersWaitingFor('importManagedFiles')]).toEqual(['getPage']);
    expect([...membersWaitingFor('sweepSegments')]).toEqual([]);
    expect([...membersWaitingFor('lockPageKeys')]).toEqual([]);
  });
});
