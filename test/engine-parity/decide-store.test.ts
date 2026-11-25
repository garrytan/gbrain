/**
 * BrainEngine parity — the decide store (`decide_state`, `decide_spend`, `decision_receipts`, `decide_calibrations`):
 * the members that replace the `engine.executeRaw` statements of src/core/ai/decide/store.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    the Rust arm through test/engine-parity/harness.ts with GBRAIN_TEST_RUST_ARM=1). State: a key keeps its last
 *    value, an absent key reads null, `ensureDecideState` keeps the first value and answers the stored one, a
 *    delete forgets one key only, and a null value or a NUL byte is refused. Spend: a request id keeps its first
 *    row, `dailyDecideSpend` adds typesafe spend from `since` on (and the remote part), costs add in insertion
 *    order, slots list in byte order, and a bad row refuses its whole batch.
 *    Receipts: every read is windowed by whole hours (a fraction or a window before the first timestamp is refused,
 *    and a window of zero or fewer hours holds nothing, not even a receipt written in the reading transaction),
 *    stats group by slot, mode, outcome and reason in byte order with the reason null last, a mean adds in insertion
 *    order and a percentile interpolates, REAL columns keep their single-precision value, replay orders by decision
 *    id (byte order), then rank (null last), then insertion, and a prune drops old receipts but keeps spend for at
 *    least 31 days.
 *    Calibrations: an insert answers a new id and the row reads back with its defaults and single-precision REALs,
 *    the list orders by slot (byte order), newest first, then id, and filters by slot and retired, a qualification
 *    replaces its three columns (null included) and stamps `qualified_at`, retire stamps and un-retire clears
 *    `retired_at` and answers whether the row exists, and a bad row or id refuses with nothing recorded.
 *  - Regression: an engine whose ensure overwrites, whose upsert keeps the first value, or whose delete drops more
 *    than its key hands `gbrain decide` a receipt salt that changes between runs (receipts stop joining) or a
 *    kill-switch that comes back after it was cleared; one that double-counts a retried request id, counts a
 *    non-typesafe provider, or records the good rows of a refused batch shows a wrong daily spend against the budget.
 *    One that counts egress by substring, counts a plain error as a mixed-model decision, replays another slot's
 *    receipts, or prunes spend with the receipts shows wrong slot usage, a wrong mixed-model alert, a replay that
 *    answers for the wrong slot, or a budget that forgets what it spent. One that lists retired calibrations, lists
 *    them oldest first, keeps an old qualification when the new one is null, or reports a retire of a missing row
 *    as done has `gbrain decide` calibrate against a withdrawn profile or show an operator the wrong qualification.
 *  - Why existing coverage misses it: the decide store tests (test/decide/runtime.test.ts, test/decide/core.test.ts) run these statements on PGLite alone; no case
 *    compares engines.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). A write the engine refuses is compared as
 *    "threw" because constraint messages name the engine's own driver.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest: armsParityTest } = parityArms(testBackends());

/**
 * The lists below read in the database's own collation and leave ties to the plan, as master does (a Postgres brain
 * on en_US sorts `a` before `A`; PGLite and the Rust store sort bytes). The engines' answers are compared after one
 * client-side byte order, so a case compares what each engine lists, not how its collation sorts it.
 */
type Row = Record<string, unknown>;
const bytes = (a: unknown, b: unknown): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : String(a) < String(b) ? -1 : 1);
const bySlotThen = (...keys: string[]) => (rows: Row[]): Row[] =>
  [...rows].sort((x, y) => { for (const k of ['slot', ...keys]) { const c = bytes(x[k], y[k]); if (c) return c; } return 0; });
const NEWEST_GROUP_FIRST = (rows: Row[]): Row[] =>
  [...rows].sort((x, y) => (y.last_at as Date).getTime() - (x.last_at as Date).getTime()
    || bytes(x.slot, y.slot) || bytes(x.provider, y.provider) || bytes(x.model_resolved, y.model_resolved));
const BYTE_ORDERED: Record<string, (rows: Row[]) => Row[]> = {
  listDecideSpendBySlot: bySlotThen(),
  listDecideReceiptStats: bySlotThen('mode', 'outcome', 'error_reason'),
  decideSlotUsage: bySlotThen(),
  listDecideCalibrations: bySlotThen(),
  listDecideMixedModelDecisions: bySlotThen(),
  listDecideResolvedModels: NEWEST_GROUP_FIRST,
  listDecideReplayReceipts: (rows) => [...rows].sort((x, y) => bytes(x.decision_id, y.decision_id)),
};
const byteOrdered = (engine: BrainEngine): BrainEngine => new Proxy(engine, {
  get(target, key) {
    const sort = typeof key === 'string' ? BYTE_ORDERED[key] : undefined;
    const member = Reflect.get(target, key, target);
    if (!sort || typeof member !== 'function') return member;
    return async (...args: unknown[]) => sort(await (member as (...a: unknown[]) => Promise<Row[]>).apply(target, args));
  },
});
const parityTest: typeof armsParityTest = ((name: string, opts: never, run: (engine: BrainEngine, ...rest: never[]) => Promise<unknown>, ...rest: never[]) =>
  (armsParityTest as unknown as (...a: unknown[]) => unknown)(name, opts, (engine: BrainEngine, ...r: never[]) => run(byteOrdered(engine), ...r), ...rest)) as typeof armsParityTest;

/** Whether a call threw. A typed `engine_capability_missing` refusal propagates so the Rust arm counts it as refused. */
async function threw(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'engine_capability_missing') throw error;
    return true;
  }
}

describe('engine parity: decide state', () => {
  parityTest(
    'upsertDecideState keeps the last value, readDecideState answers null for an absent key, deleteDecideState forgets one key',
    { methods: ['upsertDecideState', 'readDecideState', 'deleteDecideState'] },
    async (engine) => {
      const absent = await engine.readDecideState('kill_switch');
      await engine.upsertDecideState('kill_switch', 'on');
      await engine.upsertDecideState('receipt_hmac_salt', 'salt-1');
      const first = [await engine.readDecideState('kill_switch'), await engine.readDecideState('receipt_hmac_salt')];
      await engine.upsertDecideState('kill_switch', 'off');
      const replaced = [await engine.readDecideState('kill_switch'), await engine.readDecideState('receipt_hmac_salt')];
      await engine.deleteDecideState('kill_switch');
      const afterDelete = [await engine.readDecideState('kill_switch'), await engine.readDecideState('receipt_hmac_salt')];
      await engine.deleteDecideState('kill_switch');
      await engine.deleteDecideState('never_there');
      const afterNoopDeletes = [await engine.readDecideState('kill_switch'), await engine.readDecideState('receipt_hmac_salt')];
      await engine.upsertDecideState('kill_switch', 'again');
      const reborn = await engine.readDecideState('kill_switch');
      expect(absent).toBeNull();
      expect(replaced).toEqual(['off', 'salt-1']);
      expect(afterDelete).toEqual([null, 'salt-1']);
      return { absent, first, replaced, afterDelete, afterNoopDeletes, reborn };
    },
  );

  parityTest(
    'decide state keeps empty, unicode and multi-line values and tells keys apart by exact text',
    { methods: ['upsertDecideState', 'readDecideState'] },
    async (engine) => {
      const entries: Array<[string, string]> = [
        ['empty', ''], ['Case', 'upper'], ['case', 'lower'], ['uni', 'caf\u00e9 \u2603 \ud83d\ude80'],
        ['multi', 'line one\nline two\r\n\ttabbed'], ['key with spaces', 'spaced'], ['', 'empty key'],
        ['long', 'x'.repeat(5000)],
      ];
      for (const [key, value] of entries) await engine.upsertDecideState(key, value);
      const read: Record<string, string | null> = {};
      for (const [key] of entries) read[key] = await engine.readDecideState(key);
      const near = [await engine.readDecideState('CASE'), await engine.readDecideState('case '), await engine.readDecideState('Empty')];
      expect(read.empty).toBe('');
      expect(read.Case).toBe('upper');
      expect(read.case).toBe('lower');
      return { read, near };
    },
  );

  parityTest(
    'ensureDecideState keeps the first value, answers the stored one, and never overwrites a later upsert',
    { methods: ['ensureDecideState', 'upsertDecideState', 'readDecideState', 'deleteDecideState'] },
    async (engine) => {
      const first = await engine.ensureDecideState('receipt_hmac_salt', 'salt-a');
      const second = await engine.ensureDecideState('receipt_hmac_salt', 'salt-b');
      const stored = await engine.readDecideState('receipt_hmac_salt');
      await engine.upsertDecideState('receipt_hmac_salt', 'salt-c');
      const afterUpsert = await engine.ensureDecideState('receipt_hmac_salt', 'salt-d');
      const other = await engine.ensureDecideState('other_key', 'other');
      await engine.deleteDecideState('receipt_hmac_salt');
      const reborn = await engine.ensureDecideState('receipt_hmac_salt', 'salt-e');
      const emptyValue = await engine.ensureDecideState('blank', '');
      expect([first, second, stored]).toEqual(['salt-a', 'salt-a', 'salt-a']);
      expect(afterUpsert).toBe('salt-c');
      return { first, second, stored, afterUpsert, other, reborn, emptyValue, otherKept: await engine.readDecideState('other_key') };
    },
  );

  parityTest(
    'decide state refuses a null value or a NUL byte and keeps what was stored',
    { methods: ['upsertDecideState', 'ensureDecideState', 'readDecideState'] },
    async (engine) => {
      await engine.upsertDecideState('kept', 'original');
      const nullUpsert = await threw(() => engine.upsertDecideState('kept', null as unknown as string));
      const nullEnsure = await threw(() => engine.ensureDecideState('fresh', null as unknown as string));
      const nulKey = await threw(() => engine.upsertDecideState('bad\u0000key', 'v'));
      const nulValue = await threw(() => engine.upsertDecideState('kept', 'bad\u0000value'));
      const nulEnsure = await threw(() => engine.ensureDecideState('bad\u0000key', 'v'));
      const nulRead = await threw(() => engine.readDecideState('bad\u0000key'));
      const nulDelete = await threw(() => engine.deleteDecideState('bad\u0000key'));
      expect([nullUpsert, nullEnsure, nulKey, nulValue, nulEnsure, nulRead, nulDelete]).toEqual([true, true, true, true, true, true, true]);
      return { kept: await engine.readDecideState('kept'), fresh: await engine.readDecideState('fresh') };
    },
  );
});

