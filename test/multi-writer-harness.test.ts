/**
 * The parity harness's multi-writer support (test/engine-parity/harness.ts `mwCase`): the arm plan a matrix cell gives, strict
 * acceptance of a `runs` cell, reference selection after per-case skips, and the `rust-mu` view.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a multi-writer conformance case passes on an arm only when its whole scenario and inline invariant complete
 *    (a typed capability refusal, a refusal caught on the way, a pending error or a named stop fails it); the reference is
 *    the first arm that ran the case; a `compare` case on Rust with no reference fails naming DATABASE_URL, and a
 *    `standalone` case is counted apart and never as equal to PGLite; every outcome lands in the ledger; the `rust-mu` view
 *    sets GBRAIN_RUST_MULTIUSER=1 inside the test process and `rust` leaves it unset.
 *  - Regression: a harness edit that lets a refusal pass a `runs` cell, picks the wrong reference after a skip, lets a missing
 *    reference compare against nothing, or counts a standalone pass as equal. The case work is judged by this harness, so a
 *    lenient harness would turn the pass mark green by itself.
 *  - Why existing coverage misses it: rust-arm-harness.test.ts owns the ordinary refusal rules (kept unchanged, with a
 *    control below); nothing owns the matrix-driven path.
 *  - Seam: none beyond `runMwCase` and `checkMwArm`, which the harness itself calls for every `mwCase` parityTest.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertMultiuserCapabilityName, recordingEngine, rustArmModeProblem, rustArmMultiuser, rustMultiuserSwitch, checkMwArm, checkRustArm, mwArmPlan, runMwCase, rustMultiuserView, MultiuserStopError, multiuserStopArmed, OWNER_ONLY_MESSAGE, OWNER_ONLY_STOP, pinnedMultiuserStop, REMOTE_WRITE_REFUSALS, REMOTE_WRITE_STOP, stopOnOwnerOnlyRefusal, stopOnRemoteWriteRefusal, type MwArmHandle, type MwArmStarted, type RustTally } from './engine-parity/harness.ts';
import { checkRustTally } from './engine-parity/rust-tally.ts';
import { MW_ARMS, type MwArm, type MwCase, type MwCell } from './engine-parity/multi-writer-cases.ts';
import { type LedgerLine } from './engine-parity/multi-writer-ledger.ts';
import { assertRustCommitLogResolved, assertRustMultiuserResolved, installMuConnect, rustArmAddonPath, rustMuRoute, RUST_MULTIUSER_CONFIG_KEY } from './engine-parity/rust-arm.ts';
import { mwEntries, mwEntry } from './engine-parity/multi-writer-entries.ts';
import { withEnv } from './helpers/with-env.ts';
import { parityDeclarations } from './engine-parity/coverage.ts';

const RUNS: MwCell = { status: 'runs' };

function row(over: Partial<Omit<MwCase, 'cells'>> & { cells?: Partial<Record<MwArm, MwCell>> } = {}): MwCase {
  const cells = Object.fromEntries(MW_ARMS.map((arm) => [arm, RUNS])) as Record<MwArm, MwCell>;
  return {
    id: 'C04', title: 'eight workers claim each job once', operation: 'claimNextJob', invariant: 'each job is claimed once', reference: 'compare',
    members: ['claimNextJob'], storeTests: { runnable: ['c04'], pending: [] }, ...over, cells: { ...cells, ...over.cells },
  };
}

const refusal = (member: string) => Object.assign(new Error(`The Rust engine does not support ${member} yet (it needs the multi_writer capability)`),
  { code: 'engine_capability_missing', reason: 'multi_writer', detail: `member=${member} capability=multi_writer` });

interface Body<T> { calls: Set<string>; refusals: unknown[] }

function handle<T>(label: MwArmHandle<T>['label'], body: (b: Body<T>) => Promise<T>,
  o: { capabilities?: string[]; started?: string[] } = {}): MwArmHandle<T> {
  return {
    label, backend: label === 'rust' || label.startsWith('rust-mu') ? 'rust' : (label as 'pglite' | 'postgres'),
    start: async (): Promise<MwArmStarted<T>> => {
      o.started?.push(label);
      const calls = new Set<string>();
      const refusals: unknown[] = [];
      return { run: () => body({ calls, refusals }), calls, refusals,
        capabilities: o.capabilities === undefined ? undefined : new Set(o.capabilities), finish: async () => undefined };
    },
  };
}

const ok = (value: unknown, members: string[] = ['claimNextJob']) => async (b: Body<unknown>) => { for (const m of members) b.calls.add(m); return value; };
const OPTS = { methods: ['claimNextJob'] as const } as never;

function collect(): { lines: LedgerLine[]; write: (l: LedgerLine) => void } {
  const lines: LedgerLine[] = [];
  return { lines, write: (l) => { lines.push(l); } };
}

async function run(r: MwCase, arms: Array<MwArmHandle<unknown>>) {
  const ledger = collect();
  const result = await runMwCase({ row: r, name: 'C04 eight workers claim each job once', opts: OPTS, arms, ledger: ledger.write }).then((counts) => ({ counts, error: null as unknown }), (error: unknown) => ({ counts: null, error }));
  return { ...result, lines: ledger.lines };
}

describe('mwArmPlan: the matrix cell decides whether an arm runs the case', () => {
  test('runs runs; n/a and pending skip with the reason in the ledger detail', () => {
    const r = row({ cells: { pglite: { status: 'n/a', why: 'one connection' }, rust: { status: 'pending', owner: 'L1 optimistic transactions', why: 'I-1 begin_with' } } });
    expect([mwArmPlan(r, 'postgres'), mwArmPlan(r, 'pglite'), mwArmPlan(r, 'rust')]).toEqual([
      { action: 'run' },
      { action: 'skip', outcome: 'n/a', detail: 'one connection' },
      { action: 'skip', outcome: 'pending', detail: 'L1 optimistic transactions: I-1 begin_with' },
    ]);
  });
});

describe('strict acceptance of a `runs` cell (checkMwArm)', () => {
  const base = (over: Partial<Parameters<typeof checkMwArm>[0]> = {}) => {
    const ledger = collect();
    const calls = new Set<string>(['claimNextJob']);
    return { ledger, call: { row: row({ reference: 'standalone' }), label: 'postgres' as const, backend: 'postgres' as const, name: 'C04 x', opts: OPTS, calls, refusals: [] as unknown[],
      capabilities: undefined, reference: undefined, ledger: ledger.write, run: async () => ({ v: 1 }), ...over } as Parameters<typeof checkMwArm>[0] };
  };

  test('control: a scenario that completes with its members called passes and writes a pass line', async () => {
    const { ledger, call } = base();
    expect((await checkMwArm(call)).value).toEqual({ v: 1 });
    expect(ledger.lines.map((l) => [l.case, l.arm, l.outcome])).toEqual([['C04', 'postgres', 'pass']]);
  });

  test('a typed capability refusal ends the case as a failure, naming the refusal, and the fail line is written first', async () => {
    const { ledger, call } = base({ run: async () => { throw refusal('claimNextJob'); } });
    await expect(checkMwArm(call)).rejects.toThrow(/typed capability refusal \(multi_writer at claimNextJob\), which a `runs` cell does not accept/);
    expect(ledger.lines.map((l) => l.outcome)).toEqual(['fail']);
    expect(ledger.lines[0]!.detail).toContain('claimNextJob');
  });

  test('a refusal the scenario caught and carried on from still fails the case', async () => {
    const refusals: unknown[] = [];
    const { call } = base({ refusals, run: async () => { refusals.push(refusal('claimNextJob')); return { v: 1 }; } });
    await expect(checkMwArm(call)).rejects.toThrow(/refused claimNextJob with a typed capability refusal on the way/);
  });

  test('an adapter pending error and a named stop fail the case', async () => {
    const pending = base({ run: async () => { throw Object.assign(new Error('pending: L1 optimistic transactions'), { code: 'multi_writer_pending' }); } });
    await expect(checkMwArm(pending.call)).rejects.toThrow(/a pending error, which a `runs` cell does not accept/);
    const stop = base({ opts: { methods: ['claimNextJob'], rustStop: { code: 'store_busy', pin: 'pinned until L1' } } as never,
      run: async () => { throw Object.assign(new Error('store_busy: pinned until L1'), { code: 'store_busy' }); } });
    await expect(checkMwArm(stop.call)).rejects.toThrow(/a named stop \(store_busy\), which a `runs` cell does not accept/);
  });

  test('a declared member the scenario never called fails the case', async () => {
    const { call } = base({ calls: new Set<string>() });
    await expect(checkMwArm(call)).rejects.toThrow(/declared members never called: claimNextJob/);
  });

  test('a row that needs multi_writer fails on a Rust label unless the engine itself reports it, on both labels', async () => {
    for (const label of ['rust', 'rust-mu-env', 'rust-mu-config', 'rust-mu-ambient'] as const) {
      const without = base({ row: row({ needs: 'multi_writer', reference: 'standalone' }), label, backend: 'rust', capabilities: new Set(['pages']) });
      await expect(checkMwArm(without.call)).rejects.toThrow(/needs multi_writer, but the engine does not report it \(engine\.capabilities has pages\)/);
      expect(without.ledger.lines.map((l) => l.outcome)).toEqual(['fail']);
      const withIt = base({ row: row({ needs: 'multi_writer', reference: 'standalone' }), label, backend: 'rust', capabilities: new Set(['pages', 'multi_writer']) });
      expect((await checkMwArm(withIt.call)).standalone).toBe(true);
    }
  });

  test('a row that needs commit_log fails on a Rust label unless the engine itself reports it, naming it, on both labels; a SQL arm never has it', async () => {
    for (const label of ['rust-mu-env', 'rust-mu-config', 'rust-mu-ambient'] as const) {
      const without = base({ row: row({ needs: 'commit_log', reference: 'standalone' }), label, backend: 'rust', capabilities: new Set(['pages', 'multi_writer']) });
      await expect(checkMwArm(without.call)).rejects.toThrow(/needs commit_log, but the engine does not report it \(engine\.capabilities has multi_writer, pages\)/);
      const withIt = base({ row: row({ needs: 'commit_log', reference: 'standalone' }), label, backend: 'rust', capabilities: new Set(['pages', 'commit_log']) });
      await expect(checkMwArm(withIt.call)).resolves.toBeDefined();
    }
    const pg = base({ row: row({ needs: 'commit_log', reference: 'standalone' }), label: 'postgres', backend: 'postgres' });
    await expect(checkMwArm(pg.call)).rejects.toThrow(/needs commit_log, but the arm has no such capability/);
  });

  test('a row that needs multi_writer passes on Postgres (its arm table has it) and fails on PGLite (it has none)', async () => {
    const pg = base({ row: row({ needs: 'multi_writer', reference: 'standalone' }), label: 'postgres', backend: 'postgres' });
    expect((await checkMwArm(pg.call)).standalone).toBe(true);
    const lite = base({ row: row({ needs: 'multi_writer', reference: 'standalone' }), label: 'pglite', backend: 'pglite' });
    await expect(checkMwArm(lite.call)).rejects.toThrow(/the arm has no such capability/);
  });

  test('an mwCase case takes no `requires`', async () => {
    const { call } = base({ opts: { methods: ['claimNextJob'], requires: 'raw_sql' } as never });
    await expect(checkMwArm(call)).rejects.toThrow(/takes no `requires`/);
  });

  test('control: the ordinary parity path still accepts a typed refusal as a stop (strictness is for mwCase only)', async () => {
    const tally: RustTally = { compared: 0, refused: 0, diverged: 0, stops: [] };
    const error = Object.assign(new Error('The Rust engine does not support executeRaw yet (it needs the raw_sql capability)'),
      { code: 'engine_capability_missing', reason: 'raw_sql', detail: 'member=executeRaw capability=raw_sql' });
    await checkRustArm({ name: 'ordinary', opts: { methods: ['executeRaw'] }, run: async () => { throw error; }, calls: new Set(['executeRaw']), refusals: [error],
      reference: { backend: 'pglite', value: 1 }, divergence: undefined }, tally);
    expect(tally.refused).toBe(1);
  });
});

describe('reference selection after per-case skips (runMwCase)', () => {
  test('PGLite n/a, Postgres runs: Postgres is the reference and Rust compares with it', async () => {
    const r = row({ cells: { pglite: { status: 'n/a', why: 'one connection' } } });
    const out = await run(r, [handle('pglite', ok(1)), handle('postgres', ok({ won: 1 })), handle('rust', ok({ won: 1 }))]);
    expect(out.error).toBeNull();
    expect(out.counts).toEqual({ skipped: 0, compared: 1, standalone: 0 });
    expect(out.lines.map((l) => [l.arm, l.outcome, l.detail])).toEqual([
      ['pglite', 'n/a', 'one connection'], ['postgres', 'pass', 'reference arm'], ['rust', 'pass', 'equal to postgres']]);
  });

  test('a Rust value that differs from the reference fails with a fail line (the comparison can fail)', async () => {
    const r = row({ cells: { pglite: { status: 'n/a', why: 'one connection' } } });
    const out = await run(r, [handle('pglite', ok(1)), handle('postgres', ok({ won: 1 })), handle('rust', ok({ won: 2 }))]);
    expect(String((out.error as Error).message)).toContain('differs from the postgres arm, the reference');
    expect(out.lines.map((l) => [l.arm, l.outcome])).toEqual([['pglite', 'n/a'], ['postgres', 'pass'], ['rust', 'fail']]);
  });

  test('PGLite n/a and no Postgres: a compare case on Rust records prerequisite_missing and fails naming DATABASE_URL', async () => {
    const r = row({ cells: { pglite: { status: 'n/a', why: 'one connection' } } });
    const out = await run(r, [handle('pglite', ok(1)), handle('rust', ok({ won: 1 }))]);
    expect(String((out.error as Error).message)).toContain('DATABASE_URL');
    expect(out.lines.map((l) => [l.arm, l.outcome])).toEqual([['pglite', 'n/a'], ['rust', 'prerequisite_missing']]);
  });

  test('PGLite runs and no Postgres: PGLite is the reference, so Rust has one', async () => {
    const out = await run(row(), [handle('pglite', ok({ won: 1 })), handle('rust-mu-env', ok({ won: 1 }))]);
    expect(out.error).toBeNull();
    expect(out.lines.map((l) => [l.arm, l.outcome, l.detail])).toEqual([['pglite', 'pass', 'reference arm'], ['rust-mu-env', 'pass', 'equal to pglite']]);
  });

  test('a standalone case compares nothing, is counted in its own column and is never equal to PGLite', async () => {
    const r = row({ reference: 'standalone', cells: { pglite: { status: 'n/a', why: 'one connection' } } });
    // The Postgres arm returns something else: with no comparison the case still passes, and Rust gets no reference.
    const out = await run(r, [handle('pglite', ok(1)), handle('postgres', ok({ a: 1 })), handle('rust', ok({ b: 2 }))]);
    expect(out.error).toBeNull();
    expect(out.counts).toEqual({ skipped: 0, compared: 0, standalone: 1 });
    expect(out.lines.find((l) => l.arm === 'rust')!.detail).toContain('standalone');
    // And alone: no DATABASE_URL does not fail it.
    const alone = await run(r, [handle('pglite', ok(1)), handle('rust', ok({ b: 2 }))]);
    expect(alone.error).toBeNull();
    expect(alone.counts).toEqual({ skipped: 0, compared: 0, standalone: 1 });
  });

  test('all arms pending or n/a: nothing starts, the case passes having run nothing, and Rust counts one skipped case', async () => {
    const pending: MwCell = { status: 'pending', owner: 'L1 optimistic transactions', why: 'I-1' };
    const r = row({ cells: { pglite: { status: 'n/a', why: 'one connection' }, postgres: pending, rust: pending, 'rust-mu': pending } });
    const started: string[] = [];
    const out = await run(r, [handle('pglite', ok(1), { started }), handle('postgres', ok(1), { started }), handle('rust-mu-config', ok(1), { started })]);
    expect(out.error).toBeNull();
    expect(started).toEqual([]);
    expect(out.counts).toEqual({ skipped: 1, compared: 0, standalone: 0 });
    expect(out.lines.map((l) => [l.arm, l.outcome])).toEqual([['pglite', 'n/a'], ['postgres', 'pending'], ['rust-mu-config', 'pending']]);
  });

  test('the first arm that ran is the reference, not the first arm listed: a skipped first arm does not stop the second from providing it', async () => {
    const r = row({ cells: { pglite: { status: 'pending', owner: 'L5 hosts', why: 'x' } } });
    const out = await run(r, [handle('pglite', ok(9)), handle('postgres', ok({ won: 1 })), handle('rust', ok({ won: 3 }))]);
    expect(String((out.error as Error).message)).toContain('differs from the postgres arm, the reference');
  });

  test('a failure in the case still stops the remaining arms and keeps the lines already written', async () => {
    const started: string[] = [];
    const boom = async () => { throw new Error('invariant broken'); };
    const out = await run(row(), [handle('pglite', boom, { started }), handle('postgres', ok(1), { started })]);
    expect(String((out.error as Error).message)).toContain('invariant broken');
    expect(started).toEqual(['pglite']);
    expect(out.lines.map((l) => [l.arm, l.outcome])).toEqual([['pglite', 'fail']]);
  });
});

describe('the rust-tally sum check with skipped and standalone cases', () => {
  const pins = new Map([['test/engine-parity/x.test.ts', { equal: 2, stopped: 0 }]]);

  test('standalone cases join the sum so a file of them finishes, and are not counted as equal to PGLite', () => {
    // 3 cases: 1 compared, 1 skipped, 1 standalone. If the sum check ignored standalone it would return null (unfinished);
    // counted, it reaches the pin, and the pin says 2 equal, so a standalone pass does not satisfy it.
    expect(() => checkRustTally('test/engine-parity/x.test.ts', { compared: 1, refused: 0, diverged: 0, skipped: 1, standalone: 1 }, 3, pins, {})).toThrow(/1 equal and 0 stopped, but rust-tally\.tsv pins 2 equal/);
    expect(checkRustTally('test/engine-parity/x.test.ts', { compared: 2, refused: 0, diverged: 0, skipped: 0, standalone: 1 }, 3, pins, {})).toBeNull();
  });

  test('a passing standalone case beside a deficient compare pin still fails the pin (standalone is summed once, not twice)', () => {
    // 2 cases: 1 compared, 1 standalone; skipped excludes the standalone one. The pin wants 2 equal, so the file must fail.
    expect(() => checkRustTally('test/engine-parity/x.test.ts', { compared: 1, refused: 0, diverged: 0, skipped: 0, standalone: 1 }, 2, pins, {})).toThrow(/1 equal and 0 stopped, but rust-tally\.tsv pins 2 equal/);
  });

  test('rust-mu known gaps: skipped cases are allowed against the pin only on the rust-mu view, only as named gaps, and never counted as equal', () => {
    const tally = { compared: 1, refused: 0, diverged: 0, skipped: 1 };
    const file = 'test/engine-parity/x.test.ts';
    expect(checkRustTally(file, { ...tally, muView: true, knownGaps: 1 }, 2, pins, {})).toBeNull();
    // The same counts on the off arm, or on rust-mu with no named gap, fail the pin: a skipped case is not an equal one.
    expect(() => checkRustTally(file, tally, 2, pins, {})).toThrow(/pins 2 equal/);
    expect(() => checkRustTally(file, { ...tally, knownGaps: 1 }, 2, pins, {})).toThrow(/pins 2 equal/);
    expect(() => checkRustTally(file, { ...tally, muView: true, knownGaps: 0 }, 2, pins, {})).toThrow(/pins 2 equal/);
    // Gaps do not cover a refusal that grew.
    expect(() => checkRustTally(file, { compared: 1, refused: 1, diverged: 0, skipped: 0, muView: true, knownGaps: 1 }, 2, pins, {})).toThrow(/stopped/);
  });

  test('a rust-mu run never writes the regenerate output; the off arm does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-tally-out-'));
    try {
      const out = join(dir, 'rows.tsv');
      writeFileSync(out, '');
      const file = 'test/engine-parity/x.test.ts';
      const tally = { compared: 2, refused: 0, diverged: 0, skipped: 0 };
      expect(checkRustTally(file, { ...tally, muView: true }, 2, pins, { GBRAIN_TEST_PARITY_TALLY_OUT: out })).toBeNull();
      expect(readFileSync(out, 'utf8')).toBe('');
      expect(checkRustTally(file, tally, 2, pins, { GBRAIN_TEST_PARITY_TALLY_OUT: out })).toBeNull();
      expect(readFileSync(out, 'utf8')).toBe(`${file}\t2\t0\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a file without standalone cases sums exactly as before', () => {
    expect(checkRustTally('test/engine-parity/x.test.ts', { compared: 1, refused: 0, diverged: 0, skipped: 1 }, 3, pins, {})).toBeNull();
    expect(() => checkRustTally('test/engine-parity/x.test.ts', { compared: 1, refused: 0, diverged: 0, skipped: 1 }, 2, pins, {})).toThrow(/pins 2 equal/);
  });
});

describe('both rust-mu routes read the matrix\'s one rust-mu cell and keep their own ledger label', () => {
  test('rust-mu-env, rust-mu-config and the lane\'s rust-mu-ambient skip or run by the rust-mu cell; rust reads its own', () => {
    const r = row({ cells: { 'rust-mu': { status: 'pending', owner: 'L5 hosts', why: 'fence' } } });
    expect([mwArmPlan(r, 'rust').action, mwArmPlan(r, 'rust-mu-env').action, mwArmPlan(r, 'rust-mu-config').action, mwArmPlan(r, 'rust-mu-ambient').action]).toEqual(['run', 'skip', 'skip', 'skip']);
    const plain = row({ cells: { rust: { status: 'n/a', why: 'a plain store keeps no commit log' } } });
    expect([mwArmPlan(plain, 'rust').action, mwArmPlan(plain, 'rust-mu-ambient').action]).toEqual(['skip', 'run']);
  });

  test('a ledger note, when an arm handle carries one, is appended to every line of that arm, skips included', async () => {
    const r = row({ cells: { pglite: { status: 'n/a', why: 'one connection' }, 'rust-mu': { status: 'pending', owner: 'L5 hosts', why: 'fence' } } });
    const ledger = collect();
    const arms = [handle('pglite', ok(1)), { ...handle('rust-mu-config', ok(1)), note: () => 'a note' }];
    await runMwCase({ row: r, name: 'C04 x', opts: OPTS, arms, ledger: ledger.write });
    expect(ledger.lines.map((l) => [l.arm, l.outcome, l.detail])).toEqual([['pglite', 'n/a', 'one connection'], ['rust-mu-config', 'pending', 'L5 hosts: fence; a note']]);
  });
});

describe('variants: a variant is a case of its own, looked up through its parent row', () => {
  const variantRow = (): MwCase => ({ ...row({ id: 'C06', reference: 'compare', needs: 'multi_writer' }),
    variants: [{ id: 'C06.partition', of: 'C06', title: 'a host back from a partition', invariant: 'x', reference: 'standalone', members: ['putPage'],
      cells: { pglite: RUNS, postgres: RUNS, rust: RUNS, 'rust-mu': { status: 'pending', owner: 'L5 hosts', why: 'fence' } } }] } as MwCase);

  test('the variant has its own members, reference and cells; store arms are n/a; needs is its own, not the parent\'s', () => {
    const entries = mwEntries([variantRow()]);
    expect(entries.map((e) => [e.id, e.variant, e.parent.id, e.reference, e.needs ?? null, e.members])).toEqual([
      ['C06', false, 'C06', 'compare', 'multi_writer', ['claimNextJob']], ['C06.partition', true, 'C06', 'standalone', null, ['putPage']]]);
    const v = mwEntry('C06.partition', [variantRow()]);
    expect([v.cells['rust-mu'].status, v.cells['store-single'].status, v.cells['store-optimistic'].status]).toEqual(['pending', 'n/a', 'n/a']);
    expect(v.storeTests).toEqual({ runnable: [], pending: [] });
    expect(() => mwEntry('C06.nope', [variantRow()])).toThrow(/no row or variant for C06\.nope/);
  });

  test('the harness plans a variant by its own cells and passes it as a case with the dotted id in the ledger', async () => {
    const v = mwEntry('C06.partition', [variantRow()]);
    expect(mwArmPlan(v, 'rust-mu-env')).toMatchObject({ action: 'skip', outcome: 'pending' });
    const ledger = collect();
    await runMwCase({ row: v, name: 'C06 x: a host back from a partition', opts: { methods: ['putPage'] } as never, ledger: ledger.write,
      arms: [handle('postgres', ok(1, ['putPage'])), handle('rust-mu-env', ok(1, ['putPage']))] });
    expect(ledger.lines.map((l) => [l.case, l.arm, l.outcome])).toEqual([['C06.partition', 'postgres', 'pass'], ['C06.partition', 'rust-mu-env', 'pending']]);
  });

  test('a variant with a wrong id, no cells or no reference is a loud error, never a silent skip', () => {
    const bad = (v: object): MwCase => ({ ...row({ id: 'C06' }), variants: [v] } as unknown as MwCase);
    const ok1 = { id: 'C06.partition', members: ['putPage'], reference: 'standalone', cells: {} };
    expect(() => mwEntries([bad({ ...ok1, id: 'C07.partition' })])).toThrow(/the id must be `C06\.<name>`/);
    expect(() => mwEntries([bad({ ...ok1, cells: undefined })])).toThrow(/its own cells/);
    expect(() => mwEntries([bad({ ...ok1, reference: undefined })])).toThrow(/its own reference/);
    expect(() => mwEntries([bad({ ...ok1, members: [] })])).toThrow(/its own members/);
    expect(() => mwEntries([bad({ ...ok1, of: 'C07' })])).toThrow(/`of` is "C07"/);
    expect(mwEntries([bad(ok1)]).length).toBe(2);
  });
});

describe('the rust-mu route: the flag, and what the store resolved', () => {
  test('the flag names a route: 1 and env are the environment route, config is the config-row route, anything else is an error', () => {
    expect([undefined, '', '0', '1', 'env', 'config'].map((v) => rustMuRoute({ GBRAIN_TEST_RUST_MU_ARM: v }))).toEqual([null, null, null, 'env', 'env', 'config']);
    expect(() => rustMuRoute({ GBRAIN_TEST_RUST_MU_ARM: 'both' })).toThrow(/not a route/);
    expect([undefined, '1', 'env', 'config'].map((v) => rustMultiuserView({ GBRAIN_TEST_RUST_MU_ARM: v }))).toEqual(['off', 'env', 'env', 'config']);
  });

  const engineWith = (multiuser: unknown, ownerRole: string | null = 'owner') => ({ ownerRole, openStoreIfOpen: () => (multiuser === 'absent' ? {} : multiuser === 'none' ? null : { multiuser }) });

  test('a rust-mu pass requires the resolved switch: on passes, off fails naming the route, an unexposed build FAILS, a client is accepted', () => {
    expect(() => assertRustMultiuserResolved(engineWith(true), 'env')).not.toThrow();
    expect(() => assertRustMultiuserResolved(engineWith(false), 'config')).toThrow(/\[rust-mu-config\] the store did not resolve multi-user mode.*engine\.rust\.multiuser/);
    expect(() => assertRustMultiuserResolved(engineWith(false), 'env')).toThrow(/GBRAIN_RUST_MULTIUSER=1/);
    expect(() => assertRustMultiuserResolved(engineWith('absent'), 'env')).toThrow(/does not expose the resolved multi-user switch/);
    expect(() => assertRustMultiuserResolved(engineWith('none'), 'config')).toThrow(/no open store/);
    expect(() => assertRustMultiuserResolved(engineWith('absent', 'client'), 'env')).not.toThrow();
  });

  const logEngine = (commitLog: unknown, caps: string[], ownerRole = 'owner', open = true) => ({ ownerRole, capabilities: new Set(caps), openStoreIfOpen: () => (open ? { multiuser: true, commitLog } : null) });

  test('a rust-mu brain must keep a commit log and report commit_log: a store without one, or an engine without the capability, FAILS naming it', () => {
    expect(() => assertRustCommitLogResolved(logEngine(true, ['commit_log']))).not.toThrow();
    expect(() => assertRustCommitLogResolved(logEngine(false, ['commit_log']))).toThrow(/keeps no commit log.*GBRAIN_RUST_COMMIT_LOG=1/);
    expect(() => assertRustCommitLogResolved(logEngine(undefined, ['commit_log']))).toThrow(/keeps no commit log/);
    // The control: the store keeps a log but the engine does not report the capability a row that needs it is held to.
    expect(() => assertRustCommitLogResolved(logEngine(true, ['raw_sql']))).toThrow(/does not report the capability commit_log/);
    expect(() => assertRustCommitLogResolved(logEngine(true, [], 'owner', false))).toThrow(/no open store/);
    expect(() => assertRustCommitLogResolved(logEngine(false, [], 'client'))).not.toThrow();
  });

  test('a connect on the rust-mu view fails (and cleans up) when the log is not on, even though multi-user mode resolved', async () => {
    const log: string[] = [];
    const engine = {
      ownerRole: 'owner', capabilities: new Set<string>(),
      async connect() { log.push('connect'); }, async disconnect() { log.push('disconnect'); }, async setConfig() {},
      openStoreIfOpen: () => ({ multiuser: true, commitLog: false }),
    };
    installMuConnect(engine as never, 'env', () => log.push('removed'));
    await expect(engine.connect()).rejects.toThrow(/keeps no commit log/);
    expect(log.slice(-2)).toEqual(['disconnect', 'removed']);
  });

  /** A fake engine that records what connect, setConfig and disconnect did, and what the store resolves after each connect. */
  function fakeEngine(resolveAfter: (connects: number, seeded: boolean) => unknown) {
    const log: string[] = [];
    let connects = 0;
    let seeded = false;
    const engine = {
      ownerRole: 'owner',
      async connect() { connects++; log.push('connect'); },
      async disconnect() { log.push('disconnect'); },
      async setConfig(key: string, value: string) { seeded = true; log.push(`setConfig ${key}=${value}`); },
      capabilities: new Set(['commit_log']),
      openStoreIfOpen: () => ({ multiuser: resolveAfter(connects, seeded), commitLog: true }),
    };
    return { engine, log };
  }

  test('the config route seeds the config row, disconnects and reconnects so the store resolves it at open; the env route just connects', async () => {
    const config = fakeEngine((connects, seeded) => connects >= 2 && seeded);
    installMuConnect(config.engine as never, 'config', () => config.log.push('removed'));
    await config.engine.connect();
    expect(config.log).toEqual(['connect', `setConfig ${RUST_MULTIUSER_CONFIG_KEY}=true`, 'disconnect', 'connect']);
    const env = fakeEngine(() => true);
    installMuConnect(env.engine as never, 'env', () => env.log.push('removed'));
    await env.engine.connect();
    expect(env.log).toEqual(['connect']);
  });

  test('a resolution that fails after connect disconnects the engine and removes its directory before the error is thrown', async () => {
    for (const route of ['env', 'config'] as const) {
      const { engine, log } = fakeEngine(() => false);
      installMuConnect(engine as never, route, () => log.push('removed'));
      await expect(engine.connect()).rejects.toThrow(/did not resolve multi-user mode/);
      expect(log.slice(-2)).toEqual(['disconnect', 'removed']);
    }
    const unexposed = fakeEngine(() => undefined);
    installMuConnect(unexposed.engine as never, 'env', () => unexposed.log.push('removed'));
    await expect(unexposed.engine.connect()).rejects.toThrow(/does not expose/);
    expect(unexposed.log.slice(-2)).toEqual(['disconnect', 'removed']);
  });
});

