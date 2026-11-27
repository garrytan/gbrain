/**
 * The multi-writer bar's runner (test/engine-parity/multi-writer-bar.ts) on small fixture matrices and fake commands,
 * never the real suite.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the bar fails closed. A compile failure, a failed setup, a child that is killed or outlives its deadline, an
 *    empty, truncated, duplicated, short or padded ledger, an outcome the matrix does not allow for a cell, a pending store test
 *    that does not exist, and a store test that fails or never reports each end the run with a stable code, the log path and
 *    the rerun command, and a non-zero exit. A pending case is a pass of the bar only while the ledger says `pending`. The
 *    store half never runs a pending test and never runs `--exact` with no names (that would run the whole file).
 *  - Regression: a runner edit that treats a missing or short ledger as green, lets a hung child hold the gate, or runs the
 *    pending store tests. The pass mark is the gate of the multi-user branch, so a silent green is the failure to prevent.
 *  - Why existing coverage misses it: nothing else reads the ledger or runs the store half.
 *  - Seam: `BarOptions.commands` swaps the commands the bar spawns; the bar's own code path is the one tested.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BAR_ARMS, checkLedger, DEFAULT_COMMANDS, parseArms, parseIgnoredList, parseStoreRun, planEngineUnits, renderFailures, runBar, runBounded,
  type BarArm, type BarCommands, type BarOptions,
} from './engine-parity/multi-writer-bar.ts';
import { checkMwArm } from './engine-parity/harness.ts';
import type { MwCase, MwCell } from './engine-parity/multi-writer-cases.ts';
import { cellArm, renderLedgerLine, type LedgerArm, type LedgerLine } from './engine-parity/multi-writer-ledger.ts';
import { mwEntries } from './engine-parity/multi-writer-entries.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'gbrain-mw-bar-test-')); dirs.push(dir); return dir; };

const RUNS: MwCell = { status: 'runs' };
const NA = (why: string): MwCell => ({ status: 'n/a', why });
const PENDING: MwCell = { status: 'pending', owner: 'L1 optimistic transactions', why: 'I-1 begin_with' };

/** C01 compares arms and has store tests; C02 is standalone with no store tests. */
const MATRIX: readonly MwCase[] = [
  { id: 'C01', title: 'same-page writers lose no update', operation: 'putPage', invariant: 'no update is lost', reference: 'compare', members: ['putPage'],
    storeTests: { runnable: ['c01_ok'], pending: ['c01_ok_multi_writer'] },
    cells: { pglite: RUNS, postgres: RUNS, rust: RUNS, 'rust-mu': PENDING, 'store-single': RUNS, 'store-optimistic': PENDING } },
  { id: 'C02', title: 'a second reader sees the write', operation: 'getPage', invariant: 'the write is visible', reference: 'standalone', needs: 'multi_writer', members: ['getPage'],
    storeTests: { runnable: [], pending: [] },
    cells: { pglite: NA('one connection'), postgres: RUNS, rust: RUNS, 'rust-mu': PENDING, 'store-single': NA('no second connection'), 'store-optimistic': NA('no second connection') } },
];

const ALLOWED: Record<string, LedgerLine['outcome']> = { runs: 'pass', 'n/a': 'n/a', pending: 'pending' };

function line(c: string, arm: LedgerArm, outcome: LedgerLine['outcome'], detail = 'x'): LedgerLine {
  return { case: c as LedgerLine['case'], arm, outcome, detail };
}

/** The ledger a correct run of a unit with `arms` writes. */
function goodLines(arms: readonly LedgerArm[], matrix: readonly MwCase[] = MATRIX): LedgerLine[] {
  return mwEntries(matrix).flatMap((row) => arms.map((arm) => line(row.id, arm, ALLOWED[row.cells[cellArm(arm)].status]!)));
}

const ledgerText = (lines: readonly LedgerLine[]): string => lines.map(renderLedgerLine).join('');

interface Rig {
  dir: string;
  /** Per unit id, the text the fake engine process appends to the ledger. */
  ledgers: Map<string, string>;
  marks: string;
  opts: (over?: Partial<BarOptions>) => BarOptions;
}