type Spend = Parameters<BrainEngine['insertDecideSpend']>[0][number];

/** A spend row with every column set; a case overrides what it is about. */
function spend(requestId: string, over: Partial<Spend> = {}): Spend {
  return { request_id: requestId, source_id: 'default', slot: 'conflict', provider: 'typesafe:openai', model_resolved: 'gpt-x', lane: 'sweep', remote: false, input_tokens: 10, cost_usd: 0.5, outcome: 'ok', ...over };
}

const anHourAgo = () => new Date(Date.now() - 3_600_000);
const inAnHour = () => new Date(Date.now() + 3_600_000);

describe('engine parity: decide spend', () => {
  parityTest(
    'insertDecideSpend, dailyDecideSpend and listDecideSpendBySlot answer zero and an empty list on an empty ledger',
    { methods: ['insertDecideSpend', 'dailyDecideSpend', 'listDecideSpendBySlot'] },
    async (engine) => {
      await engine.insertDecideSpend([]);
      const daily = await engine.dailyDecideSpend(new Date(0));
      const bySlot = await engine.listDecideSpendBySlot();
      expect(daily).toEqual({ total: 0, remote: 0 });
      expect(bySlot).toEqual([]);
      return { daily, bySlot };
    },
  );

  parityTest(
    'dailyDecideSpend adds typesafe spend from `since` on and splits out the remote part; other providers do not count',
    { methods: ['insertDecideSpend', 'dailyDecideSpend'] },
    async (engine) => {
      await engine.insertDecideSpend([
        spend('r1', { cost_usd: 0.5 }),
        spend('r2', { cost_usd: 0.25, remote: true }),
        spend('r3', { provider: 'local:ollama', cost_usd: 8 }),
        spend('r4', { provider: 'TYPESAFE:upper', cost_usd: 16 }),
        spend('r5', { provider: 'typesafe:', cost_usd: 0.125, remote: true }),
        spend('r6', { provider: 'xtypesafe:y', cost_usd: 32 }),
      ]);
      const sinceEpoch = await engine.dailyDecideSpend(new Date(0));
      const sinceAnHourAgo = await engine.dailyDecideSpend(anHourAgo());
      const sinceInAnHour = await engine.dailyDecideSpend(inAnHour());
      expect(sinceEpoch).toEqual({ total: 0.875, remote: 0.375 });
      expect(sinceInAnHour).toEqual({ total: 0, remote: 0 });
      return { sinceEpoch, sameAsEpoch: sinceAnHourAgo.total === sinceEpoch.total, sinceInAnHour };
    },
  );

  parityTest(
    'dailyDecideSpend adds the costs in insertion order across batches',
    { methods: ['insertDecideSpend', 'dailyDecideSpend', 'listDecideSpendBySlot'] },
    async (engine) => {
      await engine.insertDecideSpend([spend('a', { cost_usd: 0.1 }), spend('b', { cost_usd: 0.2 })]);
      await engine.insertDecideSpend([spend('c', { cost_usd: 0.3 })]);
      await engine.insertDecideSpend([spend('d', { cost_usd: 1e-9, remote: true }), spend('e', { cost_usd: 1e16 }), spend('f', { cost_usd: -1e16 })]);
      const daily = await engine.dailyDecideSpend(new Date(0));
      const bySlot = await engine.listDecideSpendBySlot();
      expect(bySlot).toHaveLength(1);
      return { daily, bySlot };
    },
  );

  parityTest(
    'insertDecideSpend keeps the first row of a request id, within a batch and across batches',
    { methods: ['insertDecideSpend', 'listDecideSpendBySlot', 'dailyDecideSpend'] },
    async (engine) => {
      await engine.insertDecideSpend([spend('dup', { cost_usd: 1, input_tokens: 100 }), spend('dup', { cost_usd: 2, input_tokens: 200, slot: 'triage' }), spend('solo', { cost_usd: 4, input_tokens: 400 })]);
      const first = await engine.listDecideSpendBySlot();
      await engine.insertDecideSpend([spend('dup', { cost_usd: 8, input_tokens: 800, slot: 'recall' }), spend('late', { cost_usd: 16, input_tokens: 1600 })]);
      const second = await engine.listDecideSpendBySlot();
      const daily = await engine.dailyDecideSpend(new Date(0));
      expect(first).toEqual([{ slot: 'conflict', input_tokens: 500, cost_usd: 5, requests: 2 }]);
      expect(second).toEqual([{ slot: 'conflict', input_tokens: 2100, cost_usd: 21, requests: 3 }]);
      return { first, second, daily };
    },
  );

  parityTest(
    'listDecideSpendBySlot groups by slot in byte order and totals tokens, cost and requests',
    { methods: ['insertDecideSpend', 'listDecideSpendBySlot'] },
    async (engine) => {
      await engine.insertDecideSpend([
        spend('s1', { slot: 'b', input_tokens: 1, cost_usd: 0.5 }),
        spend('s2', { slot: 'A', input_tokens: 2, cost_usd: 0.25 }),
        spend('s3', { slot: 'a', input_tokens: 4, cost_usd: 0.125 }),
        spend('s4', { slot: 'Z', input_tokens: 0, cost_usd: 0 }),
        spend('s5', { slot: 'b', input_tokens: 8, cost_usd: 1, provider: 'local:ollama', model_resolved: null, source_id: null }),
        spend('s6', { slot: 'b', input_tokens: 0, cost_usd: 0, outcome: 'timeout' }),
      ]);
      const bySlot = await engine.listDecideSpendBySlot();
      expect(bySlot.map((r) => r.slot)).toEqual(['A', 'Z', 'a', 'b']);
      expect(bySlot[3]).toEqual({ slot: 'b', input_tokens: 9, cost_usd: 1.5, requests: 3 });
      return bySlot;
    },
  );

  parityTest(
    'insertDecideSpend keeps a request id, a null source and model, a zero cost and unicode text exactly',
    { methods: ['insertDecideSpend', 'listDecideSpendBySlot', 'dailyDecideSpend'] },
    async (engine) => {
      await engine.insertDecideSpend([
        spend('caf\u00e9-\u2603', { slot: 'caf\u00e9', source_id: null, model_resolved: null, input_tokens: 0, cost_usd: 0 }),
        spend('', { slot: 'empty-id', input_tokens: 2147483647, cost_usd: 0.5 }),
        spend('minus', { slot: 'minus', input_tokens: -5, cost_usd: -0.25 }),
        spend('line\none', { slot: 'multi\nline', remote: true }),
      ]);
      const bySlot = await engine.listDecideSpendBySlot();
      const daily = await engine.dailyDecideSpend(new Date(0));
      expect(bySlot).toHaveLength(4);
      return { bySlot, daily };
    },
  );

  parityTest(
    'insertDecideSpend refuses a null in a NOT NULL column, a NUL byte and a number that is not an int, and records none of the batch',
    { methods: ['insertDecideSpend', 'listDecideSpendBySlot', 'dailyDecideSpend'] },
    async (engine) => {
      await engine.insertDecideSpend([spend('kept', { cost_usd: 0.5 })]);
      const bad = (over: Record<string, unknown>) => ({ ...spend('bad'), ...over }) as unknown as Spend;
      const refused = {
        nullSlot: await threw(() => engine.insertDecideSpend([spend('x1'), bad({ request_id: 'x2', slot: null })])),
        missingSlot: await threw(() => engine.insertDecideSpend([bad({ request_id: 'x3', slot: undefined })])),
        nullRequest: await threw(() => engine.insertDecideSpend([bad({ request_id: null })])),
        nullProvider: await threw(() => engine.insertDecideSpend([bad({ request_id: 'x4', provider: null })])),
        nullLane: await threw(() => engine.insertDecideSpend([bad({ request_id: 'x5', lane: null })])),
        nullOutcome: await threw(() => engine.insertDecideSpend([bad({ request_id: 'x6', outcome: null })])),
        nullTokens: await threw(() => engine.insertDecideSpend([bad({ request_id: 'x7', input_tokens: null })])),
        missingTokens: await threw(() => engine.insertDecideSpend([bad({ request_id: 'x8', input_tokens: undefined })])),
        nullCost: await threw(() => engine.insertDecideSpend([bad({ request_id: 'x9', cost_usd: null })])),
        missingCost: await threw(() => engine.insertDecideSpend([bad({ request_id: 'x10', cost_usd: undefined })])),
        nullRemote: await threw(() => engine.insertDecideSpend([bad({ request_id: 'x11', remote: null })])),
        nulByte: await threw(() => engine.insertDecideSpend([bad({ request_id: 'x12', slot: 'a\u0000b' })])),
        nulRequest: await threw(() => engine.insertDecideSpend([bad({ request_id: 'a\u0000b' })])),
        fractionalTokens: await threw(() => engine.insertDecideSpend([bad({ request_id: 'x13', input_tokens: 1.5 })])),
        hugeTokens: await threw(() => engine.insertDecideSpend([bad({ request_id: 'x14', input_tokens: 2147483648 })])),
      };
      const bySlot = await engine.listDecideSpendBySlot();
      expect(Object.values(refused).every(Boolean)).toBe(true);
      expect(bySlot).toEqual([{ slot: 'conflict', input_tokens: 10, cost_usd: 0.5, requests: 1 }]);
      return { refused, bySlot, daily: await engine.dailyDecideSpend(new Date(0)) };
    },
  );

  parityTest(
    'a refused row after good rows records none of them, and a request id may be used again afterwards',
    { methods: ['insertDecideSpend', 'listDecideSpendBySlot'] },
    async (engine) => {
      const badRow = { ...spend('second'), cost_usd: null } as unknown as Spend;
      const threwOnBatch = await threw(() => engine.insertDecideSpend([spend('first'), badRow, spend('third')]));
      const none = await engine.listDecideSpendBySlot();
      await engine.insertDecideSpend([spend('first', { cost_usd: 0.25 }), spend('second', { cost_usd: 0.125 })]);
      const some = await engine.listDecideSpendBySlot();
      expect(threwOnBatch).toBe(true);
      expect(none).toEqual([]);
      return { none, some };
    },
  );

  parityTest(
    'dailyDecideSpend refuses a date that is not a date',
    { methods: ['dailyDecideSpend'] },
    async (engine) => {
      const refused = await threw(() => engine.dailyDecideSpend(new Date(Number.NaN)));
      expect(refused).toBe(true);
      return { refused };
    },
  );
});

