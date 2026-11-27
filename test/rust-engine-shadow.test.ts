/**
 * Rust engine shadow mode (docs/designs/RUST_ENGINE.md, Phase S: S1 and the read half of S2). Pure units: the
 * wrapper, the bounded queue, the codec, the classifier, the supervisor with an injected spawn, the child loop with
 * fake engines, the report and the doctor check. CLI, engine-factory and real-child coverage live in
 * rust-engine-shadow.serial.test.ts (they set GBRAIN_HOME).
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { BrainEngine } from '../src/core/engine.ts';
import { classifyError, classifyResult } from '../src/shadow/classify.ts';
import { CAPTURE_BUDGET_BYTES, CaptureTooLargeError, canonicalJson, decodeValue, encodeArgs, encodeValue } from '../src/shadow/codec.ts';
import { runShadowChild, SHADOW_CHILD_STALL_LIMIT } from '../src/shadow/child.ts';
import { appendFault, appendLedgerRows, readFaults, readShadowSummary, writeSummaryFile, type ShadowFault } from '../src/shadow/ledger.ts';
import { readShadowState, shadowBrainKey, SHADOW_STATE_VERSION, writeShadowState } from '../src/shadow/state.ts';
import { runBrainBench } from '../src/eval/brainbench/harness.ts';
import { TRUST_SUITES } from '../src/eval/brainbench/types.ts';
import { buildRunConfig, retrievalConfigHash } from '../src/eval/longmemeval/run-config.ts';
import { MirrorQueue, newMirrorCounters, type CapturedRead } from '../src/shadow/mirror.ts';
import { managedFilesystemDatastorePath, registerManagedFilesystemEngine } from '../src/core/persistence/filesystem-guard.ts';
import { SHADOW_READ_MEMBERS } from '../src/shadow/reads.ts';
import { buildProvisionalReport, renderProvisionalMarkdown } from '../src/shadow/report.ts';
import { closeAllOwedAtExit, sampleWeight, ShadowSupervisor } from '../src/shadow/supervisor.ts';
import { createWriteSampler } from '../src/shadow/write-capture.ts';
import { ensureEpoch } from '../src/shadow/evidence-epoch.ts';
import { buildFollowStatus } from '../src/shadow/follow-status.ts';
import { owedPath, readOwed, writeOwed, type OwedRecord } from '../src/shadow/write-compare.ts';
import { wrapShadowEngine, type ShadowSink } from '../src/shadow/wrapper.ts';
import { shadowChildArgv } from '../src/shadow/attach.ts';
import { parseBenchmarkEngineKind, createBenchmarkBrain, RustEngineAddonUnavailableError } from '../src/eval/longmemeval/harness.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

const tmp = (): string => mkdtempSync(join(tmpdir(), 'gbrain-shadow-unit-'));
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function sink(active = true): ShadowSink & { offered: CapturedRead[] } {
  const offered: CapturedRead[] = [];
  return { counters: newMirrorCounters(), offer: (capture) => { offered.push(capture()); }, active: () => active, offered };
}

function fakePrimary(): BrainEngine {
  const engine = {
    kind: 'pglite',
    async getPage(slug: string) { return { slug, title: 'T' }; },
    async searchKeyword(q: string) { return [{ slug: q, score: 1 }]; },
    async listPages() { throw Object.assign(new Error('boom'), { code: 'x' }); },
    async putPage() { return { ok: true }; },
    async transaction<T>(fn: (tx: BrainEngine) => Promise<T>) { return fn(engine as unknown as BrainEngine); },
    registerBeforeDisconnect() { return () => {}; },
  };
  return engine as unknown as BrainEngine;
}

describe('wrapper', () => {
  test('mirrors an allowlisted read after the primary answers and returns the same value', async () => {
    const s = sink();
    const engine = wrapShadowEngine(fakePrimary(), s, { sampleRate: 1 });
    const page = await engine.getPage('a');
    expect(page).toEqual({ slug: 'a', title: 'T' } as never);
    expect(s.offered).toHaveLength(1);
    expect(s.offered[0].op).toBe('getPage');
    expect(s.offered[0].args).toEqual(['a']);
    expect(s.offered[0].result).toEqual(encodeValue(page));
    expect(s.offered[0].result).not.toBe(page);
  });

  test('a caller that changes the result right after the call does not change what the shadow compares', async () => {
    const lines: string[] = [];
    const q = new MirrorQueue({ bound: 8, transport: { send: (l) => { lines.push(l); return true; } } });
    const engine = wrapShadowEngine(fakePrimary(), { counters: q.counters, offer: (c) => q.offer(c), active: () => true }, { sampleRate: 1 });
    const page = await engine.getPage('a') as unknown as Record<string, unknown>;
    page.title = 'changed by caller';
    page.extra = 'added by caller';
    delete page.slug;
    const opts: Record<string, unknown> = { limit: 5 };
    const pending = engine.searchKeyword('q', opts as never) as unknown as Promise<Array<Record<string, unknown>>>;
    opts.limit = 99;
    const rows = await pending;
    rows[0].score = 0;
    rows.push({ slug: 'pushed', score: 9 });
    await tick();
    const [getLine, searchLine] = lines.map((l) => JSON.parse(l));
    expect(getLine).toMatchObject({ t: 'read', op: 'getPage', args: ['a'], result: { slug: 'a', title: 'T' } });
    expect(getLine.result.extra).toBeUndefined();
    expect(searchLine).toMatchObject({ op: 'searchKeyword', args: ['q', { limit: 5 }], result: [{ slug: 'q', score: 1 }] });
    expect(searchLine.result).toHaveLength(1);
  });

  test('only sampled reads pay the encode: unsampled reads never touch their arguments or result', async () => {
    let touched = 0;
    const probe = { get spy() { touched++; return 1; } };
    const primary = fakePrimary();
    (primary as unknown as { getPage: () => Promise<unknown> }).getPage = async () => probe;
    const s = sink();
    const engine = wrapShadowEngine(primary, s, { sampleRate: 0.5, random: () => 0.9 });
    await (engine.getPage as unknown as (arg: unknown) => Promise<unknown>)(probe);
    expect(touched).toBe(0);
    expect(s.counters.sampled_out).toBe(1);
    const sampled = wrapShadowEngine(primary, s, { sampleRate: 1 });
    await (sampled.getPage as unknown as (arg: unknown) => Promise<unknown>)(probe);
    // A sampled read reads the probe three times: the function-argument check, the argument encode and the result encode.
    expect(touched).toBe(3);
    expect(s.offered).toHaveLength(1);
  });

  test('a full queue sheds without encoding, and an encode that throws fails open', async () => {
    let touched = 0;
    const probe = { get spy() { touched++; return 1; } };
    const primary = fakePrimary();
    (primary as unknown as { getPage: () => Promise<unknown> }).getPage = async () => probe;
    const q = new MirrorQueue({ bound: 1, transport: { send: () => true }, schedule: () => {} });
    const engine = wrapShadowEngine(primary, { counters: q.counters, offer: (c) => q.offer(c), active: () => true }, { sampleRate: 1 });
    await engine.getPage('a');
    expect(touched).toBe(1);
    await engine.getPage('b');
    expect(touched).toBe(1);
    expect(q.counters.shed_queue_full).toBe(1);
    const bad = { get boom(): never { throw new Error('getter'); } };
    (primary as unknown as { getPage: () => Promise<unknown> }).getPage = async () => bad;
    const q2 = new MirrorQueue({ bound: 4, transport: { send: () => true }, schedule: () => {} });
    const engine2 = wrapShadowEngine(primary, { counters: q2.counters, offer: (c) => q2.offer(c), active: () => true }, { sampleRate: 1 });
    expect(await engine2.getPage('a')).toBe(bad as never);
    expect(q2.counters.encode_error).toBe(1);
    expect(q2.depth).toBe(0);
  });

  test('a result over the capture budget is counted too_large before its copy is built, and the caller still gets it', async () => {
    const primary = fakePrimary();
    const big = { rows: Array.from({ length: 4 }, () => 'x'.repeat(400 * 1024)) };
    (primary as unknown as { getPage: () => Promise<unknown> }).getPage = async () => big;
    const q = new MirrorQueue({ bound: 4, transport: { send: () => true }, schedule: () => {} });
    const engine = wrapShadowEngine(primary, { counters: q.counters, offer: (c) => q.offer(c), active: () => true }, { sampleRate: 1 });
    expect(await engine.getPage('a')).toBe(big as never);
    expect(q.counters.shed_too_large).toBe(1);
    expect(q.counters.encode_error).toBe(0);
    expect(q.depth).toBe(0);
    // An argument list over the budget sheds the same way and still calls the primary.
    const huge = new Float32Array(200_000);
    expect(await (engine.getPage as unknown as (arg: unknown) => Promise<unknown>)(huge)).toBeDefined();
    expect(q.counters.shed_too_large).toBe(2);
  });

  test('a function-valued accessor such as the Postgres sql client keeps its identity on the engine, and its properties in a transaction', async () => {
    const reserved = {};
    const client = Object.assign(() => 'tag', { unsafe: async (_text: string) => ['row'], options: { max: 7 }, reserve: async () => reserved });
    const primary = fakePrimary();
    Object.defineProperty(primary, 'sql', { get: () => client });
    const engine = wrapShadowEngine(primary, sink(), { sampleRate: 1 });
    expect((engine as unknown as { sql: unknown }).sql).toBe(client);
    await engine.transaction(async (tx) => {
      // In a transaction the handle is the shadow's view of it (its statements are seen like executeRaw): one object for every read, with the client's own members.
      const inner = (tx as unknown as { sql: typeof client }).sql;
      expect((tx as unknown as { sql: typeof client }).sql).toBe(inner);
      expect(typeof inner).toBe('function');
      expect(inner.options).toBe(client.options);
      expect(await inner.reserve()).toBe(reserved);
      expect(await inner.unsafe('SELECT 1')).toEqual(['row']);
    });
  });

  test('a path the engine recorded when it connected is found through the shadow view', async () => {
    const primary = Object.assign(fakePrimary(), { hasPersistenceTable: async () => false });
    await registerManagedFilesystemEngine(primary as never, '/brains/main.pglite');
    const view = wrapShadowEngine(primary, sink(), { sampleRate: 1 });
    expect(managedFilesystemDatastorePath(primary as never)).toBe('/brains/main.pglite');
    expect(managedFilesystemDatastorePath(view as never)).toBe('/brains/main.pglite');
  });

  test('never mirrors writes, and passes a primary rejection through unchanged', async () => {
    const s = sink();
    const engine = wrapShadowEngine(fakePrimary(), s, { sampleRate: 1 });
    await (engine as unknown as { putPage: () => Promise<unknown> }).putPage();
    await expect(engine.listPages()).rejects.toThrow('boom');
    expect(s.offered).toHaveLength(0);
    expect(s.counters.primary_error).toBe(1);
  });

  test('sampling misses are counted and not offered', async () => {
    const s = sink();
    const engine = wrapShadowEngine(fakePrimary(), s, { sampleRate: 0.5, random: () => 0.9 });
    await engine.getPage('a');
    expect(s.offered).toHaveLength(0);
    expect(s.counters.sampled_out).toBe(1);
  });

  test('reads inside a transaction are skipped and counted', async () => {
    const s = sink();
    const engine = wrapShadowEngine(fakePrimary(), s, { sampleRate: 1 });
    await engine.transaction(async (tx) => { await tx.getPage('in-tx'); });
    expect(s.offered).toHaveLength(0);
    expect(s.counters.skipped_in_transaction).toBe(1);
  });

  test('an inactive sink passes everything through without counting', async () => {
    const s = sink(false);
    const engine = wrapShadowEngine(fakePrimary(), s, { sampleRate: 1 });
    await engine.getPage('a');
    expect(s.offered).toHaveLength(0);
    expect(s.counters.offered + s.counters.sampled_out).toBe(0);
  });

  test('a read with a function argument cannot cross the pipe and is counted unmirrorable', async () => {
    const s = sink();
    const engine = wrapShadowEngine(fakePrimary(), s, { sampleRate: 1 });
    await (engine.searchKeyword as unknown as (q: string, o: unknown) => Promise<unknown>)('q', { onRow: () => {} });
    expect(s.offered).toHaveLength(0);
    expect(s.counters.shed_unmirrorable).toBe(1);
  });

  test('a member replaced on the primary is re-bound', async () => {
    const s = sink();
    const primary = fakePrimary();
    const engine = wrapShadowEngine(primary, s, { sampleRate: 1 });
    await engine.getPage('a');
    (primary as unknown as { getPage: (slug: string) => Promise<unknown> }).getPage = async (slug) => ({ slug, title: 'new' });
    expect(await engine.getPage('b')).toEqual({ slug: 'b', title: 'new' } as never);
  });

  test('the allowlist holds only BrainEngine read members', () => {
    for (const op of Object.keys(SHADOW_READ_MEMBERS)) expect(op.startsWith('put') || op.startsWith('delete')).toBe(false);
  });
});

describe('mirror queue', () => {
  const read = (op = 'getPage'): CapturedRead => ({ op, args: ['a'], result: { slug: 'a' }, primary_ms: 1, at: 1 });

  test('sheds once the bound is reached and never blocks', async () => {
    const lines: string[] = [];
    const q = new MirrorQueue({ bound: 2, transport: { send: (l) => { lines.push(l); return true; } } });
    q.offer(read); q.offer(read); q.offer(read);
    expect(q.counters.shed_queue_full).toBe(1);
    await tick();
    expect(q.counters.sent).toBe(2);
    expect(JSON.parse(lines[0])).toMatchObject({ t: 'read', op: 'getPage', args: ['a'] });
  });

  test('stop delivers what is queued instead of dropping it, so a short-lived process still reports its reads', () => {
    const sent: string[] = [];
    const q = new MirrorQueue({ bound: 8, transport: { send: (l) => { sent.push(l); return true; } }, schedule: () => {} });
    q.offer(() => ({ op: 'getPage', args: ['a'], result: { slug: 'a' }, primary_ms: 1, at: 1 }));
    q.offer(() => ({ op: 'getPage', args: ['b'], result: { slug: 'b' }, primary_ms: 1, at: 2 }));
    expect(sent).toHaveLength(0);
    q.stop();
    expect(sent).toHaveLength(2);
    expect(q.counters.offered).toBe(2);
    expect(q.counters.sent).toBe(2);
    q.offer(() => ({ op: 'getPage', args: [], result: null, primary_ms: 1, at: 3 }));
    expect(q.counters.offered).toBe(2);
  });

  test('counts a refused send and an oversize line', async () => {
    const q = new MirrorQueue({ bound: 10, maxLineBytes: 200, transport: { send: () => false } });
    q.offer(read);
    q.offer(() => ({ ...read(), result: 'x'.repeat(500) }));
    await tick();
    expect(q.counters.shed_transport).toBe(1);
    expect(q.counters.shed_too_large).toBe(1);
  });

  test('a throwing transport fails open', async () => {
    const q = new MirrorQueue({ bound: 10, transport: { send: () => { throw new Error('pipe'); } } });
    q.offer(read);
    await tick();
    expect(q.counters.shed_transport).toBe(1);
  });
});

describe('codec', () => {
  test('round-trips dates, typed arrays, bigints, maps, sets and non-finite numbers', () => {
    const value = { d: new Date('2026-01-02T03:04:05Z'), v: new Float32Array([1, 2.5]), b: 10n, m: new Map([['k', 1]]), s: new Set([1, 2]), n: Number.NaN, i: -Infinity };
    const back = decodeValue(JSON.parse(JSON.stringify(encodeValue(value)))) as typeof value;
    expect(back.d.toISOString()).toBe(value.d.toISOString());
    expect(Array.from(back.v)).toEqual([1, 2.5]);
    expect(back.b).toBe(10n);
    expect(back.m.get('k')).toBe(1);
    expect([...back.s]).toEqual([1, 2]);
    expect(Number.isNaN(back.n)).toBe(true);
    expect(back.i).toBe(-Infinity);
  });

  test('an undefined argument stays distinct from null across the wire', () => {
    const wire = JSON.parse(JSON.stringify(encodeArgs(['Example', undefined, null, undefined, 'default']))) as unknown;
    const args = decodeValue(wire) as unknown[];
    expect(args).toHaveLength(5);
    expect(args[1]).toBeUndefined();
    expect(args[2]).toBeNull();
    expect(args[3]).toBeUndefined();
    expect(args[4]).toBe('default');
  });

  test('the capture budget stops an encode before a big typed array or string is copied', () => {
    expect(() => encodeValue(new Float32Array(200_000), undefined, { left: CAPTURE_BUDGET_BYTES })).toThrow(CaptureTooLargeError);
    expect(() => encodeValue({ a: 'x'.repeat(CAPTURE_BUDGET_BYTES + 1) }, undefined, { left: CAPTURE_BUDGET_BYTES })).toThrow(CaptureTooLargeError);
    expect(encodeValue({ a: 'small', v: new Float32Array(8) }, undefined, { left: CAPTURE_BUDGET_BYTES })).toEqual({ a: 'small', v: { $typed: 'Float32Array', v: Array.from(new Float32Array(8)) } });
  });

  test('the capture budget charges every node, so nulls, booleans and empty objects cannot slip past it', () => {
    const budget = () => ({ left: CAPTURE_BUDGET_BYTES });
    expect(() => encodeValue(new Array(2_000_000).fill(null), undefined, budget())).toThrow(CaptureTooLargeError);
    expect(() => encodeValue(new Array(2_000_000).fill(true), undefined, budget())).toThrow(CaptureTooLargeError);
    expect(() => encodeValue({ frontmatter: Array.from({ length: 400_000 }, () => ({})) }, undefined, budget())).toThrow(CaptureTooLargeError);
    expect(encodeValue({ a: [null, true, {}] }, undefined, budget())).toEqual({ a: [null, true, {}] });
  });

  test('an option left undefined stays absent instead of becoming null', () => {
    expect(encodeValue({ sourceId: 'a', takesHoldersAllowList: undefined })).toEqual({ sourceId: 'a' });
    const args = decodeValue(JSON.parse(JSON.stringify(encodeArgs(['x', { visibility: undefined, limit: 3 }])))) as unknown[];
    expect(args[1]).toEqual({ limit: 3 });
    expect('visibility' in (args[1] as object)).toBe(false);
  });

  test('drops signals and functions, and canonical JSON ignores key order', () => {
    const enc = encodeValue({ a: 1, signal: new AbortController().signal, f: () => 1 });
    expect(enc).toEqual({ a: 1 });
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});

describe('classifier', () => {
  test('match, order_diff for ranked reads only, and diff', () => {
    expect(classifyResult('exact', ['a'], { slug: 'a' }, { slug: 'a' }).outcome).toBe('match');
    const p = [{ slug: 'a', score: 1 }, { slug: 'b', score: 0.5 }];
    const r = [{ slug: 'b', score: 0.9 }, { slug: 'a', score: 0.2 }];
    expect(classifyResult('ranked', ['q'], p, r).outcome).toBe('order_diff');
    expect(classifyResult('exact', ['q'], p, r).outcome).toBe('diff');
    expect(classifyResult('ranked', ['q'], p, [{ slug: 'c' }]).outcome).toBe('diff');
  });

  test('a Rust row outside the requested sources is a privacy divergence, checked first', () => {
    const c = classifyResult('ranked', ['q', { sourceId: 'a' }], [], [{ slug: 'x', source_id: 'b' }]);
    expect(c.outcome).toBe('privacy_diverged');
  });

  test('engine_capability_missing is capability_missing; any other error keeps its code', () => {
    expect(classifyError(Object.assign(new Error('x'), { code: 'engine_capability_missing', reason: 'keyword_search' }))).toEqual({ outcome: 'capability_missing', reason: 'keyword_search' });
    expect(classifyError(Object.assign(new Error('x'), { code: 'boom' }))).toEqual({ outcome: 'error', reason: 'boom' });
  });
});

class FakeChild extends EventEmitter {
  stdin = Object.assign(new PassThrough(), { unref() {} });
  stdout = Object.assign(new PassThrough(), { unref() {} });
  pid = 4242;
  killed: string | null = null;
  unref() {}
  kill(signal: string) { this.killed = signal; return true; }
}

describe('supervisor', () => {
  function harness(overrides: Record<string, unknown> = {}) {
    let clock = 1_000_000;
    const children: FakeChild[] = [];
    const faults: ShadowFault[] = [];
    const dir = tmp();
    const sup = new ShadowSupervisor({
      dir, argv: ['gbrain', 'engine', 'shadow', '__child', dir],
      spawn: (() => { const c = new FakeChild(); children.push(c); return c; }) as never,
      now: () => clock, recordFault: (f) => faults.push(f), stillEnabled: () => true, ...overrides,
    });
    return { sup, children, faults, dir, advance: (ms: number) => { clock += ms; } };
  }

  test('spawns lazily on the first send and writes the line', () => {
    const h = harness();
    expect(h.children).toHaveLength(0);
    expect(h.sup.send('{"t":"read"}\n')).toBe(true);
    expect(h.children).toHaveLength(1);
    expect(h.children[0].stdin.read()?.toString()).toBe('{"t":"read"}\n');
    h.sup.stop();
    rmSync(h.dir, { recursive: true, force: true });
  });

  test('restarts after an exit with a backoff, then disables after the restart budget', () => {
    const h = harness();
    for (let i = 0; i < 4; i++) {
      expect(h.sup.send('x\n')).toBe(true);
      h.children.at(-1)!.emit('exit', 1, null);
      expect(h.sup.send('x\n')).toBe(false); // inside the backoff
      h.advance(61_000);
    }
    expect(h.sup.send('x\n')).toBe(true);
    h.children.at(-1)!.emit('exit', 1, null);
    expect(h.sup.active()).toBe(false);
    expect(h.sup.disabled).toBe('restart_budget_spent');
    expect(h.faults.filter((f) => f.kind === 'child_exit')).toHaveLength(5);
    expect(h.faults.at(-1)!.kind).toBe('mirroring_disabled');
    rmSync(h.dir, { recursive: true, force: true });
  });

  test('kills a child that stops sending heartbeats', () => {
    const h = harness({ hangMs: 60_000 });
    h.sup.send('x\n');
    h.children[0].stdout.write('{"t":"hb"}\n');
    h.advance(61_000);
    h.sup.checkHang();
    expect(h.children[0].killed).toBe('SIGKILL');
    expect(h.faults.map((f) => f.kind)).toContain('child_hung');
    h.sup.stop();
    rmSync(h.dir, { recursive: true, force: true });
  });

  test('stop kills a child that never exits after its input ends, and leaves one that exits in time', async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const stuck = harness({ hangMs: 20 });
    stuck.sup.send('x\n');
    stuck.sup.stop();
    const fine = harness({ hangMs: 20 });
    fine.sup.send('x\n');
    fine.sup.stop();
    fine.children[0].emit('exit', 0, null);
    await wait(80);
    expect(stuck.children[0].killed).toBe('SIGKILL');
    expect(fine.children[0].killed).toBeNull();
    for (const h of [stuck, fine]) rmSync(h.dir, { recursive: true, force: true });
  });

  test('a pause from the child stops mirroring', async () => {
    const h = harness();
    h.sup.send('x\n');
    h.children[0].stdout.write('{"t":"pause","reason":"privacy_diverged"}\n');
    await tick();
    expect(h.sup.active()).toBe(false);
    expect(h.faults.at(-1)!.kind).toBe('privacy_pause');
    rmSync(h.dir, { recursive: true, force: true });
  });

  test('turning shadow mode off in state.json stops mirroring at the next check', () => {
    let enabled = true;
    const h = harness({ stillEnabled: () => enabled, stateCheckMs: 30_000 });
    expect(h.sup.send('x\n')).toBe(true);
    enabled = false;
    h.advance(31_000);
    expect(h.sup.send('x\n')).toBe(false);
    expect(h.sup.disabled).toBe('stopped');
    rmSync(h.dir, { recursive: true, force: true });
  });

  test('refuses a send while the pipe holds more than its byte budget', () => {
    const h = harness({ maxBufferedBytes: 10 });
    h.sup.send('x\n');
    Object.defineProperty(h.children[0].stdin, 'writableLength', { value: 100 });
    expect(h.sup.send('x\n')).toBe(false);
    h.sup.stop();
    rmSync(h.dir, { recursive: true, force: true });
  });

  test('the child argv runs the same gbrain', () => {
    expect(shadowChildArgv('/d', ['/bin/bun', '/src/cli.ts'])).toEqual(['/bin/bun', '/src/cli.ts', 'engine', 'shadow', '__child', '/d']);
  });
});

describe('child loop', () => {
  const event = (op: string, args: unknown[], result: unknown) => JSON.stringify({ t: 'read', id: 1, at: Date.parse('2026-11-17T00:00:00Z'), op, primary_ms: 2, args: encodeValue(args), result: encodeValue(result) }) + '\n';

  async function run(lines: string[], deps: Partial<Parameters<typeof runShadowChild>[1]>) {
    const dir = tmp();
    const input = new PassThrough();
    const control: string[] = [];
    const done = runShadowChild(dir, { input, writeControl: (l) => control.push(l), heartbeatMs: 60_000, childId: 'c1', ...deps });
    for (const l of lines) input.write(l);
    input.end();
    await done;
    return { dir, control, summary: readShadowSummary(dir) };
  }

  test('a read the Rust engine refuses records capability_missing', async () => {
    const refuse = async () => { throw Object.assign(new Error('not served'), { code: 'engine_capability_missing', reason: 'raw_sql' }); };
    const r = await run([event('getPage', ['a'], { slug: 'a' }), event('searchKeyword', ['q'], [])], {
      loadAddon: async () => ({ ok: true, addon: { target: 'linux-x64-glibc', engineAbi: 1 } as never }),
      openEngine: () => ({ connect: async () => {}, disconnect: async () => {}, getPage: refuse, searchKeyword: refuse }) as never,
    });
    expect(r.summary.by_op.getPage).toEqual({ capability_missing: 1 });
    expect(r.summary.by_op.searchKeyword).toEqual({ capability_missing: 1 });
    const ledger = readdirSync(join(r.dir, 'ledger'));
    const rows = readFileSync(join(r.dir, 'ledger', ledger[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ op: 'getPage', outcome: 'capability_missing', primary_rows: null });
    // Content-free: no slug or query in the ledger.
    expect(JSON.stringify(rows)).not.toContain('"a"');
    expect(r.control[0]).toBe('{"t":"hb"}\n');
    rmSync(r.dir, { recursive: true, force: true });
  });

  test('an addon the engine cannot open records error with an open_failed reason for every read', async () => {
    // A stand-in addon object has no native store, so the real engine's connect throws before any read.
    const r = await run([event('getPage', ['a'], { slug: 'a' })], {
      loadAddon: async () => ({ ok: true, addon: { target: 'linux-x64-glibc', engineAbi: 1 } as never }),
    });
    expect(r.summary.by_op.getPage).toEqual({ error: 1 });
    const ledger = readdirSync(join(r.dir, 'ledger'));
    expect(readFileSync(join(r.dir, 'ledger', ledger[0]), 'utf8')).toContain('open_failed:');
    rmSync(r.dir, { recursive: true, force: true });
  });

  test('a missing addon records addon_unavailable with its code and reason', async () => {
    const r = await run([event('getPage', ['a'], null)], {
      loadAddon: async () => ({ ok: false, code: 'rust_engine_addon_missing', reason: 'not_installed', message: 'm' }),
    });
    expect(r.summary.by_op.getPage).toEqual({ addon_unavailable: 1 });
    const ledger = readdirSync(join(r.dir, 'ledger'));
    expect(readFileSync(join(r.dir, 'ledger', ledger[0]), 'utf8')).toContain('rust_engine_addon_missing:not_installed');
    rmSync(r.dir, { recursive: true, force: true });
  });

  test('match, timeout and a privacy pause with a fake engine', async () => {
    const fake = {
      async connect() {}, async disconnect() {},
      async getPage(slug: string) { return { slug }; },
      getTags() { return new Promise(() => {}); },
      async searchKeyword() { return [{ slug: 'x', source_id: 'other' }]; },
    };
    const r = await run([
      event('getPage', ['a'], { slug: 'a' }),
      event('getTags', ['a'], []),
      event('searchKeyword', ['q', { sourceId: 'mine' }], []),
      event('getPage', ['b'], { slug: 'b' }),
    ], {
      loadAddon: async () => ({ ok: true, addon: {} as never }), openEngine: () => fake as never, timeoutMs: 20,
    });
    expect(r.summary.by_op.getPage).toEqual({ match: 1 });
    expect(r.summary.by_op.getTags).toEqual({ timeout: 1 });
    expect(r.summary.by_op.searchKeyword).toEqual({ privacy_diverged: 1 });
    expect(r.control).toContain('{"t":"pause","reason":"privacy_diverged"}\n');
    expect(readFaults(r.dir).map((f) => f.kind)).toContain('privacy_pause');
    rmSync(r.dir, { recursive: true, force: true });
  });

  test('one malformed event is recorded and the next event is still compared', async () => {
    const fake = { async connect() {}, async disconnect() {}, async getPage(slug: string) { return { slug }; } };
    const bad = JSON.stringify({ t: 'read', id: 1, at: Date.parse('2026-11-17T00:00:00Z'), op: 'getPage', primary_ms: 1, args: [{ $bigint: 'not-a-number' }], result: null }) + '\n';
    const r = await run([bad, event('getPage', ['a'], { slug: 'a' })], {
      loadAddon: async () => ({ ok: true, addon: {} as never }), openEngine: () => fake as never,
    });
    const counts = r.summary.by_op.getPage ?? {};
    expect(counts.match).toBe(1);
    expect(Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)).toBe(2);
    rmSync(r.dir, { recursive: true, force: true });
  });

  test('timed-out calls are capped: past the limit new reads are shed unstarted and the heartbeat goes quiet', async () => {
    let started = 0;
    const fake = { async connect() {}, async disconnect() {}, getTags() { started++; return new Promise(() => {}); } };
    const dir = tmp();
    const input = new PassThrough();
    const hb: string[] = [];
    const done = runShadowChild(dir, {
      input, writeControl: (l) => { if (l.includes('"hb"')) hb.push(l); }, heartbeatMs: 5, childId: 'c1', timeoutMs: 5,
      loadAddon: async () => ({ ok: true, addon: {} as never }), openEngine: () => fake as never,
    });
    for (let i = 0; i < SHADOW_CHILD_STALL_LIMIT + 3; i++) input.write(event('getTags', ['a'], []));
    await new Promise((r) => setTimeout(r, 150));
    const quiet = hb.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(hb.length).toBe(quiet);
    input.end();
    await done;
    expect(started).toBe(SHADOW_CHILD_STALL_LIMIT);
    expect(readShadowSummary(dir).by_op.getTags).toEqual({ timeout: SHADOW_CHILD_STALL_LIMIT + 3 });
    rmSync(dir, { recursive: true, force: true });
  });

  test('a shadow directory deleted while the child starts is not recreated', async () => {
    const during = async (where: 'load' | 'connect') => {
      const dir = tmp();
      writeShadowState(dir, { version: SHADOW_STATE_VERSION, enabled: true, started_at: 'x', sample_rate: 1, queue_bound: 8, plan_hash: 'p', brain: 'b', primary_engine: 'pglite' });
      let opened = 0;
      const fake = { async connect() { opened++; rmSync(dir, { recursive: true, force: true }); mkdirSync(join(dir, 'store'), { recursive: true }); }, async disconnect() {} };
      const input = new PassThrough();
      const done = runShadowChild(dir, {
        input, writeControl: () => {}, heartbeatMs: 60_000, childId: 'c1',
        loadAddon: async () => { if (where === 'load') rmSync(dir, { recursive: true, force: true }); return { ok: true, addon: {} as never }; },
        openEngine: () => fake as never,
      });
      input.write(event('getPage', ['a'], { slug: 'a' }));
      input.end();
      await done;
      expect(existsSync(dir), where).toBe(false);
      return opened;
    };
    expect(await during('load')).toBe(0); // never opened
    expect(await during('connect')).toBe(1); // opened, found the directory gone, cleaned up
  });

  test('stats events update the serving counters in the summary', async () => {
    const counters = { ...newMirrorCounters(), offered: 7, sent: 5 };
    const r = await run([JSON.stringify({ t: 'stats', at: 1, counters }) + '\n'], {
      loadAddon: async () => ({ ok: false, code: 'rust_engine_addon_missing', reason: 'not_installed', message: 'm' }),
    });
    expect(r.summary.primary.offered).toBe(7);
    rmSync(r.dir, { recursive: true, force: true });
  });
});

describe('shadow state and evidence files', () => {
  test('two brains behind one pooler differ by user name, and a password never changes the key', () => {
    const pooler = (user: string, password: string) => ({ engine: 'postgres' as const, database_url: `postgresql://${user}:${password}@aws-0.pooler.example:6543/postgres` });
    expect(shadowBrainKey(pooler('postgres.projecta', 'one'))).not.toBe(shadowBrainKey(pooler('postgres.projectb', 'one')));
    expect(shadowBrainKey(pooler('postgres.projecta', 'one'))).toBe(shadowBrainKey(pooler('postgres.projecta', 'two')));
  });

  test('a state file with a bad sample rate or queue bound reads as off', () => {
    const dir = tmp();
    const good = { version: SHADOW_STATE_VERSION, enabled: true, started_at: '2026-11-17T00:00:00Z', sample_rate: 0.1, queue_bound: 256, plan_hash: 'p', brain: 'b', primary_engine: 'pglite' };
    writeShadowState(dir, good);
    expect(readShadowState(dir)?.enabled).toBe(true);
    for (const bad of [{ sample_rate: 0 }, { sample_rate: 1.5 }, { sample_rate: Number.NaN }, { queue_bound: 0 }, { queue_bound: 2.5 }, { queue_bound: undefined }]) {
      writeShadowState(dir, { ...good, ...bad } as never);
      expect(readShadowState(dir)).toBeNull();
    }
    writeFileSync(join(dir, 'state.json'), '{not json');
    expect(readShadowState(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a late write after the shadow directory was deleted does not bring it back', () => {
    const dir = join(tmp(), 'brain');
    mkdirSync(dir);
    rmSync(dir, { recursive: true, force: true });
    appendFault(dir, { ts: '2026-11-17T00:00:00Z', kind: 'child_exit', detail: 'late' });
    appendLedgerRows(dir, [{ ts: '2026-11-17T00:00:00Z', op: 'getPage', outcome: 'match', primary_ms: 1, rust_ms: 1, primary_rows: 1, rust_rows: 1 }]);
    writeSummaryFile(dir, { version: 1, child_id: 'late', started_at: '', updated_at: '', first_event_at: null, last_event_at: null, by_op: {}, child_shed: 0, primary: newMirrorCounters() });
    expect(existsSync(dir)).toBe(false);
  });

  test('serving counters are not added twice when a restarted child reports the same process again', () => {
    const dir = tmp();
    const file = (id: string, pid: number, offered: number) => ({
      version: 1, child_id: id, started_at: '', updated_at: '', first_event_at: null, last_event_at: null, by_op: {}, child_shed: 0,
      primary: { ...newMirrorCounters(), offered, sent: offered }, primary_pid: pid,
    });
    mkdirSync(join(dir, 'summaries'));
    writeFileSync(join(dir, 'summaries', 'a.json'), JSON.stringify(file('a', 100, 10)));
    writeFileSync(join(dir, 'summaries', 'b.json'), JSON.stringify(file('b', 100, 25)));
    writeFileSync(join(dir, 'summaries', 'c.json'), JSON.stringify(file('c', 200, 4)));
    const total = readShadowSummary(dir);
    expect(total.children).toBe(3);
    expect(total.primary.offered).toBe(29);
    expect(total.primary.sent).toBe(29);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('provisional report', () => {
  test('always says NOT READY and counts per operation and outcome', async () => {
    const dir = tmp();
    const input = new PassThrough();
    const done = runShadowChild(dir, {
      input, writeControl: () => {}, heartbeatMs: 60_000,
      loadAddon: async () => ({ ok: true, addon: {} as never }),
      openEngine: () => ({ async connect() {}, async disconnect() {}, async getPage(s: string) { return { s }; } }) as never,
    });
    input.write(JSON.stringify({ t: 'read', at: 1, op: 'getPage', primary_ms: 1, args: ['a'], result: { s: 'a' } }) + '\n');
    input.write(JSON.stringify({ t: 'read', at: 2, op: 'getPage', primary_ms: 1, args: ['b'], result: { s: 'z' } }) + '\n');
    input.end();
    await done;
    const report = buildProvisionalReport(dir, 'pglite-abc', null);
    expect(report.verdict).toBe('NOT READY');
    // A mismatch on an exactness comparison is inconclusive (it keeps `diff` in the ledger row's mismatch) until a rerun can settle it.
    expect(report.by_op).toEqual([expect.objectContaining({ op: 'getPage', total: 2, match: 1, diff: 0, inconclusive: 1, capability_missing: 0 })]);
    expect(renderProvisionalMarkdown(report)).toContain('Verdict: **NOT READY**');
    rmSync(dir, { recursive: true, force: true });
  });

  test('a perfect run is still NOT READY', () => {
    const dir = tmp();
    expect(buildProvisionalReport(dir, 'b', null).verdict).toBe('NOT READY');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('eval --engine rust', () => {
  test('parses pglite and rust and refuses anything else', () => {
    expect(parseBenchmarkEngineKind('--engine', 'rust')).toBe('rust');
    expect(parseBenchmarkEngineKind('--engine', 'pglite')).toBe('pglite');
    expect(() => parseBenchmarkEngineKind('--engine', 'postgres')).toThrow();
  });

  test('a missing addon stops before anything is created, with the loader code, reason and message', async () => {
    const err = await createBenchmarkBrain('rust', {
      loadAddon: async () => ({ ok: false, code: 'rust_engine_addon_mismatch', reason: 'engine_abi', message: 'ABI 2, expected 1.' }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RustEngineAddonUnavailableError);
    expect(err.code).toBe('rust_engine_addon_mismatch');
    expect(err.reason).toBe('engine_abi');
    expect(err.message).toContain('ABI 2, expected 1.');
  });

  test('an addon the engine cannot open stops the run with that error, not an addon refusal', async () => {
    const err = await createBenchmarkBrain('rust', {
      loadAddon: async () => ({ ok: true, addon: { target: 'linux-x64-glibc', engineAbi: 1 } as never }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RustEngineAddonUnavailableError);
  });

  withAddon('with the built addon the run is refused up front, before any work, and leaves no store behind', async () => {
    const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    const stores = () => readdirSync(tmpdir()).filter((n) => n.startsWith('gbrain-bench-rust-')).sort();
    const before = stores();
    const err = await createBenchmarkBrain('rust', { loadAddon: async () => ({ ok: true, addon }) as never }).catch((e) => e);
    expect(err).toBeInstanceOf(RustEngineAddonUnavailableError);
    expect(err.code).toBe('rust_benchmark_unsupported');
    expect(err.reason).toBe('raw_sql_missing');
    expect(stores()).toEqual(before);
  });

  test('a Rust run keys its own resume hash and run config, and the default engine leaves both unchanged', () => {
    const pins = { mode: 'balanced', keyword_only: false, reranker: { enabled: false, model: null }, autocut: false, expansion: false, expansion_variant_budget: null, embedder: 'e@1', top_k: 5, trajectory: false };
    const knobs = { knobs_hash: 'k', knobs_hash_version: 1 };
    const withEngine = { ...pins, engine: 'rust' as const };
    expect(retrievalConfigHash(withEngine as never, knobs as never)).not.toBe(retrievalConfigHash(pins as never, knobs as never));
    expect(buildRunConfig({ pins: withEngine } as never).engine).toBe('rust');
    expect('engine' in buildRunConfig({ pins } as never)).toBe(false);
  });

  test('the memory-trust suites refuse --engine rust instead of benchmarking PGLite', async () => {
    const corpus = { fixtures: [{ fixture: { suites: [TRUST_SUITES[0]], holdout: false } }] } as never;
    await expect(runBrainBench(corpus, { harnesses: ['openclaw'], suites: [TRUST_SUITES[0]] as never, includeHoldout: true, llm: false, engine: 'rust' }))
      .rejects.toThrow('--engine rust does not run the memory-trust suites');
  });
});

// A pipe whose write callbacks the test fires by hand: what Bun does (a callback fires once the bytes have left for the kernel pipe, `drain` never fires, `writableLength` reads 0).
class HeldPipeChild extends EventEmitter {
  held: Array<{ line: string; cb: (error?: Error | null) => void }> = [];
  writes: string[] = []; // every line handed to the pipe, in order
  owedAtWrite: number[] = []; // what the owed record said at each write (a test seam)
  onWrite?: () => void;
  ended = false;
  stdin = Object.assign(new EventEmitter(), {
    writable: true, destroyed: false, writableLength: 0, unref() {},
    write: (line: string, cb: (error?: Error | null) => void): boolean => { this.writes.push(line); this.onWrite?.(); this.held.push({ line, cb }); return false; }, // false: Bun says "backpressure" for most lines of a burst
    end: () => { this.ended = true; if (this.held.length === 0) queueMicrotask(() => this.stdin.emit('finish')); },
  });
  stdout = Object.assign(new PassThrough(), { unref() {} });
  pid = 4343;
  unref() {}
  kill() { return true; }
  flush(n = this.held.length, error?: Error): void { for (const h of this.held.splice(0, n)) h.cb(error ?? null); if (this.ended && this.held.length === 0) queueMicrotask(() => this.stdin.emit('finish')); }
}

describe('supervisor sample accounting (a sample is owed in a durable record before it is sent; the child settles it, or books it lost)', () => {
  const sample = (i: number, pad = 400, extra = ''): string => `{"t":"write","op":"putPage","i":${i},"pad":"${'x'.repeat(pad)}"${extra}}\n`;
  const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
  function harness(overrides: Record<string, unknown> = {}) {
    const children: HeldPipeChild[] = []; const sessions: string[] = []; const faults: ShadowFault[] = []; const owedWrites: number[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-sample-accounting-'));
    const sup = new ShadowSupervisor({
      dir, argv: ['g'], spawn: ((_cmd: string, _args: string[], options: { env: Record<string, string> }) => { const c = new HeldPipeChild(); c.onWrite = () => { c.owedAtWrite.push((readOwed(dir, sessions[children.indexOf(c)]!) as { owed: number } | null)?.owed ?? -1); }; children.push(c); sessions.push(options.env.GBRAIN_SHADOW_SESSION!); return c; }) as never,
      recordFault: (f: ShadowFault) => faults.push(f), stillEnabled: () => true, maxBufferedBytes: 1_000, drainMs: 60, retryMs: 10,
      writeOwed: (d: string, rec: OwedRecord) => { owedWrites.push(rec.owed); writeOwed(d, rec); }, ...overrides,
    } as never);
    return { sup, children, sessions, faults, dir, owedWrites, owed: (i = 0) => readOwed(dir, sessions[i]!), done: () => { sup.stop(); rmSync(dir, { recursive: true, force: true }); } };
  }

  test('a sample is accepted at once but its owed record is written in a later turn, never inside the caller; the lines reach the pipe after it, in order, one record per turn', async () => {
    const h = harness({ maxBufferedBytes: 1_000_000 });
    expect(h.sup.send(sample(0))).toBe(true); expect(h.sup.send('{"t":"read","n":1}\n')).toBe(true); expect(h.sup.send(sample(1))).toBe(true); expect(h.sup.send('{"t":"read","n":2}\n')).toBe(true);
    expect(h.owedWrites).toEqual([]); // nothing durable inside send(): the fsync is off the request's synchronous path
    expect(h.children[0]!.writes).toEqual([]); // a read behind a staged sample waits too, so order holds
    await turn();
    expect(h.owedWrites).toEqual([2]); // one record for the whole turn, stating everything accepted
    expect(h.children[0]!.owedAtWrite).toEqual([2, 2, 2, 2]); // the record was on disk before the first line reached the pipe
    expect(h.children[0]!.writes.map((l) => /"i":(\d)|"n":(\d)/.exec(l)!.slice(1).find(Boolean))).toEqual(['0', '1', '1', '2']);
    expect(h.owed()).toMatchObject({ v: 1, owed: 2, closed: false, child_exited: false, serving_pid: process.pid });
    h.done();
  });

  test('a read with nothing staged goes to the pipe at once, as before', () => {
    const h = harness();
    expect(h.sup.send('{"t":"read","n":1}\n')).toBe(true);
    expect(h.children[0]!.writes).toHaveLength(1);
    expect(h.owedWrites).toEqual([]);
    h.done();
  });

  test('a sample that would pass the byte budget of samples still staged or in the pipe is refused; a write() that returns false alone is not, and a read is not refused for size', async () => {
    const h = harness();
    expect([0, 1, 2, 3].map((i) => h.sup.send(sample(i)))).toEqual([true, true, true, false]); // 3 x ~444 bytes pass 1,000 before the 4th is offered
    expect(h.sup.send('{"t":"read","pad":"' + 'y'.repeat(900) + '"}\n')).toBe(true); // a read, a follower line, an ask answer: no new refusal while the stage is under its own bound
    await turn();
    h.children[0]!.flush(1);
    expect(h.sup.send(sample(4))).toBe(true); // one left the pipe: room again
    h.sup.closeOwed();
    expect(h.owed()).toMatchObject({ owed: 4, closed: true }); // the refused sample is not owed: its sender counts it send_shed
    h.done();
  });

  test('a failing owed write sends nothing: the lines stay staged, the owed count is exact, the stage is bounded for lines of every kind, and everything goes out in order once the record can be written', async () => {
    const h = harness({ maxBufferedBytes: 1_000_000, maxStagedBytes: 3_000 });
    h.sup.send(sample(0)); // creates the session
    mkdirSync(join(h.dir, `write-owed.${h.sessions[0]}.json.${process.pid}.tmp`)); // the record cannot be written (EISDIR stands for ENOSPC)
    await turn(); await new Promise((r) => setTimeout(r, 40));
    expect(h.children[0]!.writes).toEqual([]); // no sample reaches the child unless the record that owes it is on disk
    let refused = 0; for (let i = 0; i < 50; i++) if (!h.sup.send('{"t":"read","pad":"' + 'r'.repeat(500) + '"}\n')) refused++;
    expect(refused).toBeGreaterThan(0); // sustained reads behind the stuck sample cannot grow memory without bound (was: lines of any kind other than samples were never refused for size)
    expect(h.sup.send(sample(1))).toBe(false); expect(h.sup.send('{"t":"read"}\n')).toBe(false);
    rmSync(join(h.dir, `write-owed.${h.sessions[0]}.json.${process.pid}.tmp`), { recursive: true });
    await new Promise((r) => setTimeout(r, 60)); // the retry
    expect(h.owed()).toMatchObject({ owed: 1 }); // exact: only the accepted sample is owed
    expect(h.children[0]!.writes[0]).toContain('"i":0'); // the sample goes first, then the reads, in the order they came
    expect(h.children[0]!.writes.length).toBeGreaterThan(1);
    h.done();
  });

  test('drain returns as soon as every callback has fired and the child\'s input has ended, and at once when nothing was sent', async () => {
    const h = harness();
    await h.sup.drain(5_000); // no child yet: nothing to wait for
    h.sup.send(sample(0)); h.sup.send(sample(1));
    const started = Date.now();
    const waiting = h.sup.drain(5_000); // hands the staged lines to the pipe, in order
    h.children[0]!.flush(); // every callback fires, the child's stdin is ended, and it says it finished
    await waiting;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(h.children[0]!.ended).toBe(true);
    expect(h.owed()).toMatchObject({ owed: 2, closed: true });
    h.done();
  });

  test('a pipe that does not flush within the bound does not hold the process: drain returns at the bound, and stop() closes the record with every sample that was accepted', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) h.sup.send(sample(i));
    const started = Date.now();
    await h.sup.drain(60);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(50);
    expect(waited).toBeLessThan(1_000);
    h.sup.stop();
    expect(h.owed()).toMatchObject({ owed: 3, closed: true }); // the child books 3 minus what it read; whatever the callbacks said
    h.done();
  });

  test('a clean disconnect (drain, then stop) closes the record once: stop writes nothing the drain already made durable', async () => {
    const h = harness();
    h.sup.send(sample(0)); h.sup.send(sample(1));
    const waiting = h.sup.drain(5_000);
    h.children[0]!.flush();
    await waiting;
    const writes = h.owedWrites.length;
    expect(h.owed()).toMatchObject({ owed: 2, closed: true });
    h.sup.stop();
    expect(h.owedWrites.length).toBe(writes); // before: stop() wrote the receipt again, and the next worker counted two samples that had arrived as lost
    h.done();
  });

  test('a record that could not be written at stop() leaves the older one (a count that is too low, never a hidden mismatch) and no fault line stands for it', async () => {
    const h = harness();
    h.sup.send(sample(0)); await turn(); // owed 1, durable
    h.sup.send(sample(1));
    mkdirSync(join(h.dir, `write-owed.${h.sessions[0]}.json.${process.pid}.tmp`)); // the next record cannot be written
    h.sup.stop();
    expect(h.owed()).toMatchObject({ owed: 1, closed: false });
    expect(h.faults).toEqual([]); // was: a write_samples_unrecorded fault `sent_count n=2`
    h.done();
  });

  test('the exit hook closes the record of every supervisor with a running child, counting lines still staged, and a stopped one already closed its own', () => {
    const a = harness(); const b = harness(); const c = harness();
    a.sup.send(sample(0)); b.sup.send(sample(0)); b.sup.send(sample(1)); c.sup.send(sample(0));
    b.sup.stop();
    expect(b.owed()).toMatchObject({ owed: 2, closed: true });
    rmSync(owedPath(b.dir, b.sessions[0]!));
    closeAllOwedAtExit(); // nothing has had a turn yet: every line is still staged, and the record counts them
    expect(a.owed()).toMatchObject({ owed: 1, closed: true }); expect(c.owed()).toMatchObject({ owed: 1, closed: true });
    expect(a.children[0]!.writes).toHaveLength(1); // the staged line is handed to the pipe after the record, so a pipe that can still deliver gets it
    expect(b.owed()).toBeNull(); // stopped: not live, nothing more to write
    a.done(); b.done(); c.done();
  });

  test('a child that exits is marked in its record, durably, with the exact count, and its staged lines are dropped (the next owner worker books them); a respawned child has a record of its own', async () => {
    let clock = 1_000_000;
    const h = harness({ now: () => clock, minBackoffMs: 10, maxBackoffMs: 10 });
    h.sup.send(sample(0)); h.sup.send(sample(1));
    h.children[0]!.emit('exit', 1, null);
    expect(h.owed(0)).toMatchObject({ owed: 2, child_exited: true, child_pid: 4343 }); // written before anything about the session is reset
    await turn();
    expect(h.children[0]!.writes).toEqual([]); // the dead child's staged lines never go anywhere
    clock += 100;
    expect(h.sup.send(sample(2))).toBe(true);
    expect(h.children).toHaveLength(2);
    await turn();
    expect(h.owed(1)).toMatchObject({ owed: 1, child_exited: false });
    expect(h.sessions[0]).not.toBe(h.sessions[1]);
    h.done();
  });

  test('G2: owe(n) adds n to the owed weight durably in a later turn, with no line sent; a failing owed write is retried, and it needs a running child', async () => {
    const h = harness({ maxBufferedBytes: 1_000_000 });
    expect(h.sup.owe(2)).toBe(false); // no child yet: nothing to owe it to
    h.sup.send(sample(0)); await turn();
    expect(h.owed()).toMatchObject({ owed: 1 });
    expect(h.sup.owe(3)).toBe(true);
    expect(h.owedWrites).toEqual([1]); // nothing durable inside the call
    await turn();
    expect(h.owed()).toMatchObject({ owed: 4, closed: false }); // 1 sent + 3 owed with no line
    expect(h.children[0]!.writes).toHaveLength(1); // no line went to the pipe for them
    mkdirSync(join(h.dir, `write-owed.${h.sessions[0]}.json.${process.pid}.tmp`)); // the next record cannot be written
    h.sup.owe(2); await turn(); await new Promise((r) => setTimeout(r, 30));
    expect(h.owed()).toMatchObject({ owed: 4 });
    rmSync(join(h.dir, `write-owed.${h.sessions[0]}.json.${process.pid}.tmp`), { recursive: true });
    await new Promise((r) => setTimeout(r, 60)); // the retry
    expect(h.owed()).toMatchObject({ owed: 6 });
    h.sup.closeOwed(); expect(h.owed()).toMatchObject({ owed: 6, closed: true });
    h.done();
  });

  test('G3: wired together, a sampler whose follow-up loss-only line is refused by the real supervisor leaves the remainder owed in the durable record, so owed exceeds what a worker can settle and status cannot read measured', async () => {
    const h = harness({ maxBufferedBytes: 50 }); // the main line (about 100 bytes) fills the byte budget: the next sample line is refused
    let refuse = 10_001;
    const sampler = createWriteSampler({ rate: 1, random: () => 0, active: () => true, send: (line) => { if (refuse > 0) { refuse--; return false; } return h.sup.send(line); }, owe: (n) => h.sup.owe(n) });
    const fn = async () => 1; const ctx = { engine: {}, inTransaction: false, mayWrite: () => true };
    const wrap = () => (sampler.wrap('addTag', fn, ctx as never) as () => Promise<unknown>)();
    for (let i = 0; i < 10_001; i++) await wrap();
    await wrap(); await turn();
    const weights = h.children[0]!.writes.map(sampleWeight);
    expect(weights).toEqual([10_001]); // the main line (1 + 10,000); the extra line was refused by the supervisor
    expect(h.owed()).toMatchObject({ owed: 10_002 }); // and the one remaining sample is owed, durably: 10,001 + 1 (was 10,001: it waited only in memory)
    h.done();
  });

  test('a line whose write throws at the flush is still owed (the record was written first): the child books it lost; it was accepted, not refused', async () => {
    const h = harness();
    h.sup.send(sample(0));
    h.children[0]!.stdin.write = () => { throw new Error('closed'); };
    expect(h.sup.send(sample(1))).toBe(true); // was false: the write threw inside send() and the line was not counted
    await turn();
    h.sup.closeOwed();
    expect(h.owed()).toMatchObject({ owed: 2, closed: true });
    h.done();
  });

  // S2d: an owed record that could not be written is the only copy of an obligation the sampler already let go of (`owe(n)`, or lines staged behind the record). It must survive the worker's exit and the respawn.
  describe('S2d: a failed owed-record write is kept in the serving process and retried until it is durable', () => {
    const NOW_S2D = new Date('2026-12-01T00:00:00Z');
    const INPUTS_S2D = { seed_id: 's', rust_addon_sha256: 'a', comparator_version: 1, adapter_version: 'x', capability_set_hash: null, readiness_policy_hash: 'p' } as const;
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    /** A disk that refuses the owed record while `disk.failing` is set (what ENOSPC or EIO does), through the supervisor's own writer seam. */
    function flakyHarness(overrides: Record<string, unknown> = {}) {
      const disk = { failing: false }; let clock = 1_000_000; const okWrites: number[] = []; const attempts: number[] = [];
      const h = harness({ maxBufferedBytes: 1_000_000, now: () => clock, minBackoffMs: 10, maxBackoffMs: 10, writeOwed: (d: string, rec: OwedRecord) => { attempts.push(Date.now()); if (disk.failing) throw new Error('ENOSPC'); writeOwed(d, rec); okWrites.push(rec.owed); }, ...overrides });
      const epoch = ensureEpoch(h.dir, INPUTS_S2D, NOW_S2D.getTime()).epoch_id;
      /** The worker's tally: 1,000 passing comparisons and the samples it settled per session, so only an unsettled obligation can keep status from reading measured. */
      const settle = (settled: Record<string, number>): void => writeFileSync(join(h.dir, 'write-comparisons.json'), JSON.stringify({ version: 1, epoch_id: epoch, updated_at: '', comparable: 1000, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, capability_missing_by_family: {}, uncomparable_by_reason: {}, in_flight: [], settled }) + '\n');
      const status = () => buildFollowStatus(h.dir, { sample_rate: 0.1 } as never, NOW_S2D).write_comparisons!;
      const respawn = async (i: number): Promise<void> => { h.children[i]!.emit('exit', 1, null); clock += 100; };
      return { ...h, disk, okWrites, attempts, settle, status, respawn, clockBack: () => { clock -= 100; }, clockAdvance: (ms: number) => { clock += ms; } };
    }

    test('the reader\'s case: owe(1) cannot be written, the worker exits, the disk recovers and the worker respawns: the old session\'s sample stays outstanding, never measured', async () => {
      const h = flakyHarness();
      h.sup.send(sample(0)); await turn(); const old = h.sessions[0]!;
      expect(h.owed(0)).toMatchObject({ owed: 1 });
      h.settle({ [old]: 1 });
      expect(h.status()).toMatchObject({ state: 'measured' }); // the first sample is settled: nothing is owed
      h.disk.failing = true;
      expect(h.sup.owe(1)).toBe(true); // the sampler's backlog is gone: this process holds the only copy of the obligation
      await turn(); await wait(40); // the flush and its retries fail
      await h.respawn(0); // the worker exits while the disk still refuses the record
      await wait(40);
      h.disk.failing = false; // the disk recovers
      expect(h.sup.send(sample(1))).toBe(true); expect(h.children).toHaveLength(2); // a new worker, a new session
      await turn(); await wait(60);
      h.settle({ [old]: 1, [h.sessions[1]!]: 1 }); // the old worker settled one sample; the new one settled its own
      expect(h.status()).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, outstanding_sessions: [`write-owed.${old}.json`] }); // was measured, with the second sample in no file
      expect(h.owed(0)).toMatchObject({ owed: 2, child_exited: true }); // was owed: 1, and nothing ever published the second
      h.done();
    });

    test('with no respawn at all, the kept record is published as soon as the disk recovers (a retry, not the next send)', async () => {
      const h = flakyHarness();
      h.sup.send(sample(0)); await turn(); const old = h.sessions[0]!; h.settle({ [old]: 1 });
      h.disk.failing = true; h.sup.owe(2); await turn(); await wait(30);
      await h.respawn(0); await wait(30);
      expect(h.owed(0)).toMatchObject({ owed: 1 }); // still the old record: the disk refuses
      expect(h.status()).toMatchObject({ state: 'capability_missing', outstanding_sessions: [`write-pending.${old}.json`] }); // the marker holds status closed while the disk refuses (was measured: nothing could say otherwise)
      h.disk.failing = false; await wait(80);
      expect(h.owed(0)).toMatchObject({ owed: 3, child_exited: true });
      expect(existsSync(join(h.dir, `write-pending.${old}.json`))).toBe(false); // cleared in the same lock hold as the publish
      expect(h.status()).toMatchObject({ state: 'capability_missing', outstanding_sessions: [`write-owed.${old}.json`] });
      h.done();
    });

    test('every old session that could not publish is kept, each with its own count, through two worker exits', async () => {
      const h = flakyHarness();
      h.sup.send(sample(0)); await turn(); const first = h.sessions[0]!;
      h.disk.failing = true; h.sup.owe(1); await turn(); await h.respawn(0);
      h.sup.send(sample(1)); await turn(); await wait(30); const second = h.sessions[1]!; // the second worker's first record cannot be written either
      expect(h.sup.owe(3)).toBe(true); await turn(); await h.respawn(1);
      h.disk.failing = false; await wait(80);
      expect(h.owed(0)).toMatchObject({ owed: 2, child_exited: true });
      expect(h.owed(1)).toMatchObject({ owed: 4, child_exited: true }); // its own sample (staged behind the record that was never written) and the 3 owed
      expect(first).not.toBe(second);
      h.done();
    });

    test('stop() with the record unwritable keeps the closed record too: the child ends its input on the older one, and the full count is published when the disk recovers', async () => {
      const h = flakyHarness();
      h.sup.send(sample(0)); await turn();
      h.disk.failing = true; h.sup.owe(1); await turn();
      h.sup.stop(); await wait(30);
      expect(h.owed(0)).toMatchObject({ owed: 1 });
      h.disk.failing = false; await wait(80);
      expect(h.owed(0)).toMatchObject({ owed: 2, closed: true });
      h.done();
    });

    test('ship-r2: stop() before the queued owe flush runs keeps the close: the queued flush (writes still failing) rebuilds the record with no worker, and the kept record still publishes closed', async () => {
      const h = flakyHarness({ retryMs: 60_000 });
      try {
        h.sup.send(sample(0)); await turn();
        h.disk.failing = true; h.sup.owe(1); h.sup.stop(); // stop() leaves the owe-only flush queued; its closed record cannot be written and is kept
        await turn(); // the queued flush runs with no worker and the disk still refusing
        h.disk.failing = false; h.sup.publishKeptNow();
        expect(h.owed(0)).toMatchObject({ owed: 2, closed: true });
      } finally { h.done(); }
    });

    test('ship-r3: a remover paused under the tally lock after it read a settled owed:1 cannot delete the owed:2 that a stop()-path publication writes meanwhile: the record is kept and republished, and the extra sample is still owed', async () => {
      const fsm = await import('node:fs');
      const h = flakyHarness({ retryMs: 60_000 });
      const { WriteTally } = await import('../src/shadow/write-compare.ts');
      const epoch = (): string => ensureEpoch(h.dir, INPUTS_S2D, NOW_S2D.getTime()).epoch_id;
      const lock = join(h.dir, 'write-comparisons.lock'); const tallyFile = join(h.dir, 'write-comparisons.json');
      const realRead = fsm.readFileSync; let paused = false; let s0 = '';
      // The seam is the one the D1-F2 tests use: the remover's last read, the tally's settled count, taken under the lock right before it unlinks. What the serving process does next happens "while the remover is paused".
      const spy = spyOn(fsm, 'readFileSync').mockImplementation(((path: unknown, ...rest: unknown[]) => {
        const out = (realRead as (...a: unknown[]) => unknown)(path, ...rest);
        if (!paused && String(path) === tallyFile && existsSync(lock)) {
          paused = true;
          h.disk.failing = true; h.sup.owe(1); h.sup.stop(); // the close-time write fails: the record is kept and marked; stop() leaves the owe flush queued
          h.disk.failing = false; (h.sup as unknown as { flushStaged(): boolean }).flushStaged(); // the disk is back and the queued flush runs, as it would in its own turn
        }
        return out;
      }) as never);
      try {
        h.sup.send(sample(0)); await turn(); s0 = h.sessions[0]!; h.settle({ [s0]: 1 });
        writeOwed(h.dir, { v: 1, session: s0, serving_pid: process.pid, owed: 1, closed: true, child_exited: true }); // the record the remover judges: settled, its session over
        new WriteTally(h.dir, epoch, () => true, process.pid, 'owner').recover(); // the owner's pass removes the settled record; the interleaving happens inside it
        expect(paused).toBe(true);
      } finally { spy.mockRestore(); }
      try {
        h.sup.publishKeptNow(); // the keeper's own try, with the disk fine and the lock free
        expect(h.owed(0)).toMatchObject({ owed: 2, closed: true }); // was: gone (unlinked on the owed:1 it judged), and nothing kept to republish it
        expect(existsSync(join(h.dir, `write-pending.${s0}.json`))).toBe(false);
        expect(h.status()).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, outstanding_sessions: [`write-owed.${s0}.json`] }); // the second sample is owed, not measured
        new WriteTally(h.dir, epoch, () => true, process.pid, 'owner').recover();
        expect(h.owed(0)).toMatchObject({ owed: 2 }); // one settled of two: the file stays until the worker books the other
        h.settle({ [s0]: 2 }); // booked once
        expect(h.status()).toMatchObject({ state: 'measured' });
      } finally { h.done(); }
    });

    // ---- D1 (second read of the plan): the marker's own durability, the live-worker window, refused samples ----
    test('D1-F1: the marker\'s directory entry is flushed after the link; a failed flush leaves it unpublished and it is retried until the flush succeeds', async () => {
      const durable = await import('../src/core/fs-durable.ts');
      const h = flakyHarness();
      h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!; h.settle({ [s0]: 1 });
      const real = durable.flushDirectory; let linkFlushes = 0; let failOnce = true;
      const spy = spyOn(durable, 'flushDirectory').mockImplementation(((path: string, options?: unknown) => {
        if (existsSync(join(h.dir, `write-pending.${s0}.json`))) { linkFlushes++; if (failOnce) { failOnce = false; throw new Error('EIO'); } }
        return (real as (p: string, o?: unknown) => void)(path, options);
      }) as never);
      try {
        h.disk.failing = true; h.sup.owe(1); await turn(); await wait(80);
        expect(existsSync(join(h.dir, `write-pending.${s0}.json`))).toBe(true); // linked
        expect(linkFlushes).toBeGreaterThanOrEqual(2); // the first flush failed, so the marker was not taken as published and was flushed again
        expect(h.status()).toMatchObject({ state: 'capability_missing', outstanding_sessions: [`write-pending.${s0}.json`] });
      } finally { spy.mockRestore(); h.done(); }
    });

    test('D1-F1: a live worker whose owed record cannot be written is covered at once (no exit needed): the marker blocks status while the worker runs', async () => {
      const h = flakyHarness();
      try {
        h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!; h.settle({ [s0]: 1 });
        expect(h.status()).toMatchObject({ state: 'measured' });
        h.disk.failing = true; h.sup.owe(2); await turn();
        expect(h.status()).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, outstanding_sessions: [`write-pending.${s0}.json`] });
        h.disk.failing = false; await wait(80);
        expect(h.owed(0)).toMatchObject({ owed: 3 });
        expect(existsSync(join(h.dir, `write-pending.${s0}.json`))).toBe(false);
      } finally { h.done(); }
    });

    test('D1-F3: a sample refused while no worker runs, whose lost-line append also fails, is owed durably (kept, marked, retried) and blocks status after the disk recovers with no further send', async () => {
      const h = flakyHarness();
      const epoch = ensureEpoch(h.dir, INPUTS_S2D, NOW_S2D.getTime()).epoch_id;
      const { recordLost, lostPath } = await import('../src/shadow/write-compare.ts');
      try {
        h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!; h.settle({ [s0]: 1 });
        await h.respawn(0); // the worker exits; the restart backoff refuses the next samples
        mkdirSync(lostPath(h.dir, process.pid)); // lost-line appends fail; so does the owed writer
        h.disk.failing = true;
        const sampler = createWriteSampler({ rate: 1, random: () => 0, active: () => true, send: (line: string) => h.sup.send(line), owe: (n: number) => h.sup.owe(n),
          lost: (reason: string) => recordLost(h.dir, epoch, reason), refuse: (n: number) => h.sup.oweRefused(n) });
        const fn = async () => 1; const ctx = { engine: {}, inTransaction: false, mayWrite: () => true };
        h.clockBack(); await (sampler.wrap('addTag', fn, ctx as never) as () => Promise<unknown>)(); await turn();
        expect(h.children).toHaveLength(1); // refused: no new worker inside the backoff
        h.disk.failing = false; rmSync(lostPath(h.dir, process.pid), { recursive: true }); // the disk recovers; nothing else is sent
        await wait(120);
        const names = readdirSync(h.dir).filter((n) => /^write-owed\.r/.test(n));
        expect(names).toHaveLength(1); // the refused sample's own record
        expect(h.status()).toMatchObject({ state: 'capability_missing', outstanding_sessions: [names[0]] }); // was measured: the count lived only in the sampler's memory
      } finally { h.done(); }
    });

    test('D1-F3: the refused samples\' kept record is booked once by the next owner worker as uncomparable receipt_orphaned, and status returns to measured', async () => {
      const h = flakyHarness();
      const { WriteTally, readWriteTally } = await import('../src/shadow/write-compare.ts');
      try {
        h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!; h.settle({ [s0]: 1 });
        await h.respawn(0); h.clockBack();
        expect(h.sup.oweRefused(3)).toBe(true); expect(h.sup.oweRefused(2)).toBe(true); // both ride one record
        await wait(40);
        const names = readdirSync(h.dir).filter((n) => /^write-owed\.r/.test(n)); expect(names).toHaveLength(1);
        expect(readOwed(h.dir, names[0]!.slice('write-owed.'.length, -'.json'.length))).toMatchObject({ owed: 5, closed: true, child_exited: true });
        expect(h.status()).toMatchObject({ state: 'capability_missing', outstanding_sessions: [names[0]] });
        new WriteTally(h.dir, () => epoch(), () => true, process.pid, 'owner').recover(); // the next owner worker's pass
        expect(readWriteTally(h.dir, epoch())!.uncomparable).toBe(5);
        expect(readWriteTally(h.dir, epoch())!.uncomparable_by_reason).toMatchObject({ receipt_orphaned: 5 });
        expect(readdirSync(h.dir).filter((n) => /^write-owed\.r/.test(n))).toEqual([]);
        expect(h.status()).toMatchObject({ state: 'measured' });
      } finally { h.done(); }
      function epoch(): string { return ensureEpoch(h.dir, INPUTS_S2D, NOW_S2D.getTime()).epoch_id; }
    });

    test('D1-F4: nothing durable (no writer call, no link, no flush) runs inside send(), on a cold start or a respawn; the first writer call comes in a later turn', async () => {
      const durable = await import('../src/core/fs-durable.ts');
      const calls: string[] = []; const real = durable.flushDirectory;
      const spy = spyOn(durable, 'flushDirectory').mockImplementation(((path: string, options?: unknown) => { calls.push('flush'); return (real as (p: string, o?: unknown) => void)(path, options); }) as never);
      const h = flakyHarness({ writeOwed: (d: string, rec: OwedRecord) => { calls.push('write'); writeOwed(d, rec); } });
      try {
        calls.length = 0; // construction is not a request
        expect(h.sup.send(sample(0))).toBe(true); expect(calls).toEqual([]); // cold start
        await turn(); expect(calls).toContain('write');
        await h.respawn(0); calls.length = 0;
        expect(h.sup.send(sample(1))).toBe(true); expect(h.children).toHaveLength(2); expect(calls).toEqual([]); // respawn
        await turn(); expect(calls).toContain('write');
      } finally { spy.mockRestore(); h.done(); }
    });

    test('fallback chain: a session whose very first record cannot be written (no record yet) still gets a marker (child.log, else state.json) that blocks status and stays until the record is durable', async () => {
      const h = flakyHarness({ retryMs: 60_000 }); // no retry inside the test: nothing but an operator or the retry would clear it
      try {
        h.disk.failing = true;
        h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!;
        expect(existsSync(join(h.dir, `write-owed.${s0}.json`))).toBe(false); // no record yet
        expect(statSync(join(h.dir, `write-pending.${s0}.json`)).ino).toBe(statSync(join(h.dir, 'child.log')).ino); // linked to child.log
        expect(h.status()).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, pending_markers: [join(h.dir, `write-pending.${s0}.json`)] });
        await wait(30); expect(existsSync(join(h.dir, `write-pending.${s0}.json`))).toBe(true); // nothing cleared it
        // no child.log: the chain falls to state.json
        rmSync(join(h.dir, `write-pending.${s0}.json`)); rmSync(join(h.dir, 'child.log')); writeFileSync(join(h.dir, 'state.json'), '{}');
        expect((h.sup as unknown as { markPending(s: string): boolean }).markPending(s0)).toBe(true);
        expect(statSync(join(h.dir, `write-pending.${s0}.json`)).ino).toBe(statSync(join(h.dir, 'state.json')).ino);
      } finally { h.done(); }
    });

    test('named limit 1: when the hard-link call itself fails, the record is still kept and retried and is published after the disk recovers (status cannot see it meanwhile)', async () => {
      const fs = await import('node:fs');
      const h = flakyHarness();
      const spy = spyOn(fs, 'linkSync').mockImplementation((() => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); }) as never);
      try {
        h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!; h.settle({ [s0]: 1 });
        h.disk.failing = true; h.sup.owe(1); await turn(); await wait(40);
        expect(existsSync(join(h.dir, `write-pending.${s0}.json`))).toBe(false); // the limit: no marker
        expect(h.status()).toMatchObject({ state: 'measured' }); // and so status cannot see it
        h.disk.failing = false; spy.mockRestore(); await wait(150);
        expect(h.owed(0)).toMatchObject({ owed: 2 }); // kept and retried: durable after recovery
        expect(h.status()).toMatchObject({ state: 'capability_missing', outstanding_sessions: [`write-owed.${s0}.json`] });
      } finally { spy.mockRestore(); h.done(); }
    });

    test('the exit hook publishes a kept record at once, for a supervisor with no worker, without waiting for the retry timer', async () => {
      const h = flakyHarness({ retryMs: 60_000 });
      try {
        h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!; h.settle({ [s0]: 1 });
        h.disk.failing = true; h.sup.owe(2); await turn(); await h.respawn(0);
        expect(h.owed(0)).toMatchObject({ owed: 1 });
        h.disk.failing = false;
        closeAllOwedAtExit(); // the process is exiting: the timer would be too late
        expect(h.owed(0)).toMatchObject({ owed: 3, child_exited: true });
        expect(existsSync(join(h.dir, `write-pending.${s0}.json`))).toBe(false);
      } finally { h.done(); }
    });

    test('a publish that cannot take the tally lock defers: nothing is written and nothing is removed until the lock is free', async () => {
      const { withLock } = await import('../src/shadow/evidence-epoch.ts');
      const h = flakyHarness({ retryMs: 60_000 });
      try {
        h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!;
        h.disk.failing = true; h.sup.owe(1); await turn(); await h.respawn(0); h.disk.failing = false;
        withLock(join(h.dir, 'write-comparisons.lock'), () => { closeAllOwedAtExit(); }); // another process holds the lock
        expect(h.owed(0)).toMatchObject({ owed: 1 });
        expect(existsSync(join(h.dir, `write-pending.${s0}.json`))).toBe(true);
        closeAllOwedAtExit();
        expect(h.owed(0)).toMatchObject({ owed: 2 });
        expect(existsSync(join(h.dir, `write-pending.${s0}.json`))).toBe(false);
      } finally { h.done(); }
    }, 15_000);

    test('a marker that cannot be cleared after the record is durable is retried alone: the record is never written again', async () => {
      const fs = await import('node:fs');
      const h = flakyHarness();
      const realRm = fs.rmSync; let failClear = 0;
      const spy = spyOn(fs, 'rmSync').mockImplementation(((p: unknown, ...rest: unknown[]) => { if (String(p).includes('write-pending.') && failClear > 0) { failClear--; throw new Error('EIO'); } return (realRm as (...a: unknown[]) => unknown)(p, ...rest); }) as never);
      try {
        h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!;
        h.disk.failing = true; h.sup.owe(1); await turn(); failClear = 2;
        h.disk.failing = false; await wait(150);
        expect(h.owed(0)).toMatchObject({ owed: 2 });
        expect(existsSync(join(h.dir, `write-pending.${s0}.json`))).toBe(false); // cleared on a later try
        expect(h.okWrites.filter((n) => n === 2)).toHaveLength(1); // written once, never again for the clean-up
      } finally { spy.mockRestore(); h.done(); }
    });

    test('the retry backs off while it keeps failing and nothing is dropped: many kept sessions across restart-window rollovers are all published after recovery', async () => {
      const h = flakyHarness({ restartWindowMs: 1_000, maxRestarts: 100 });
      try {
        h.sup.send(sample(0)); await turn(); h.disk.failing = true;
        for (let i = 0; i < 8; i++) { h.sup.owe(1); await turn(); await h.respawn(i); h.clockAdvance(5_000); if (i < 7) { h.sup.send(sample(i + 1)); await turn(); } }
        await wait(100); h.attempts.length = 0; await wait(400);
        expect(h.attempts.length).toBeGreaterThanOrEqual(8); expect(h.attempts.length).toBeLessThan(60); // 8 kept sessions, each retried at a doubling delay (10 ms to 500 ms), not in a tight loop
        h.disk.failing = false; await wait(1_200);
        expect(readdirSync(h.dir).filter((n) => n.startsWith('write-pending.'))).toEqual([]);
        for (let i = 0; i < 8; i++) expect(h.owed(i)).toMatchObject({ child_exited: true });
      } finally { h.done(); }
    }, 30_000);

    // ---- /ship round 1: three findings on the keeper (the timer, the exit flags, the marker flag) ----
    test('ship-r1 A: during a continuous burst of refused samples (never a pause near a retry interval) every status read taken after two retry intervals from the first refusal blocks, and the marker exists', async () => {
      const h = flakyHarness({ retryMs: 40 });
      try {
        h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!; h.settle({ [s0]: 1 });
        await h.respawn(0); h.disk.failing = true; h.attempts.length = 0;
        const t0 = Date.now(); let maxGap = 0; let last = t0; let reads = 0; const bad: string[] = [];
        h.sup.oweRefused(1);
        while (Date.now() - t0 < 400) {
          await wait(10); const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now;
          h.sup.oweRefused(1); // the burst: a refusal every ~10 ms, status read after each
          if (now - t0 >= 80) { // two retry intervals after the first refusal (one interval, plus a timer's lateness)
            reads++; const st = h.status().state; const markers = readdirSync(h.dir).filter((n) => /^write-pending\.r/.test(n)).length;
            if (st === 'measured' || markers !== 1) bad.push(`${now - t0}ms:${st}:markers=${markers}`);
          }
        }
        expect(maxGap).toBeLessThan(40); // the burst really was continuous: no gap as long as one retry interval
        expect(reads).toBeGreaterThan(10);
        expect(bad).toEqual([]);
        expect(h.attempts.length).toBeGreaterThan(0);
      } finally { h.done(); }
    });

    test('ship-r1 A: successful samples cannot postpone the clearing of a marker whose record is already durable', async () => {
      const h = flakyHarness({ retryMs: 40 });
      try {
        h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!; h.settle({ [s0]: 1 });
        h.disk.failing = true; h.sup.owe(1); await turn();
        expect(existsSync(join(h.dir, `write-pending.${s0}.json`))).toBe(true);
        h.disk.failing = false; h.settle({ [s0]: 2 });
        const until = Date.now() + 400; let cleared = false;
        while (Date.now() < until) { h.sup.owe(1); await wait(10); h.settle({ [s0]: (h.owed(0) as { owed: number }).owed }); if (!existsSync(join(h.dir, `write-pending.${s0}.json`))) { cleared = true; break; } } // traffic keeps arriving, each sample a flush
        expect(cleared).toBe(true);
      } finally { h.done(); }
    });

    test('ship-r1 B: a flush queued before the worker exited cannot downgrade the kept exit record: child_exited stays true and the next owner pass books the samples', async () => {
      const h = flakyHarness({ retryMs: 60_000 });
      const { WriteTally, readWriteTally } = await import('../src/shadow/write-compare.ts');
      const epoch = (): string => ensureEpoch(h.dir, INPUTS_S2D, NOW_S2D.getTime()).epoch_id;
      try {
        h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!; h.settle({ [s0]: 1 });
        h.disk.failing = true;
        h.sup.owe(1); // the owe-only flush is queued for the next turn ...
        await h.respawn(0); // ... and the worker exits before it runs: the exit-time record cannot be written and is kept
        const afterExit = h.attempts.length;
        await turn(); // the queued flush runs now, with no worker
        expect(h.attempts.length).toBe(afterExit); // and finds nothing left to write: no second attempt for a session whose worker is gone
        h.disk.failing = false; h.sup.publishKeptNow();
        expect(h.owed(0)).toMatchObject({ owed: 2, child_exited: true });
        new WriteTally(h.dir, epoch, () => true, process.pid, 'owner').recover();
        expect(readWriteTally(h.dir, epoch())!.uncomparable_by_reason).toMatchObject({ receipt_orphaned: 1 });
        expect(readdirSync(h.dir).filter((n) => n.startsWith('write-owed.'))).toEqual([]);
      } finally { h.done(); }
    });

    test('ship-r1 C: a marker removed whose directory flush then failed is not still counted as published: the next failed write makes its marker again', async () => {
      const durable = await import('../src/core/fs-durable.ts');
      const h = flakyHarness({ retryMs: 60_000 });
      const real = durable.flushDirectory; let failOnce = true; let marker = '';
      const spy = spyOn(durable, 'flushDirectory').mockImplementation(((path: string, options?: unknown) => {
        if (marker && failOnce && !existsSync(marker)) { failOnce = false; throw new Error('EIO'); }
        return (real as (p: string, o?: unknown) => void)(path, options);
      }) as never);
      try {
        h.sup.send(sample(0)); await turn(); const s0 = h.sessions[0]!; h.settle({ [s0]: 1 }); marker = join(h.dir, `write-pending.${s0}.json`);
        h.disk.failing = true; h.sup.owe(2); await turn();
        expect(existsSync(marker)).toBe(true);
        h.disk.failing = false; h.sup.publishKeptNow(); // the record is written and the marker unlinked, then the flush throws
        expect(failOnce).toBe(false); expect(h.owed(0)).toMatchObject({ owed: 3 });
        h.disk.failing = true; h.sup.owe(1); await turn(); // a later record fails too
        expect(existsSync(marker)).toBe(true);
        expect(h.status()).toMatchObject({ state: 'capability_missing', outstanding_sessions: [`write-pending.${s0}.json`] });
      } finally { spy.mockRestore(); h.done(); }
    });
  });

  test('a sample weighs 1 plus the earlier losses it carries (its last field); a page key named dropped, nested or not, changes nothing', () => {
    expect(sampleWeight(sample(0, 10, ',"dropped":4'))).toBe(5);
    expect(sampleWeight(`{"t":"write","op":"putPage","args":[{"frontmatter":{"dropped":9}}],"pre":{"dropped":7}}\n`)).toBe(1);
    expect(sampleWeight(`{"t":"write","op":"putPage","args":[{"a":{"b":1,"dropped":8}}]}\n`)).toBe(1);
    expect(sampleWeight(`{"t":"write","op":"putPage","dropped":99999999}\n`)).toBe(1); // not a count we wrote (too long): the line is one sample
    expect(sampleWeight(sample(0, 10, ',"dropped":99999'))).toBe(10_001);
    expect(sampleWeight('{"t":"read","op":"getPage"}\n')).toBe(0);
    expect(sampleWeight('{"t":"stats"}\n')).toBe(0);
    const h = harness({ maxBufferedBytes: 1_000_000 });
    h.sup.send(sample(0, 10, ',"dropped":4')); h.sup.send('{"t":"read"}\n'); h.sup.send(`{"t":"write","args":[{"frontmatter":{"dropped":9}}]}\n`);
    h.sup.closeOwed();
    expect(h.owed()).toMatchObject({ owed: 5 + 1 });
    h.done();
  });
});

describe('Bun child stdin write callbacks (what the sample accounting stands on)', () => {
  test('each write callback fires once, after the bytes leave: most are still pending while the reader sleeps, all fire once it reads, none with an error', async () => {
    const { spawn } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-bun-pipe-'));
    const child = spawn('sh', ['-c', `sleep 0.5; cat > "${join(dir, 'out')}"`], { stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      let fired = 0; let failed = 0; const line = 'x'.repeat(1_999) + '\n';
      for (let i = 0; i < 300; i++) child.stdin!.write(line, (error) => { fired++; if (error) failed++; });
      expect(fired).toBeLessThan(300); // 600,000 bytes against a 64 KB pipe and a sleeping reader: not all can have left
      expect(child.stdin!.writableLength).toBe(0); // Bun reports an empty buffer while it holds hundreds of KB: why the count is ours
      child.stdin!.end();
      const start = Date.now(); while (fired < 300 && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 20));
      expect({ fired, failed }).toEqual({ fired: 300, failed: 0 });
    } finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
