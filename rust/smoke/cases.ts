/**
 * The addon proofs. Each case takes the loaded addon and throws if the behavior is wrong.
 * `run.ts` runs all of them under Bun; `selfcheck.ts` runs the ones in `compiledCases` inside a
 * `bun build --compile` executable.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Addon, Pool } from './addon.ts';

export interface Case {
  name: string;
  run(addon: Addon): Promise<void> | void;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Wait until `check` holds, for at most `ms`. */
async function until(what: string, check: () => boolean, ms = 5000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new assert.AssertionError({ message: `timed out waiting for ${what}` });
    await sleep(5);
  }
}

/** The error a synchronous call throws. */
function thrown(call: () => unknown): Error & Record<string, unknown> {
  try {
    call();
  } catch (error) {
    assert.ok(error instanceof Error, 'throws must be real Error objects');
    return error as Error & Record<string, unknown>;
  }
  throw new assert.AssertionError({ message: 'expected the call to throw' });
}

/** Await a promise that must reject, and return the rejection. */
async function rejection(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error, 'rejections must be real Error objects');
    return error as Error & Record<string, unknown>;
  }
  throw new assert.AssertionError({ message: 'expected the promise to reject' });
}

/** A fresh brain directory, removed when `body` ends. */
async function withBrainDir(body: (dir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-store-smoke-'));
  try {
    await body(join(root, 'brain'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


// ---------------------------------------------------------------------------------------------
// Boundary fuzz: hostile input must never panic the engine or end the process.
// ---------------------------------------------------------------------------------------------

/** A small seeded random generator (mulberry32), so a failing run can be replayed exactly. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;

/** Strings that break parsers and escapers. Several are not valid Unicode (lone surrogates). */
const NASTY_STRINGS: readonly string[] = [
  '',
  '\u0000',
  'a\u0000b',
  'people/\u0000alice',
  '\uD800',
  '\uDC00',
  'x\uD83Dy',
  '\uD83D\uDE00',
  '\uDBFF\uDFFF\uD800',
  '\uFFFE\uFFFF\uFDD0',
  '\u202Eevil',
  '\u2028\u2029\u0085',
  '../../etc/passwd',
  'C:\\Windows\\System32',
  "'; DROP TABLE pages; --",
  '%s%n%x',
  '*',
  '"',
  '{"a":',
  'people/alice',
  'default',
  'version',
  'sync.repo',
];

/** A hostile JavaScript value of any shape. `depth` bounds nesting. */
function hostileValue(rng: Rng, depth = 0): unknown {
  const kinds = depth >= 3 ? 14 : 22;
  switch (Math.floor(rng() * kinds)) {
    case 0: return null;
    case 1: return undefined;
    case 2: return rng() < 0.5;
    case 3: return pick(rng, [0, -0, NaN, Infinity, -Infinity, 1e308, -1e308, 5e-324, 2 ** 53, 2 ** 53 + 2, -1, 1.5, 1e21, 2 ** 31, -(2 ** 31) - 1, 4294967296, Number.MAX_SAFE_INTEGER]);
    case 4: return Math.floor((rng() - 0.5) * 2 ** 40);
    case 5:
    case 6: return pick(rng, NASTY_STRINGS);
    case 7: return 'z'.repeat(1 + Math.floor(rng() * 50_000));
    case 8: return Array.from({ length: 1 + Math.floor(rng() * 8) }, () => String.fromCharCode(Math.floor(rng() * 0x10000))).join('');
    case 9: return Symbol('hostile');
    case 10: return () => 1;
    case 11: return new Uint8Array(Math.floor(rng() * 64));
    case 12: return new Float64Array([NaN, Infinity, -0]);
    case 13: return new Date(pick(rng, [0, NaN, 8.64e15, -8.64e15]));
    case 14:
    case 15:
    case 16: return Array.from({ length: Math.floor(rng() * 5) }, () => hostileValue(rng, depth + 1));
    case 17:
    case 18:
    case 19: {
      const object: Record<string, unknown> = {};
      for (let i = Math.floor(rng() * 5); i > 0; i--) {
        object[pick(rng, ['sourceId', 'slug', 'id', 'limit', 'input', 'fact', 'config', 'type', 'where', 'constructor', 'prototype', ...NASTY_STRINGS])] = hostileValue(rng, depth + 1);
      }
      return object;
    }
    case 20: return JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}}}');
    default: return pick(rng, [new Map([[1, 2]]), new Set([1]), /x/g, new Error('hostile'), Object.create(null), new ArrayBuffer(8)]);
  }
}

/** A copy of a valid argument with one thing wrong: a field dropped, retyped or added. */
function mangle(rng: Rng, valid: unknown): unknown {
  const copy = structuredClone(valid) as any;
  const paths: Array<Array<string | number>> = [[]];
  const walk = (node: unknown, here: Array<string | number>) => {
    if (Array.isArray(node)) node.forEach((child, i) => { paths.push([...here, i]); walk(child, [...here, i]); });
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) { paths.push([...here, key]); walk(child, [...here, key]); }
    }
  };
  walk(copy, []);
  const path = pick(rng, paths);
  if (path.length === 0) return hostileValue(rng);
  let parent = copy;
  for (const step of path.slice(0, -1)) parent = parent[step];
  const last = path[path.length - 1]!;
  const op = rng();
  if (op < 0.25) {
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete parent[last];
  } else if (op < 0.85) {
    parent[last] = hostileValue(rng);
  } else if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
    parent[pick(rng, ['extra', '__proto__x', 'constructor', '\u0000', 'sourceId'])] = hostileValue(rng);
  }
  return copy;
}