function rig(): Rig {
  const dir = tmp();
  const ledgers = new Map<string, string>();
  const marks = join(dir, 'marks.txt');
  writeFileSync(marks, '');
  const mark = (what: string) => `echo ${what} >> ${marks}`;
  const commands: Partial<BarCommands> = {
    engineSetup: () => [],
    engineRun: (unit) => {
      const file = join(dir, `ledger-${unit.id}.txt`);
      writeFileSync(file, ledgers.get(unit.id) ?? '');
      return ['sh', '-c', `${mark(`engine-${unit.id}`)}; cat ${file} >> "$${'GBRAIN_TEST_MW_LEDGER'}"`];
    },
    storeBuild: () => ['sh', '-c', `${mark('build')}`],
    storeList: () => ['sh', '-c', `${mark('list')}; printf 'c01_ok_multi_writer: test\\n'`],
    storeRun: (names) => ['sh', '-c', `${mark(`run:${names.join(',')}`)}; echo "running ${names.length} test"; ${names.map((n) => `echo "test ${n} ... ok"`).join('; ')}`],
  };
  return {
    dir, ledgers, marks,
    opts: (over = {}) => ({ arms: [...BAR_ARMS], matrix: MATRIX, env: { DATABASE_URL: 'postgres://fixture' }, logDir: join(dir, 'logs'), commands, timeouts: { setup: 5000, build: 5000, engine: 5000, store: 5000 }, ...over }),
  };
}

const marksOf = (r: Rig): string[] => readFileSync(r.marks, 'utf8').split('\n').filter((l) => l !== '');
const codes = (failures: ReadonlyArray<{ code: string }>): string[] => failures.map((f) => f.code);

function goodRig(): Rig {
  const r = rig();
  r.ledgers.set('rust', ledgerText(goodLines(['pglite', 'postgres', 'rust'])));
  r.ledgers.set('rust-mu-env', ledgerText(goodLines(['pglite', 'postgres', 'rust-mu-env'])));
  r.ledgers.set('rust-mu-config', ledgerText(goodLines(['pglite', 'postgres', 'rust-mu-config'])));
  r.ledgers.set('rust-mu-ambient', ledgerText(goodLines(['pglite', 'postgres', 'rust-mu-ambient'])));
  return r;
}

describe('a correct run', () => {
  test('passes with pending and n/a cells shown as such, and counts standalone passes apart from compare passes', async () => {
    const r = goodRig();
    const report = await runBar(r.opts());
    expect(report.failures).toEqual([]);
    expect(Object.fromEntries(['C01:pglite', 'C01:rust', 'C01:rust-mu-env', 'C01:rust-mu-config', 'C01:rust-mu-ambient', 'C02:pglite', 'C02:rust', 'C01:store-single', 'C01:store-optimistic', 'C02:store-single'].map((k) => [k, report.cells.get(k)])))
      .toEqual({ 'C01:pglite': 'pass', 'C01:rust': 'pass', 'C01:rust-mu-env': 'pending', 'C01:rust-mu-config': 'pending', 'C01:rust-mu-ambient': 'pending', 'C02:pglite': 'n/a', 'C02:rust': 'pass', 'C01:store-single': 'pass',
        'C01:store-optimistic': 'pending', 'C02:store-single': 'n/a' });
    expect(report.table).toContain('4 pass (compare), 2 pass (standalone, invariant only), 7 pending, 3 n/a');
    // The pending store test was listed, never run; the runnable one ran by exact name.
    expect(marksOf(r)).toEqual(['engine-rust', 'engine-rust-mu-env', 'engine-rust-mu-config', 'engine-rust-mu-ambient', 'build', 'list', 'run:c01_ok']);
  });

  test('the store modes differ only in GBRAIN_RUST_CONCURRENT_WRITES, which the single-writer run leaves unset', async () => {
    const r = rig();
    const commands = { ...r.opts().commands, storeRun: () => ['sh', '-c', 'echo "mode=${GBRAIN_RUST_CONCURRENT_WRITES:-unset}"; echo "running 1 test"; echo "test c01_ok ... ok"'] };
    const matrix = MATRIX.map((row) => (row.id === 'C01' ? { ...row, cells: { ...row.cells, 'store-optimistic': RUNS }, storeTests: { runnable: ['c01_ok'], pending: [] } } : row));
    const report = await runBar(r.opts({ arms: ['store-single', 'store-optimistic'], matrix, commands: commands as BarOptions['commands'], env: { GBRAIN_RUST_CONCURRENT_WRITES: '1' } }));
    expect(report.failures).toEqual([]);
    expect(readFileSync(join(r.dir, 'logs', 'store-run-store-single.log'), 'utf8')).toContain('mode=unset');
    expect(readFileSync(join(r.dir, 'logs', 'store-run-store-optimistic.log'), 'utf8')).toContain('mode=1');
  });

  test('the real cargo commands run the matrix names by exact name and list ignored tests', () => {
    expect(DEFAULT_COMMANDS.storeRun(['a', 'b']).slice(-3)).toEqual(['--exact', 'a', 'b']);
    expect(DEFAULT_COMMANDS.storeList().slice(-3)).toEqual(['--', '--list', '--ignored']);
    expect(DEFAULT_COMMANDS.storeBuild()).toContain('--no-run');
  });
});