type Receipt = Parameters<BrainEngine['insertDecideReceipts']>[0][number];

/** A receipt row with every required column set; a case overrides what it is about. */
function receipt(decisionId: string, over: Partial<Receipt> = {}): Receipt {
  return { decision_id: decisionId, slot: 'conflict', mode: 'live', provider: 'typesafe:openai', outcome: 'kept', call_site: 'sweep', lane: 'sweep', ...over };
}

/**
 * Batches written this far apart get different timestamps even on an engine whose clock ticks in milliseconds. A
 * zero-hour or zero-day window read waits this long after the last insert, so every receipt is strictly older than the
 * read's now(): a receipt stamped in the same clock tick as the read is inside `created_at >= now() - 0` and outside
 * `created_at < now() - 0`. The receipt insert takes no created_at, so a past timestamp cannot be written on every arm.
 */
const apart = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

const badReceipt = (over: Record<string, unknown>) => ({ ...receipt('bad'), ...over }) as unknown as Receipt;

describe('engine parity: decide receipts', () => {
  parityTest(
    'every receipt read answers an empty list or zero on an empty table, and an empty insert or prune does nothing',
    { methods: ['insertDecideReceipts', 'pruneDecideReceipts', 'listDecideReceiptStats', 'decideSlotUsage', 'decideConflictNoEntityCounts', 'listDecideReplayReceipts', 'listDecideResolvedModels', 'listDecideMixedModelDecisions'] },
    async (engine) => {
      await engine.insertDecideReceipts([]);
      const out = {
        pruned: await engine.pruneDecideReceipts(7),
        stats: await engine.listDecideReceiptStats({ sinceHours: 24 }),
        slotStats: await engine.listDecideReceiptStats({ slot: 'conflict', sinceHours: 24 }),
        usage: await engine.decideSlotUsage(24),
        conflict: await engine.decideConflictNoEntityCounts(24),
        replay: await engine.listDecideReplayReceipts('conflict', 24),
        models: await engine.listDecideResolvedModels(24),
        mixed: await engine.listDecideMixedModelDecisions(24),
      };
      expect(out).toEqual({ pruned: 0, stats: [], slotStats: [], usage: [], conflict: { receipts: 0, skipped: 0 }, replay: [], models: [], mixed: [] });
      return out;
    },
  );

  parityTest(
    'listDecideReceiptStats groups by slot, mode, outcome and error reason in byte order (a null reason last) and aggregates the non-null values',
    { methods: ['insertDecideReceipts', 'listDecideReceiptStats'] },
    async (engine) => {
      await engine.insertDecideReceipts([
        receipt('d1', { answer_value: 0.5, latency_ms: 10, input_tokens: 100 }),
        receipt('d2', { answer_value: 0.25, latency_ms: 20, input_tokens: 200 }),
        receipt('d3', { answer_value: null, latency_ms: 30, input_tokens: null }),
        receipt('d4', { answer_value: 0.125, latency_ms: 40, input_tokens: 400 }),
        receipt('d5', { latency_ms: null, outcome: 'error', error_reason: 'timeout', input_tokens: 7 }),
        receipt('d6', { outcome: 'error', error_reason: 'bad_json', latency_ms: 5 }),
        receipt('d7', { outcome: 'error', error_reason: 'bad_json', latency_ms: 6 }),
        receipt('d8', { outcome: 'error', error_reason: null, latency_ms: 1 }),
        receipt('d9', { slot: 'Triage', mode: 'shadow', latency_ms: 3 }),
        receipt('d10', { slot: 'triage', mode: 'live', latency_ms: 4 }),
        receipt('d11', { slot: 'conflict', mode: 'Live', latency_ms: 2 }),
        receipt('d12', { answer_value: 0.1, confidence: 0.9, latency_ms: 1000, outcome: 'pass', input_tokens: 0 }),
        receipt('d13', { answer_value: 0.2, latency_ms: 1000, outcome: 'pass', input_tokens: 0 }),
        receipt('d14', { answer_value: 0.30000001, latency_ms: 1001, outcome: 'pass' }),
      ]);
      const all = await engine.listDecideReceiptStats({ sinceHours: 1 });
      const conflictOnly = await engine.listDecideReceiptStats({ slot: 'conflict', sinceHours: 1 });
      const nothing = await engine.listDecideReceiptStats({ sinceHours: 0 });
      const otherSlot = await engine.listDecideReceiptStats({ slot: 'nope', sinceHours: 1 });
      expect(all[0]).toMatchObject({ slot: 'Triage' });
      expect(nothing).toEqual([]);
      expect(otherSlot).toEqual([]);
      expect(conflictOnly.every((r) => r.slot === 'conflict')).toBe(true);
      const kept = all.find((r) => r.slot === 'conflict' && r.mode === 'live' && r.outcome === 'kept' && r.error_reason === null);
      expect(kept).toMatchObject({ n: 4, avg_value: (0.5 + 0.25 + 0.125) / 3, p50_latency: 25, input_tokens: 700 });
      return { all, conflictOnly };
    },
  );

  parityTest(
    'listDecideReceiptStats interpolates percentiles over one, two and many latencies, and answers null when every latency is null',
    { methods: ['insertDecideReceipts', 'listDecideReceiptStats'] },
    async (engine) => {
      const rows: Receipt[] = [receipt('one-a', { slot: 'a-one', latency_ms: 7 })];
      rows.push(receipt('two-a', { slot: 'b-two', latency_ms: 0 }), receipt('two-b', { slot: 'b-two', latency_ms: 3 }));
      for (const [i, ms] of [1, 2, 3, 4, 5, 6, 7, 8, 9, 100].entries()) rows.push(receipt(`many-${i}`, { slot: 'c-many', latency_ms: ms }));
      rows.push(receipt('null-a', { slot: 'd-null', latency_ms: null }), receipt('null-b', { slot: 'd-null', latency_ms: null, answer_value: null }));
      rows.push(receipt('neg', { slot: 'e-neg', latency_ms: -10 }), receipt('neg2', { slot: 'e-neg', latency_ms: 2147483647 }));
      await engine.insertDecideReceipts(rows);
      const stats = await engine.listDecideReceiptStats({ sinceHours: 1 });
      expect(stats.map((r) => r.slot)).toEqual(['a-one', 'b-two', 'c-many', 'd-null', 'e-neg']);
      expect(stats[0]).toMatchObject({ p50_latency: 7, p95_latency: 7 });
      expect(stats[1]).toMatchObject({ p50_latency: 1.5 });
      expect(stats[3]).toMatchObject({ n: 2, avg_value: null, p50_latency: null, p95_latency: null });
      return stats;
    },
  );

  parityTest(
    'receipt REAL columns keep the single-precision value Postgres would, in the replay read and in the mean',
    { methods: ['insertDecideReceipts', 'listDecideReplayReceipts', 'listDecideReceiptStats'] },
    async (engine) => {
      const values = [0.1, 1 / 3, 16777217, 1e-7, 3.4e38, 0, -0.5, 123456.789];
      await engine.insertDecideReceipts(values.map((v, i) => receipt(`real-${i}`, { answer_value: v, outcome: 'pass' })));
      const replay = await engine.listDecideReplayReceipts('conflict', 1);
      const stats = await engine.listDecideReceiptStats({ sinceHours: 1 });
      expect(replay).toHaveLength(values.length);
      expect(replay.find((r) => r.decision_id === 'real-0')?.answer_value).toBe(0.1);
      return { replay, stats };
    },
  );

  parityTest(
    'receipt means add the values in insertion order, so a sum that depends on order comes out the same',
    { methods: ['insertDecideReceipts', 'listDecideReceiptStats'] },
    async (engine) => {
      // Single-precision values that cancel only when added in this order: -1e30 + 1e30 + 1 is 1, 1e30 + 1 + -1e30 is 0.
      await engine.insertDecideReceipts([-1e30, 1e30, 1].map((v, i) => receipt(`ord-${i}`, { answer_value: v, outcome: 'pass' })));
      const stats = await engine.listDecideReceiptStats({ sinceHours: 1 });
      expect(stats).toHaveLength(1);
      return stats;
    },
  );

  parityTest(
    'decideSlotUsage counts distinct decisions, rows, tokens, errors, skips and egress refusals per slot in byte order',
    { methods: ['insertDecideReceipts', 'decideSlotUsage'] },
    async (engine) => {
      await engine.insertDecideReceipts([
        receipt('u1', { input_tokens: 10 }),
        receipt('u1', { input_tokens: 20, rank: 1 }),
        receipt('u2', { outcome: 'error', error_reason: 'timeout', input_tokens: null }),
        receipt('u3', { outcome: 'skipped', error_reason: 'no_entity' }),
        receipt('u4', { outcome: 'skipped', error_reason: 'egress_denied' }),
        receipt('u5', { outcome: 'error', error_reason: 'egress' }),
        receipt('u6', { outcome: 'skipped', error_reason: 'denied_source' }),
        receipt('u7', { outcome: 'skipped', error_reason: 'missing_provenance' }),
        receipt('u8', { outcome: 'skipped', error_reason: 'EGRESS_upper' }),
        receipt('u9', { outcome: 'skipped', error_reason: 'not_egress' }),
        receipt('u10', { outcome: 'skipped', error_reason: 'denied_source_2' }),
        receipt('u11', { outcome: 'skipped', error_reason: null }),
        receipt('v1', { slot: 'Alpha', input_tokens: 5 }),
        receipt('v2', { slot: 'alpha', input_tokens: 6 }),
        receipt('w1', { slot: 'zeta', outcome: 'error', error_reason: 'egress_x', input_tokens: 0 }),
      ]);
      const usage = await engine.decideSlotUsage(1);
      await apart();
      const none = await engine.decideSlotUsage(0);
      expect(usage.map((r) => r.slot)).toEqual(['Alpha', 'alpha', 'conflict', 'zeta']);
      expect(usage[2]).toEqual({ slot: 'conflict', decisions: 11, rows: 12, input_tokens: 30, errors: 2, skipped: 8, egress: 4 });
      expect(none).toEqual([]);
      return usage;
    },
  );

  parityTest(
    'decideConflictNoEntityCounts counts only conflict receipts and only no_entity skips, and the window cuts everything off at zero hours',
    { methods: ['insertDecideReceipts', 'decideConflictNoEntityCounts'] },
    async (engine) => {
      await engine.insertDecideReceipts([
        receipt('c1', { outcome: 'skipped', error_reason: 'no_entity' }),
        receipt('c2', { outcome: 'skipped', error_reason: 'no_entity' }),
        receipt('c3', { outcome: 'skipped', error_reason: 'other' }),
        receipt('c4', { outcome: 'error', error_reason: 'no_entity' }),
        receipt('c5'),
        receipt('t1', { slot: 'triage', outcome: 'skipped', error_reason: 'no_entity' }),
      ]);
      const counts = await engine.decideConflictNoEntityCounts(1);
      await apart();
      const none = await engine.decideConflictNoEntityCounts(0);
      expect(counts).toEqual({ receipts: 5, skipped: 2 });
      expect(none).toEqual({ receipts: 0, skipped: 0 });
      return { counts, none };
    },
  );

  parityTest(
    'listDecideReplayReceipts keeps the replay outcomes of one slot, ordered by decision id in byte order, then rank (null last), then insertion',
    { methods: ['insertDecideReceipts', 'listDecideReplayReceipts'] },
    async (engine) => {
      await engine.insertDecideReceipts([
        receipt('b', { rank: 2, answer_value: 0.5, protected: true, min_keep: 3 }),
        receipt('b', { rank: 1, answer_value: 0.25, outcome: 'pruned' }),
        receipt('b', { rank: null, answer_value: 0.75, outcome: 'margin_hold' }),
        receipt('B', { rank: 1, outcome: 'pass' }),
        receipt('a', { rank: 5, outcome: 'reject' }),
        receipt('a', { rank: 5, answer_value: 0.125, outcome: 'quarantine' }),
        receipt('a', { rank: 5, answer_value: 0.0625, outcome: 'insufficient_context' }),
        receipt('a', { rank: 0, outcome: 'skipped' }),
        receipt('a', { rank: -1, outcome: 'error', error_reason: 'timeout' }),
        receipt('a', { rank: 9, outcome: 'Kept' }),
        receipt('z', { slot: 'triage', rank: 1 }),
        receipt('\u00e9', { rank: 1 }),
        receipt('', { rank: 1 }),
      ]);
      const replay = await engine.listDecideReplayReceipts('conflict', 1);
      const triage = await engine.listDecideReplayReceipts('triage', 1);
      await apart();
      const none = await engine.listDecideReplayReceipts('conflict', 0);
      expect(replay.map((r) => r.decision_id)).toEqual(['', 'B', 'a', 'a', 'a', 'b', 'b', 'b', '\u00e9']);
      expect(replay.filter((r) => r.decision_id === 'b').map((r) => r.rank)).toEqual([1, 2, null]);
      expect(triage).toHaveLength(1);
      expect(none).toEqual([]);
      return { replay, triage };
    },
  );

  parityTest(
    'listDecideResolvedModels and listDecideMixedModelDecisions group the window per slot, skip rows without a model, and list the newest group first',
    { methods: ['insertDecideReceipts', 'listDecideResolvedModels', 'listDecideMixedModelDecisions'] },
    async (engine) => {
      await engine.insertDecideReceipts([
        receipt('m1', { model_resolved: 'gpt-b', error_reason: 'mixed_model' }),
        receipt('m2', { model_resolved: 'gpt-a' }),
        receipt('m3', { model_resolved: null, error_reason: 'mixed_model' }),
        receipt('m4', { slot: 'Alpha', model_resolved: 'gpt-a' }),
        receipt('m8', { outcome: 'error', error_reason: 'timeout' }),
      ]);
      await apart();
      await engine.insertDecideReceipts([
        receipt('m5', { slot: 'triage', provider: 'typesafe:anthropic', model_resolved: 'claude-x', error_reason: 'mixed_model' }),
        receipt('m6', { model_resolved: 'gpt-b' }),
      ]);
      await apart();
      await engine.insertDecideReceipts([receipt('m7', { slot: 'triage', provider: 'typesafe:anthropic', model_resolved: 'claude-y', error_reason: 'mixed_model' })]);
      const models = await engine.listDecideResolvedModels(1);
      const mixed = await engine.listDecideMixedModelDecisions(1);
      await apart();
      const noneModels = await engine.listDecideResolvedModels(0);
      const noneMixed = await engine.listDecideMixedModelDecisions(0);
      expect(models.every((r) => r.last_at instanceof Date && Math.abs(r.last_at.getTime() - Date.now()) < 3_600_000)).toBe(true);
      expect(noneModels).toEqual([]);
      expect(noneMixed).toEqual([]);
      expect(mixed).toEqual([{ slot: 'conflict', n: 2 }, { slot: 'triage', n: 2 }]);
      // The timestamps differ between engines; compare the order and the counts only.
      return { order: models.map((r) => [r.slot, r.provider, r.model_resolved, r.n]), mixed };
    },
  );

  parityTest(
    'pruneDecideReceipts deletes receipts older than the window and answers how many; spend is kept for at least 31 days',
    { methods: ['insertDecideReceipts', 'insertDecideSpend', 'pruneDecideReceipts', 'decideSlotUsage', 'dailyDecideSpend'] },
    async (engine) => {
      await engine.insertDecideReceipts([receipt('p1'), receipt('p2'), receipt('p3', { slot: 'triage' })]);
      await engine.insertDecideSpend([spend('keep-me', { cost_usd: 0.5 })]);
      const sevenDays = await engine.pruneDecideReceipts(7);
      const afterSeven = await engine.decideSlotUsage(1);
      await apart();
      const zeroDays = await engine.pruneDecideReceipts(0);
      const afterZero = await engine.decideSlotUsage(1);
      const again = await engine.pruneDecideReceipts(0);
      const spendKept = await engine.dailyDecideSpend(new Date(0));
      expect(sevenDays).toBe(0);
      expect(afterSeven).toHaveLength(2);
      expect(zeroDays).toBe(3);
      expect(afterZero).toEqual([]);
      expect(again).toBe(0);
      expect(spendKept).toEqual({ total: 0.5, remote: 0 });
      return { sevenDays, zeroDays, again, spendKept };
    },
  );

  parityTest(
    'receipts keep null columns, unicode text and extreme integers exactly',
    { methods: ['insertDecideReceipts', 'listDecideReplayReceipts', 'decideSlotUsage'] },
    async (engine) => {
      await engine.insertDecideReceipts([
        receipt('caf\u00e9-\u2603', { slot: 'caf\u00e9', source_id: null, model_alias: null, answer_choice: 'line\none', run_meta: '{"a":1}', rank: 2147483647, min_keep: -2147483648, k_used: 0, latency_ms: 0, input_tokens: 2147483647, remote: true, protected: true, outcome: 'pass' }),
        receipt('x', { slot: 'caf\u00e9', input_tokens: 0, outcome: 'pass', rank: 1 }),
      ]);
      const replay = await engine.listDecideReplayReceipts('caf\u00e9', 1);
      const usage = await engine.decideSlotUsage(1);
      expect(replay).toHaveLength(2);
      return { replay, usage };
    },
  );

  parityTest(
    'a token total past int4 is refused by the read that sums it, as Postgres refuses the cast',
    { methods: ['insertDecideReceipts', 'decideSlotUsage', 'listDecideReceiptStats'] },
    async (engine) => {
      await engine.insertDecideReceipts([receipt('big1', { input_tokens: 2147483647 }), receipt('big2', { input_tokens: 2147483647 })]);
      const usage = await threw(() => engine.decideSlotUsage(1));
      const stats = await threw(() => engine.listDecideReceiptStats({ sinceHours: 1 }));
      expect(usage && stats).toBe(true);
      return { usage, stats };
    },
  );

  parityTest(
    'insertDecideReceipts refuses a null in a NOT NULL column, a NUL byte, a number that is not an int or a real, and records none of the batch',
    { methods: ['insertDecideReceipts', 'decideSlotUsage'] },
    async (engine) => {
      await engine.insertDecideReceipts([receipt('kept')]);
      const refused = {
        nullDecision: await threw(() => engine.insertDecideReceipts([receipt('x1'), badReceipt({ decision_id: null })])),
        missingDecision: await threw(() => engine.insertDecideReceipts([badReceipt({ decision_id: undefined })])),
        nullSlot: await threw(() => engine.insertDecideReceipts([badReceipt({ slot: null })])),
        nullMode: await threw(() => engine.insertDecideReceipts([badReceipt({ mode: null })])),
        nullProvider: await threw(() => engine.insertDecideReceipts([badReceipt({ provider: null })])),
        nullOutcome: await threw(() => engine.insertDecideReceipts([badReceipt({ outcome: null })])),
        nullCallSite: await threw(() => engine.insertDecideReceipts([badReceipt({ call_site: null })])),
        nullLane: await threw(() => engine.insertDecideReceipts([badReceipt({ lane: null })])),
        nullProtected: await threw(() => engine.insertDecideReceipts([badReceipt({ protected: null })])),
        nullRemote: await threw(() => engine.insertDecideReceipts([badReceipt({ remote: null })])),
        nulByte: await threw(() => engine.insertDecideReceipts([badReceipt({ error_reason: 'a\u0000b' })])),
        nulDecision: await threw(() => engine.insertDecideReceipts([badReceipt({ decision_id: 'a\u0000b' })])),
        nulRunMeta: await threw(() => engine.insertDecideReceipts([badReceipt({ run_meta: 'a\u0000b' })])),
        fractionalLatency: await threw(() => engine.insertDecideReceipts([badReceipt({ latency_ms: 1.5 })])),
        hugeTokens: await threw(() => engine.insertDecideReceipts([badReceipt({ input_tokens: 2147483648 })])),
        hugeRank: await threw(() => engine.insertDecideReceipts([badReceipt({ rank: -2147483649 })])),
        fractionalMinKeep: await threw(() => engine.insertDecideReceipts([badReceipt({ min_keep: 0.5 })])),
        fractionalK: await threw(() => engine.insertDecideReceipts([badReceipt({ k_used: 2.5 })])),
        hugeReal: await threw(() => engine.insertDecideReceipts([badReceipt({ answer_value: 1e39 })])),
        hugeConfidence: await threw(() => engine.insertDecideReceipts([badReceipt({ confidence: -1e39 })])),
        underflowThreshold: await threw(() => engine.insertDecideReceipts([badReceipt({ threshold: 1e-50 })])),
      };
      const usage = await engine.decideSlotUsage(1);
      expect(Object.values(refused).every(Boolean)).toBe(true);
      expect(usage).toEqual([{ slot: 'conflict', decisions: 1, rows: 1, input_tokens: 0, errors: 0, skipped: 0, egress: 0 }]);
      return { refused, usage };
    },
  );

  parityTest(
    'the receipt reads and the prune refuse a window that is not a whole number of hours or days, or reaches before the first timestamp',
    { methods: ['insertDecideReceipts', 'pruneDecideReceipts', 'listDecideReceiptStats', 'decideSlotUsage', 'decideConflictNoEntityCounts', 'listDecideReplayReceipts', 'listDecideResolvedModels', 'listDecideMixedModelDecisions'] },
    async (engine) => {
      await engine.insertDecideReceipts([receipt('w1', { model_resolved: 'gpt-x' })]);
      const refused = {
        statsFraction: await threw(() => engine.listDecideReceiptStats({ sinceHours: 1.5 })),
        statsNaN: await threw(() => engine.listDecideReceiptStats({ sinceHours: Number.NaN })),
        statsInfinity: await threw(() => engine.listDecideReceiptStats({ sinceHours: Number.POSITIVE_INFINITY })),
        statsHuge: await threw(() => engine.listDecideReceiptStats({ sinceHours: 2147483647 })),
        statsTooBigForInt: await threw(() => engine.listDecideReceiptStats({ sinceHours: 2147483648 })),
        usageFraction: await threw(() => engine.decideSlotUsage(0.5)),
        usageHuge: await threw(() => engine.decideSlotUsage(2147483647)),
        conflictFraction: await threw(() => engine.decideConflictNoEntityCounts(24.5)),
        conflictHuge: await threw(() => engine.decideConflictNoEntityCounts(2147483647)),
        replayFraction: await threw(() => engine.listDecideReplayReceipts('conflict', 0.1)),
        replayHuge: await threw(() => engine.listDecideReplayReceipts('conflict', 2147483647)),
        modelsFraction: await threw(() => engine.listDecideResolvedModels(1.1)),
        modelsHuge: await threw(() => engine.listDecideResolvedModels(2147483647)),
        mixedFraction: await threw(() => engine.listDecideMixedModelDecisions(2.2)),
        mixedHuge: await threw(() => engine.listDecideMixedModelDecisions(2147483647)),
        pruneFraction: await threw(() => engine.pruneDecideReceipts(7.5)),
        pruneNaN: await threw(() => engine.pruneDecideReceipts(Number.NaN)),
        pruneHuge: await threw(() => engine.pruneDecideReceipts(2147483647)),
        statsNulByte: await threw(() => engine.listDecideReceiptStats({ slot: 'a\u0000b', sinceHours: 1 })),
        replayNulByte: await threw(() => engine.listDecideReplayReceipts('a\u0000b', 1)),
      };
      expect(Object.values(refused).every(Boolean)).toBe(true);
      // A far but valid window still works, and the refused prune deleted nothing.
      const far = await engine.decideSlotUsage(1_000_000);
      expect(far).toHaveLength(1);
      return { refused, far };
    },
  );
  /**
   * The rows each read below sees in a one-hour window. They are written and read in ONE transaction: on PGLite and
   * Postgres now() is the transaction's start there, so every row is stamped with the very now() the read uses, and a
   * `created_at >= now() - 0` filter counts it on every run (outside a transaction it counts only a row written in the
   * read's clock tick). A zero or negative window must still hold nothing.
   */
  const SAME_TRANSACTION_ROWS = [
    receipt('z1', { model_resolved: 'gpt-x', outcome: 'skipped', error_reason: 'no_entity' }),
    receipt('z2', { model_resolved: 'gpt-y', outcome: 'error', error_reason: 'mixed_model' }),
    receipt('z3', { model_resolved: 'gpt-x' }),
  ];
  /** The answer with each `last_at` replaced by whether it is a date (the arms' clocks differ) and a list in one order (rows stamped in one transaction tie on time). */
  const comparableAnswer = (value: unknown): unknown => (!Array.isArray(value) ? value : value
    .map((row: Row) => ('last_at' in row ? { ...row, last_at: row.last_at instanceof Date } : row))
    .sort((a, b) => bytes(JSON.stringify(a), JSON.stringify(b))));
  /** Write SAME_TRANSACTION_ROWS and read them over one hour, zero hours and minus one hour, in one transaction. */
  async function sameTransactionWindows(engine: BrainEngine, read: (tx: BrainEngine, hours: number) => Promise<unknown>, empty: unknown) {
    const answer = await engine.transaction(async (tx) => {
      await tx.insertDecideReceipts(SAME_TRANSACTION_ROWS);
      return { hour: comparableAnswer(await read(tx, 1)), zero: await read(tx, 0), negative: await read(tx, -1) };
    });
    expect(answer.hour).not.toEqual(empty);
    expect(answer.zero).toEqual(empty);
    expect(answer.negative).toEqual(empty);
    return answer;
  }
  const SAME_TRANSACTION = 'holds nothing in a zero or negative window, even a receipt written in the same transaction';

  parityTest(`listDecideReceiptStats ${SAME_TRANSACTION}`, { methods: ['insertDecideReceipts', 'listDecideReceiptStats'] },
    (engine) => sameTransactionWindows(engine, async (tx, h) =>
      [...await tx.listDecideReceiptStats({ sinceHours: h }), ...await tx.listDecideReceiptStats({ slot: 'conflict', sinceHours: h })], []));
  parityTest(`decideSlotUsage ${SAME_TRANSACTION}`, { methods: ['insertDecideReceipts', 'decideSlotUsage'] },
    (engine) => sameTransactionWindows(engine, (tx, h) => tx.decideSlotUsage(h), []));
  parityTest(`decideConflictNoEntityCounts ${SAME_TRANSACTION}`, { methods: ['insertDecideReceipts', 'decideConflictNoEntityCounts'] },
    (engine) => sameTransactionWindows(engine, (tx, h) => tx.decideConflictNoEntityCounts(h), { receipts: 0, skipped: 0 }));
  parityTest(`listDecideReplayReceipts ${SAME_TRANSACTION}`, { methods: ['insertDecideReceipts', 'listDecideReplayReceipts'] },
    (engine) => sameTransactionWindows(engine, (tx, h) => tx.listDecideReplayReceipts('conflict', h), []));
  parityTest(`listDecideResolvedModels ${SAME_TRANSACTION}`, { methods: ['insertDecideReceipts', 'listDecideResolvedModels'] },
    (engine) => sameTransactionWindows(engine, (tx, h) => tx.listDecideResolvedModels(h), []));
  parityTest(`listDecideMixedModelDecisions ${SAME_TRANSACTION}`, { methods: ['insertDecideReceipts', 'listDecideMixedModelDecisions'] },
    (engine) => sameTransactionWindows(engine, (tx, h) => tx.listDecideMixedModelDecisions(h), []));
});

