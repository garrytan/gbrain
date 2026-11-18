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
 *  - Regression: an engine whose ensure overwrites, whose upsert keeps the first value, or whose delete drops more
 *    than its key hands `gbrain decide` a receipt salt that changes between runs (receipts stop joining) or a
 *    kill-switch that comes back after it was cleared; one that double-counts a retried request id, counts a
 *    non-typesafe provider, or records the good rows of a refused batch shows a wrong daily spend against the budget.
 *  - Why existing coverage misses it: the decide store tests (test/decide/runtime.test.ts, test/decide/core.test.ts) run these statements on PGLite alone; no case
 *    compares engines.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). A write the engine refuses is compared as
 *    "threw" because constraint messages name the engine's own driver.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

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