describe('a child that cannot finish fails the bar with a stable code, the log path and the rerun command', () => {
  test('a compile failure: build_failed, the rustc error in the log, the store tests never listed or run', async () => {
    const r = rig();
    const commands = { ...r.opts().commands, storeBuild: () => ['sh', '-c', 'echo "error[E0425]: cannot find value x" >&2; exit 101'] };
    const report = await runBar(r.opts({ arms: ['store-single'], commands: commands as BarOptions['commands'] }));
    expect(codes(report.failures)).toEqual(['build_failed']);
    expect(readFileSync(report.failures[0]!.log!, 'utf8')).toContain('error[E0425]');
    expect(report.failures[0]!.rerun).toContain('--arms store-single');
    expect(report.cells.get('C01:store-single')).toBe('ERROR');
    expect(renderFailures(report.failures)).toMatch(/^multi-writer bar FAILED \[build_failed\] .*\n {2}log: .*gbrain-mw-bar-test-.*store-build\.log\n {2}rerun: bun test\/engine-parity\/multi-writer-bar\.ts --arms store-single$/);
  });

  test('a failed setup: setup_failed, and the engine process never starts', async () => {
    const r = goodRig();
    const commands = { ...r.opts().commands, engineSetup: () => [{ name: 'the Rust addon file exists', cmd: ['sh', '-c', 'exit 3'] }] };
    const report = await runBar(r.opts({ arms: ['rust'], commands: commands as BarOptions['commands'] }));
    expect(codes(report.failures)).toEqual(['setup_failed']);
    expect(report.failures[0]!.message).toContain('exited 3');
    expect(marksOf(r)).toEqual([]);
    expect(report.cells.get('C01:rust')).toBe('ERROR');
  });

  test('a killed child: killed, naming the signal, with no ledger judged', async () => {
    const r = goodRig();
    const commands = { ...r.opts().commands, engineRun: () => ['sh', '-c', 'kill -9 $$'] };
    const report = await runBar(r.opts({ arms: ['rust'], commands: commands as BarOptions['commands'] }));
    expect(codes(report.failures)).toEqual(['killed']);
    expect(report.failures[0]!.message).toContain('SIGKILL');
  });

  test('a child that outlives its deadline is killed with its whole process group: timeout, and the grandchild is gone', async () => {
    const r = goodRig();
    const pidFile = join(r.dir, 'grandchild.pid');
    const commands = { ...r.opts().commands, engineRun: () => ['sh', '-c', `sleep 60 & echo $! > ${pidFile}; wait`] };
    const started = Date.now();
    const report = await runBar(r.opts({ arms: ['rust'], commands: commands as BarOptions['commands'], timeouts: { engine: 400, setup: 5000, build: 5000, store: 5000 } }));
    expect(codes(report.failures)).toEqual(['timeout']);
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive()).toBe(false);
  });

  test('a program that is not there: launch_failed', async () => {
    const r = goodRig();
    const commands = { ...r.opts().commands, engineRun: () => ['/nonexistent/gbrain-mw-bar-program'] };
    const report = await runBar(r.opts({ arms: ['rust'], commands: commands as BarOptions['commands'] }));
    expect(codes(report.failures)).toEqual(['launch_failed']);
  });

  test('runBounded reports a launch error and a signal exit, and writes the command line to the log', async () => {
    const dir = tmp();
    const log = join(dir, 'x.log');
    expect((await runBounded(['/nonexistent/x'], { cwd: dir, env: {}, timeoutMs: 1000, logPath: log })).launchError).toBeDefined();
    const killed = await runBounded(['sh', '-c', 'kill -TERM $$'], { cwd: dir, env: {}, timeoutMs: 5000, logPath: log });
    expect([killed.signal, killed.timedOut]).toEqual(['SIGTERM', false]);
    expect(readFileSync(log, 'utf8')).toContain('$ sh -c kill -TERM $$');
  });

  test('a conformance run that exits non-zero fails the bar even when its ledger is complete and clean', async () => {
    const r = goodRig();
    const commands = { ...r.opts().commands, engineRun: (unit: { id: string }) => ['sh', '-c', `cat ${join(r.dir, `ledger-${unit.id}.txt`)} >> "$GBRAIN_TEST_MW_LEDGER"; exit 1`] };
    for (const id of ['rust']) writeFileSync(join(r.dir, `ledger-${id}.txt`), r.ledgers.get(id)!);
    const report = await runBar(r.opts({ arms: ['rust'], commands: commands as BarOptions['commands'] }));
    expect(codes(report.failures)).toEqual(['test_run_failed']);
  });
});