type CalibrationInsert = Parameters<BrainEngine['insertDecideCalibration']>[0];
type CalibrationRow = Awaited<ReturnType<BrainEngine['listDecideCalibrations']>>[number];

function calibration(over: Partial<CalibrationInsert> = {}): CalibrationInsert {
  return {
    slot: 'conflict', call_site: 'sweep', provider: 'typesafe:openai', model_resolved: 'gpt-x', threshold: 0.8, min_keep: null,
    metric: 'f1', metric_value: 0.9, ece: 0.05, retest_sd: 0.01, repack_sd: 0.02, n: 100, dataset_hash: 'd1', split_hash: 's1',
    calibrate_ids_hash: 'c1', calibrate_only: true, pack_shape: 'full', notes: null, ...over,
  };
}

const badCalibration = (over: Record<string, unknown>) => ({ ...calibration(), ...over }) as unknown as CalibrationInsert;

/**
 * A row with its timestamps replaced by whether they are dates (the engines' clocks differ) and its id made relative to
 * `first` (a Postgres sequence keeps counting across cases).
 */
function comparable(row: CalibrationRow, first: number) {
  const stamp = (v: Date | null) => (v === null ? null : v instanceof Date && Math.abs(v.getTime() - Date.now()) < 3_600_000);
  return { ...row, id: row.id - first, created_at: stamp(row.created_at), qualified_at: stamp(row.qualified_at), retired_at: stamp(row.retired_at) };
}

