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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { BrainEngine } from '../src/core/engine.ts';
import { attachShadowParts } from '../src/shadow/attach.ts';
import { encodeValue } from '../src/shadow/codec.ts';
import { runShadowChild, type ShadowChildDeps } from '../src/shadow/child.ts';
import { createWaiter } from '../src/shadow/child-checks.ts';
import { SHADOW_COMPARATOR_VERSION } from '../src/shadow/exactness.ts';
import { ensureEpoch, epochWatch } from '../src/shadow/evidence-epoch.ts';
import { appendRecall, readEpochRecall } from '../src/shadow/recall.ts';
import { buildEvidenceStatus } from '../src/shadow/evidence.ts';
import { MirrorQueue, newMirrorCounters, UsageMeter, zeroUsage } from '../src/shadow/mirror.ts';
import { appendUsage } from '../src/shadow/usage.ts';
import { evaluateReadiness } from '../src/core/engine-swap/readiness.ts';
import { writeSeedRecord, type SeedRecord } from '../src/shadow/seed.ts';
import { wrapShadowEngine, type ShadowSink } from '../src/shadow/wrapper.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gbrain-shadow-evidence-')); dirs.push(d); return d; };
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const SEED = { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as unknown as SeedRecord;
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
    const all = readdirSync(join(dir, 'ledger')).sort().flatMap((n) => readFileSync(join(dir, 'ledger', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
    // An unresolved row is written before its rerun starts and is settled by a completion row with the same sample id (evidence.ts).
    const done = new Set(all.filter((r) => r.sid && r.rerun !== 'pending').map((r) => r.sid));
    return all.filter((r) => !(r.rerun === 'pending' && done.has(r.sid)));
  } catch { return []; }
};
const faults = (dir: string): Array<Record<string, unknown>> => {
  try { return readFileSync(join(dir, 'faults.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const manifest = (dir: string): { epoch_id: string; started_at: string; inputs: Record<string, unknown>; build?: unknown } => JSON.parse(readFileSync(join(dir, 'evidence', 'epoch.json'), 'utf8'));
const SAMPLE_NONE = { version: 1, enabled: true, started_at: 'x', sample_rate: 0, queue_bound: 4, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' };
const writeManifest = (dir: string, id: string): void => {
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'evidence', 'epoch.json'), JSON.stringify({ version: 1, epoch_id: id, started_at: '2026-11-23T00:00:00.000Z', inputs: { seed_id: 's' } }));
};
const usageLines = (dir: string): Array<{ epoch_id: string | null; ops: Record<string, Record<string, number>> }> =>
  readdirSync(join(dir, 'usage')).sort().flatMap((n) => readFileSync(join(dir, 'usage', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
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
    expect(q.meter.take()).toEqual([{ epoch_id: null, ops: {
      getPage: { offered: 5, sampled_out: 2, shed: 1, skipped_in_transaction: 0, unmirrorable: 1 },
      listPages: { offered: 1, sampled_out: 0, shed: 0, skipped_in_transaction: 1, unmirrorable: 0 },
    } }]);
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

  test('a process whose calls were all sampled out appends its counts, under the epoch current when they were noted, when its engine disconnects', async () => {
    const dir = tmp(); // unseeded, so attach builds no follower; the epoch manifest is written by hand
    writeManifest(dir, 'e1');
    const engine = fakePrimary();
    const attached = attachShadowParts(engine, dir, SAMPLE_NONE as never, { gbrainArgv: ['never-spawned'] });
    await attached.engine.getPage('a');
    await attached.engine.listPages();
    for (const hook of (engine as unknown as { hooks: Array<() => Promise<void>> }).hooks) await hook();
    const lines = usageLines(dir);
    expect(lines.every((l) => l.epoch_id === 'e1')).toBe(true);
    const total = (op: string) => lines.reduce((n, l) => n + (l.ops[op]?.sampled_out ?? 0), 0);
    expect([total('getPage'), total('listPages')]).toEqual([1, 1]);
    expect(attached.supervisor.childPid).toBeNull(); // nothing was sent, so no child was spawned for the counts
  });

  test('the first call of a class is on disk before any flush: a used, sampled-out class reaches readiness after an abrupt exit', async () => {
    const dir = tmp();
    writeManifest(dir, 'e1');
    const attached = attachShadowParts(fakePrimary(), dir, SAMPLE_NONE as never, { gbrainArgv: ['never-spawned'] });
    await attached.engine.getPage('a'); // no flush, no disconnect: the process "dies" here
    await attached.engine.getPage('b');
    expect(usageLines(dir).map((l) => Object.keys(l.ops))).toEqual([['getPage']]); // one small append, not one per call
    const evidence = buildEvidenceStatus({ dir });
    expect(evidence.reads!.ops).toEqual([{ op: 'getPage', successful: 0, minimum: 100 }]);
    const verdict = evaluateReadiness({ epoch_id: 'e1', epoch_started_at: '2026-11-23T00:00:00.000Z', ...evidence }, new Date('2026-12-30T00:00:00Z'));
    expect(verdict.criteria.find((c) => c.n === 2)).toMatchObject({ state: 'fail' });
    expect(verdict.criteria.find((c) => c.n === 2)!.detail).toContain('getPage 0/100');
  });

  test('an epoch rotation is seen: the next first call of a class registers under the new epoch and counts stay with the epoch they were noted in', () => {
    const dir = tmp();
    let at = 0;
    writeManifest(dir, 'e1');
    const meter = new UsageMeter();
    // pregate-literal: SHADOW_ADAPTER_VERSION=11 the 11 on the next line is the month of a fixed timestamp, not the adapter version
    meter.bind({ epoch: epochWatch(dir, () => at, 1_000), register: (epoch_id, op) => appendUsage(dir, { ts: '2026-11-23T00:00:00.000Z', epoch_id, ops: { [op]: zeroUsage() } }) });
    meter.note('getPage', 'offered');
    meter.note('getPage', 'offered'); // the same class again: not registered twice
    writeManifest(dir, 'e2');
    at = 500;
    meter.note('getPage', 'offered'); // inside the 1 s window the process still sees e1
    at = 1_500;
    meter.note('getPage', 'offered'); // now e2: a new first use
    expect(usageLines(dir).map((l) => l.epoch_id)).toEqual(['e1', 'e2']);
    expect(meter.take()).toEqual([
      { epoch_id: 'e1', ops: { getPage: { ...zeroUsage(), offered: 3 } } }, { epoch_id: 'e2', ops: { getPage: { ...zeroUsage(), offered: 1 } } },
    ]);
  });

  test('a failed first-use append loses nothing: the counts stay for the next flush', () => {
    const meter = new UsageMeter();
    meter.bind({ epoch: () => 'e1', register: () => { throw new Error('disk full'); } });
    meter.note('getPage', 'offered');
    expect(meter.take()).toEqual([{ epoch_id: 'e1', ops: { getPage: { ...zeroUsage(), offered: 1 } } }]);
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
    // One UTC day: rows go to one file per day, and the order of files in a directory listing is not a contract.
    const committedAt = Date.parse('2026-11-23T00:00:10Z');
    input.write(JSON.stringify({ t: 'apply', seq: 1, committed_at: committedAt, relation: 'pages', generation: 1, keys: [], rows: [], digests: [] }) + '\n');
    const later = Date.parse('2026-11-23T00:00:20Z');
    input.write(read('findByTitleFuzzy', ['t'], rows(['a', 'b']), later));
    input.write(read('searchKeyword', ['q'], rows(['a', 'b']), later));
    input.write(read('searchTitles', ['q'], rows(['a', 'b']), later)); // a different row set
    input.write(read('getPage', ['x'], { slug: 'x' }, Date.parse('2026-11-23T00:00:05Z'))); // captured BEFORE the pending write was committed
    await reached;
    for (let i = 0; i < 5; i++) await tick();
    release();
    input.end();
    await done;
    expect(ledgerRows(dir).map((r) => [r.op, r.outcome, r.mismatch])).toEqual([
      ['findByTitleFuzzy', 'stale', 'order_diff'], ['searchKeyword', 'stale', 'order_diff'], ['searchTitles', 'stale', 'diff'], ['getPage', 'inconclusive', 'diff'],
    ]);
  });

  test('rows of different UTC days go to separate day files, each in arrival order: a listing of the directory orders nothing', async () => {
    const dir = seeded();
    const day = (iso: string) => Date.parse(iso);
    await runChild(dir, [read('getPage', ['a'], { slug: 'x' }, day('2026-11-23T00:00:30Z')), read('getTags', ['a'], ['x'], day('2026-11-22T23:59:30Z')), read('getPage', ['b'], { slug: 'x' }, day('2026-11-23T00:00:40Z'))], {
      openEngine: () => engineOf({ getPage: async () => ({ slug: 'a' }), getTags: async () => ['x'] }) as never,
    });
    const files = readdirSync(join(dir, 'ledger')).sort();
    expect(files).toEqual(['2026-11-22.jsonl', '2026-11-23.jsonl']);
    const ops = (f: string) => readFileSync(join(dir, 'ledger', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.rerun !== 'pending').map((r) => `${r.op}:${r.ts.slice(11, 19)}`); // the unresolved rows are settled by these completion rows
    expect(ops(files[0]!)).toEqual(['getTags:23:59:30']);
    expect(ops(files[1]!)).toEqual(['getPage:00:00:30', 'getPage:00:00:40']); // arrival order within a day
  });

  test('the same order-only trigram difference with no lag is inconclusive, never a match', async () => {
    const dir = seeded();
    await runChild(dir, [read('findByTitleFuzzy', ['t'], rows(['a', 'b']))], { openEngine: () => engineOf({ findByTitleFuzzy: async () => rows(['b', 'a']) }) as never });
    expect(ledgerRows(dir).map((r) => [r.outcome, r.mismatch])).toEqual([['inconclusive', 'order_diff']]);
  });
});

describe('collation_order', () => {
  const engineOf = (over: Record<string, unknown>) => ({ async connect() {}, async disconnect() {}, ...over });
  const page = (slug: string) => ({ slug, source_id: 'default' });
  const outcomes = async (calls: Array<{ op: string; args: unknown[]; primary: unknown; rust: unknown }>) => {
    const dir = seeded();
    await runChild(dir, calls.map((c) => read(c.op, c.args, c.primary)), {
      openEngine: () => engineOf(Object.fromEntries(calls.map((c) => [c.op, async () => c.rust]))) as never,
    });
    return ledgerRows(dir).map((r) => [r.op, r.outcome, r.mismatch]);
  };

  test('same rows in the order the primary\'s rows have in C byte order are collation_order, not a divergence', async () => {
    // A Postgres host with an ICU or glibc collation answers alpha, Beta, Zeta; Rust follows PGLite's C order.
    expect(await outcomes([{ op: 'getTags', args: ['p'], primary: ['alpha', 'Beta', 'Zeta'], rust: ['Beta', 'Zeta', 'alpha'] }]))
      .toEqual([['getTags', 'collation_order', 'diff']]);
    expect(await outcomes([{ op: 'listPages', args: [{ sort: 'slug' }], primary: [page('ab'), page('a-c')], rust: [page('a-c'), page('ab')] }]))
      .toEqual([['listPages', 'collation_order', 'diff']]);
  });

  test('anything else stays inconclusive: Rust in neither order, different rows, no text sort, or an operation not ordered by text', async () => {
    expect(await outcomes([
      { op: 'getTags', args: ['p'], primary: ['alpha', 'Beta', 'Zeta'], rust: ['Zeta', 'Beta', 'alpha'] }, // not C order
      { op: 'getTags', args: ['p'], primary: ['alpha', 'Beta'], rust: ['Beta', 'Zeta'] }, // different rows
      { op: 'listPages', args: [{ sort: 'updated_desc' }], primary: [page('ab'), page('a-c')], rust: [page('a-c'), page('ab')] },
      { op: 'listPages', args: [], primary: [page('ab'), page('a-c')], rust: [page('a-c'), page('ab')] },
      { op: 'getLinks', args: ['p'], primary: [{ to_slug: 'b' }, { to_slug: 'a' }], rust: [{ to_slug: 'a' }, { to_slug: 'b' }] },
    ])).toEqual([
      ['getTags', 'inconclusive', 'diff'], ['getTags', 'inconclusive', 'diff'], ['listPages', 'inconclusive', 'diff'], ['listPages', 'inconclusive', 'diff'], ['getLinks', 'inconclusive', 'diff'],
    ]);
  });

  test('an order that already matches is a match', async () => {
    expect(await outcomes([{ op: 'getTags', args: ['p'], primary: ['Beta', 'alpha'], rust: ['Beta', 'alpha'] }])).toEqual([['getTags', 'match', undefined]]);
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
    // pregate-literal: SHADOW_COMPARATOR_VERSION=1 the 1 on this line is the end of the seed id and of the policy hash, not a comparator version
    expect(second.inputs).toMatchObject({ seed_id: 'seed-1', rust_addon_sha256: 'b'.repeat(64), comparator_version: SHADOW_COMPARATOR_VERSION, readiness_policy_hash: 'p1' });
    expect(ledgerRows(dir).map((r) => r.epoch_id)).toEqual([first.epoch_id, first.epoch_id, second.epoch_id]);
    expect(JSON.parse(readFileSync(join(dir, 'evidence', 'epochs.jsonl'), 'utf8').trim()).epoch_id).toBe(first.epoch_id);
  });

  test('records an epoch of comparator version 2 collected stay out of the epoch the current comparator opens: their recall and clearance do not count', async () => {
    expect(SHADOW_COMPARATOR_VERSION).toBeGreaterThanOrEqual(3); // the privacy, rerun and recall rules changed what a record means
    const engine = () => ({ async connect() {}, async disconnect() {}, getPage: async () => ({ slug: 'a' }) }) as never;
    const probe = seeded();
    await runChild(probe, [], { openEngine: engine });
    const inputs = manifest(probe).inputs; // what this child's epoch is made of, but for the comparator
    const dir = seeded();
    // pregate-literal: SHADOW_ADAPTER_VERSION=11 the 11 on the next line is the month of a fixed date, not the adapter version
    const old = ensureEpoch(dir, { ...inputs, comparator_version: 2 } as never, Date.parse('2026-11-24T00:00:00Z'));
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 ref_size 10 is the top-ten recall size, not the adapter version
    for (let i = 0; i < 30; i++) appendRecall(dir, { ts: new Date().toISOString(), epoch_id: old.epoch_id, vector: 1, primary: 1, overlap: 1, ref_size: 10 }); // thirty perfect scores of the old rule
    await runChild(dir, [], { openEngine: engine }); // the shadow restarts on the new build
    const now = manifest(dir);
    expect(now.epoch_id).not.toBe(old.epoch_id);
    expect(now.inputs.comparator_version).toBe(SHADOW_COMPARATOR_VERSION);
    expect(readEpochRecall(dir, now.epoch_id)).toEqual([]); // none of them counts in the new epoch
    expect(readEpochRecall(dir, old.epoch_id)).toHaveLength(30); // and they are still on disk, as the first epoch's
    expect(buildEvidenceStatus({ dir }).evidence?.recall_samples ?? 0).toBe(0);
  });

  test('the build (commit, version, addon target) is recorded when the epoch starts and survives a TS update that changes nothing relevant', async () => {
    const dir = seeded();
    const engine = () => ({ async connect() {}, async disconnect() {}, getPage: async () => ({ slug: 'a' }) }) as never;
    const build = (commit: string | null) => () => ({ gbrain_commit: commit, gbrain_version: '9.9.9', addon_target: 'linux-x64-glibc' });
    await runChild(dir, [], { openEngine: engine, build: build('c'.repeat(40)) });
    const first = manifest(dir);
    expect(first.build).toEqual({ gbrain_commit: 'c'.repeat(40), gbrain_version: '9.9.9', addon_target: 'linux-x64-glibc' });
    await runChild(dir, [], { openEngine: engine, build: build('d'.repeat(40)) }); // a new gbrain commit, same relevant inputs
    expect(manifest(dir)).toEqual(first);
    await runChild(dir, [], { openEngine: engine, build: build('e'.repeat(40)), addonSha256: () => 'b'.repeat(64) }); // a new epoch records the build it started with
    expect(manifest(dir).build).toMatchObject({ gbrain_commit: 'e'.repeat(40) });
  });

  test('without an injected build the child records this gbrain\'s version and this machine\'s addon target; an unstamped source run has no commit', async () => {
    const dir = seeded();
    await runChild(dir, [], { openEngine: () => ({ async connect() {}, async disconnect() {} }) as never });
    const { VERSION } = await import('../src/version.ts');
    const { detectAddonTarget } = await import('../src/core/rust-engine/addon-target.ts');
    expect(manifest(dir).build).toEqual({ gbrain_commit: null, gbrain_version: VERSION, addon_target: detectAddonTarget() });
  });

  test('the readiness policy hash defaults to policyHash(READINESS_POLICY) from engine-swap/policy.ts', async () => {
    const dir = seeded();
    await runChild(dir, [], { openEngine: () => ({ async connect() {}, async disconnect() {} }) as never, readinessPolicyHash: undefined });
    const { policyHash, READINESS_POLICY } = await import('../src/core/engine-swap/policy.ts');
    expect(manifest(dir).inputs.readiness_policy_hash).toBe(policyHash(READINESS_POLICY));
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

describe('owner identity, timeouts, adapter and follower evidence', () => {
  const engineOf = (over: Record<string, unknown>) => ({ async connect() {}, async disconnect() {}, ...over });

  test('a client of another process\'s owner cannot name an epoch: its rows carry none, and a takeover opens the epoch for its own addon', async () => {
    const dir = seeded();
    const eng = { ownerRole: 'client', async connect() {}, async disconnect() {}, getPage: async () => ({ slug: 'a' }) };
    const input = new PassThrough();
    const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, openEngine: () => eng as never });
    input.write(read('getPage', ['a'], { slug: 'a' }));
    for (let i = 0; i < 6; i++) await tick();
    expect(existsSync(join(dir, 'evidence', 'epoch.json'))).toBe(false); // the owner's addon is unknown: no epoch is opened for this child's
    eng.ownerRole = 'owner'; // the owner went away and this child took over the store
    input.write(read('getPage', ['b'], { slug: 'b' }));
    input.end();
    await done;
    const rows = ledgerRows(dir);
    expect(rows.map((r) => r.epoch_id)).toEqual([undefined, manifest(dir).epoch_id]);
    expect(manifest(dir).inputs.rust_addon_sha256).toBe('a'.repeat(64));
  });

  test('an internal_error that rejects after the read timeout is recorded once, under the epoch', async () => {
    const dir = seeded();
    const input = new PassThrough();
    const done = runShadowChild(dir, {
      input, writeControl: () => {}, ...BASE, timeoutMs: 20,
      openEngine: () => engineOf({ getPage: () => new Promise((_, reject) => setTimeout(() => reject(internal()), 80)) }) as never,
    });
    input.write(read('getPage', ['a'], { slug: 'a' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    input.end();
    await done;
    expect(ledgerRows(dir).map((r) => r.outcome)).toEqual(['timeout']);
    const found = faults(dir).filter((f) => f.kind === 'rust_internal_error');
    expect(found.map((f) => [f.detail, f.epoch_id])).toEqual([['boundary=read code=internal_error', manifest(dir).epoch_id]]);
  });

  test('a change of the TS adapter version, everything else equal, opens a new epoch', async () => {
    const dir = seeded();
    const open = { openEngine: () => engineOf({}) as never };
    await runChild(dir, [], { ...open, adapterVersion: 1 });
    const first = manifest(dir);
    expect(first.inputs.adapter_version).toBe('adapter1.abi1.catalog3');
    await runChild(dir, [], { ...open, adapterVersion: 1 });
    expect(manifest(dir).epoch_id).toBe(first.epoch_id);
    await runChild(dir, [], { ...open, adapterVersion: 2 });
    expect(manifest(dir).epoch_id).not.toBe(first.epoch_id);
    expect(manifest(dir).inputs).toMatchObject({ ...first.inputs, adapter_version: 'adapter2.abi1.catalog3' });
  });

  test('the follower\'s probe, fingerprint totals, allocators and lag start over under a new epoch and survive a restart in the same one', async () => {
    const dir = seeded();
    const stale = {
      version: 1, epoch_id: 'seed-1', seed_id: 'seed-1', evidence_epoch: 'an-older-epoch', epoch_started_at: 't', updated_at: new Date().toISOString(), applied_rows: 9, queue_depth: 0, lag_ms: 0, last_seq: 1,
      watermark: { valid: true, through: null, invalidated_reason: null }, lag: { epoch: [3], hours: { '1': [3] } }, fingerprints: { checked_rows: 50, mismatches: 0 },
      probe: { state: 'pass', checked_at: 't', server_version: '16', collation: 'C', mismatches: 0 }, allocators: { verified: true, checked_at: 't' },
    };
    writeFileSync(join(dir, 'follower.json'), JSON.stringify(stale));
    const follower = () => JSON.parse(readFileSync(join(dir, 'follower.json'), 'utf8'));
    await runChild(dir, [], { openEngine: () => engineOf({}) as never });
    expect(follower()).toMatchObject({
      evidence_epoch: manifest(dir).epoch_id, applied_rows: 9, lag: { epoch: [], hours: {} }, fingerprints: { checked_rows: 0, mismatches: 0 },
      probe: { state: 'not_run' }, allocators: { verified: false },
    });
    writeFileSync(join(dir, 'follower.json'), JSON.stringify({ ...follower(), probe: { ...stale.probe }, fingerprints: { checked_rows: 7, mismatches: 0 } }));
    await runChild(dir, [], { openEngine: () => engineOf({}) as never }); // the same epoch
    expect(follower()).toMatchObject({ probe: { state: 'pass' }, fingerprints: { checked_rows: 7 } });
    await runChild(dir, [], { openEngine: () => engineOf({}) as never, addonSha256: () => 'c'.repeat(64) }); // a new epoch
    expect(follower()).toMatchObject({ probe: { state: 'not_run' }, fingerprints: { checked_rows: 0 } });
  });
});

describe('a rerun waiting for a quiet window', () => {
  test('the end of input cuts the wait short: the sample ends as skipped (child_closing), not after the full wait', async () => {
    const dir = seeded();
    const input = new PassThrough();
    let asked = 0;
    const done = runShadowChild(dir, { input, writeControl: (l) => {
      const m = JSON.parse(l) as { t?: string; id?: number; session?: string; kind?: string };
      if (m.t === 'ask' && m.kind === 'rerun' && ++asked === 1) input.write(JSON.stringify({ t: 'answer', id: m.id, session: m.session ?? '', ok: false, error: { code: 'moved' } }) + '\n'); // the position moved: the next run waits 0.5 s
    }, ...BASE, random: () => 0.5, openEngine: () => ({ async connect() {}, async disconnect() {}, async getPage() { return { slug: 'other' }; } }) as never });
    const started = Date.now();
    input.write(read('getPage', ['a'], { slug: 'a' }));
    while (asked < 1) await tick();
    await new Promise((r) => setTimeout(r, 100)); // now inside the wait
    input.end();
    await done;
    expect(Date.now() - started).toBeLessThan(450); // the full wait is 500 ms
    expect(ledgerRows(dir).at(-1)).toMatchObject({ op: 'getPage', rerun: 'skipped:child_closing' });
  });
});

describe('a rerun wait that starts after the end of input', () => {
  test('a privacy answer that says moved, followed at once by the end of input: shutdown does not wait for the back-off', async () => {
    const dir = seeded();
    const input = new PassThrough();
    let asked = 0;
    const page = { page_id: 1, source_id: 's', slug: 'a' };
    const line = JSON.stringify({ t: 'read', id: 1, sid: 's1', at: Date.parse('2026-11-23T00:00:00Z'), op: 'listPages', primary_ms: 2, args: encodeValue([{ excludePrivate: true }]), result: encodeValue([page]) }) + '\n';
    const done = runShadowChild(dir, { input, writeControl: (l) => {
      const m = JSON.parse(l) as { t?: string; id?: number; session?: string; kind?: string };
      if (m.t === 'ask' && m.kind === 'privacy' && ++asked === 1) {
        input.write(JSON.stringify({ t: 'answer', id: m.id, session: m.session ?? '', ok: true, value: { verdict: 'privacy_check_moved', complete: false } }) + '\n'); // the position moved: the rerun would wait 0.5 s first
        input.end(); // and the input ends in the same breath, before that wait can start
      }
    }, ...BASE, random: () => 0.5, openEngine: () => ({ async connect() {}, async disconnect() {}, async listPages() { return [page, { page_id: 2, source_id: 's', slug: 'extra' }]; } }) as never });
    const started = Date.now();
    input.write(line);
    await done;
    expect(asked).toBe(1); // the privacy question was asked, so the wait is the one that follows its moved answer
    expect(Date.now() - started).toBeLessThan(450); // the full wait is 500 ms
    expect(ledgerRows(dir).at(-1)).toMatchObject({ op: 'listPages', reason: 'privacy_check_moved', rerun: expect.stringMatching(/^skipped:/) });
  });
});

describe('the rerun waiter', () => {
  test('a pause asked for after close() returns at once and starts no timer', async () => {
    const waiter = createWaiter();
    waiter.close();
    const started = Date.now();
    await waiter.pause(5_000);
    expect(Date.now() - started).toBeLessThan(100);
    expect(waiter.closed()).toBe(true);
  });
});