describe('the ledger is checked against the matrix, closed on every gap', () => {
  async function withLedger(text: string, arms: BarArm[] = ['rust']) {
    const r = goodRig();
    r.ledgers.set('rust', text);
    return runBar(r.opts({ arms }));
  }
  const good = goodLines(['pglite', 'postgres', 'rust']);

  test('control: the complete ledger passes', async () => {
    expect((await withLedger(ledgerText(good))).failures).toEqual([]);
  });

  test('an empty ledger: ledger_empty', async () => {
    expect(codes((await withLedger('')).failures)).toEqual(['ledger_empty']);
  });

  test('a truncated ledger (cut mid-line, no closing newline): ledger_malformed names the cut, and the lines after it are missing', async () => {
    const text = ledgerText(good);
    const report = await withLedger(text.slice(0, text.length - 25));
    expect(codes(report.failures)).toContain('ledger_malformed');
    expect(report.failures.find((f) => f.code === 'ledger_malformed')!.message).toContain('truncated');
    expect(codes(report.failures)).toContain('ledger_missing');
  });

  test('a complete last line with its newline cut off is still a truncated ledger, and that case and arm count as missing', async () => {
    const report = await withLedger(ledgerText(good).trimEnd());
    expect(report.failures.map((f) => f.code)).toEqual(['ledger_malformed', 'ledger_missing']);
  });

  test('a duplicate line: ledger_duplicate', async () => {
    expect(codes((await withLedger(ledgerText([...good, good[0]!]))).failures)).toEqual(['ledger_duplicate']);
  });

  test('a missing line: ledger_missing names the (case, arm)', async () => {
    const report = await withLedger(ledgerText(good.filter((l) => !(l.case === 'C02' && l.arm === 'rust'))));
    expect(report.failures.map((f) => [f.code, f.message.includes('C02:rust')])).toEqual([['ledger_missing', true]]);
    expect(report.cells.get('C02:rust')).toBe('MISSING');
  });

  test('a line for an arm the process does not run and one for a case the matrix lacks are unexpected; malformed JSON is malformed', async () => {
    const report = await withLedger(`${ledgerText([...good, line('C01', 'rust-mu-env', 'pass')])}{"case":"C99","arm":"rust","outcome":"pass","detail":"x"}\nnot json\n`);
    expect(codes(report.failures).sort()).toEqual(['ledger_malformed', 'ledger_unexpected', 'ledger_unexpected']);
  });

  test('outcomes the matrix does not allow: a failed case, a pending cell that passed, a runs cell that went pending, a missing prerequisite', async () => {
    const wrong = good.map((l) => {
      if (l.case === 'C01' && l.arm === 'pglite') return { ...l, outcome: 'fail' as const, detail: 'invariant broken' };
      if (l.case === 'C01' && l.arm === 'postgres') return { ...l, outcome: 'pending' as const };
      if (l.case === 'C02' && l.arm === 'pglite') return { ...l, outcome: 'pass' as const };
      if (l.case === 'C02' && l.arm === 'rust') return { ...l, outcome: 'prerequisite_missing' as const, detail: 'set DATABASE_URL' };
      return l;
    });
    const report = await withLedger(ledgerText(wrong));
    expect(report.failures.map((f) => f.code)).toEqual(['case_failed', 'outcome_mismatch', 'outcome_mismatch', 'prerequisite_missing']);
    expect(report.failures[0]!.message).toContain('invariant broken');
    expect(report.cells.get('C01:rust')).toBe('pass');
    expect([report.cells.get('C01:pglite'), report.cells.get('C02:rust')]).toEqual([undefined, 'PREREQ']);
  });

  test('a ledger file that is not there is its own code', () => {
    const failures = checkLedger({ id: 'rust', arms: ['rust'], ledger: '/nowhere' }, MATRIX, null, 'rerun').failures;
    expect(codes(failures)).toEqual(['ledger_missing']);
  });

  test('an expected pending case is not a failure while the ledger says pending, and the bar needs the ledger to say it', async () => {
    const r = goodRig();
    const report = await runBar(r.opts({ arms: ['rust-mu-env'] }));
    expect(report.failures).toEqual([]);
    expect(report.cells.get('C01:rust-mu-env')).toBe('pending');
  });
});