describe('engine parity: decide calibrations', () => {
  parityTest(
    'every calibration read answers empty or null on an empty table, and a write to an unknown id changes nothing',
    { methods: ['listDecideCalibrations', 'getDecideCalibration', 'storeDecideQualification', 'setDecideCalibrationRetired'] },
    async (engine) => {
      const out = {
        list: await engine.listDecideCalibrations(),
        listSlot: await engine.listDecideCalibrations({ slot: 'conflict', includeRetired: true }),
        get: await engine.getDecideCalibration(1),
        getZero: await engine.getDecideCalibration(0),
        getNegative: await engine.getDecideCalibration(-1),
        retire: await engine.setDecideCalibrationRetired(999999, true),
        unretire: await engine.setDecideCalibrationRetired(999999, false),
        retireNegative: await engine.setDecideCalibrationRetired(-5, true),
        qualified: await threw(() => engine.storeDecideQualification(999999, { action_precision_lb: 0.5, qualification: '{}', policy_fingerprint: 'p' })),
      };
      expect(out).toEqual({ list: [], listSlot: [], get: null, getZero: null, getNegative: null, retire: false, unretire: false, retireNegative: false, qualified: false });
      return out;
    },
  );

  parityTest(
    'insertDecideCalibration answers a new id each time and getDecideCalibration reads the row back with its defaults and single-precision REAL columns',
    { methods: ['insertDecideCalibration', 'getDecideCalibration', 'listDecideCalibrations'] },
    async (engine) => {
      const a = await engine.insertDecideCalibration(calibration({ threshold: 0.1, metric_value: 1 / 3, ece: 16777217, retest_sd: 1e-7, repack_sd: 123456.789 }));
      const b = await engine.insertDecideCalibration(calibration({ slot: 'triage', min_keep: 3, notes: 'second' }));
      const c = await engine.insertDecideCalibration(calibration({ calibrate_only: false }));
      expect([b - a, c - b]).toEqual([1, 1]);
      const rows = await Promise.all([a, b, c].map((id) => engine.getDecideCalibration(id)));
      expect(rows.every((r) => r !== null)).toBe(true);
      expect((await engine.listDecideCalibrations()).map((r) => r.id - a)).toEqual([2, 0, 1]);
      expect(rows[0]!.threshold).toBe(0.1);
      expect(rows[0]).toMatchObject({ qualification: null, qualified_at: null, action_precision_lb: null, policy_fingerprint: null, retired_at: null });
      expect(rows[0]!.created_at).toBeInstanceOf(Date);
      return { rows: rows.map((r) => comparable(r!, a)), ids: [b - a, c - a] };
    },
  );

  parityTest(
    'listDecideCalibrations orders by slot in byte order, then newest first, then highest id, and filters by slot and by retired',
    { methods: ['insertDecideCalibration', 'listDecideCalibrations', 'setDecideCalibrationRetired'] },
    async (engine) => {
      const ids: Record<string, number> = {};
      for (const [name, slot] of [['a1', 'alpha'], ['A1', 'Alpha'], ['z1', 'zeta'], ['e1', '\u00e9'], ['x1', ''], ['a2', 'alpha'], ['a3', 'alpha'], ['z2', 'zeta']] as const) {
        ids[name] = await engine.insertDecideCalibration(calibration({ slot, notes: name }));
      }
      const first = ids.a1!;
      const all = await engine.listDecideCalibrations();
      const retired = await engine.setDecideCalibrationRetired(ids.a2!, true);
      const visible = await engine.listDecideCalibrations();
      const withRetired = await engine.listDecideCalibrations({ includeRetired: true });
      const alpha = await engine.listDecideCalibrations({ slot: 'alpha' });
      const alphaRetired = await engine.listDecideCalibrations({ slot: 'alpha', includeRetired: true });
      const empty = await engine.listDecideCalibrations({ slot: '' });
      const none = await engine.listDecideCalibrations({ slot: 'nothing' });
      const notes = (rows: CalibrationRow[]) => rows.map((r) => r.notes);
      expect(notes(all)).toEqual(['x1', 'A1', 'a3', 'a2', 'a1', 'z2', 'z1', 'e1']);
      expect(retired).toBe(true);
      expect(notes(visible)).toEqual(['x1', 'A1', 'a3', 'a1', 'z2', 'z1', 'e1']);
      expect(notes(withRetired)).toEqual(notes(all));
      expect(notes(alpha)).toEqual(['a3', 'a1']);
      expect(notes(alphaRetired)).toEqual(['a3', 'a2', 'a1']);
      expect(notes(empty)).toEqual(['x1']);
      expect(none).toEqual([]);
      return { all: all.map((r) => comparable(r, first)), visible: notes(visible), alpha: notes(alpha), alphaRetired: alphaRetired.map((r) => comparable(r, first)), empty: notes(empty) };
    },
  );

  parityTest(
    'storeDecideQualification replaces the three qualification columns, null included, and stamps qualified_at',
    { methods: ['insertDecideCalibration', 'storeDecideQualification', 'getDecideCalibration', 'listDecideCalibrations'] },
    async (engine) => {
      const id = await engine.insertDecideCalibration(calibration());
      const other = await engine.insertDecideCalibration(calibration({ slot: 'triage' }));
      await engine.storeDecideQualification(id, { action_precision_lb: 0.123456789, qualification: '{"pass":true}', policy_fingerprint: 'fp-1' });
      const one = await engine.getDecideCalibration(id);
      await engine.storeDecideQualification(id, { action_precision_lb: null, qualification: 'unicode \u00e9 \u{1F600}', policy_fingerprint: 'fp-2' });
      const two = await engine.getDecideCalibration(id);
      await engine.storeDecideQualification(id, { action_precision_lb: 1, qualification: null, policy_fingerprint: null });
      const three = await engine.getDecideCalibration(id);
      const untouched = await engine.getDecideCalibration(other);
      expect((await engine.listDecideCalibrations()).map((r) => r.id - id)).toEqual([0, other - id]);
      expect(one).toMatchObject({ action_precision_lb: 0.12345679, qualification: '{"pass":true}', policy_fingerprint: 'fp-1' });
      expect(one!.qualified_at).toBeInstanceOf(Date);
      expect(untouched).toMatchObject({ qualification: null, qualified_at: null });
      return { one: comparable(one!, id), two: comparable(two!, id), three: comparable(three!, id), untouched: comparable(untouched!, id) };
    },
  );

  parityTest(
    'setDecideCalibrationRetired stamps and clears retired_at, answers whether the row exists, and keeps the other columns',
    { methods: ['insertDecideCalibration', 'setDecideCalibrationRetired', 'getDecideCalibration', 'listDecideCalibrations'] },
    async (engine) => {
      const id = await engine.insertDecideCalibration(calibration());
      const other = await engine.insertDecideCalibration(calibration({ slot: 'triage' }));
      await engine.storeDecideQualification(id, { action_precision_lb: 0.5, qualification: 'q', policy_fingerprint: 'p' });
      const retired = await engine.setDecideCalibrationRetired(id, true);
      const afterRetire = await engine.getDecideCalibration(id);
      const hidden = (await engine.listDecideCalibrations()).map((r) => r.id - id);
      const again = await engine.setDecideCalibrationRetired(id, true);
      const brought = await engine.setDecideCalibrationRetired(id, false);
      const afterBack = await engine.getDecideCalibration(id);
      const shown = (await engine.listDecideCalibrations()).map((r) => r.id - id);
      const untouched = await engine.getDecideCalibration(other);
      expect([retired, again, brought]).toEqual([true, true, true]);
      expect(afterRetire!.retired_at).toBeInstanceOf(Date);
      expect(afterBack!.retired_at).toBeNull();
      expect(untouched!.retired_at).toBeNull();
      return { afterRetire: comparable(afterRetire!, id), hidden, afterBack: comparable(afterBack!, id), shown };
    },
  );

  parityTest(
    'a calibration keeps null columns, unicode text, the smallest and largest ints and negative or zero REALs exactly',
    { methods: ['insertDecideCalibration', 'getDecideCalibration'] },
    async (engine) => {
      const rows = [
        calibration({ min_keep: null, metric_value: null, ece: null, retest_sd: null, repack_sd: null, dataset_hash: null, split_hash: null, calibrate_ids_hash: null, notes: null }),
        calibration({ slot: 'slot \u00e9 \u{1F600}', call_site: '', provider: ' ', model_resolved: "it's \"quoted\" \\ back", metric: 'm\n\t', pack_shape: '\u4e2d\u6587', notes: 'note \u00e9' }),
        calibration({ n: 2147483647, min_keep: -2147483648, threshold: -0.5, metric_value: 0, ece: 3.4e38, retest_sd: -3.4e38, repack_sd: 1e-37 }),
        calibration({ n: 0, min_keep: 0, threshold: 0 }),
      ];
      const ids: number[] = [];
      for (const row of rows) ids.push(await engine.insertDecideCalibration(row));
      const read = await Promise.all(ids.map((id) => engine.getDecideCalibration(id)));
      expect(read[2]).toMatchObject({ n: 2147483647, min_keep: -2147483648, threshold: -0.5 });
      return read.map((r) => comparable(r!, ids[0]!));
    },
  );

  parityTest(
    'insertDecideCalibration refuses a null in a NOT NULL column, a NUL byte and a number that is not an int or a real, and records nothing',
    { methods: ['insertDecideCalibration', 'listDecideCalibrations'] },
    async (engine) => {
      const refused = {
        nullSlot: await threw(() => engine.insertDecideCalibration(badCalibration({ slot: null }))),
        missingSlot: await threw(() => engine.insertDecideCalibration(badCalibration({ slot: undefined }))),
        nullCallSite: await threw(() => engine.insertDecideCalibration(badCalibration({ call_site: null }))),
        nullProvider: await threw(() => engine.insertDecideCalibration(badCalibration({ provider: null }))),
        nullModel: await threw(() => engine.insertDecideCalibration(badCalibration({ model_resolved: null }))),
        nullThreshold: await threw(() => engine.insertDecideCalibration(badCalibration({ threshold: null }))),
        nullMetric: await threw(() => engine.insertDecideCalibration(badCalibration({ metric: null }))),
        nullN: await threw(() => engine.insertDecideCalibration(badCalibration({ n: null }))),
        nullCalibrateOnly: await threw(() => engine.insertDecideCalibration(badCalibration({ calibrate_only: null }))),
        missingCalibrateOnly: await threw(() => engine.insertDecideCalibration(badCalibration({ calibrate_only: undefined }))),
        nullPackShape: await threw(() => engine.insertDecideCalibration(badCalibration({ pack_shape: null }))),
        nulSlot: await threw(() => engine.insertDecideCalibration(badCalibration({ slot: 'a\u0000b' }))),
        nulNotes: await threw(() => engine.insertDecideCalibration(badCalibration({ notes: 'a\u0000b' }))),
        nulHash: await threw(() => engine.insertDecideCalibration(badCalibration({ dataset_hash: 'a\u0000b' }))),
        fractionalN: await threw(() => engine.insertDecideCalibration(badCalibration({ n: 1.5 }))),
        hugeN: await threw(() => engine.insertDecideCalibration(badCalibration({ n: 2147483648 }))),
        hugeMinKeep: await threw(() => engine.insertDecideCalibration(badCalibration({ min_keep: -2147483649 }))),
        hugeThreshold: await threw(() => engine.insertDecideCalibration(badCalibration({ threshold: 1e39 }))),
        hugeEce: await threw(() => engine.insertDecideCalibration(badCalibration({ ece: -1e39 }))),
        underflowSd: await threw(() => engine.insertDecideCalibration(badCalibration({ retest_sd: 1e-50 }))),
      };
      const list = await engine.listDecideCalibrations({ includeRetired: true });
      expect(Object.values(refused).every(Boolean)).toBe(true);
      expect(list).toEqual([]);
      return { refused, list };
    },
  );

  parityTest(
    'the calibration members that take an id refuse an id that is not a whole number in the bigint range, and the qualification refuses a NUL byte or a bad REAL',
    { methods: ['insertDecideCalibration', 'getDecideCalibration', 'storeDecideQualification', 'setDecideCalibrationRetired', 'listDecideCalibrations'] },
    async (engine) => {
      const id = await engine.insertDecideCalibration(calibration());
      const q = { action_precision_lb: 0.5, qualification: 'q', policy_fingerprint: 'p' };
      const refused = {
        getFraction: await threw(() => engine.getDecideCalibration(1.5)),
        getNaN: await threw(() => engine.getDecideCalibration(Number.NaN)),
        getInfinity: await threw(() => engine.getDecideCalibration(Number.POSITIVE_INFINITY)),
        getHuge: await threw(() => engine.getDecideCalibration(1e21)),
        retireFraction: await threw(() => engine.setDecideCalibrationRetired(0.5, true)),
        retireHuge: await threw(() => engine.setDecideCalibrationRetired(-1e21, false)),
        qualifyFraction: await threw(() => engine.storeDecideQualification(2.5, q)),
        qualifyNul: await threw(() => engine.storeDecideQualification(id, { ...q, qualification: 'a\u0000b' })),
        qualifyNulFingerprint: await threw(() => engine.storeDecideQualification(id, { ...q, policy_fingerprint: 'a\u0000b' })),
        qualifyHugeReal: await threw(() => engine.storeDecideQualification(id, { ...q, action_precision_lb: 1e39 })),
        listNul: await threw(() => engine.listDecideCalibrations({ slot: 'a\u0000b' })),
      };
      const row = await engine.getDecideCalibration(id);
      expect(Object.values(refused).every(Boolean)).toBe(true);
      expect(row).toMatchObject({ qualification: null, qualified_at: null, retired_at: null });
      return { refused, row: comparable(row!, id) };
    },
  );
});