describe('the rust-mu view runs the Rust arm by each route, and plain rust sets nothing', () => {
  const addon = rustArmAddonPath();
  const REPO = join(import.meta.dir, '..');

  test.skipIf(!existsSync(addon))('env (and its alias 1) sets GBRAIN_RUST_MULTIUSER=1 in the process; config leaves it unset and writes the config row on the Rust brain; rust sets neither', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-mu-view-'));
    try {
      const fixture = join(dir, 'view.test.ts');
      writeFileSync(fixture, `import { appendFileSync } from 'node:fs';
import { parityArms, rustMultiuserView } from ${JSON.stringify(join(REPO, 'test/engine-parity/harness.ts'))};
import { testBackends } from ${JSON.stringify(join(REPO, 'test/helpers/test-backends.ts'))};
const { parityTest } = parityArms(testBackends());
parityTest('the multi-user switch as the arm sees it', { methods: ['getConfig'] }, async (engine, backend) => {
  const row = await engine.getConfig('engine.rust.multiuser');
  appendFileSync(process.env.MU_VIEW_OUT!, [backend, process.env.GBRAIN_RUST_MULTIUSER ?? 'unset', rustMultiuserView(), row ?? 'none'].join(' ') + '\\n');
  return 'same';
});
`);
      const runView = (name: string, flags: Record<string, string>) => {
        const out = join(dir, `out-${name}.txt`);
        writeFileSync(out, '');
        const env: Record<string, string | undefined> = { ...process.env, GBRAIN_TEST_RUST_ARM: undefined, GBRAIN_TEST_RUST_MU_ARM: undefined, DATABASE_URL: undefined,
          GBRAIN_TEST_RUST_ENGINE_ADDON: addon, MU_VIEW_OUT: out, ...flags };
        const proc = spawnSync('bun', ['test', '--timeout=60000', fixture], { cwd: REPO, env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
        return { status: proc.status, text: `${proc.stdout}\n${proc.stderr}`, seen: readFileSync(out, 'utf8').trim().split('\n').sort() };
      };
      for (const flag of ['1', 'env']) {
        const mu = runView(`env-${flag}`, { GBRAIN_TEST_RUST_MU_ARM: flag });
        expect({ flag, status: mu.status }).toEqual({ flag, status: 0 });
        expect(mu.seen).toEqual(['pglite 1 env none', 'rust 1 env none']); // the switch is process-wide while the view is on
        expect(mu.text).toContain('[rust-mu-env arm]');
      }
      const config = runView('config', { GBRAIN_TEST_RUST_MU_ARM: 'config', GBRAIN_RUST_MULTIUSER: '1' });
      expect(config.status).toBe(0);
      // The environment variable is unset for the whole view; only the Rust brain carries the config row.
      expect(config.seen).toEqual(['pglite unset config none', 'rust unset config true']);
      expect(config.text).toContain('[rust-mu-config arm]');
      expect(config.text).not.toContain('does not expose');
      const plain = runView('plain', { GBRAIN_TEST_RUST_ARM: '1' });
      expect(plain.status).toBe(0);
      expect(plain.seen).toEqual(['pglite unset off none', 'rust unset off none']);
      expect(plain.text).toContain('[rust arm]');
      expect(plain.text).not.toContain('rust-mu');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});

describe('ctx.sameBrainEngine: a second connected engine on the same brain', () => {
  const addon = rustArmAddonPath();
  const REPO = join(import.meta.dir, '..');

  test.skipIf(!existsSync(addon))('PGLite refuses with same_brain_unavailable; Rust (an owner-socket client of the first engine) and Postgres read what the first wrote, and calls on it count toward methods', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-same-brain-'));
    try {
      const fixture = join(dir, 'same-brain.test.ts');
      writeFileSync(fixture, `import { expect } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { parityArms } from ${JSON.stringify(join(REPO, 'test/engine-parity/harness.ts'))};
import { testBackends } from ${JSON.stringify(join(REPO, 'test/helpers/test-backends.ts'))};
const { parityTest } = parityArms(testBackends());
// putPage runs on the arm's engine and getPage only on the second engine: the declared getPage is satisfied by the second's calls.
parityTest('a second engine on the same brain', { methods: ['putPage', 'getPage'] }, async (engine, backend, ctx) => {
  const page = { type: 'note', title: 'A', compiled_truth: 'Body.', timeline: '' } as const;
  await engine.putPage('notes/a', page);
  if (backend === 'pglite') {
    const refused = await ctx.sameBrainEngine().then(() => null, (e: { code?: string }) => e);
    appendFileSync(process.env.SAME_BRAIN_OUT!, 'pglite:' + (refused as { code?: string } | null)?.code + '\\n');
    await engine.getPage('notes/a');
    return 'ok';
  }
  const second = await ctx.sameBrainEngine();
  const read = await second.getPage('notes/a');
  expect(read?.title).toBe('A');
  appendFileSync(process.env.SAME_BRAIN_OUT!, backend + ':read ' + read?.title + '\\n');
  return 'ok';
});
`);
      const out = join(dir, 'out.txt');
      writeFileSync(out, '');
      const env: Record<string, string | undefined> = { ...process.env, GBRAIN_TEST_RUST_ARM: '1', GBRAIN_TEST_RUST_MU_ARM: undefined, GBRAIN_TEST_RUST_ENGINE_ADDON: addon, SAME_BRAIN_OUT: out };
      const proc = spawnSync('bun', ['test', '--timeout=60000', fixture], { cwd: REPO, env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
      expect({ status: proc.status, log: proc.status === 0 ? '' : `${proc.stdout}\n${proc.stderr}` }).toEqual({ status: 0, log: '' });
      const seen = readFileSync(out, 'utf8').trim().split('\n').sort();
      expect(seen).toEqual(['pglite:same_brain_unavailable', ...(process.env.DATABASE_URL ? ['postgres:read A'] : []), 'rust:read A'].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('coverage.ts reads mwCase statically, for cases and variants', () => {
  const read = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-mw-decl-'));
    try {
      writeFileSync(join(dir, 'x.test.ts'), `const { parityTest } = parityArms(testBackends());\n${body}\n`);
      return parityDeclarations(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('a case id and a dotted variant id are read as string literals', () => {
    const decls = read(`parityTest('C06 a', { methods: ['putPage'], mwCase: 'C06' }, async () => 1);\nparityTest('C06 a: b', { methods: ['putPage'], mwCase: 'C06.partition' }, async () => 1);\nparityTest('plain', { methods: ['getPage'] }, async () => 1);`);
    expect(decls.map((d) => [d.name, d.mwCase ?? null])).toEqual([['C06 a', 'C06'], ['C06 a: b', 'C06.partition'], ['plain', null]]);
  });

  test('an unknown case id, a non-literal, and mwCase together with requires are errors', () => {
    expect(() => read(`parityTest('x', { methods: ['putPage'], mwCase: 'C99' }, async () => 1);`)).toThrow(/is not a case id/);
    expect(() => read(`parityTest('x', { methods: ['putPage'], mwCase: id }, async () => 1);`)).toThrow(/must be a string literal/);
    expect(() => read(`parityTest('x', { methods: ['putPage'], requires: 'raw_sql', mwCase: 'C06' }, async () => 1);`)).toThrow(/takes no requires/);
  });
});

describe('commit_log is an ordinary engine capability a row may need', () => {
  test('it must be in ENGINE_CAPABILITIES (the Rust engine reports it only while its store keeps a log), unlike multi_writer', () => {
    expect(() => assertMultiuserCapabilityName('commit_log')).not.toThrow();
    expect(() => assertMultiuserCapabilityName('commit_log', { ENGINE_CAPABILITIES: ['raw_sql'] })).toThrow(/not in ENGINE_CAPABILITIES/);
    expect(() => assertMultiuserCapabilityName('commit_log', { ENGINE_CAPABILITIES: ['raw_sql', 'commit_log'], MULTIUSER_CAPABILITIES: ['multi_writer'] })).not.toThrow();
    expect(() => assertMultiuserCapabilityName('multi_writer', { ENGINE_CAPABILITIES: ['raw_sql', 'commit_log', 'multi_writer'] })).toThrow(/ENGINE_CAPABILITIES/);
  });
});

describe('multi_writer is a multi-user capability', () => {
  test('it is never in ENGINE_CAPABILITIES, and when MULTIUSER_CAPABILITIES exists it is listed there', () => {
    expect(() => assertMultiuserCapabilityName('multi_writer')).not.toThrow();
    expect(() => assertMultiuserCapabilityName('multi_writer', { ENGINE_CAPABILITIES: ['raw_sql', 'multi_writer'] })).toThrow(/ENGINE_CAPABILITIES/);
    expect(() => assertMultiuserCapabilityName('multi_writer', { ENGINE_CAPABILITIES: ['raw_sql'], MULTIUSER_CAPABILITIES: [] })).toThrow(/not in MULTIUSER_CAPABILITIES/);
    expect(() => assertMultiuserCapabilityName('multi_writer', { ENGINE_CAPABILITIES: ['raw_sql'], MULTIUSER_CAPABILITIES: ['multi_writer'] })).not.toThrow();
  });
});

describe('a case no selected arm runs is a todo, not a pass, and still writes its ledger lines', () => {
  const REPO = join(import.meta.dir, '..');

  test('C11 (n/a on every arm but rust-mu) in a plain Bun run: reported as todo, exit 0, no pass, one ledger line per selected arm saying why', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-mw-todo-'));
    try {
      const fixture = join(dir, 'todo.test.ts');
      writeFileSync(fixture, `import { parityArms } from ${JSON.stringify(join(REPO, 'test/engine-parity/harness.ts'))};
import { testBackends } from ${JSON.stringify(join(REPO, 'test/helpers/test-backends.ts'))};
const { parityTest } = parityArms(testBackends());
parityTest('C11 a case no plain arm runs', { methods: ['getConfig'], mwCase: 'C11' }, async (engine) => { await engine.getConfig('version'); return 1; });
`);
      const ledger = join(dir, 'ledger.jsonl');
      writeFileSync(ledger, '');
      const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: undefined, GBRAIN_TEST_RUST_ARM: undefined, GBRAIN_TEST_RUST_MU_ARM: undefined, GBRAIN_TEST_MW_LEDGER: ledger };
      const proc = spawnSync('bun', ['test', '--timeout=60000', fixture], { cwd: REPO, env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
      const text = `${proc.stdout}\n${proc.stderr}`;
      expect(proc.status).toBe(0);
      expect(text).toMatch(/\(todo\) C11 a case no plain arm runs \[no selected arm runs it: pglite: not applicable: commit order is a multi-user Rust guarantee/);
      expect(text).toMatch(/\b1 todo\b/);
      expect(text).not.toMatch(/\b[1-9]\d* pass\b/);
      const lines = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { case: string; arm: string; outcome: string; detail: string });
      expect(lines.map((l) => [l.case, l.arm, l.outcome, l.detail.startsWith('not applicable: commit order')])).toEqual([['C11', 'pglite', 'n/a', true]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('the recording wrapper keeps the Proxy invariant', () => {
  test('a non-configurable, non-writable method (a Rust transaction clone\'s openStore) is returned as it is', () => {
    const openStore = () => ({ brain: 'b' });
    const clone = Object.defineProperty({ putPage: async () => 1 }, 'openStore', { value: openStore, configurable: false, writable: false, enumerable: false });
    const calls = new Set<string>();
    const wrapped = recordingEngine(clone as never, calls) as unknown as { openStore: typeof openStore; putPage: () => Promise<number> };
    expect(wrapped.openStore).toBe(openStore);
    expect(wrapped.openStore()).toEqual({ brain: 'b' });
    void wrapped.putPage();
    expect([...calls]).toEqual(['putPage']);
  });
});

describe('the Rust arm under an ambient multi-user mode', () => {
  // Value: protects=a lane that starts the whole suite with GBRAIN_RUST_MULTIUSER=1 gets its plain Rust arm checked as a
  // multi-user arm (its store must resolve the mode on), while a normal run still fails a plain brain that resolved it;
  // fails_when=the plain-arm guard ignores how the process started; why_new=the multi-user self-check lane runs the suite with
  // the switch in its environment; seam=pure functions
  test('the mode is the view, else ambient when the process started with the switch, else off', () => {
    expect(rustArmMultiuser({}, false)).toBe('off');
    expect(rustArmMultiuser({}, true)).toBe('ambient');
    expect(rustArmMultiuser({ GBRAIN_TEST_RUST_MU_ARM: 'env' }, true)).toBe('env');
    expect(rustArmMultiuser({ GBRAIN_TEST_RUST_MU_ARM: 'config' }, false)).toBe('config');
  });

  // Value: protects=a scenario that opens its own owner on the self-check lane resolves multi-user mode by the variable the lane
  // started with, so C16, C17.served and C21 run there instead of failing as `off`; fails_when=the ambient lane maps to off or to
  // config; why_new=the lane reads the rust-mu cell (rust-mu-ambient); seam=pure functions
  test('the switch a scenario\'s own brains use: the view\'s route, env on an ambient run, else off', () => {
    expect(rustMultiuserSwitch({}, false)).toBe('off');
    expect(rustMultiuserSwitch({}, true)).toBe('env');
    expect(rustMultiuserSwitch({ GBRAIN_TEST_RUST_MU_ARM: 'config' }, true)).toBe('config');
    expect(rustMultiuserSwitch({ GBRAIN_TEST_RUST_MU_ARM: 'env' }, false)).toBe('env');
  });

  test('a normal run still fails a plain brain that resolved multi-user mode; an ambient run fails one that did not', () => {
    expect(rustArmModeProblem(true, 'off')).toBe('the plain Rust arm ran a multi-user store');
    expect(rustArmModeProblem(false, 'off')).toBeNull();
    expect(rustArmModeProblem(undefined, 'off')).toBeNull();
    expect(rustArmModeProblem(true, 'ambient')).toBeNull();
    expect(rustArmModeProblem(false, 'ambient')).toMatch(/GBRAIN_RUST_MULTIUSER=1 set when the process started/);
    expect(rustArmModeProblem(undefined, 'ambient')).toMatch(/did not resolve/);
    expect(rustArmModeProblem(true, 'env')).toBeNull();
    expect(rustArmModeProblem(false, 'config')).toMatch(/rust-mu arm/);
  });
});

describe('rustMultiuserStop: a case pinned to the multi-user owner-only refusal (checkRustArm)', () => {
  const refusalText = JSON.stringify({ error: 'permission_denied', code: 'permission_denied', message: `This credential cannot open a multi-user session on this brain (${OWNER_ONLY_MESSAGE} for now).` });
  const stop = () => { stopOnOwnerOnlyRefusal(refusalText, ['a page body'], 'env'); };
  const tally = (): RustTally => ({ compared: 0, refused: 0, diverged: 0, stops: [] });
  const engine = { marker: 'engine' } as never;
  const kase = (over: { run: () => Promise<unknown>; mode?: 'off' | 'env' | 'config' | 'ambient'; pin?: ReturnType<typeof OWNER_ONLY_STOP> }) => ({
    name: 'a case', opts: { methods: ['getConfig'], rustMultiuserStop: over.pin ?? OWNER_ONLY_STOP() } as never, run: over.run, calls: new Set(['getConfig']), refusals: [],
    reference: { backend: 'pglite' as const, value: 'same' }, divergence: undefined, multiuserMode: over.mode ?? 'env', engine });

  test('mode on, the scenario ends on the owner-only refusal: accepted, named, counted as a known gap and never as equal or stopped', async () => {
    const t = tally();
    const seen: unknown[] = [];
    await checkRustArm(kase({ run: async () => { stop(); return 'x'; }, pin: OWNER_ONLY_STOP(async (e) => { seen.push(e); }) }), t);
    expect([t.compared, t.refused, t.diverged, t.multiuserStops]).toEqual([0, 0, 0, ['a case']]);
    expect(seen).toEqual([engine]); // the no-effect check ran on the case's engine
    for (const mode of ['env', 'config', 'ambient'] as const) await checkRustArm(kase({ mode, run: async () => { stop(); return 'x'; } }), tally());
  });

  test('mode on, the case returns: the pin fails and says to remove it (the key is admitted)', async () => {
    await expect(checkRustArm(kase({ run: async () => 'same' }), tally())).rejects.toThrow(/returned in multi-user mode; the key is admitted now, so remove the pin/);
  });

  test('mode on, the case ends on anything else (another error, or another refusal text): the pin fails and names what it ended on', async () => {
    await expect(checkRustArm(kase({ run: async () => { throw new Error('boom'); } }), tally())).rejects.toThrow(/ended on something else.*boom/);
    await expect(checkRustArm(kase({ run: async () => { throw new MultiuserStopError('permission_denied', 'permission_denied: another reason'); } }), tally())).rejects.toThrow(/ended on something else/);
    await expect(checkRustArm(kase({ run: async () => { throw new MultiuserStopError('invalid_params', `invalid_params: ${OWNER_ONLY_MESSAGE}`); } }), tally())).rejects.toThrow(/ended on something else/);
  });

  test('mode on, the refusal came but the case left an effect: the no-effect check fails the case', async () => {
    await expect(checkRustArm(kase({ run: async () => { stop(); return 'x'; }, pin: OWNER_ONLY_STOP(async () => { throw new Error('a row exists'); }) }), tally())).rejects.toThrow(/a row exists/);
  });

  test('a pin past its due date fails even on the right refusal', async () => {
    await expect(checkRustArm(kase({ run: async () => { stop(); }, pin: { ...OWNER_ONLY_STOP(), due: '2020-01-01' } }), tally())).rejects.toThrow(/has passed its due date/);
  });

  test('mode off: the pin does nothing, the case compares with the reference as before, and a refusal is no stop', async () => {
    const t = tally();
    await checkRustArm(kase({ mode: 'off', run: async () => 'same' }), t);
    expect([t.compared, t.multiuserStops]).toEqual([1, undefined]);
    // A case that differs from its reference fails with the pin present (the pin does not hide a switch-off failure).
    await expect(checkRustArm(kase({ mode: 'off', run: async () => 'other' }), tally())).rejects.toThrow();
    // The helper itself does nothing off, even on the refusal text, so the scenario's own failure path runs unchanged.
    expect(() => stopOnOwnerOnlyRefusal(refusalText, [], 'off')).not.toThrow();
  });

  test('the helper stops only on the owner-only refusal, and fails loudly when the refusal carries what the call would have returned', () => {
    expect(() => stopOnOwnerOnlyRefusal(refusalText, [], 'env')).toThrow(MultiuserStopError);
    expect(() => stopOnOwnerOnlyRefusal('plain text', [], 'env')).not.toThrow();
    expect(() => stopOnOwnerOnlyRefusal(JSON.stringify({ code: 'permission_denied' }), [], 'env')).not.toThrow(); // the code alone is not the owner-only gate
    expect(() => stopOnOwnerOnlyRefusal(`${refusalText} a page body`, ['a page body'], 'env')).toThrow(/yet its reply carries what the call would have returned/);
  });

  describe('a served-only pin (REMOTE_WRITE_STOP): the served client\'s refusal of a remote write', () => {
    const refusalText = (site: 'member' | 'operation') => JSON.stringify({ error: 'engine_capability_missing', code: 'engine_capability_missing', message: REMOTE_WRITE_REFUSALS[site].message, detail: `member=x ${REMOTE_WRITE_REFUSALS[site].capability} outcome=none` }, null, 2);
    const served = (over: { run: () => Promise<unknown>; mode?: 'off' | 'env' | 'config' | 'ambient'; served: boolean; site?: 'member' | 'operation' }) => ({
      ...kase({ run: over.run, mode: over.mode ?? 'env', pin: REMOTE_WRITE_STOP(over.site ?? 'member', async () => { effectChecks++; }) }), served: over.served });
    let effectChecks = 0;

    test('armed only while the store is multi-user and the arm is served; the owner-only pin needs no served arm', () => {
      const pin = REMOTE_WRITE_STOP('member');
      expect([multiuserStopArmed(pin, 'env', true), multiuserStopArmed(pin, 'config', true), multiuserStopArmed(pin, 'ambient', true)]).toEqual([true, true, true]);
      expect([multiuserStopArmed(pin, 'env', false), multiuserStopArmed(pin, 'off', true), multiuserStopArmed(pin, 'off', false)]).toEqual([false, false, false]);
      expect([multiuserStopArmed(OWNER_ONLY_STOP(), 'env', false), multiuserStopArmed(OWNER_ONLY_STOP(), 'off', true)]).toEqual([true, false]);
      expect(pin).toMatchObject({ code: 'engine_capability_missing', owner: 'L4 per-user remote writes', due: '2026-12-02', served: true });
      expect(pin.message).toContain(REMOTE_WRITE_REFUSALS.member.message);
      expect(pin.message).toContain('capability=pages');
      expect(REMOTE_WRITE_STOP('operation').message).toContain('capability=raw_sql');
    });

    test('served and multi-user, the case ends on the pinned refusal: accepted after its no-effect check, counted as a known gap', async () => {
      for (const site of ['member', 'operation'] as const) {
        effectChecks = 0;
        const t = tally();
        await checkRustArm(served({ served: true, site, run: async () => { stopOnRemoteWriteRefusal(refusalText(site), site, [], 'env'); return 'x'; } }), t);
        expect([t.compared, t.refused, t.multiuserStops, effectChecks], site).toEqual([0, 0, ['a case'], 1]);
      }
    });

    test('served and multi-user, the case returns or ends elsewhere: the pin fails (the case returned; another site\'s refusal; another error; an effect; past due)', async () => {
      await expect(checkRustArm(served({ served: true, run: async () => 'same' }), tally())).rejects.toThrow(/returned in multi-user mode/);
      // The refusal of the other site is not the pinned one: the helper does not stop on it, so the case ends on its own result.
      expect(() => stopOnRemoteWriteRefusal(refusalText('operation'), 'member', [], 'env')).not.toThrow();
      expect(() => stopOnRemoteWriteRefusal(refusalText('member'), 'operation', [], 'env')).not.toThrow();
      await expect(checkRustArm(served({ served: true, site: 'member', run: async () => { throw new MultiuserStopError('engine_capability_missing', `engine_capability_missing: ${REMOTE_WRITE_REFUSALS.operation.message} (${REMOTE_WRITE_REFUSALS.operation.capability})`); } }), tally())).rejects.toThrow(/ended on something else/);
      await expect(checkRustArm(served({ served: true, run: async () => { throw new Error('boom'); } }), tally())).rejects.toThrow(/ended on something else.*boom/);
      const stops = served({ served: true, run: async () => { stopOnRemoteWriteRefusal(refusalText('member'), 'member', [], 'env'); } });
      await expect(checkRustArm({ ...stops, opts: { ...(stops.opts as object), rustMultiuserStop: { ...REMOTE_WRITE_STOP('member'), noEffect: async () => { throw new Error('a page was written'); } } } as never }, tally())).rejects.toThrow(/a page was written/);
      await expect(checkRustArm({ ...stops, opts: { ...(stops.opts as object), rustMultiuserStop: { ...REMOTE_WRITE_STOP('member'), due: '2020-01-01' } } as never }, tally())).rejects.toThrow(/has passed its due date/);
    });

    test('not served, or the switch off: the pin does nothing and the case compares as before (a case that returns is not a failure)', async () => {
      const t = tally();
      await checkRustArm(served({ served: false, run: async () => 'same' }), t);
      await checkRustArm(served({ served: true, mode: 'off', run: async () => 'same' }), t);
      expect([t.compared, t.multiuserStops]).toEqual([2, undefined]);
      expect(() => stopOnRemoteWriteRefusal(refusalText('member'), 'member', [], 'off')).not.toThrow();
    });

    test('the helper stops only on its own site\'s refusal, and fails loudly when the refusal carries what the call would have returned', () => {
      expect(() => stopOnRemoteWriteRefusal(refusalText('member'), 'member', [], 'env')).toThrow(MultiuserStopError);
      expect(() => stopOnRemoteWriteRefusal(JSON.stringify({ code: 'engine_capability_missing' }), 'member', [], 'env')).not.toThrow(); // the code alone is not the refusal
      expect(() => stopOnRemoteWriteRefusal('written', 'member', [], 'env')).not.toThrow();
      expect(() => stopOnRemoteWriteRefusal(`${refusalText('member')} a page body`, 'member', ['a page body'], 'env')).toThrow(/yet its reply carries what the call would have returned/);
    });

    test('pinnedMultiuserStop (a case that is not a parityTest): armed on the served multi-user Rust arm, it demands the pinned stop; elsewhere it runs the body as it was', async () => {
      const rust = { backend: 'rust', engine: { marker: 'engine' } } as never;
      const stopBody = async () => { stopOnRemoteWriteRefusal(refusalText('operation'), 'operation', [], 'env'); };
      await withEnv({ GBRAIN_TEST_RUST_MU_ARM: 'env', GBRAIN_TEST_RUST_SERVED: '1' }, async () => {
        expect(await pinnedMultiuserStop(rust, 'a plain case', REMOTE_WRITE_STOP('operation'), stopBody)).toBe(true);
        await expect(pinnedMultiuserStop(rust, 'a plain case', REMOTE_WRITE_STOP('operation'), async () => 'returned')).rejects.toThrow(/returned in multi-user mode/);
        // A SQL arm runs its body untouched, even with the pin armed for Rust.
        let ran = 0;
        expect(await pinnedMultiuserStop({ backend: 'pglite', engine: {} } as never, 'a plain case', REMOTE_WRITE_STOP('operation'), async () => { ran++; })).toBe(false);
        expect(ran).toBe(1);
      });
      for (const env of [{ GBRAIN_TEST_RUST_MU_ARM: undefined, GBRAIN_TEST_RUST_SERVED: '1' }, { GBRAIN_TEST_RUST_MU_ARM: 'env', GBRAIN_TEST_RUST_SERVED: undefined }]) {
        await withEnv(env, async () => {
          let ran = 0;
          expect(await pinnedMultiuserStop(rust, 'a plain case', REMOTE_WRITE_STOP('operation'), async () => { ran++; })).toBe(false);
          expect(ran).toBe(1);
          // The refusal is the case's own failure there: the body's error is not turned into a stop.
          await expect(pinnedMultiuserStop(rust, 'a plain case', REMOTE_WRITE_STOP('operation'), async () => { throw new Error('its own failure'); })).rejects.toThrow('its own failure');
        });
      }
    });
  });

  test('the tally: pinned stops allow the multi-user run against the off pin by name, and never count as equal', () => {
    const pins = new Map([['test/engine-parity/x.test.ts', { equal: 3, stopped: 0 }]]);
    const f = 'test/engine-parity/x.test.ts';
    // 3 cases: 1 equal, 2 pinned stops (skipped for the sum, allowed as known gaps).
    expect(checkRustTally(f, { compared: 1, refused: 0, diverged: 0, skipped: 2, muView: true, knownGaps: 2 }, 3, pins, {})).toBeNull();
    expect(() => checkRustTally(f, { compared: 1, refused: 0, diverged: 0, skipped: 2, muView: true, knownGaps: 1 }, 3, pins, {})).toThrow(/pins 3 equal/);
    expect(() => checkRustTally(f, { compared: 1, refused: 0, diverged: 0, skipped: 2 }, 3, pins, {})).toThrow(/pins 3 equal/); // the switch off gets no allowance
  });
});

describe('the commit log check on a served client', () => {
  // Value: protects=on the served arm a client engine (no store of its own) is accepted only when it reports the owner's
  // commit_log capability; fails_when=a served client without the log passes, or one with it is refused for having no store;
  // why_new=C21 on the served arm ended on "no open store"; seam=stand-in engines
  test('a served client passes with commit_log, fails without it; a storeless non-served engine still fails', async () => {
    const { assertRustCommitLogResolved } = await import('./engine-parity/rust-arm.ts');
    const served = (caps: string[]) => ({ ownerRole: null, capabilities: new Set(caps), openStoreIfOpen: () => null });
    expect(() => assertRustCommitLogResolved(served(['served', 'commit_log']))).not.toThrow();
    expect(() => assertRustCommitLogResolved(served(['served']))).toThrow(/served client does not report the capability commit_log/);
    expect(() => assertRustCommitLogResolved(served([]))).toThrow(/no open store/);
  });
});