describe('a fake engine that reports multi_writer but refuses a required member: the case and the bar both fail', () => {
  test('the case fails on the harness, writes a fail line, and the bar turns that line into case_failed', async () => {
    const refused = Object.assign(new Error('The Rust engine does not support putPage yet (it needs the multi_writer capability)'),
      { code: 'engine_capability_missing', reason: 'multi_writer', detail: 'member=putPage capability=multi_writer' });
    const lines: LedgerLine[] = [];
    const engine = { capabilities: new Set(['multi_writer']), putPage: async () => { throw refused; } };
    const calls = new Set<string>();
    const row = MATRIX[1]!; // needs multi_writer, runs on rust
    const outcome = await checkMwArm({ row, label: 'rust', backend: 'rust', name: 'C02 fake', opts: { methods: ['putPage'] } as never, calls, refusals: [],
      capabilities: engine.capabilities, reference: undefined, ledger: (l) => { lines.push(l); },
      run: async () => { calls.add('putPage'); await engine.putPage(); return 'unreachable'; } }).then(() => 'passed', (e: Error) => e.message);
    expect(outcome).toContain('typed capability refusal');
    expect(lines.map((l) => [l.case, l.arm, l.outcome])).toEqual([['C02', 'rust', 'fail']]);

    const r = goodRig();
    r.ledgers.set('rust', ledgerText([...goodLines(['pglite', 'postgres', 'rust']).filter((l) => !(l.case === 'C02' && l.arm === 'rust')), ...lines]));
    const report = await runBar(r.opts({ arms: ['rust'] }));
    expect(codes(report.failures)).toEqual(['case_failed']);
    expect(report.failures[0]!.message).toContain('typed capability refusal');
    expect(report.cells.get('C02:rust')).toBe('FAIL');
  });
});