/**
 * The one decide case that does not sort client-side (Ember ruling A, Nov 20). Slot and decision-id keys differ only
 * by case and by a non-ASCII letter, so byte order and an en_US collation list them differently. PGLite and the Rust
 * store list bytes and must match exactly. A Postgres database on a non-C collation lists them in its own order: that
 * order is pinned here as the known divergence (docs/designs/RUST_ENGINE.md, loss table), then the Postgres arm hands
 * back the byte order so the arms still compare the rows themselves. A Postgres database on the C collation lists bytes
 * and is held to them like the other two.
 */
describe('engine parity: decide orderings without a client-side sort', () => {
  const KEYS = ['b', 'A', 'z', 'a', '\u00e9', 'B', 'e'];
  const BYTE_ORDER = ['A', 'B', 'a', 'b', 'e', 'z', '\u00e9'];
  const EN_US_ORDER = ['a', 'A', 'b', 'B', 'e', '\u00e9', 'z'];
  armsParityTest(
    'decideSlotUsage and listDecideReplayReceipts list case and non-ASCII keys in byte order on PGLite and Rust; Postgres on a non-C collation is the pinned divergence',
    { methods: ['insertDecideReceipts', 'decideSlotUsage', 'listDecideReplayReceipts'] },
    async (engine, backend) => {
      await engine.insertDecideReceipts(KEYS.map((k) => receipt(k, { slot: k })));
      await engine.insertDecideReceipts(KEYS.map((k) => receipt(`r-${k}`)));
      const slots = (await engine.decideSlotUsage(1)).map((r) => r.slot).filter((s) => s !== 'conflict');
      const refs = (await engine.listDecideReplayReceipts('conflict', 1)).map((r) => r.decision_id);
      const byteRefs = BYTE_ORDER.map((k) => `r-${k}`);
      if (backend === 'postgres' && slots.join() !== BYTE_ORDER.join()) {
        expect({ backend, slots, refs }).toEqual({ backend, slots: EN_US_ORDER, refs: EN_US_ORDER.map((k) => `r-${k}`) });
        return { slots: BYTE_ORDER, refs: byteRefs };
      }
      expect({ backend, slots, refs }).toEqual({ backend, slots: BYTE_ORDER, refs: byteRefs });
      return { slots, refs };
    },
  );
});
