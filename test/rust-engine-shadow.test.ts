/**
 * Rust engine shadow mode (docs/designs/RUST_ENGINE.md, Phase S: S1 and the read half of S2). Pure units: the
 * wrapper, the bounded queue, the codec, the classifier, the supervisor with an injected spawn, the child loop with
 * fake engines, the report and the doctor check. CLI, engine-factory and real-child coverage live in
 * rust-engine-shadow.serial.test.ts (they set GBRAIN_HOME).
 */
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { recordAllSentAtExit, sampleWeight, ShadowSupervisor } from '../src/shadow/supervisor.ts';
import { readSent } from '../src/shadow/write-compare.ts';
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

  test('a function-valued accessor such as the Postgres sql client keeps its identity and properties, on the engine and in a transaction', async () => {
    const client = Object.assign(() => 'tag', { unsafe: async () => [], options: { max: 7 }, reserve: async () => ({}) });
    const primary = fakePrimary();
    Object.defineProperty(primary, 'sql', { get: () => client });
    const engine = wrapShadowEngine(primary, sink(), { sampleRate: 1 });
    expect((engine as unknown as { sql: unknown }).sql).toBe(client);
    await engine.transaction(async (tx) => {
      const inner = (tx as unknown as { sql: typeof client }).sql;
      expect(inner).toBe(client);
      expect(inner.options.max).toBe(7);
      expect(typeof inner.unsafe).toBe('function');
    });
  });

  test('a path the engine recorded when it connected is found through the shadow view', async () => {
    const primary = Object.assign(fakePrimary(), { executeRaw: async () => [{ present: false }] });
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
  ended = false;
  stdin = Object.assign(new EventEmitter(), {
    writable: true, destroyed: false, writableLength: 0, unref() {},
    write: (line: string, cb: (error?: Error | null) => void): boolean => { this.held.push({ line, cb }); return false; }, // false: Bun says "backpressure" for most lines of a burst
    end: () => { this.ended = true; if (this.held.length === 0) queueMicrotask(() => this.stdin.emit('finish')); },
  });
  stdout = Object.assign(new PassThrough(), { unref() {} });
  pid = 4343;
  unref() {}
  kill() { return true; }
  flush(n = this.held.length, error?: Error): void { for (const h of this.held.splice(0, n)) h.cb(error ?? null); if (this.ended && this.held.length === 0) queueMicrotask(() => this.stdin.emit('finish')); }
}

describe('supervisor sample accounting (a sample is received, refused and counted, or counted lost by the child from the sent count)', () => {
  const sample = (i: number, pad = 400, extra = ''): string => `{"t":"write","op":"putPage","i":${i},"pad":"${'x'.repeat(pad)}"${extra}}\n`;
  function harness(overrides: Record<string, unknown> = {}) {
    const children: HeldPipeChild[] = []; const sessions: string[] = []; const faults: ShadowFault[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-sample-accounting-'));
    const sup = new ShadowSupervisor({
      dir, argv: ['g'], spawn: ((_cmd: string, _args: string[], options: { env: Record<string, string> }) => { const c = new HeldPipeChild(); children.push(c); sessions.push(options.env.GBRAIN_SHADOW_SESSION!); return c; }) as never,
      recordFault: (f: ShadowFault) => faults.push(f), stillEnabled: () => true, maxBufferedBytes: 1_000, drainMs: 60, ...overrides,
    } as never);
    return { sup, children, sessions, faults, dir, sent: (i = 0) => readSent(dir, sessions[i]!), done: () => { sup.stop(); rmSync(dir, { recursive: true, force: true }); } };
  }

  test('a sample that would pass the byte budget of samples still in the pipe is refused; a write() that returns false alone is not, and other lines are never refused for size', () => {
    const h = harness();
    expect([0, 1, 2, 3].map((i) => h.sup.send(sample(i)))).toEqual([true, true, true, false]); // 3 x ~444 bytes pass 1,000 before the 4th is offered
    expect(h.sup.send('{"t":"read","pad":"' + 'y'.repeat(5_000) + '"}\n')).toBe(true); // a read, a follower line, an ask answer: no new refusal
    h.children[0]!.flush(1);
    expect(h.sup.send(sample(4))).toBe(true); // one left the pipe: room again
    h.sup.recordSent();
    expect(h.sent()).toBe(4); // the refused sample is not in the sent count: its sender counts it send_shed
    h.done();
  });

  test('drain returns as soon as every callback has fired and the child\'s input has ended, and at once when nothing was sent', async () => {
    const h = harness();
    await h.sup.drain(5_000); // no child yet: nothing to wait for
    h.sup.send(sample(0)); h.sup.send(sample(1));
    const started = Date.now();
    const waiting = h.sup.drain(5_000);
    h.children[0]!.flush(); // every callback fires, the child's stdin is ended, and it says it finished
    await waiting;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(h.children[0]!.ended).toBe(true);
    expect(h.sent()).toBe(2);
    h.done();
  });

  test('a pipe that does not flush within the bound does not hold the process: drain returns at the bound, and stop() writes down every sample that was sent', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) h.sup.send(sample(i));
    const started = Date.now();
    await h.sup.drain(60);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(50);
    expect(waited).toBeLessThan(1_000);
    h.sup.stop();
    expect(h.sent()).toBe(3); // the child counts 3 minus what it read; whatever the callbacks said
    h.done();
  });

  test('a clean disconnect (drain, then stop) writes the sent count once: a count the child already took is never written again', async () => {
    const h = harness();
    h.sup.send(sample(0)); h.sup.send(sample(1));
    const waiting = h.sup.drain(5_000);
    h.children[0]!.flush();
    await waiting;
    expect(h.sent()).toBe(2);
    rmSync(join(h.dir, `write-sent.${h.sessions[0]}.json`)); // the child took it and removed it
    h.sup.stop();
    expect(h.sent()).toBeNull(); // before: stop() wrote it again, and the next worker counted two samples that had arrived as lost
    h.done();
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
    h.sup.recordSent();
    expect(h.sent()).toBe(5 + 1);
    h.done();
  });

  test('the exit hook writes the sent count of every supervisor with a running child, and a stopped one already wrote its own', () => {
    const a = harness(); const b = harness(); const c = harness();
    a.sup.send(sample(0)); b.sup.send(sample(0)); b.sup.send(sample(1)); c.sup.send(sample(0));
    b.sup.stop();
    expect(b.sent()).toBe(2);
    rmSync(join(b.dir, `write-sent.${b.sessions[0]}.json`));
    recordAllSentAtExit();
    expect(a.sent()).toBe(1); expect(c.sent()).toBe(1);
    expect(b.sent()).toBeNull(); // stopped: not live, nothing more to write
    a.done(); b.done(); c.done();
  });

  test('a respawned child has a count of its own; a child that died has none (nobody could read it)', () => {
    let clock = 1_000_000;
    const h = harness({ now: () => clock, minBackoffMs: 10, maxBackoffMs: 10 });
    h.sup.send(sample(0)); h.sup.send(sample(1));
    h.children[0]!.emit('exit', 1, null);
    expect(h.sent(0)).toBeNull();
    clock += 100;
    expect(h.sup.send(sample(2))).toBe(true);
    expect(h.children).toHaveLength(2);
    h.sup.recordSent();
    expect(h.sent(1)).toBe(1);
    expect(h.sessions[0]).not.toBe(h.sessions[1]);
    h.done();
  });

  test('a sent count that cannot be written is a fault line, never silent', () => {
    const h = harness();
    h.sup.send(sample(0)); h.sup.send(sample(1));
    rmSync(h.dir, { recursive: true, force: true });
    h.sup.recordSent();
    expect(h.faults.map((f) => [f.kind, f.detail])).toEqual([['write_samples_unrecorded', 'sent_count n=2']]);
    h.done();
  });

  test('a line whose write throws is not accepted and not counted', () => {
    const h = harness();
    h.sup.send(sample(0));
    h.children[0]!.stdin.write = () => { throw new Error('closed'); };
    expect(h.sup.send(sample(1))).toBe(false);
    h.sup.recordSent();
    expect(h.sent()).toBe(1);
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