describe('single-arm modes', () => {
  const plan = (arms: BarArm[], env: Record<string, string | undefined>) => planEngineUnits({ arms, matrix: MATRIX, env, logDir: '/x' });
  const shape = (arms: BarArm[], env: Record<string, string | undefined>) => {
    const { units, problems } = plan(arms, env);
    return { units: units.map((u) => ({ id: u.id, arms: u.arms, rust: u.env.GBRAIN_TEST_RUST_ARM, mu: u.env.GBRAIN_TEST_RUST_MU_ARM, db: 'DATABASE_URL' in u.env ? 'removed' : 'kept', backend: u.env.GBRAIN_TEST_BACKEND })), problems: codes(problems) };
  };

  test('PGLite alone runs without DATABASE_URL; Postgres alone needs it and says so; both together keep it', () => {
    expect(shape(['pglite'], { DATABASE_URL: 'u' })).toEqual({ units: [{ id: 'sql', arms: ['pglite'], rust: undefined, mu: undefined, db: 'removed', backend: undefined }], problems: [] });
    expect(shape(['postgres'], {})).toEqual({ units: [], problems: ['setup_failed'] });
    expect(plan(['postgres'], {}).problems[0]!.message).toContain('DATABASE_URL');
    expect(shape(['postgres'], { DATABASE_URL: 'u' }).units).toEqual([{ id: 'sql', arms: ['postgres'], rust: undefined, mu: undefined, db: 'kept', backend: 'postgres' }]);
    expect(shape(['pglite', 'postgres'], { DATABASE_URL: 'u' }).units).toEqual([{ id: 'sql', arms: ['pglite', 'postgres'], rust: undefined, mu: undefined, db: 'kept', backend: undefined }]);
  });

  test('a Rust label runs with PGLite (and Postgres when DATABASE_URL is set) as its reference; the two labels are two processes', () => {
    expect(shape(['rust'], {}).units).toEqual([{ id: 'rust', arms: ['pglite', 'rust'], rust: '1', mu: undefined, db: 'removed', backend: undefined }]);
    expect(shape(['rust'], { DATABASE_URL: 'u' }).units).toEqual([{ id: 'rust', arms: ['pglite', 'postgres', 'rust'], rust: '1', mu: undefined, db: 'kept', backend: undefined }]);
    expect(shape(['rust-mu-env'], { DATABASE_URL: 'u' }).units).toEqual([{ id: 'rust-mu-env', arms: ['pglite', 'postgres', 'rust-mu-env'], rust: undefined, mu: 'env', db: 'kept', backend: undefined }]);
    expect(shape(['rust-mu-config'], { DATABASE_URL: 'u' }).units).toEqual([{ id: 'rust-mu-config', arms: ['pglite', 'postgres', 'rust-mu-config'], rust: undefined, mu: 'config', db: 'kept', backend: undefined }]);
    expect(shape(['rust', 'rust-mu-env', 'rust-mu-config', 'rust-mu-ambient'], {}).units.map((u) => u.id)).toEqual(['rust', 'rust-mu-env', 'rust-mu-config', 'rust-mu-ambient']);
  });

  test('rust-mu-ambient is the self-check lane: the switches are on when the process starts and the preload keeps them', () => {
    const { units } = plan(['rust-mu-ambient'], { DATABASE_URL: 'u', GBRAIN_RUST_COMMIT_LOG: '1' });
    expect(units.map((u) => [u.id, u.arms])).toEqual([['rust-mu-ambient', ['pglite', 'postgres', 'rust-mu-ambient']]]);
    const env = units[0]!.env;
    expect({ rust: env.GBRAIN_TEST_RUST_ARM, mu: env.GBRAIN_TEST_RUST_MU_ARM, multiuser: env.GBRAIN_RUST_MULTIUSER, selfCheck: env.GBRAIN_RUST_ACCESS_SELF_CHECK, keep: env.GBRAIN_TEST_KEEP_AMBIENT_ENV })
      .toEqual({ rust: '1', mu: undefined, multiuser: '1', selfCheck: '1', keep: '1' });
    // The commit log is the harness's to turn on for the multi-writer file, never the caller's environment.
    expect('GBRAIN_RUST_COMMIT_LOG' in env && env.GBRAIN_RUST_COMMIT_LOG === undefined).toBe(true);
    // The two rust-mu routes never inherit the lane's switches.
    for (const id of ['rust-mu-env', 'rust-mu-config'] as const) {
      const other = plan([id], { DATABASE_URL: 'u' }).units[0]!.env;
      expect([other.GBRAIN_RUST_MULTIUSER, other.GBRAIN_RUST_ACCESS_SELF_CHECK, other.GBRAIN_TEST_KEEP_AMBIENT_ENV]).toEqual([undefined, undefined, undefined]);
    }
  });

  test('a store arm alone starts no engine process', () => {
    expect(shape(['store-single'], { DATABASE_URL: 'u' })).toEqual({ units: [], problems: [] });
  });

  test('Rust alone without DATABASE_URL: a compare case with PGLite n/a records prerequisite_missing, and the table shows only the selected arm', async () => {
    const r = rig();
    r.ledgers.set('rust', ledgerText([line('C01', 'pglite', 'pass'), line('C01', 'rust', 'pass'), line('C02', 'pglite', 'n/a'), line('C02', 'rust', 'prerequisite_missing', 'set DATABASE_URL')]));
    const report = await runBar(r.opts({ arms: ['rust'], env: {} }));
    expect(codes(report.failures)).toEqual(['prerequisite_missing']);
    expect(report.failures[0]!.message).toContain('DATABASE_URL');
    expect(report.table.split('\n')[0]).toMatch(/^case +rust +reference$/);
  });

  test('--arms parsing: all by default, a list, and a typed complaint for an unknown or empty one', () => {
    expect(parseArms(undefined)).toEqual([...BAR_ARMS]);
    expect(parseArms('rust-mu,store-single')).toEqual(['rust-mu-env', 'rust-mu-config', 'store-single']);
    expect(parseArms('rust, store-single,rust')).toEqual(['rust', 'store-single']);
    expect(parseArms('rust,mu')).toContain('unknown arm mu');
    expect(typeof parseArms('')).toBe('string');
  });
});

