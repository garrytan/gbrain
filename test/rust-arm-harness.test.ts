/**
 * The Rust arm's own check (test/engine-parity/harness.ts `checkRustArm`) must not let a case pass for the wrong reason.
 * These tests feed it fabricated outcomes: the honest ones pass, and the two false passes the first version allowed
 * (a refusal caught earlier excusing an unrelated failure, and a divergence row excusing any thrown error) now fail.
 */
import { describe, expect, test } from 'bun:test';
import { checkRustArm, type RustCase, type RustTally } from './engine-parity/harness.ts';
import { DIVERGENCE_NORMALIZERS, readDivergences, rustMemberCapability, rustRefusal } from './engine-parity/rust-arm.ts';

// A member the store serves, and one it does not (its capability is what a refusal must name).
const SERVED = 'getPage';
const REFUSED = 'searchVector';

function refusal(capability: string): Error {
  return Object.assign(new Error(`refused: ${capability}`), { code: 'engine_capability_missing', reason: capability });
}

function tally(): RustTally { return { compared: 0, refused: 0, diverged: 0 }; }

function rustCase<T>(over: Partial<RustCase<T>> & { run: () => Promise<T> }): RustCase<T> {
  return {
    name: 'case', opts: { methods: [SERVED] as never }, calls: new Set([SERVED]), refusals: [],
    reference: { backend: 'pglite', value: undefined as T }, divergence: undefined, ...over,
  };
}

const row = (normalizer: string) => ({ file: 'f', name: 'case', normalizer, reason: 'why' });

describe('the Rust arm check', () => {
  test('the capability names the tests rely on exist', () => {
    expect(rustRefusal(SERVED)).toBeNull();
    expect(rustRefusal(REFUSED)).not.toBeNull();
  });

  test('an equal answer passes and is counted equal', async () => {
    const t = tally();
    await checkRustArm(rustCase({ run: async () => ({ a: 1 }), reference: { backend: 'pglite', value: { a: 1 } } }), t);
    expect(t).toEqual({ compared: 1, refused: 0, diverged: 0 });
  });

  test('a different answer without a row fails', async () => {
    await expect(checkRustArm(rustCase({ run: async () => ({ a: 2 }), reference: { backend: 'pglite', value: { a: 1 } } }), tally())).rejects.toThrow();
  });

  test('ending on the typed refusal of a reached capability passes and is counted refused', async () => {
    const capability = rustMemberCapability(REFUSED)!;
    const t = tally();
    await checkRustArm(rustCase({
      opts: { methods: [REFUSED] as never }, calls: new Set([REFUSED]),
      run: async () => { throw refusal(capability); },
    }), t);
    expect(t).toEqual({ compared: 0, refused: 1, diverged: 0 });
  });

  test('FALSE PASS 1: a refusal caught earlier no longer excuses a different failure', async () => {
    const capability = rustMemberCapability(REFUSED)!;
    const t = tally();
    await expect(checkRustArm(rustCase({
      opts: { methods: [REFUSED] as never }, calls: new Set([REFUSED]),
      refusals: [refusal(capability)], // the case caught this one and carried on ...
      run: async () => { throw new Error('something unrelated broke'); }, // ... and then failed for another reason
    }), t)).rejects.toThrow('something unrelated broke');
    expect(t).toEqual({ compared: 0, refused: 0, diverged: 0 });
  });

  test('a case that caught a refusal and then returned a value does not pass either', async () => {
    // a served member declined one option (the refusal names its own capability), and the case carried on
    const capability = rustMemberCapability(SERVED)!;
    await expect(checkRustArm(rustCase({
      refusals: [refusal(capability)],
      run: async () => 'ok', reference: { backend: 'pglite', value: 'ok' },
    }), tally())).rejects.toThrow();
  });

  test('a divergence row passes only when both answers are equal after its normaliser, and they still differ raw', async () => {
    const ours = [{ slug: 'b', score: 0.9 }, { slug: 'a', score: 0.1 }];
    const theirs = [{ slug: 'a', score: 3 }, { slug: 'b', score: 2 }];
    const t = tally();
    await checkRustArm(rustCase({ run: async () => ours, reference: { backend: 'pglite', value: theirs }, divergence: row('ranking-order-and-score') }), t);
    expect(t).toEqual({ compared: 0, refused: 0, diverged: 1 });
  });

  test('FALSE PASS 2: a divergence row no longer excuses a thrown error', async () => {
    const t = tally();
    await expect(checkRustArm(rustCase({
      run: async () => { throw new Error('rust blew up'); },
      reference: { backend: 'pglite', value: [] }, divergence: row('ranking-order-and-score'),
    }), t)).rejects.toThrow('rust blew up');
    expect(t.diverged).toBe(0);
  });

  test('a divergence row does not excuse a different set of rows', async () => {
    await expect(checkRustArm(rustCase({
      run: async () => [{ slug: 'a', score: 1 }], reference: { backend: 'pglite', value: [{ slug: 'a', score: 2 }, { slug: 'b', score: 1 }] },
      divergence: row('ranking-order-and-score'),
    }), tally())).rejects.toThrow();
  });

  test('a stale divergence row (the answers now match) fails', async () => {
    await expect(checkRustArm(rustCase({
      run: async () => [{ slug: 'a', score: 1 }], reference: { backend: 'pglite', value: [{ slug: 'a', score: 1 }] },
      divergence: row('ranking-order-and-score'),
    }), tally())).rejects.toThrow('remove the row');
  });

  test('a divergence row that names no normaliser, or an unknown one, fails', async () => {
    await expect(checkRustArm(rustCase({
      run: async () => 1, reference: { backend: 'pglite', value: 2 }, divergence: row('nope'),
    }), tally())).rejects.toThrow('does not exist');
  });

  test('every row of test/rust-expected-divergence/ names a normaliser that exists', () => {
    for (const r of readDivergences()) expect(Object.keys(DIVERGENCE_NORMALIZERS)).toContain(r.normalizer);
  });
});