/** One sampled Brain method and what each argument position is. */
type Slot = 'str' | 'num' | { valid: unknown };
interface FuzzMethod { name: string; slots: Slot[] }

const jobInsert = {
  name: 'work', queue: 'default', status: 'waiting', priority: 0, data: {}, max_attempts: 3,
  backoff_type: 'exponential', backoff_delay: 1000, backoff_jitter: 0.2, on_child_fail: 'fail_parent',
  remove_on_complete: false, remove_on_fail: false, submission_authority: { version: 1, kind: 'application' },
};
const scope = { valid: { sourceId: 'default', includeDeleted: true } };
const searchOptions = { valid: { limit: 5, type: 'note', sources: ['default'] } };

/** About 30 methods across pages, facts (insert, list, withdraw, purge), search, config, sources and jobs. */
const fuzzMethods: FuzzMethod[] = [
  { name: 'readPageSnapshot', slots: ['str', scope] },
  { name: 'putPage', slots: ['str', { valid: { type: 'note', title: 'T', compiled_truth: 'body zebra' } }, { valid: { sourceId: 'default', force: true } }] },
  { name: 'listPages', slots: [{ valid: { limit: 10, type: 'note' } }] },
  { name: 'countPages', slots: [{ valid: { sourceId: 'default' } }] },
  { name: 'softDeletePage', slots: ['str', scope] },
  { name: 'resolveSlugs', slots: ['str', scope] },
  { name: 'lockPageKeys', slots: [{ valid: [{ sourceId: 'default', slug: 'people/alice' }] }] },
  { name: 'insertFact', slots: [{ valid: { input: { fact: 'Alice likes zebras', entity_slug: 'people/alice', source: 's' }, sourceId: 'default' } }] },
  { name: 'listFactsByEntity', slots: [{ valid: { sourceId: 'default', entitySlug: 'people/alice', activeOnly: true, limit: 10 } }] },
  { name: 'expireFact', slots: [{ valid: { id: 1, at: '2026-01-01T00:00:00.000Z' } }] },
  { name: 'expireFactsByWithdrawal', slots: [{ valid: { sourceId: 'default', visibility: 'world', fact: 'Alice likes zebras', subject: 'people/alice' } }] },
  { name: 'planFactPurgeIds', slots: [{ valid: { sourceId: 'default', visibility: 'world', factHash: 'abc', subject: '*' } }] },
  { name: 'insertFactPurge', slots: [{ valid: { sourceId: 'default', visibility: 'world', subject: 'people/alice', factHash: 'abc', requestId: '00000000-0000-4000-8000-000000000002', actor: 't', reason: 'fuzz' } }] },
  { name: 'searchKeyword', slots: ['str', searchOptions] },
  { name: 'searchKeywordChunks', slots: ['str', searchOptions] },
  { name: 'countKeywordPages', slots: ['str', searchOptions] },
  { name: 'getConfig', slots: ['str'] },
  { name: 'setConfig', slots: ['str', 'str'] },
  { name: 'listConfigKeys', slots: ['str'] },
  { name: 'getConfigValues', slots: [{ valid: ['version', 'sync.repo'] }] },
  { name: 'upsertSource', slots: [{ valid: { id: 'notes', name: 'Notes', config: { federated: true } } }] },
  { name: 'updateSourceConfig', slots: ['str', { valid: { federated: false } }] },
  { name: 'getSourceById', slots: ['str'] },
  { name: 'admitJob', slots: [{ valid: { insert: jobInsert, maxSpawnDepth: 5 } }] },
  { name: 'listJobs', slots: [{ valid: { status: 'waiting', limit: 10 } }] },
  { name: 'claimNextJob', slots: [{ valid: { lockToken: 'w:1', lockDurationMs: 30000, queue: 'default', names: ['work'], suspectMark: 'watchdog_suspect', handlerTimeouts: {}, handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 } } }] },
  { name: 'getJob', slots: ['num'] },
  { name: 'completeJob', slots: ['num', 'str', { valid: { ok: true } }] },
  { name: 'renewJobLease', slots: ['num', 'str', 'num'] },
];

/** The codes a hostile call may end with: the engine's snake_case codes (never internal_error) and napi's own argument-type codes. */
const NAPI_ARGUMENT_CODES = new Set(['InvalidArg', 'StringExpected', 'NumberExpected', 'ObjectExpected', 'BooleanExpected', 'ArrayExpected']);
function isTypedCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  if (code === 'internal_error') return false;
  return /^[a-z]+(_[a-z]+)*$/.test(code) || NAPI_ARGUMENT_CODES.has(code);
}

/** Builds the arguments for one fuzz call. */
function fuzzArgs(rng: Rng, method: FuzzMethod, call: number): unknown[] {
  return method.slots.map(slot => {
    // The first call to each method is its valid sample, so the method is known to work.
    if (slot === 'str') return call === 0 ? 'people/alice' : rng() < 0.7 ? pick(rng, NASTY_STRINGS) : hostileValue(rng);
    if (slot === 'num') return call === 0 ? 1 : rng() < 0.7 ? hostileNumber(rng) : hostileValue(rng);
    if (call === 0) return slot.valid;
    return rng() < 0.7 ? mangle(rng, slot.valid) : hostileValue(rng);
  });
}

function hostileNumber(rng: Rng): number {
  return pick(rng, [0, -0, NaN, Infinity, -Infinity, 1e308, -1e308, 5e-324, 2 ** 53, 2 ** 53 + 2, -1, 0.5, 1e21, 2 ** 31, 4294967296, Number.MAX_SAFE_INTEGER, 1, 2]);
}