describe('variants and both rust-mu routes', () => {
  const PART: MwCell = { status: 'pending', owner: 'L5 hosts', why: 'store lease fence' };
  /** C01 as above, plus a variant with engine cells only (as the case work's MwVariant). */
  const WITH_VARIANT: readonly MwCase[] = [{ ...MATRIX[0]!, variants: [{ id: 'C01.partition', of: 'C01', title: 'back from a partition', invariant: 'x', reference: 'compare', members: ['putPage'],
    cells: { pglite: RUNS, postgres: RUNS, rust: RUNS, 'rust-mu': PART } }] } as unknown as MwCase, MATRIX[1]!];

  test('the expected set is the rows on engine and store arms plus the variant on engine arms only; the variant is its own table row', async () => {
    const r = rig();
    for (const id of ['rust', 'rust-mu-env', 'rust-mu-config', 'rust-mu-ambient'] as const) r.ledgers.set(id, ledgerText(goodLines(['pglite', 'postgres', id], WITH_VARIANT)));
    const report = await runBar(r.opts({ matrix: WITH_VARIANT }));
    expect(report.failures).toEqual([]);
    expect(report.table.split('\n').filter((l) => /^C0\d/.test(l)).map((l) => l.split(/\s+/)[0])).toEqual(['C01', 'C01.partition', 'C02']);
    expect([report.cells.get('C01.partition:rust'), report.cells.get('C01.partition:rust-mu-config'), report.cells.get('C01.partition:store-single')]).toEqual(['pass', 'pending', 'n/a']);
    // Only the row's runnable store test ran: the variant has no store tests, and its store cells are n/a, not a gap.
    expect(marksOf(r).filter((m) => m.startsWith('run:'))).toEqual(['run:c01_ok']);
  });

  test('a missing variant line fails closed like a missing case line, and a variant pass on a pending cell is a mismatch', async () => {
    const r = rig();
    const lines = goodLines(['pglite', 'postgres', 'rust'], WITH_VARIANT);
    r.ledgers.set('rust', ledgerText(lines.filter((l) => !(l.case === 'C01.partition' && l.arm === 'postgres'))));
    const missing = await runBar(r.opts({ matrix: WITH_VARIANT, arms: ['rust'] }));
    expect(missing.failures.map((f) => [f.code, f.message.includes('C01.partition:postgres')])).toEqual([['ledger_missing', true]]);
    r.ledgers.set('rust-mu-env', ledgerText(goodLines(['pglite', 'postgres', 'rust-mu-env'], WITH_VARIANT).map((l) => (l.case === 'C01.partition' && l.arm === 'rust-mu-env' ? { ...l, outcome: 'pass' as const } : l))));
    const mismatch = await runBar(r.opts({ matrix: WITH_VARIANT, arms: ['rust-mu-env'] }));
    expect(mismatch.failures.map((f) => f.code)).toEqual(['outcome_mismatch']);
  });

  test('the two routes are two processes with their own ledger labels; a line labelled for the other route is unexpected', async () => {
    const r = goodRig();
    r.ledgers.set('rust-mu-config', ledgerText([...goodLines(['pglite', 'postgres']), ...goodLines(['rust-mu-env']).filter((l) => l.arm === 'rust-mu-env')]));
    const report = await runBar(r.opts({ arms: ['rust-mu-config'] }));
    expect(report.failures.map((f) => f.code).sort()).toEqual(['ledger_missing', 'ledger_missing', 'ledger_unexpected', 'ledger_unexpected']);
  });
});

const report = (r: { cells: Map<string, string> }, key: string) => r.cells.get(key);

