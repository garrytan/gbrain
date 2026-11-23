/**
 * Shadow evidence producers, the capture side (plan a1): what the wrapper counts per operation, what the child writes
 * into the ledger and the fault history, and the epoch it binds them to. Fake engines and stores, no Rust addon.
 *
 * Protects: a used class that was only ever sampled out, shed or run in a transaction still shows up with its counts;
 * a mismatch on an exactness comparison is `stale` only with follower-lag evidence and `inconclusive` otherwise, and keeps the
 * original mismatch; a panic (`internal_error`) in open, read, apply, fingerprint or reconcile work is recorded whatever the read
 * ledger holds, once per failure; a changed epoch input starts a new epoch and the old child's rows stay with the old one.
 * Reads the files raw so it does not depend on the aggregator (test/shadow-evidence.test.ts covers that).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { BrainEngine } from '../src/core/engine.ts';
import { attachShadowParts } from '../src/shadow/attach.ts';
import { encodeValue } from '../src/shadow/codec.ts';
import { runShadowChild, type ShadowChildDeps } from '../src/shadow/child.ts';
import { MirrorQueue, newMirrorCounters } from '../src/shadow/mirror.ts';
import { writeSeedRecord, type SeedRecord } from '../src/shadow/seed.ts';
import { wrapShadowEngine, type ShadowSink } from '../src/shadow/wrapper.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gbrain-shadow-evidence-')); dirs.push(d); return d; };
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const SEED = { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {} } as unknown as SeedRecord;
const RESULT = { upserted: 1, deleted: 0, skipped_older: 0, displaced: 0, dropped: 0, unmapped_columns: [], losses: {} };
const internal = (): Error => Object.assign(new Error('worker panicked'), { code: 'internal_error' });
const ADDON = async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1', catalogVersion: 3 } as never });
const BASE: Partial<ShadowChildDeps> = { loadAddon: ADDON, addonSha256: () => 'a'.repeat(64), capabilities: () => ['search', 'pages'], readinessPolicyHash: () => 'p1', heartbeatMs: 60_000, childId: 'c1' };

const read = (op: string, args: unknown[], result: unknown, at = Date.parse('2026-11-23T00:00:00Z')) =>
  JSON.stringify({ t: 'read', id: 1, at, op, primary_ms: 2, args: encodeValue(args), result: encodeValue(result) }) + '\n';

async function runChild(dir: string, lines: string[], deps: Partial<ShadowChildDeps>): Promise<void> {
  const input = new PassThrough();
  const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, ...deps });
  for (const l of lines) input.write(l);
  input.end();
  await done;
}

const ledgerRows = (dir: string): Array<Record<string, unknown>> => {
  try {
    return readdirSync(join(dir, 'ledger')).flatMap((n) => readFileSync(join(dir, 'ledger', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  } catch { return []; }
};
const faults = (dir: string): Array<Record<string, unknown>> => {
  try { return readFileSync(join(dir, 'faults.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const manifest = (dir: string): { epoch_id: string; started_at: string; inputs: Record<string, unknown> } => JSON.parse(readFileSync(join(dir, 'evidence', 'epoch.json'), 'utf8'));
const seeded = (): string => { const d = tmp(); writeSeedRecord(d, SEED); return d; };

function fakePrimary(): BrainEngine {
  const engine = {
    kind: 'pglite',
    async getPage(slug: string) { return { slug }; },
    async listPages() { return []; },
    async transaction<T>(fn: (tx: BrainEngine) => Promise<T>) { return fn(engine as unknown as BrainEngine); },
    registerBeforeDisconnect(fn: () => Promise<void>) { (engine as { hooks?: Array<() => Promise<void>> }).hooks = [...((engine as { hooks?: Array<() => Promise<void>> }).hooks ?? []), fn]; return () => {}; },
  };
  return engine as unknown as BrainEngine;
}

describe('per-operation usage', () => {
  test('a class whose every call was sampled out, in a transaction, unmirrorable or shed is still counted', async () => {
    const q = new MirrorQueue({ bound: 1, transport: { send: () => true }, schedule: () => {} }); // never drains: the second offer is shed
    const sink: ShadowSink = { counters: q.counters, offer: (c, op) => q.offer(c, op), use: (op, f) => q.meter.note(op, f), active: () => true };
    const out = wrapShadowEngine(fakePrimary(), sink, { sampleRate: 0 });
    await out.getPage('a');
    await out.getPage('b');
    await out.transaction(async (tx) => { await tx.listPages(); });
    const full = wrapShadowEngine(fakePrimary(), sink, { sampleRate: 1 });
    await full.getPage('a'); // accepted
    await full.getPage('b'); // queue full: shed
    await (full as unknown as { getPage(...a: unknown[]): Promise<unknown> }).getPage('c', { cb: () => 1 }); // a callback cannot cross the pipe
    expect(q.meter.take()).toEqual({
      getPage: { offered: 5, sampled_out: 2, shed: 1, skipped_in_transaction: 0, unmirrorable: 1 },
      listPages: { offered: 1, sampled_out: 0, shed: 0, skipped_in_transaction: 1, unmirrorable: 0 },
    });
    expect(q.meter.take()).toBeNull();
  });

  test('a wrapper with no usage meter still works, and an inactive sink counts nothing', async () => {
    const calls: string[] = [];
    const sink: ShadowSink = { counters: newMirrorCounters(), offer: () => {}, use: (op) => { calls.push(op); }, active: () => false };
    await wrapShadowEngine(fakePrimary(), sink, { sampleRate: 1 }).getPage('a');
    expect(calls).toEqual([]);
    const bare: ShadowSink = { counters: newMirrorCounters(), offer: () => {}, active: () => true };
    expect(await wrapShadowEngine(fakePrimary(), bare, { sampleRate: 0 }).getPage('a')).toEqual({ slug: 'a' } as never);
  });

  test('a process whose calls were all sampled out appends its counts, tagged with the current epoch, when its engine disconnects', async () => {
    const dir = tmp(); // unseeded, so attach builds no follower; the epoch manifest is written by hand
    mkdirSync(join(dir, 'evidence'));
    writeFileSync(join(dir, 'evidence', 'epoch.json'), JSON.stringify({ version: 1, epoch_id: 'e1', started_at: '2026-11-23T00:00:00.000Z', inputs: { seed_id: 's' } }));
    const engine = fakePrimary();
    const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 0, queue_bound: 4, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' };
    const attached = attachShadowParts(engine, dir, state as never, { gbrainArgv: ['never-spawned'] });
    await attached.engine.getPage('a');
    await attached.engine.listPages();
    for (const hook of (engine as unknown as { hooks: Array<() => Promise<void>> }).hooks) await hook();
    const files = readdirSync(join(dir, 'usage'));
    expect(files).toHaveLength(1);
    const line = JSON.parse(readFileSync(join(dir, 'usage', files[0]!), 'utf8').trim());
    expect(line.epoch_id).toBe('e1');
    expect(line.ops).toEqual({
      getPage: { offered: 1, sampled_out: 1, shed: 0, skipped_in_transaction: 0, unmirrorable: 0 },
      listPages: { offered: 1, sampled_out: 1, shed: 0, skipped_in_transaction: 0, unmirrorable: 0 },
    });
    expect(attached.supervisor.childPid).toBeNull(); // nothing was sent, so no child was spawned for the counts
  });
});

describe('stale and inconclusive mismatches', () => {
  const rows = (a: string[]) => a.map((slug) => ({ slug }));
  const engineOf = (over: Record<string, unknown>) => ({ async connect() {}, async disconnect() {}, ...over });

  test('an exact read that differs with no lag evidence is inconclusive and keeps its mismatch; a vector order difference is untouched', async () => {
    const dir = seeded();
    await runChild(dir, [
      read('getPage', ['a'], { slug: 'a' }), read('searchVector', [[1]], rows(['x', 'y'])), read('getPage', ['b'], { slug: 'b' }),
    ], { openEngine: () => engineOf({ getPage: async (s: string) => (s === 'a' ? { slug: 'other' } : { slug: 'b' }), searchVector: async () => rows(['y', 'x']) }) as never });
    const got = ledgerRows(dir);
    expect(got.map((r) => [r.op, r.outcome, r.mismatch])).toEqual([['getPage', 'inconclusive', 'diff'], ['searchVector', 'order_diff', undefined], ['getPage', 'match', undefined]]);
    expect(new Set(got.map((r) => r.epoch_id))).toEqual(new Set([manifest(dir).epoch_id]));
  });

  test('a mismatch while the follower holds older committed, unapplied work is stale; an order-only trigram or ts_rank difference goes the same way', async () => {
    const dir = seeded();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let seen = 0;
    let called!: () => void;
    const reached = new Promise<void>((resolve) => { called = resolve; });
    const answer = (list: string[]) => async () => { if (++seen === 4) called(); return rows(list); };
    const input = new PassThrough();
    const done = runShadowChild(dir, {
      input, writeControl: () => {}, ...BASE,
      openEngine: () => engineOf({
        storeFor: async () => ({ replaceRelationRows: async () => { await gate; return RESULT; } }),
        findByTitleFuzzy: answer(['b', 'a']), searchKeyword: answer(['b', 'a']), searchTitles: answer(['a']), getPage: answer([]),
      }) as never,
    });
    const committedAt = Date.parse('2026-11-22T23:59:00Z');
    input.write(JSON.stringify({ t: 'apply', seq: 1, committed_at: committedAt, relation: 'pages', generation: 1, keys: [], rows: [], digests: [] }) + '\n');
    input.write(read('findByTitleFuzzy', ['t'], rows(['a', 'b'])));
    input.write(read('searchKeyword', ['q'], rows(['a', 'b'])));
    input.write(read('searchTitles', ['q'], rows(['a', 'b']))); // a different row set
    input.write(read('getPage', ['x'], { slug: 'x' }, Date.parse('2026-11-22T23:00:00Z'))); // captured BEFORE the pending write was committed
    await reached;
    for (let i = 0; i < 5; i++) await tick();
    release();
    input.end();
    await done;
    expect(ledgerRows(dir).map((r) => [r.op, r.outcome, r.mismatch])).toEqual([
      ['findByTitleFuzzy', 'stale', 'order_diff'], ['searchKeyword', 'stale', 'order_diff'], ['searchTitles', 'stale', 'diff'], ['getPage', 'inconclusive', 'diff'],
    ]);
  });

  test('the same order-only trigram difference with no lag is inconclusive, never a match', async () => {
    const dir = seeded();
    await runChild(dir, [read('findByTitleFuzzy', ['t'], rows(['a', 'b']))], { openEngine: () => engineOf({ findByTitleFuzzy: async () => rows(['b', 'a']) }) as never });
    expect(ledgerRows(dir).map((r) => [r.outcome, r.mismatch])).toEqual([['inconclusive', 'order_diff']]);
  });
});

describe('internal errors at every Rust boundary', () => {
  const engineOf = (over: Record<string, unknown>) => ({ async connect() {}, async disconnect() {}, ...over });
  const rpc = (id: number, method: string) => JSON.stringify({ t: 'rpc', id, method, args: { relation: 'pages' } }) + '\n';
  const apply = (seq: number, fp = false) => JSON.stringify({ t: 'apply', seq, committed_at: 1, relation: 'pages', generation: seq, keys: [], rows: [{ fact: 'x' }], digests: [], ...(fp ? { fp: [['a', 'b']] } : {}) }) + '\n';
  const internalFaults = (dir: string) => faults(dir).filter((f) => f.kind === 'rust_internal_error');

  test('a panic while applying, fingerprinting or in a reconcile call is recorded with no read row at all', async () => {
    const dir = seeded();
    const store = {
      replaceRelationRows: async (_s: string, _r: string, generation: number) => { if (generation === 1) throw internal(); return RESULT; },
      factFingerprints: async () => { throw internal(); },
      relationDigest: async () => { throw internal(); },
      replaceInterval: async () => { throw Object.assign(new Error('refused'), { code: 'invalid_state' }); },
      seedPlan: async () => ({}),
    };
    await runChild(dir, [apply(1), apply(2, true), rpc(1, 'relationDigest'), rpc(2, 'replaceInterval'), rpc(3, 'probe')], { openEngine: () => engineOf({ storeFor: async () => store }) as never });
    const found = internalFaults(dir).map((f) => String(f.detail));
    expect(found.sort()).toEqual(['boundary=apply code=internal_error', 'boundary=fingerprint code=internal_error', 'boundary=reconcile code=internal_error']);
    expect(internalFaults(dir).every((f) => f.epoch_id === manifest(dir).epoch_id)).toBe(true);
    expect(ledgerRows(dir)).toEqual([]); // nothing in the read ledger could have shown it
    expect(JSON.stringify(faults(dir))).not.toContain('worker panicked'); // the code and the boundary only
  });

  test('an open failure, a failed store hand-out and a failing read each record a fault; other error codes do not', async () => {
    const opened = seeded();
    await runChild(opened, [read('getPage', ['a'], null)], { openEngine: () => { throw internal(); } });
    expect(internalFaults(opened).map((f) => f.detail)).toEqual(['boundary=open code=internal_error']);
    expect(ledgerRows(opened).map((r) => [r.outcome, r.reason])).toEqual([['error', 'open_failed:internal_error']]);

    const handed = seeded();
    await runChild(handed, [apply(1)], { openEngine: () => engineOf({ storeFor: async () => { throw internal(); } }) as never });
    expect(internalFaults(handed).map((f) => f.detail)).toEqual(['boundary=open code=internal_error']);

    const reading = seeded();
    await runChild(reading, [read('getPage', ['a'], null), read('getPage', ['b'], null)], {
      openEngine: () => engineOf({ getPage: async (s: string) => { throw s === 'a' ? internal() : Object.assign(new Error('x'), { code: 'not_found' }); } }) as never,
    });
    expect(internalFaults(reading).map((f) => f.detail)).toEqual(['boundary=read code=internal_error']);
    expect(ledgerRows(reading).map((r) => r.outcome)).toEqual(['error', 'error']);
  });

  test('one failure seen on two paths counts once, and one broken boundary does not write a line per call', async () => {
    const same = internal();
    const engine = (errors: Error[]) => engineOf({ storeFor: async () => ({ replaceRelationRows: async (_s: string, _r: string, g: number) => { throw errors[g - 1]; } }) }) as never;
    const slow = seeded();
    let t = 5_000;
    await runChild(slow, [apply(1), apply(2), apply(3)], { now: () => (t += 2_000), openEngine: () => engine([same, same, internal()]) });
    expect(internalFaults(slow)).toHaveLength(2); // seq 1 and 2 are one failure; seq 3 is another, long after
    const fast = seeded();
    await runChild(fast, [apply(1), apply(2)], { now: () => 5_000, openEngine: () => engine([internal(), internal()]) });
    expect(internalFaults(fast)).toHaveLength(1); // two failures of one boundary in the same instant: one line
  });
});

describe('evidence epoch in the child', () => {
  test('rows and faults carry the epoch; a changed addon digest opens a new one and the first epoch\'s rows stay in the ledger', async () => {
    const dir = seeded();
    const engine = () => ({ async connect() {}, async disconnect() {}, getPage: async () => ({ slug: 'a' }) });
    await runChild(dir, [read('getPage', ['a'], { slug: 'a' })], { openEngine: () => engine() as never });
    const first = manifest(dir);
    await runChild(dir, [read('getPage', ['a'], { slug: 'a' })], { openEngine: () => engine() as never }); // same inputs: same epoch
    expect(manifest(dir)).toEqual(first);
    await runChild(dir, [read('getPage', ['a'], { slug: 'a' })], { openEngine: () => engine() as never, addonSha256: () => 'b'.repeat(64) });
    const second = manifest(dir);
    expect(second.epoch_id).not.toBe(first.epoch_id);
    expect(second.inputs).toMatchObject({ seed_id: 'seed-1', rust_addon_sha256: 'b'.repeat(64), comparator_version: 1, readiness_policy_hash: 'p1' });
    expect(ledgerRows(dir).map((r) => r.epoch_id)).toEqual([first.epoch_id, first.epoch_id, second.epoch_id]);
    expect(JSON.parse(readFileSync(join(dir, 'evidence', 'epochs.jsonl'), 'utf8').trim()).epoch_id).toBe(first.epoch_id);
  });

  test('an unseeded store has no epoch: its rows carry none', async () => {
    const dir = tmp();
    await runChild(dir, [read('getPage', ['a'], { slug: 'a' })], { openEngine: () => ({ async connect() {}, async disconnect() {}, getPage: async () => ({ slug: 'a' }) }) as never });
    expect(ledgerRows(dir).map((r) => r.epoch_id)).toEqual([undefined]);
    expect(() => manifest(dir)).toThrow();
  });

  test('an unavailable addon is recorded under an epoch of its own', async () => {
    const dir = seeded();
    mkdirSync(dir, { recursive: true });
    await runChild(dir, [read('getPage', ['a'], null)], { loadAddon: async () => ({ ok: false, code: 'rust_engine_addon_missing', reason: 'not_installed', message: 'm' }) });
    expect(manifest(dir).inputs).toMatchObject({ rust_addon_sha256: null, capability_set_hash: null });
    expect(ledgerRows(dir).map((r) => [r.outcome, r.epoch_id])).toEqual([['addon_unavailable', manifest(dir).epoch_id]]);
    writeFileSync(join(dir, 'unused'), '');
  });
});
