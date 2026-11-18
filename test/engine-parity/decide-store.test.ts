/**
 * BrainEngine parity — the decide store (`decide_state`, `decide_spend`, `decision_receipts`, `decide_calibrations`):
 * the members that replace the `engine.executeRaw` statements of src/core/ai/decide/store.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    the Rust arm through test/engine-parity/harness.ts with GBRAIN_TEST_RUST_ARM=1). State: a key keeps its last
 *    value, an absent key reads null, `ensureDecideState` keeps the first value and answers the stored one, a
 *    delete forgets one key only, and a null value or a NUL byte is refused.
 *  - Regression: an engine whose ensure overwrites, whose upsert keeps the first value, or whose delete drops more
 *    than its key hands `gbrain decide` a receipt salt that changes between runs (receipts stop joining) or a
 *    kill-switch that comes back after it was cleared.
 *  - Why existing coverage misses it: the decide store tests (test/decide/runtime.test.ts, test/decide/core.test.ts) run these statements on PGLite alone; no case
 *    compares engines.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). A write the engine refuses is compared as
 *    "threw" because constraint messages name the engine's own driver.
 */
import { describe, expect } from 'bun:test';
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
