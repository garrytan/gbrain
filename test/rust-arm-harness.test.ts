/**
 * The Rust arm's own check (test/engine-parity/harness.ts `checkRustArm`) must not let a case pass for the wrong reason.
 * These tests feed it fabricated outcomes: the honest ones pass, and the two false passes the first version allowed
 * (a refusal caught earlier excusing an unrelated failure, and a divergence row excusing any thrown error) now fail.
 */
import { describe, expect, test } from 'bun:test';
import { checkRustArm, type RustCase, type RustTally } from './engine-parity/harness.ts';
import { DIVERGENCE_NORMALIZERS, readDivergences, rustMemberCapability, rustRefusal } from './engine-parity/rust-arm.ts';
import { readStopPins, refusalFacts, rustServes, setupStep, today, type StopPin } from './engine-parity/rust-refusals.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A member the store serves, and one it never serves: the Rust store runs no SQL, so executeRaw always refuses
// (its capability is what a refusal must name). A member a lane may type later would make this test go stale.
const SERVED = 'getPage';
const REFUSED = 'executeRaw';

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

  // A write the coordinator refuses inside the store returns write_pending; the case's own assertion then throws.
  const pending = async () => { throw new Error('expected committed, received { code: "write_pending" }'); };
  const preimage = Object.assign(refusal('page_versions'), { detail: 'member=createVersion (option preimage) capability=page_versions outcome=none' });
  const pendingPin = { capability: 'page_versions', member: 'createVersion (option preimage)', site: 's', owner: 'o', due: 'd' } as const;

  test('a write_pending behind exactly the pinned refusal is counted refused', async () => {
    const t = tally();
    await checkRustArm(rustCase({ opts: { methods: [SERVED] as never, rustPendingStop: pendingPin }, refusals: [preimage], run: pending }), t);
    expect(t).toEqual({ compared: 0, refused: 1, diverged: 0 });
  });

  test('a write_pending with no pin still fails, even behind a typed refusal', async () => {
    await expect(checkRustArm(rustCase({ refusals: [preimage], run: pending }), tally())).rejects.toThrow('write_pending');
  });

  test('a pin whose capability or member does not match the refusal fails and says to update it', async () => {
    for (const wrong of [{ ...pendingPin, capability: 'raw_sql' }, { ...pendingPin, member: 'putPage' }]) {
      await expect(checkRustArm(rustCase({ opts: { methods: [SERVED] as never, rustPendingStop: wrong }, refusals: [preimage], run: pending }),
        tally())).rejects.toThrow('rustPendingStop');
    }
  });

  test('a pinned case that no longer stops fails and says to remove the pin', async () => {
    await expect(checkRustArm(rustCase({ opts: { methods: [SERVED] as never, rustPendingStop: pendingPin }, run: async () => 'ok',
      reference: { backend: 'pglite', value: 'ok' } }), tally())).rejects.toThrow('remove its rustPendingStop pin');
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

  // ---- item 6 of docs/research/rust-test-audit-r2.md: a refusal of a served case, or of a setup, fails ---------------

  /** The refusal a served member raises when it declines one option (store-members/common.ts takeOptions). */
  const servedRefusal = (member = SERVED, what = 'option nope') => capabilityMissing(rustMemberCapability(member) as never, `${member} (${what})`);
  /** The refusal of a raw-SQL fixture, as the Rust engine's executeRaw raises it. */
  const rawSqlRefusal = () => capabilityMissing('raw_sql', 'executeRaw');
  const pin = (over: Partial<StopPin> = {}): StopPin => ({ file: 'f', name: 'case', member: SERVED, owner: 'lane-x', due: '2999-01-01', reason: 'why', ...over });

  test('refusalFacts reads the member, the capability and the text off a real refusal', () => {
    expect(refusalFacts(servedRefusal())).toEqual({ member: SERVED, capability: rustMemberCapability(SERVED), text: `${SERVED} (option nope)` });
    expect(refusalFacts(rawSqlRefusal())).toMatchObject({ member: 'executeRaw', capability: 'raw_sql' });
    expect(refusalFacts(new Error('plain'))).toEqual({ member: null, capability: null, text: null });
  });

  test('the member table agrees on which members are served', () => {
    expect(rustServes(SERVED)).toBe(true);
    expect(rustServes(REFUSED)).toBe(false);
    expect(rustServes('connect')).toBe(true);
    expect(rustServes('notAMember')).toBe(false);
  });

  test('a refusal by a member the engine does not serve passes and is counted refused, with the member in the ledger', async () => {
    const t: RustTally = { ...tally(), stops: [] };
    await checkRustArm(rustCase({ opts: { methods: [REFUSED] as never }, calls: new Set([REFUSED]), run: async () => { throw rawSqlRefusal(); } }), t);
    expect(t.refused).toBe(1);
    expect(t.stops).toEqual([{ name: 'case', member: 'executeRaw', capability: 'raw_sql' }]);
  });

  test('a refusal by a SERVED member fails the case and names the member', async () => {
    const t = tally();
    await expect(checkRustArm(rustCase({ run: async () => { throw servedRefusal(); } }), t)).rejects.toThrow(`the Rust engine serves ${SERVED} but it refused`);
    expect(t.refused).toBe(0);
  });

  test('a served member refusing for any option still fails: the member decides', async () => {
    await expect(checkRustArm(rustCase({ run: async () => { throw servedRefusal(SERVED, 'a vector'); } }), tally())).rejects.toThrow(SERVED);
  });

  test('a REFUSED SETUP of a case whose own members are all served fails, naming the step and the member', async () => {
    const t = tally();
    await expect(checkRustArm(rustCase({
      calls: new Set([SERVED, REFUSED]),
      run: async () => { await setupStep('restrictFolder', async () => { throw rawSqlRefusal(); }); return 1; },
    }), t)).rejects.toThrow(/setup step restrictFolder was refused \(executeRaw.*\).*never reached its own members \(getPage\)/);
    expect(t.refused).toBe(0);
  });

  test('a refused setup passes as a stop when the case declares a member the engine does not serve', async () => {
    const t = tally();
    await checkRustArm(rustCase({
      opts: { methods: [SERVED, REFUSED] as never }, calls: new Set([SERVED, REFUSED]),
      run: async () => { await setupStep('restrictFolder', async () => { throw rawSqlRefusal(); }); return 1; },
    }), t);
    expect(t.refused).toBe(1);
  });

  test('a pin with an owner and a due date lets a served-member refusal stop the case, and the ledger shows the pin', async () => {
    const t: RustTally = { ...tally(), stops: [] };
    await checkRustArm(rustCase({ run: async () => { throw servedRefusal(); }, pin: pin() }), t);
    expect(t.refused).toBe(1);
    expect(t.stops).toMatchObject([{ name: 'case', member: SERVED, pinned: { owner: 'lane-x', due: '2999-01-01' } }]);
  });

  test('a pin lets a refused setup stop the case', async () => {
    const t = tally();
    await checkRustArm(rustCase({
      calls: new Set([SERVED, REFUSED]), pin: pin({ member: 'executeRaw' }),
      run: async () => { await setupStep('restrictFolder', async () => { throw rawSqlRefusal(); }); return 1; },
    }), t);
    expect(t.refused).toBe(1);
  });

  test('a pin for another member, a pin past its due date and a pin the case no longer needs all fail', async () => {
    const run = async () => { throw servedRefusal(); };
    await expect(checkRustArm(rustCase({ run, pin: pin({ member: 'putPage' }) }), tally())).rejects.toThrow('for putPage, but the refusal names getPage');
    await expect(checkRustArm(rustCase({ run, pin: pin({ due: '2000-01-01' }) }), tally())).rejects.toThrow('was due 2000-01-01 and has passed');
    // the case now returns the PGLite answer: the pin is stale
    await expect(checkRustArm(rustCase({ run: async () => 1, reference: { backend: 'pglite', value: 1 }, pin: pin() }), tally())).rejects.toThrow('no longer stops on a refusal');
    // the case now stops on a member the engine does not serve: the pin covers nothing
    await expect(checkRustArm(rustCase({ opts: { methods: [REFUSED] as never }, calls: new Set([REFUSED]), run: async () => { throw rawSqlRefusal(); }, pin: pin({ member: 'executeRaw' }) }), tally()))
      .rejects.toThrow('no longer one the pin covers');
  });

  // A caught refusal: a refused member read that code on the way swallows (a best-effort writer, a fallback lookup).
  // Its pin names the member and the src/ file that called it (`member@site`); the stack is what the harness reads.
  const caughtAt = (site: string) => Object.assign(rawSqlRefusal(), {
    stack: `Error: refused\n    at refuse (/repo/src/core/rust-engine/errors.ts:22:3)\n    at opError (/repo/src/core/ops/contract.ts:204:13)\n    at caller (/repo/${site}:10:5)`,
  });
  const SPELLINGS = 'src/core/ops/slug-params.ts';
  const READ_LOG = 'src/core/access/read-log.ts';
  const caughtPin = (site: string, over: Partial<StopPin> = {}) => pin({ member: `executeRaw@${site}`, ...over });
  const equalCase = (refusals: unknown[], caughtPins: StopPin[]) => rustCase({
    opts: { methods: [SERVED] as never }, calls: new Set([SERVED, REFUSED]), refusals, caughtPins,
    run: async () => 1, reference: { backend: 'pglite', value: 1 },
  });

  test('a caught refusal pinned by member and site lets an equal answer pass, and the ledger names the pin', async () => {
    const t: RustTally = { ...tally(), stops: [] };
    await checkRustArm(equalCase([caughtAt(SPELLINGS), caughtAt(SPELLINGS), caughtAt(READ_LOG)], [caughtPin(SPELLINGS), caughtPin(READ_LOG, { owner: 'lane-y' })]), t);
    expect(t.compared).toBe(1);
    expect(t.stops).toMatchObject([
      { name: 'case', member: `executeRaw@${SPELLINGS}`, pinned: { owner: 'lane-x' } },
      { name: 'case', member: `executeRaw@${READ_LOG}`, pinned: { owner: 'lane-y' } },
    ]);
  });

  test('a caught refusal no pin covers, a caught pin past its due date and a caught pin nothing hits all fail', async () => {
    await expect(checkRustArm(equalCase([caughtAt(SPELLINGS), caughtAt(READ_LOG)], [caughtPin(SPELLINGS)]), tally()))
      .rejects.toThrow(`executeRaw@${READ_LOG}`);
    await expect(checkRustArm(equalCase([caughtAt(SPELLINGS)], [caughtPin(SPELLINGS, { due: '2000-01-01' })]), tally()))
      .rejects.toThrow('was due 2000-01-01 and has passed');
    await expect(checkRustArm(equalCase([caughtAt(SPELLINGS)], [caughtPin(SPELLINGS), caughtPin(READ_LOG)]), tally()))
      .rejects.toThrow(`no longer catches executeRaw@${READ_LOG}; remove the row`);
  });

  test('a caught pin never excuses a different answer or a thrown error', async () => {
    await expect(checkRustArm(rustCase({ calls: new Set([SERVED, REFUSED]), refusals: [caughtAt(SPELLINGS)], caughtPins: [caughtPin(SPELLINGS)],
      run: async () => 2, reference: { backend: 'pglite', value: 1 } }), tally())).rejects.toThrow();
    await expect(checkRustArm(rustCase({ calls: new Set([SERVED, REFUSED]), refusals: [caughtAt(SPELLINGS)], caughtPins: [caughtPin(SPELLINGS)],
      run: async () => { throw new Error('boom'); } }), tally())).rejects.toThrow('boom');
  });

  test('every row of test/rust-stop-pins/ has an owner and is not past its due date', () => {
    for (const row of readStopPins()) {
      expect(row.owner.trim()).not.toBe('');
      expect(row.due >= today()).toBe(true);
    }
  });

  test('readStopPins refuses a row without an owner or with a bad date', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-pins-'));
    try {
      writeFileSync(join(dir, 'a.tsv'), '# comment\nf\tc\tgetPage\t\t2026-12-01\twhy\n');
      expect(() => readStopPins(dir)).toThrow('a row needs file, case name, member, owner, due date and reason');
      writeFileSync(join(dir, 'a.tsv'), 'f\tc\tgetPage\tme\tsoon\twhy\n');
      expect(() => readStopPins(dir)).toThrow('due date must be YYYY-MM-DD');
      writeFileSync(join(dir, 'a.tsv'), 'f\tc\tgetPage\tme\t2026-12-01\twhy\n');
      expect(readStopPins(dir)).toEqual([{ file: 'f', name: 'c', member: 'getPage', owner: 'me', due: '2026-12-01', reason: 'why' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Rust arm check: a rustStop pin', () => {
  const PIN = 'Rust stop: a grant this base does not serve. Owner: another lane. Unpin at the join.';
  const STOP = { code: 'permission_denied', pin: PIN };
  const stopped = (message = `put_page refused permission_denied: ${PIN}`, code = 'permission_denied') =>
    Object.assign(new Error(message), { code });
  const pinned = <T>(over: Partial<RustCase<T>> & { run: () => Promise<T> }) =>
    rustCase<T>({ opts: { methods: [SERVED] as never, rustStop: STOP }, ...over });

  test('the named stop passes and is counted refused', async () => {
    const t = tally();
    await checkRustArm(pinned({ run: async () => { throw stopped(); } }), t);
    expect(t).toEqual({ compared: 0, refused: 1, diverged: 0 });
  });

  test('a different code fails', async () => {
    const t = tally();
    await expect(checkRustArm(pinned({ run: async () => { throw stopped(undefined, 'storage_error'); } }), t)).rejects.toThrow('rustStop pin (permission_denied)');
    expect(t).toEqual({ compared: 0, refused: 0, diverged: 0 });
  });

  test('a message without the pin fails', async () => {
    await expect(checkRustArm(pinned({ run: async () => { throw stopped('put_page refused permission_denied'); } }), tally())).rejects.toThrow('ended on another error');
  });

  test('a thrown object that is not an Error fails, even with the code and the pin', async () => {
    await expect(checkRustArm(pinned({ run: async () => { throw { code: 'permission_denied', message: PIN }; } }), tally())).rejects.toThrow('ended on another error');
  });

  test('a member in methods that was not called fails', async () => {
    await expect(checkRustArm(pinned({ calls: new Set(), run: async () => { throw stopped(); } }), tally())).rejects.toThrow();
  });

  test('an empty pin fails', async () => {
    await expect(checkRustArm(rustCase({ opts: { methods: [SERVED] as never, rustStop: { code: 'permission_denied', pin: '  ' } },
      run: async () => { throw stopped(); } }), tally())).rejects.toThrow('needs a pin');
  });

  test('a pin on the capability refusal code fails: that stop takes the in-test pin', async () => {
    await expect(checkRustArm(rustCase({ opts: { methods: [SERVED] as never, rustStop: { code: 'engine_capability_missing', pin: PIN } },
      run: async () => { throw stopped(undefined, 'engine_capability_missing'); } }), tally())).rejects.toThrow('in-test pin');
  });

  test('STALE: a pinned case that now returns fails, even when the value equals the reference', async () => {
    const t = tally();
    await expect(checkRustArm(pinned({ run: async () => ({ a: 1 }), reference: { backend: 'pglite', value: { a: 1 } } }), t))
      .rejects.toThrow('has a rustStop pin (permission_denied) but now returns; remove the pin and expect equal');
    expect(t).toEqual({ compared: 0, refused: 0, diverged: 0 });
  });

  test('a pinned case that ends on a capability refusal fails', async () => {
    const capability = rustMemberCapability(REFUSED)!;
    const t = tally();
    await expect(checkRustArm(pinned({ opts: { methods: [REFUSED] as never, rustStop: STOP }, calls: new Set([REFUSED]),
      run: async () => { throw refusal(capability); } }), t)).rejects.toThrow('ended on a typed capability refusal');
    expect(t).toEqual({ compared: 0, refused: 0, diverged: 0 });
  });
});