describe('the Rust store half', () => {
  const storeOnly = (r: Rig, commands: Partial<BarCommands>, over: Partial<BarOptions> = {}) =>
    runBar(r.opts({ arms: ['store-single'], commands: { ...r.opts().commands, ...commands }, ...over }));

  test('parses libtest output: ignored list names, result lines and the running count', () => {
    expect([...parseIgnoredList('a_one: test\nb_two: test\n\n2 tests, 0 benchmarks\n')]).toEqual(['a_one', 'b_two']);
    const parsed = parseStoreRun('running 2 tests\ntest a ... ok\ntest b ... FAILED\n\ntest result: FAILED. 1 passed; 1 failed\n');
    expect([parsed.running, [...parsed.results]]).toEqual([2, [['a', ['ok']], ['b', ['FAILED']]]]);
  });

  test('a pending store test that is not an ignored test of the file: store_pending_missing, and nothing is run for it', async () => {
    const r = rig();
    const report = await storeOnly(r, { storeList: () => ['sh', '-c', 'printf "something_else: test\\n"'] }, { arms: ['store-optimistic'] });
    expect(codes(report.failures)).toEqual(['store_pending_missing']);
    expect(report.failures[0]!.message).toContain('c01_ok_multi_writer');
    expect(marksOf(r)).not.toContain('run:c01_ok_multi_writer');
  });

  test('a runnable test with a pending twin: the twin is validated against the ignored list even though the cell runs (a missing twin fails)', async () => {
    const r = rig();
    // C01 runs c01_ok on store-single and names c01_ok_multi_writer as its pending twin.
    const missing = await storeOnly(r, { storeList: () => ['sh', '-c', 'printf "other: test\\n"'] });
    expect(codes(missing.failures)).toEqual(['store_pending_missing']);
    expect(missing.failures[0]!.message).toContain('c01_ok_multi_writer');
    expect(report(missing, 'C01:store-single')).toBe('pass'); // the runnable baseline still ran and passed
    const present = await storeOnly(r, {});
    expect(present.failures).toEqual([]);
  });

  test('a failing store test: store_case_failed (and store_run_failed for the non-zero exit), the cell is FAIL', async () => {
    const r = rig();
    const report = await storeOnly(r, { storeRun: () => ['sh', '-c', 'echo "running 1 test"; echo "test c01_ok ... FAILED"; exit 101'] });
    expect(codes(report.failures).sort()).toEqual(['store_case_failed', 'store_run_failed']);
    expect(report.cells.get('C01:store-single')).toBe('FAIL');
  });

  test('a store test that never reports, and one that is ignored, fail closed', async () => {
    const r = rig();
    const none = await storeOnly(r, { storeRun: () => ['sh', '-c', 'echo "running 0 tests"'] });
    expect(codes(none.failures)).toEqual(['store_result_missing']);
    expect(none.cells.get('C01:store-single')).toBe('MISSING');
    const ignored = await storeOnly(r, { storeRun: () => ['sh', '-c', 'echo "running 1 test"; echo "test c01_ok ... ignored"'] });
    expect(codes(ignored.failures)).toEqual(['store_result_unexpected']);
  });

  test('a test cargo ran that the matrix did not name fails the bar', async () => {
    const r = rig();
    const report = await storeOnly(r, { storeRun: () => ['sh', '-c', 'echo "running 2 tests"; echo "test c01_ok ... ok"; echo "test stray ... ok"'] });
    expect(codes(report.failures)).toEqual(['store_result_unexpected', 'store_result_unexpected']);
  });

  test('a runs cell with no runnable test named fails, and --exact is never run with no names (that would run the whole file)', async () => {
    const r = rig();
    const matrix = MATRIX.map((row) => (row.id === 'C01' ? { ...row, storeTests: { runnable: [], pending: [] } } : row));
    const report = await storeOnly(r, {}, { matrix });
    expect(codes(report.failures)).toEqual(['store_cell_empty']);
    expect(marksOf(r).filter((m) => m.startsWith('run:'))).toEqual([]);
  });

  test('a store run that outlives its deadline is killed: timeout', async () => {
    const r = rig();
    const report = await storeOnly(r, { storeRun: () => ['sh', '-c', 'sleep 60'] }, { timeouts: { setup: 5000, build: 5000, engine: 5000, store: 300 } });
    expect(codes(report.failures)).toEqual(['timeout']);
    expect(report.cells.get('C01:store-single')).toBe('ERROR');
  });
});
