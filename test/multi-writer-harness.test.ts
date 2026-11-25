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
import { checkMwArm, checkRustArm, mwArmPlan, runMwCase, type MwArmHandle, type MwArmStarted, type RustTally } from './engine-parity/harness.ts';
import { checkRustTally } from './engine-parity/rust-tally.ts';
import { MW_ARMS, type MwArm, type MwCase, type MwCell } from './engine-parity/multi-writer-cases.ts';
import { type LedgerLine } from './engine-parity/multi-writer-ledger.ts';
import { rustArmAddonPath } from './engine-parity/rust-arm.ts';

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
    label, backend: label === 'rust' || label === 'rust-mu' ? 'rust' : (label as 'pglite' | 'postgres'),
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
    for (const label of ['rust', 'rust-mu'] as const) {
      const without = base({ row: row({ needs: 'multi_writer', reference: 'standalone' }), label, backend: 'rust', capabilities: new Set(['pages']) });
      await expect(checkMwArm(without.call)).rejects.toThrow(/needs multi_writer, but the engine does not report it \(engine\.capabilities has pages\)/);
      expect(without.ledger.lines.map((l) => l.outcome)).toEqual(['fail']);
      const withIt = base({ row: row({ needs: 'multi_writer', reference: 'standalone' }), label, backend: 'rust', capabilities: new Set(['pages', 'multi_writer']) });
      expect((await checkMwArm(withIt.call)).standalone).toBe(true);
    }
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
    const out = await run(row(), [handle('pglite', ok({ won: 1 })), handle('rust-mu', ok({ won: 1 }))]);
    expect(out.error).toBeNull();
    expect(out.lines.map((l) => [l.arm, l.outcome, l.detail])).toEqual([['pglite', 'pass', 'reference arm'], ['rust-mu', 'pass', 'equal to pglite']]);
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
    const out = await run(r, [handle('pglite', ok(1), { started }), handle('postgres', ok(1), { started }), handle('rust-mu', ok(1), { started })]);
    expect(out.error).toBeNull();
    expect(started).toEqual([]);
    expect(out.counts).toEqual({ skipped: 1, compared: 0, standalone: 0 });
    expect(out.lines.map((l) => [l.arm, l.outcome])).toEqual([['pglite', 'n/a'], ['postgres', 'pending'], ['rust-mu', 'pending']]);
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

  test('a file without standalone cases sums exactly as before', () => {
    expect(checkRustTally('test/engine-parity/x.test.ts', { compared: 1, refused: 0, diverged: 0, skipped: 1 }, 3, pins, {})).toBeNull();
    expect(() => checkRustTally('test/engine-parity/x.test.ts', { compared: 1, refused: 0, diverged: 0, skipped: 1 }, 2, pins, {})).toThrow(/pins 2 equal/);
  });
});

describe('the rust-mu view sets GBRAIN_RUST_MULTIUSER=1 inside the test process, and rust leaves it unset', () => {
  const addon = rustArmAddonPath();
  const REPO = join(import.meta.dir, '..');

  test.skipIf(!existsSync(addon))('a parity file run with GBRAIN_TEST_RUST_MU_ARM=1 sees the switch on the Rust arm and prints the rust-mu label; the plain Rust arm does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-mu-view-'));
    try {
      const fixture = join(dir, 'view.test.ts');
      writeFileSync(fixture, `import { appendFileSync } from 'node:fs';
import { parityArms } from ${JSON.stringify(join(REPO, 'test/engine-parity/harness.ts'))};
import { testBackends } from ${JSON.stringify(join(REPO, 'test/helpers/test-backends.ts'))};
const { parityTest } = parityArms(testBackends());
parityTest('the multi-user switch as the arm sees it', { methods: ['getConfig'] }, async (engine, backend) => {
  appendFileSync(process.env.MU_VIEW_OUT!, backend + ':' + (process.env.GBRAIN_RUST_MULTIUSER ?? 'unset') + '\\n');
  await engine.getConfig('version');
  return 'same';
});
`);
      const runView = (flags: Record<string, string>) => {
        const out = join(dir, `out-${Object.keys(flags)[0]}.txt`);
        writeFileSync(out, '');
        const env: Record<string, string | undefined> = { ...process.env, GBRAIN_TEST_RUST_ARM: undefined, GBRAIN_TEST_RUST_MU_ARM: undefined, DATABASE_URL: undefined,
          GBRAIN_TEST_RUST_ENGINE_ADDON: addon, MU_VIEW_OUT: out, ...flags };
        const proc = spawnSync('bun', ['test', '--timeout=60000', fixture], { cwd: REPO, env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
        return { status: proc.status, text: `${proc.stdout}\n${proc.stderr}`, seen: readFileSync(out, 'utf8').trim().split('\n').sort() };
      };
      const mu = runView({ GBRAIN_TEST_RUST_MU_ARM: '1' });
      expect(mu.status).toBe(0);
      expect(mu.seen).toEqual(['pglite:1', 'rust:1']); // the switch is process-wide while the view is on
      expect(mu.text).toContain('[rust-mu arm]');
      const plain = runView({ GBRAIN_TEST_RUST_ARM: '1' });
      expect(plain.status).toBe(0);
      expect(plain.seen).toEqual(['pglite:unset', 'rust:unset']);
      expect(plain.text).toContain('[rust arm]');
      expect(plain.text).not.toContain('[rust-mu arm]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
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