/** Runs one call and returns how it ended: 'ok', or the error it threw or rejected with. */
async function settle(call: () => Promise<unknown>): Promise<'ok' | (Error & Record<string, unknown>)> {
  try {
    await call();
    return 'ok';
  } catch (error) {
    assert.ok(error instanceof Error, `a failure must be a real Error, got ${String(error)}`);
    return error as Error & Record<string, unknown>;
  }
}

export const cases: Case[] = [
  {
    name: 'metadata: target, abi, build hash, catalog version, format versions',
    run(addon) {
      assert.match(addon.target, /^(linux|darwin|win32)-(x64|arm64)(-(glibc|musl))?$/);
      assert.equal(addon.engineAbi, 1);
      assert.match(addon.engineBuild, /^[0-9a-f]{64}$/);
      assert.equal(addon.catalogVersion, 0);
      // Every format from 1 to the newest this build writes (never pinned as a literal); 9 holds the keyed lookups.
      const newest = Math.max(...addon.formatVersions);
      assert.ok(newest >= 9, `newest store format ${newest}`);
      assert.deepEqual(addon.formatVersions, Array.from({ length: newest }, (_, i) => i + 1));
    },
  },
  {
    name: 'event loop stays free: a timer fires while a native task runs',
    async run(addon) {
      const pool = new addon.Pool(2);
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      const startedAt = performance.now();
      try {
        assert.equal(await pool.blockFor(300), 300);
      } finally {
        clearInterval(timer);
      }
      assert.ok(performance.now() - startedAt >= 290, 'the task waited for its full time');
      // A blocked loop would give 0 or 1 ticks. 300 ms at 10 ms is about 30; allow a lot of slack.
      assert.ok(ticks >= 10, `timer fired only ${ticks} times during a 300 ms native task`);
      await pool.shutdown(1000);
    },
  },
  {
    name: 'typed arrays: sync sum, scale, in-place scale, offset views, empty array',
    run(addon) {
      assert.equal(addon.sumF32(new Float32Array([1, 2, 3.5])), 6.5);
      const input = new Float32Array([1, 2, 3]);
      const scaled = addon.scaleF32(input, 2);
      assert.deepEqual([...scaled], [2, 4, 6]);
      assert.deepEqual([...input], [1, 2, 3], 'scaleF32 leaves its input alone');
      assert.notEqual(scaled.buffer, input.buffer, 'scaleF32 returns a new array');
      const mutable = new Float32Array([1, 2, 3]);
      assert.equal(addon.scaleInPlaceF32(mutable, 3), 3);
      assert.deepEqual([...mutable], [3, 6, 9], 'scaleInPlaceF32 writes into the caller array');
      const window = new Float32Array([5, 1, 2, 5]);
      addon.scaleInPlaceF32(window.subarray(1, 3), 10);
      assert.deepEqual([...window], [5, 10, 20, 5], 'an offset view only touches its own window');
      // A view into the middle of a larger buffer must read only its own window.
      const backing = new Float32Array([100, 100, 1, 2, 3, 100]);
      assert.equal(addon.sumF32(backing.subarray(2, 5)), 6);
      assert.equal(addon.sumF32(new Float32Array(0)), 0);
      assert.equal(addon.scaleF32(new Float32Array(0), 3).length, 0);
    },
  },
  {
    name: 'typed arrays: async calls copy the input before returning',
    async run(addon) {
      const pool = new addon.Pool(1);
      // Occupy the only worker so the sum is still queued when the array changes below.
      const busy = pool.blockFor(100);
      const values = new Float32Array([1, 2, 3]);
      const sum = pool.sumF32(values);
      const scaled = pool.scaleF32(values, 10);
      values.fill(1000);
      assert.equal(await sum, 6, 'the sum used the values at call time');
      assert.deepEqual([...(await scaled)], [10, 20, 30]);
      await busy;
      assert.equal(await pool.sumF32(new Float32Array(0)), 0);
      await pool.shutdown(1000);
    },
  },
  {
    name: 'panics: a sync panic is a typed Error and the process keeps working',
    run(addon) {
      let caught: (Error & Record<string, unknown>) | undefined;
      try {
        addon.probePanicSync();
      } catch (error) {
        caught = error as Error & Record<string, unknown>;
      }
      assert.ok(caught instanceof Error);
      assert.equal(caught.code, 'internal_error');
      assert.match(String(caught.diagnosticId), /^gbrain-\d+-\d+$/);
      assert.ok(!caught.message.includes('on purpose'), 'the panic text must not reach callers');
      assert.equal(addon.sumF32(new Float32Array([4])), 4, 'the next call still works');
    },
  },
  {
    name: 'panics: an async panic rejects, and the same pool runs the next task',
    async run(addon) {
      const pool = new addon.Pool(1);
      const error = await rejection(pool.probePanic());
      assert.equal(error.code, 'internal_error');
      assert.match(String(error.diagnosticId), /^gbrain-\d+-\d+$/);
      assert.equal(await pool.sumF32(new Float32Array([1, 2])), 3, 'the only worker survived');
      assert.equal(pool.state, 'running');
      await pool.shutdown(1000);
    },
  },
  {
    name: 'cancellation: a token cancelled after start rejects with completedSteps',
    async run(addon) {
      const pool = new addon.Pool(1);
      const token = new addon.CancelToken();
      const controller = new AbortController();
      // The mapping the TypeScript wrapper will use for AbortSignal.
      controller.signal.addEventListener('abort', () => token.cancel());
      const task = pool.runSteps(200, 10, token);
      await sleep(80);
      controller.abort();
      const error = await rejection(task);
      assert.equal(error.code, 'cancelled');
      assert.equal(error.started, true);
      const done = error.completedSteps as number;
      assert.ok(done > 0 && done < 200, `completedSteps was ${done}`);
      assert.equal(token.cancelled, true);
      // Not cancelled: runs to the end.
      assert.equal(await pool.runSteps(3, 5, new addon.CancelToken()), 3);
      // Cancelled before it starts: rejects with started=false and zero steps.
      const early = new addon.CancelToken();
      early.cancel();
      const earlyError = await rejection(pool.runSteps(5, 5, early));
      assert.equal(earlyError.code, 'cancelled');
      assert.equal(earlyError.completedSteps, 0);
      await pool.shutdown(1000);
    },
  },
  {
    name: 'shutdown: queued tasks cancel, running tasks are awaited, later calls reject',
    async run(addon) {
      const pool = new addon.Pool(1);
      const running = pool.blockFor(300);
      const queuedA = rejection(pool.blockFor(10));
      const queuedB = rejection(pool.blockFor(10));
      await until('the first task to start', () => pool.running === 1);
      assert.equal(pool.running, 1);
      assert.equal(pool.queued, 2);
      const startedAt = performance.now();
      const report = await pool.shutdown(5000);
      const waited = performance.now() - startedAt;
      assert.deepEqual(report, { cancelledQueued: 2, finishedRunning: 1, abandonedRunning: 0 });
      assert.ok(waited < 2000, `shutdown took ${waited.toFixed(0)} ms`);
      assert.equal(await running, 300, 'the running task finished normally');
      for (const error of await Promise.all([queuedA, queuedB])) {
        assert.equal(error.code, 'cancelled');
        assert.equal(error.started, false);
        assert.equal(error.completedSteps, 0);
      }
      assert.equal(pool.state, 'closed');
      assert.equal((await rejection(pool.blockFor(1))).code, 'engine_shutdown');
      assert.equal((await rejection(pool.sumF32(new Float32Array(1)))).code, 'engine_shutdown');
      // Shutting down again is allowed and reports nothing left to do.
      assert.deepEqual(await pool.shutdown(100), {
        cancelledQueued: 0,
        finishedRunning: 0,
        abandonedRunning: 0,
      });
    },
  },
  {
    name: 'shutdown: the wait is bounded when a task will not finish in time',
    async run(addon) {
      const pool: Pool = new addon.Pool(1);
      const slow = pool.blockFor(1500);
      await until('the slow task to start', () => pool.running === 1);
      const startedAt = performance.now();
      const report = await pool.shutdown(150);
      const waited = performance.now() - startedAt;
      assert.equal(report.abandonedRunning, 1);
      assert.equal(report.finishedRunning, 0);
      assert.ok(waited >= 140 && waited < 1000, `waited ${waited.toFixed(0)} ms for a 150 ms bound`);
      assert.equal(pool.state, 'closed');
      assert.equal(await slow, 1500, 'the abandoned task still settles its promise');
    },
  },
  {
    name: 'shutdown: admission closes before shutdown() returns, not when it settles',
    async run(addon) {
      const pool = new addon.Pool(1);
      const running = pool.blockFor(200);
      const queued = rejection(pool.blockFor(10));
      await until('the first task to start', () => pool.running === 1);
      const pending = pool.shutdown(5000);
      // The shutdown promise is still pending; nothing new may get in.
      assert.equal(pool.state, 'shutting_down');
      assert.equal((await rejection(pool.blockFor(1))).code, 'engine_shutdown');
      assert.equal((await rejection(pool.runSteps(1, 1))).code, 'engine_shutdown');
      assert.equal((await rejection(pool.sumF32(new Float32Array([1])))).code, 'engine_shutdown');
      assert.deepEqual(await pending, { cancelledQueued: 1, finishedRunning: 1, abandonedRunning: 0 });
      assert.equal((await queued).code, 'cancelled');
      assert.equal(await running, 200);
      assert.equal(pool.state, 'closed');
      await until('the worker to exit', () => pool.workers === 0);
    },
  },
  {
    name: 'pool: the worker count is bounded and a pool with no workers still gets one',
    async run(addon) {
      const one = new addon.Pool(0);
      assert.equal(one.workers, 1);
      assert.equal(await one.blockFor(1), 1);
      await one.shutdown(1000);
      const capped = new addon.Pool(100_000);
      assert.equal(capped.workers, 256);
      await capped.shutdown(1000);
      await until('the capped workers to exit', () => capped.workers === 0);
    },
  },
  {
    name: 'pool: a pool collected without shutdown stops its workers',
    async run(addon) {
      const collect = (globalThis as { Bun?: { gc(full: boolean): void } }).Bun?.gc;
      assert.ok(collect, 'this case runs under Bun, which can force a collection');
      const before = addon.liveWorkers();
      (() => {
        for (let i = 0; i < 8; i++) new addon.Pool(2);
      })();
      assert.equal(addon.liveWorkers(), before + 16);
      await until(
        'the collected pools to stop their workers',
        () => {
          collect(true);
          return addon.liveWorkers() <= before;
        },
        10_000,
      );
    },
  },
  {
    name: 'typed arrays: a view of a SharedArrayBuffer is refused by every entry point',
    async run(addon) {
      const shared = new Float32Array(new SharedArrayBuffer(12));
      shared.set([1, 2, 3]);
      const pool = new addon.Pool(1);
      const calls: Array<[string, () => unknown]> = [
        ['sumF32', () => addon.sumF32(shared)],
        ['scaleF32', () => addon.scaleF32(shared, 2)],
        ['scaleInPlaceF32', () => addon.scaleInPlaceF32(shared, 2)],
        ['pool.sumF32', () => pool.sumF32(shared)],
        ['pool.scaleF32', () => pool.scaleF32(shared, 2)],
      ];
      for (const [name, call] of calls) {
        const error = thrown(call);
        assert.equal(error.code, 'InvalidArg', `${name} code`);
        assert.match(error.message, /SharedArrayBuffer/, `${name} message`);
      }
      assert.deepEqual([...shared], [1, 2, 3], 'nothing wrote into the shared memory');
      assert.equal(addon.sumF32(new Float32Array([1, 2, 3])), 6, 'a plain array still works');
      assert.equal(await pool.sumF32(new Float32Array([2])), 2);
      await pool.shutdown(1000);
    },
  },
  {
    // The refusal above asks the runtime whether the buffer is a plain ArrayBuffer
    // (napi_is_arraybuffer), which reads the engine's own record of the buffer, not JavaScript
    // state. Hiding the global constructor or swapping the prototype must not change the answer.
    name: 'typed arrays: shared memory is refused even with SharedArrayBuffer hidden or a swapped prototype',
    async run(addon) {
      const realShared = globalThis.SharedArrayBuffer;
      const shared = new Float32Array(new realShared(12));
      shared.set([1, 2, 3]);
      const swapped = new Float32Array(new realShared(12));
      swapped.set([1, 2, 3]);
      Object.setPrototypeOf(swapped.buffer, ArrayBuffer.prototype);
      const pool = new addon.Pool(1);
      try {
        // @ts-expect-error hiding the global on purpose
        globalThis.SharedArrayBuffer = undefined;
        for (const [label, values] of [['hidden constructor', shared], ['swapped prototype', swapped]] as const) {
          const calls: Array<[string, () => unknown]> = [
            ['sumF32', () => addon.sumF32(values)],
            ['scaleF32', () => addon.scaleF32(values, 2)],
            ['scaleInPlaceF32', () => addon.scaleInPlaceF32(values, 2)],
            ['pool.sumF32', () => pool.sumF32(values)],
            ['pool.scaleF32', () => pool.scaleF32(values, 2)],
          ];
          for (const [name, call] of calls) {
            assert.equal(thrown(call).code, 'InvalidArg', `${label}: ${name} refuses`);
          }
          assert.deepEqual([...values], [1, 2, 3], `${label}: memory untouched`);
        }
      } finally {
        globalThis.SharedArrayBuffer = realShared;
        await pool.shutdown(1000);
      }
    },
  },
  {
    name: 'sink: a full queue says queue_full, closing says closing, nothing is lost',
    async run(addon) {
      assert.equal(addon.sinkMaxQueueSize, 4);
      const received: number[] = [];
      const sink = new addon.Sink(value => received.push(value));
      // Synchronous emits cannot drain between calls, so the fifth must be refused.
      const statuses = [0, 1, 2, 3, 4, 5, 6, 7].map(n => sink.emit(n));
      assert.deepEqual(statuses.slice(0, 4), ['ok', 'ok', 'ok', 'ok']);
      assert.ok(statuses.slice(4).every(status => status === 'queue_full'), statuses.join(','));
      await sleep(50);
      assert.deepEqual(received, [0, 1, 2, 3], 'every ok value was delivered, in order');

      // From a Rust thread the same rule holds.
      const before = received.length;
      const fromThread = await sink.emitFromThread(50);
      assert.ok(fromThread.every(status => status === 'ok' || status === 'queue_full'));
      await sleep(50);
      assert.equal(received.length - before, fromThread.filter(status => status === 'ok').length);

      sink.close();
      assert.equal(sink.emit(9), 'closing');
      assert.deepEqual(await sink.emitFromThread(2), ['closing', 'closing']);
      await sleep(20);
    },
  },
  {
    name: 'store: open, reopen, a second open is refused, close',
    async run(addon) {
      await withBrainDir(async dir => {
        const pool = new addon.Pool(2);
        const first = new addon.Brain(pool);
        assert.equal(first.isOpen, false);
        const opened = await first.open(dir, { schemaVersion: 319 });
        assert.equal(opened.created, true);
        assert.equal(opened.format_version, addon.formatVersions.at(-1)); // the store's current format, from the addon's own list (line 257 pins the whole list)
        assert.match(opened.brain_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.equal(first.isOpen, true);

        const second = new addon.Brain(pool);
        const refused = await rejection(second.open(dir));
        assert.equal(refused.code, 'store_locked');
        assert.equal(second.isOpen, false);
        assert.equal((await first.info()).brain_id, opened.brain_id, 'the owner keeps working');
        assert.equal(await first.getConfig('version'), '319');
        assert.equal(await first.getConfig('nothing'), null);
        await first.setConfig('sync.repo', '/work');
        assert.deepEqual(await first.listConfigKeys('sync.'), ['sync.repo']);
        assert.equal(await first.unsetConfig('sync.repo'), 1);
        const sources = await first.listAllSources();
        assert.deepEqual(sources.map(s => s.id), ['default']);
        assert.deepEqual(sources[0]!.config, { federated: true });
        assert.equal(await first.getSourceById('nope'), null);

        await first.close();
        assert.equal(first.isOpen, false);
        assert.equal((await rejection(first.info())).code, 'store_closed');
        await first.close();

        const reopened = await second.open(dir);
        assert.equal(reopened.created, false);
        assert.equal(reopened.brain_id, opened.brain_id);
        await second.close();
        await pool.shutdown(1000);
      });
    },
  },
  {
    name: 'store: a close called while an open is still queued releases the brain',
    async run(addon) {
      await withBrainDir(async dir => {
        const pool = new addon.Pool(1);
        const busy = pool.blockFor(200);
        const brain = new addon.Brain(pool);
        const queued = rejection(brain.open(dir));
        await brain.close();
        assert.equal((await queued).code, 'store_closed');
        await busy;
        assert.equal(brain.isOpen, false);
        const other = new addon.Brain(pool);
        assert.equal((await other.open(dir)).created, true, 'the queued open took no lock and created nothing');
        await other.close();
        const reopened = await brain.open(dir);
        assert.equal(reopened.created, false, 'the handle opens again after the close');
        await brain.close();
        await pool.shutdown(1000);
      });
    },
  },
  {
    name: 'store: put, get, list, tags, versions and delete a page',
    async run(addon) {
      await withBrainDir(async dir => {
        const pool = new addon.Pool(2);
        const brain = new addon.Brain(pool);
        await brain.open(dir);
        assert.equal(await brain.readPageSnapshot('people/ada'), null);
        assert.deepEqual(await brain.listPages(), []);
        const put = await brain.putPage('People/Ada', {
          type: 'person',
          title: 'Ada Lovelace',
          compiled_truth: 'Wrote the first program.',
          frontmatter: { born: 1815 },
        });
        assert.equal(put.slug, 'people/ada');
        assert.equal(put.source_id, 'default');
        assert.equal(put.text_projection_revision, put.knowledge_revision, 'put indexes the page');
        const found = await brain.searchKeyword('first program');
        assert.deepEqual(found.map(r => r.slug), ['people/ada']);
        assert.equal(found[0].chunk_source, 'compiled_truth');
        assert.equal(found[0].stale, false);
        assert.deepEqual(await brain.searchKeyword('first program', { type: 'company' }), []);
        assert.equal((await brain.getChunks('people/ada')).length, 1);
        assert.match(put.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
        const snapshot = await brain.readPageSnapshot('people/ada');
        assert.equal(snapshot!.page.title, 'Ada Lovelace');
        assert.equal(snapshot!.revision, put.knowledge_revision);
        assert.deepEqual(snapshot!.page.frontmatter, { born: 1815 });
        await brain.addTag('people/ada', 'math');
        assert.deepEqual(await brain.getTags('people/ada'), ['math']);
        assert.deepEqual((await brain.listPages({ tag: 'math' })).map(p => p.slug), ['people/ada']);

        const stale = await rejection(
          brain.putPage('people/ada', { type: 'person', title: 'x', compiled_truth: 'y' }, { expectedRevision: put.knowledge_revision }),
        );
        assert.equal(stale.code, 'revision_conflict', 'adding a tag moved the revision');
        const blank = await rejection(brain.putPage('people/ada', { type: 'person', title: 'x', compiled_truth: '' }));
        assert.equal(blank.code, 'empty_overwrite');
        assert.equal((await rejection(brain.putPage('../x', { type: 'note', title: 'x', compiled_truth: 'y' }))).code, 'invalid_slug');

        const version = await brain.createVersion('people/ada');
        assert.equal(version.compiled_truth, 'Wrote the first program.');
        assert.equal((await brain.getVersions('people/ada')).length, 1);
        assert.deepEqual(await brain.resolveSlugs('people/ada'), ['people/ada']);
        // A partial name resolves the way pg_trgm does on PGLite and Postgres: an exact slug first, else a similar
        // title or a slug that contains the name (engine-sql/pages.ts resolveSlugs).
        assert.deepEqual(await brain.resolveSlugs('ada'), ['people/ada'], 'resolveSlugs falls back to a pg_trgm-style partial match');
        assert.deepEqual(await brain.resolveSlugs('zzqx'), [], 'resolveSlugs finds nothing for a name no page resembles');
        assert.deepEqual(await brain.resolveSlugs('zzz'), [], 'resolveSlugs finds nothing for a name no page has');
        assert.deepEqual(await brain.softDeletePage('people/ada'), { slug: 'people/ada' });
        assert.equal(await brain.readPageSnapshot('people/ada'), null);
        assert.equal(await brain.countPages(), 0);
        assert.equal(await brain.restorePage('people/ada'), true);
        assert.equal(await brain.countPages(), 1);

        await brain.close();
        const again = new addon.Brain(pool);
        await again.open(dir);
        assert.equal((await again.readPageSnapshot('people/ada'))!.page.title, 'Ada Lovelace', 'the page survives a reopen');
        await again.putPage('people/ada', { type: 'person', title: 'Ada Lovelace', compiled_truth: 'Wrote the first program.' });
        assert.deepEqual((await again.searchKeyword('program')).map(r => r.slug), ['people/ada'], 'search works after a reopen');
        assert.equal(await again.countChunks(), 1);
        await again.upsertChunks('people/ada', [{ chunk_index: 0, chunk_text: 'engine notes', chunk_source: 'timeline' }]);
        await again.deleteChunks('people/ada');
        assert.equal(await again.countChunks(), 0);
        await again.deletePage('people/ada');
        assert.equal(await again.readPageSnapshot('people/ada', { includeDeleted: true }), null);
        await again.close();
        await pool.shutdown(1000);
      });
    },
  },
  {
    name: 'store: a journaled write is idempotent, conflicts are receipts, a second open refuses',
    async run(addon) {
      await withBrainDir(async dir => {
        const pool = new addon.Pool(2);
        const brain = new addon.Brain(pool);
        await brain.open(dir);
        const principal = { kind: 'local_cli', id: 'smoke' };
        const request = '11111111-1111-4111-8111-111111111111';
        const mutation = {
          principal,
          requestId: request,
          slug: 'notes/first',
          page: { type: 'note', title: 'First note', compiled_truth: 'The journal keeps one receipt per request.' },
        };
        const receipt = await brain.submitPageMutation(mutation);
        assert.equal(receipt.state, 'committed');
        assert.equal(receipt.status, 'created');
        assert.deepEqual(await brain.submitPageMutation(mutation), receipt, 'the same request returns the same receipt');
        const other = await rejection(
          brain.submitPageMutation({ ...mutation, page: { ...mutation.page, compiled_truth: 'different' } }),
        );
        assert.equal(other.code, 'idempotency_conflict');
        const stale = await brain.submitPageMutation({
          principal,
          requestId: '22222222-2222-4222-8222-222222222222',
          slug: 'notes/first',
          page: { type: 'note', title: 'x', compiled_truth: 'y' },
          options: { expectedRevision: '00000000-0000-4000-8000-000000000000' },
        });
        assert.equal(stale.state, 'conflict');
        assert.equal(stale.write_error, 'revision_conflict');
        assert.deepEqual((await brain.searchKeyword('receipt per request')).map(r => r.slug), ['notes/first']);
        assert.deepEqual(await brain.journalOutstanding(), { brain: 0, principals: {} });
        const writer = await brain.registerLocalWriter({
          id: '33333333-3333-4333-8333-333333333333',
          lane: 'cli',
          credentialHash: 'a'.repeat(64),
        });
        assert.equal(writer.lane, 'cli');
        assert.equal((await brain.getBrainIdentity()).brain_id, (await brain.info()).brain_id);

        const second = new addon.Brain(pool);
        assert.equal((await rejection(second.open(dir))).code, 'store_locked');
        await brain.close();
        const again = new addon.Brain(pool);
        await again.open(dir);
        assert.deepEqual(await again.submitPageMutation(mutation), receipt, 'the receipt survives a reopen');
        assert.equal((await again.getWriteRequest(principal, request))!.sequence, 1);
        await again.close();
        await pool.shutdown(1000);
      });
    },
  },
  {
    name: 'store: links, graph walks, timeline and the stale flag',
    async run(addon) {
      await withBrainDir(async dir => {
        const pool = new addon.Pool(2);
        const brain = new addon.Brain(pool);
        await brain.open(dir);
        for (const slug of ['g/a', 'g/b', 'g/c']) {
          await brain.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} zebra` });
        }
        assert.equal(await brain.addLink('g/a', 'g/b', { linkType: 'cites', context: 'ab' }), null);
        assert.equal(await brain.addLinksBatch([{ from_slug: 'g/b', to_slug: 'g/c', link_type: 'cites' }]), 1);
        assert.deepEqual((await brain.getLinks('g/a')).map(l => [l.to_slug, l.link_type, l.context]), [['g/b', 'cites', 'ab']]);
        assert.deepEqual((await brain.getBacklinks('g/c')).map(l => l.from_slug), ['g/b']);
        assert.deepEqual((await brain.traverseGraph('g/a', 1)).map(n => [n.slug, n.depth]), [['g/a', 0], ['g/b', 1]]);
        assert.deepEqual((await brain.traverseGraph('g/a')).map(n => n.slug), ['g/a', 'g/b', 'g/c'], 'default depth');
        const paths = await brain.traversePathsDetailed('g/c', { depth: 2, direction: 'in' });
        assert.deepEqual(paths.paths.map(p => [p.from_slug, p.to_slug, p.depth]), [['g/b', 'g/c', 1], ['g/a', 'g/b', 2]]);
        assert.equal(paths.truncated, false);
        assert.equal((await brain.traversePaths('g/a', { depth: 1 })).length, 1);
        const refused = await rejection(brain.addLink('g/a', 'g/c', { linkSource: 'Bad_Source' }));
        assert.equal(refused.code, 'constraint_violation');
        assert.equal((await rejection(brain.addLink('g/a', 'g/none'))).code, 'page_not_found');
        assert.equal(await brain.removeLink('g/a', 'g/b', { linkType: 'cites' }), 1);

        assert.equal((await brain.searchKeyword('zebra', { type: 'note' })).find(r => r.slug === 'g/a')!.stale, false);
        assert.equal(await brain.addTimelineEntry('g/a', { date: '2026-01-02', summary: 'met' }), true);
        assert.equal(await brain.addTimelineEntry('g/a', { date: '2026-01-02', summary: 'met' }), false);
        assert.equal(await brain.addTimelineEntriesBatch([{ slug: 'g/a', date: '2026-01-03', summary: 'again' }]), 1);
        assert.deepEqual((await brain.getTimeline('g/a')).map(e => [e.date, e.summary]), [['2026-01-03', 'again'], ['2026-01-02', 'met']]);
        assert.equal((await rejection(brain.addTimelineEntry('g/a', { date: 'soon', summary: 'x' }))).code, 'invalid_argument');
        assert.equal((await brain.searchKeyword('zebra')).find(r => r.slug === 'g/a')!.stale, true, 'an entry after the last write');
        await brain.close();
        await pool.shutdown(1000);
      });
    },
  },
  {
    name: 'boundary: hostile input never panics, aborts or ends in internal_error, and the brain keeps working',
    async run(addon) {
      await withBrainDir(async dir => {
        const pool = new addon.Pool(2);
        const brain = new addon.Brain(pool);
        await brain.open(dir);
        await brain.putPage('people/alice', { type: 'note', title: 'Alice', compiled_truth: 'Alice likes zebra stripes.' });
        // A fixed seed keeps CI repeatable; set GBRAIN_FUZZ_SEED and GBRAIN_FUZZ_ROUNDS to hunt harder by hand.
        const rng = mulberry32(Number(process.env.GBRAIN_FUZZ_SEED ?? 0x6b72ae1f));
        const seen = new Map<string, number>();
        const failures: string[] = [];
        let ok = 0;
        let calls = 0;
        const callMethod = async (method: FuzzMethod, args: unknown[], label: string) => {
          calls++;
          const outcome = await settle(() => (brain as any)[method.name](...args));
          if (outcome === 'ok') {
            ok++;
            seen.set('ok', (seen.get('ok') ?? 0) + 1);
            return;
          }
          const code = String(outcome.code);
          seen.set(code, (seen.get(code) ?? 0) + 1);
          // A valid sample may be refused for its state (no such job), never for its shape.
          if (label === 'round 0' && (code === 'invalid_argument' || NAPI_ARGUMENT_CODES.has(code))) {
            failures.push(`${method.name}: its valid sample was refused as malformed: ${outcome.message.slice(0, 120)}`);
          }
          if (!isTypedCode(outcome.code)) {
            failures.push(`${method.name} ${label}: code ${String(outcome.code)}: ${outcome.message.slice(0, 120)}`);
          }
        };

        // 1. About 10 seeded hostile calls for each sampled method (the first is its valid sample).
        const perMethod = Number(process.env.GBRAIN_FUZZ_ROUNDS ?? 10);
        for (let round = 0; round < perMethod; round++) {
          for (const method of fuzzMethods) await callMethod(method, fuzzArgs(rng, method, round), `round ${round}`);
        }

        // 2. Fixed hostile inputs that a seeded draw may not reach: a multi-MB string and deep nesting.
        const huge = 'q'.repeat(4 * 1024 * 1024);
        const hugeUnicode = '漢\uD800'.repeat(1024 * 1024);
        const nested = (depth: number, leaf: unknown, asObject: boolean) => {
          let value = leaf;
          for (let i = 0; i < depth; i++) value = asObject ? { x: value } : [value];
          return value;
        };
        const byName = (name: string) => fuzzMethods.find(m => m.name === name)!;
        await callMethod(byName('getConfig'), [huge], 'multi-MB key');
        await callMethod(byName('setConfig'), ['k', huge], 'multi-MB value');
        await callMethod(byName('setConfig'), [hugeUnicode, hugeUnicode], 'multi-MB unpaired surrogates');
        await callMethod(byName('searchKeyword'), [huge, { limit: 5 }], 'multi-MB query');
        await callMethod(byName('putPage'), ['big/page', { type: 'note', title: huge, compiled_truth: hugeUnicode }, {}], 'multi-MB page');
        await callMethod(byName('readPageSnapshot'), [huge, {}], 'multi-MB slug');
        for (const asObject of [false, true]) {
          for (const depth of [100, 127, 129, 20000]) {
            const label = `${asObject ? 'object' : 'array'} nested ${depth} deep`;
            for (const name of ['putPage', 'listPages', 'insertFact', 'admitJob', 'updateSourceConfig', 'getConfigValues']) {
              const method = byName(name);
              await callMethod(method, method.slots.map(slot => (slot === 'str' ? 'x' : slot === 'num' ? 1 : nested(depth, 1, asObject))), label);
            }
          }
        }

        // One array of many small elements: napi allows up to a million nodes per argument.
        await callMethod(byName('getConfigValues'), [Array.from({ length: 200_000 }, (_, i) => `key${i}`)], '200k-element array');
        await callMethod(byName('getConfigValues'), [Array.from({ length: 1_100_000 }, () => 'k')], 'over a million nodes');

        assert.deepEqual(failures, [], `calls that ended without a typed engine code:\n${failures.join('\n')}`);
        assert.ok(calls >= 200, `only ${calls} calls`);
        assert.ok(ok > 0, 'no call succeeded, so the valid samples are wrong');
        assert.ok(
          [...seen.keys()].some(code => /^[a-z]+(_[a-z]+)*$/.test(code) && code !== 'ok'),
          `hostile input never reached an engine error code: ${[...seen.keys()].join(',')}`,
        );
        console.log(`        ${calls} hostile calls, outcomes: ${[...seen].sort().map(([code, n]) => `${code}=${n}`).join(' ')}`);

        // 3. The brain still works after all of it.
        assert.equal((await brain.info()).format_version, addon.formatVersions.at(-1));
        await brain.setConfig('fuzz.after', 'fine');
        assert.equal(await brain.getConfig('fuzz.after'), 'fine');
        // (The fuzz may have soft-deleted people/alice, so write and read a new page.)
        await brain.putPage('after/fuzz', { type: 'note', title: 'After', compiled_truth: 'still here' });
        assert.equal((await brain.readPageSnapshot('after/fuzz'))!.page.title, 'After');
        assert.equal((await rejection(brain.getJob(0.5))).code, 'invalid_argument', 'errors are still typed');
        await brain.close();
        await pool.shutdown(1000);
      });
    },
  },
];

/** The cases that make sense inside a compiled executable (everything in-process and quick). */
export const compiledCases: Case[] = cases.filter(c =>
  /^(metadata|typed arrays|panics|cancellation|shutdown: queued|sink)/.test(c.name),
);
