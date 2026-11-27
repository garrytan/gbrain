/**
 * The multi-writer pass mark: one command that prints, per case C01..C22, what each arm did.
 *
 *   bun test/engine-parity/multi-writer-bar.ts [--arms pglite,postgres,rust,rust-mu-env,rust-mu-config,rust-mu-ambient,store-single,store-optimistic]
 *                                              [--log-dir <dir>] [--timeout-ms <ms>]
 *
 * The engine arms run `test/engine-parity/multi-writer-conformance.test.ts` once per Rust label (so the Rust arm has the SQL
 * arms in its process as the reference the `compare` cases need): the harness writes one terminal outcome line per
 * (case, arm) to a ledger file (GBRAIN_TEST_MW_LEDGER, multi-writer-ledger.ts) and the bar reads it back. The Rust store arms
 * run the cargo tests of `rust/crates/gbrain-store/tests/multi_writer_conformance.rs`: only the tests the matrix marks runnable,
 * by exact name, in the single-writer mode and in the optimistic mode (GBRAIN_RUST_CONCURRENT_WRITES=1); the pending ones are
 * only listed from `--list --ignored`, never run.
 *
 * The bar fails closed. It knows the expected (case, arm) set from the matrix (multi-writer-cases.ts) and fails on a missing,
 * malformed, duplicate or unexpected ledger line, on an outcome the matrix does not allow for that cell, and on any setup,
 * build, launch, kill or timeout failure (every child is bounded by a timeout and killed, with its process group, on expiry).
 * Each failure prints a stable code, the log path and the rerun command on stderr, and the exit status is 1.
 *
 * Failure codes: usage, setup_failed, build_failed, launch_failed, killed, timeout, test_run_failed, ledger_empty,
 * ledger_missing, ledger_malformed, ledger_duplicate, ledger_unexpected, outcome_mismatch, case_failed, prerequisite_missing,
 * store_cell_empty, store_pending_missing, store_result_missing, store_result_unexpected, store_case_failed, store_run_failed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MW_CASES, MW_STORE_ARMS, type MwCase, type MwStoreArm } from './multi-writer-cases.ts';
import { mwEntries, type MwEntry } from './multi-writer-entries.ts';
import { cellArm, LEDGER_ARMS, MW_LEDGER_ENV, parseLedger, type LedgerArm, type LedgerLine } from './multi-writer-ledger.ts';

/**
 * The arms of the bar: the engine arms by the label the ledger carries (the `rust-mu` view has two routes to the multi-user
 * switch, `rust-mu-env` and `rust-mu-config`, each its own process, column and ledger label; both read the matrix's one
 * `rust-mu` cell), the self-check lane's label `rust-mu-ambient` (the process starts with GBRAIN_RUST_MULTIUSER=1 and the
 * access self-check on, kept through the preload by GBRAIN_TEST_KEEP_AMBIENT_ENV=1; it reads the same `rust-mu` cell) and the
 * two Rust store arms. `--arms rust-mu` is shorthand for the two rust-mu routes.
 */
export const BAR_ARMS = [...LEDGER_ARMS, ...MW_STORE_ARMS] as const;
export type BarArm = typeof BAR_ARMS[number];

const REPO = join(import.meta.dir, '..', '..');
const ENGINE_FILE = 'test/engine-parity/multi-writer-conformance.test.ts';
const STORE_TEST_TARGET = 'multi_writer_conformance';

export interface BarFailure {
  code: string;
  message: string;
  /** The log of the step that failed, when it has one. */
  log?: string;
  rerun: string;
}

// ---- bounded children ------------------------------------------------------------------------------------------

export interface BoundedResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Set when the child never started (missing program, bad cwd). */
  launchError?: string;
}

export interface BoundedOptions {
  cwd: string;
  /** `undefined` removes a variable. */
  env: Record<string, string | undefined>;
  timeoutMs: number;
  /** Combined stdout and stderr go here (appended, after a line naming the command). */
  logPath: string;
}

const live = new Set<number>();

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

process.on('exit', () => { for (const pid of live) killGroup(pid); });

/**
 * Run a command with a deadline: the child leads its own process group, and on expiry the whole group is killed (cargo and
 * bun both start grandchildren). Never throws; the result says whether it launched, was killed by the deadline or a signal,
 * or exited.
 */
export function runBounded(cmd: readonly string[], o: BoundedOptions): Promise<BoundedResult> {
  return new Promise((resolve) => {
    const fd = openSync(o.logPath, 'a');
    writeSync(fd, `$ ${cmd.join(' ')}\n`);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...o.env })) if (value !== undefined) env[key] = value;
    let child: ChildProcess;
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: BoundedResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (child?.pid !== undefined) live.delete(child.pid);
      closeSync(fd);
      resolve(result);
    };
    try {
      child = spawn(cmd[0]!, cmd.slice(1), { cwd: o.cwd, env, stdio: ['ignore', fd, fd], detached: true });
    } catch (error) {
      finish({ exitCode: null, signal: null, timedOut: false, launchError: (error as Error).message });
      return;
    }
    if (child.pid !== undefined) live.add(child.pid);
    timer = setTimeout(() => { timedOut = true; killGroup(child.pid); }, o.timeoutMs);
    child.on('error', (error) => finish({ exitCode: null, signal: null, timedOut: false, launchError: error.message }));
    child.on('close', (exitCode, signal) => {
      // Whatever the leader left behind in its group goes with it.
      killGroup(child.pid);
      finish({ exitCode, signal, timedOut });
    });
  });
}

// ---- plan ------------------------------------------------------------------------------------------------------

/** One command the bar runs: a setup check, a build, or the run itself. */
export interface BarStep {
  name: string;
  /** The failure code when the step fails (`timeout`, `killed` and `launch_failed` are decided from how it ended). */
  code: 'setup_failed' | 'build_failed' | 'test_run_failed' | 'store_run_failed';
  cmd: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs: number;
}

/** One `bun test` process of the engine file and what its ledger must hold. */
export interface EngineUnit {
  id: string;
  /** The arms this process runs (the Rust label, and the SQL arms it has as its reference). */
  arms: LedgerArm[];
  env: Record<string, string | undefined>;
  setup: BarStep[];
  run: BarStep;
  ledger: string;
  log: string;
}

export interface BarCommands {
  /** Setup checks of an engine unit, run before it (default: the Rust addon file exists, for a Rust label). */
  engineSetup(unit: { arms: LedgerArm[]; env: Record<string, string | undefined> }): Array<Pick<BarStep, 'name' | 'cmd'>>;
  engineRun(unit: { id: string; arms: LedgerArm[] }): string[];
  storeBuild(): string[];
  storeList(): string[];
  storeRun(names: readonly string[]): string[];
}

export const DEFAULT_COMMANDS: BarCommands = {
  engineSetup: (unit) => {
    const addon = unit.env.GBRAIN_TEST_RUST_ENGINE_ADDON;
    return unit.arms.some((a) => a === 'rust' || a === 'rust-mu-env' || a === 'rust-mu-config' || a === 'rust-mu-ambient') && addon !== undefined && addon !== ''
      ? [{ name: `the Rust addon file exists (${addon})`, cmd: ['test', '-f', addon] }] : [];
  },
  engineRun: () => ['bun', 'test', '--timeout=60000', ENGINE_FILE],
  storeBuild: () => ['cargo', 'test', '-p', 'gbrain-store', '--test', STORE_TEST_TARGET, '--no-run'],
  storeList: () => ['cargo', 'test', '-p', 'gbrain-store', '--test', STORE_TEST_TARGET, '--', '--list', '--ignored'],
  storeRun: (names) => ['cargo', 'test', '-p', 'gbrain-store', '--test', STORE_TEST_TARGET, '--', '--exact', ...names],
};

export interface BarOptions {
  arms: readonly BarArm[];
  matrix: readonly MwCase[];
  /** The caller's environment (DATABASE_URL, the addon path); children inherit the process environment plus each unit's own. */
  env: Record<string, string | undefined>;
  logDir: string;
  repoDir?: string;
  commands?: Partial<BarCommands>;
  timeouts?: { setup?: number; build?: number; engine?: number; store?: number };
}

export interface BarReport {
  failures: BarFailure[];
  /** Cell text per `${case}:${arm}` for the selected arms. */
  cells: Map<string, string>;
  table: string;
  logDir: string;
}

const RUST_ENV_FLAGS = ['GBRAIN_TEST_RUST_ARM', 'GBRAIN_TEST_RUST_MU_ARM', 'GBRAIN_TEST_BACKEND', 'GBRAIN_RUST_CONCURRENT_WRITES', 'GBRAIN_RUST_MULTIUSER', 'GBRAIN_RUST_COMMIT_LOG', 'GBRAIN_RUST_ACCESS_SELF_CHECK', 'GBRAIN_TEST_KEEP_AMBIENT_ENV'] as const;

/**
 * The engine processes the selection needs. Without a Rust label, one process holds the selected SQL arms. With one, a process
 * per label holds that label and its SQL reference arms (PGLite, and Postgres when DATABASE_URL is set), because a `compare`
 * case needs an arm that ran it first.
 */
export function planEngineUnits(opts: BarOptions): { units: EngineUnit[]; problems: BarFailure[] } {
  const selected = new Set(opts.arms);
  const havePg = opts.env.DATABASE_URL !== undefined && opts.env.DATABASE_URL !== '';
  const problems: BarFailure[] = [];
  const rerun = (arms: string) => `bun test/engine-parity/multi-writer-bar.ts --arms ${arms}`;
  const cmds = { ...DEFAULT_COMMANDS, ...opts.commands };
  const timeouts = { setup: 60_000, build: 1_800_000, engine: 900_000, store: 900_000, ...opts.timeouts };
  const units: EngineUnit[] = [];
  const baseEnv = (): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = {};
    for (const flag of RUST_ENV_FLAGS) env[flag] = undefined;
    return env;
  };
  const add = (id: string, arms: LedgerArm[], extra: Record<string, string | undefined>): void => {
    const ledger = join(opts.logDir, `engine-${id}.ledger.jsonl`);
    const log = join(opts.logDir, `engine-${id}.log`);
    const env = { ...baseEnv(), ...extra, [MW_LEDGER_ENV]: ledger };
    const setup: BarStep[] = cmds.engineSetup({ arms, env: { ...opts.env, ...env } })
      .map((s) => ({ ...s, code: 'setup_failed' as const, timeoutMs: timeouts.setup }));
    units.push({ id, arms, env, setup, ledger, log, run: { name: `${ENGINE_FILE} (${arms.join(', ')})`, code: 'test_run_failed', cmd: cmds.engineRun({ id, arms }), env, timeoutMs: timeouts.engine } });
  };
  const wantsRust = selected.has('rust');
  const wantsMuEnv = selected.has('rust-mu-env');
  const wantsMuConfig = selected.has('rust-mu-config');
  const wantsMuAmbient = selected.has('rust-mu-ambient');
  const sqlSelected = (['pglite', 'postgres'] as const).filter((a) => selected.has(a));
  if (selected.has('postgres') && !havePg) {
    problems.push({ code: 'setup_failed', message: 'the postgres arm is selected but DATABASE_URL is not set (set it with GBRAIN_TEST_ALLOW_DATABASE_URL=1, or leave postgres out of --arms)', rerun: rerun([...opts.arms].join(',')) });
  }
  if (!wantsRust && !wantsMuEnv && !wantsMuConfig && !wantsMuAmbient) {
    // Only the SQL arms: PGLite alone runs without DATABASE_URL, Postgres alone with GBRAIN_TEST_BACKEND=postgres, both as is.
    const running = sqlSelected.filter((a) => a !== 'postgres' || havePg);
    if (running.length > 0) {
      add('sql', running, running.length === 2 ? {} : running[0] === 'pglite' ? { DATABASE_URL: undefined } : { GBRAIN_TEST_BACKEND: 'postgres' });
    }
    return { units, problems };
  }
  const reference: LedgerArm[] = havePg ? ['pglite', 'postgres'] : ['pglite'];
  const databaseEnv: Record<string, string | undefined> = havePg ? {} : { DATABASE_URL: undefined };
  if (wantsRust) add('rust', [...reference, 'rust'], { ...databaseEnv, GBRAIN_TEST_RUST_ARM: '1' });
  if (wantsMuEnv) add('rust-mu-env', [...reference, 'rust-mu-env'], { ...databaseEnv, GBRAIN_TEST_RUST_MU_ARM: 'env' });
  if (wantsMuConfig) add('rust-mu-config', [...reference, 'rust-mu-config'], { ...databaseEnv, GBRAIN_TEST_RUST_MU_ARM: 'config' });
  // The self-check lane's environment (.github/workflows/rust-multiuser-selfcheck.yml): the switches are on when the process
  // starts and the preload keeps them; the harness labels the arm `rust-mu-ambient` and asserts what each brain resolved.
  if (wantsMuAmbient) {
    add('rust-mu-ambient', [...reference, 'rust-mu-ambient'], {
      ...databaseEnv, GBRAIN_TEST_RUST_ARM: '1', GBRAIN_RUST_MULTIUSER: '1', GBRAIN_RUST_ACCESS_SELF_CHECK: '1', GBRAIN_TEST_KEEP_AMBIENT_ENV: '1',
    });
  }
  return { units, problems };
}

// ---- ledger check ----------------------------------------------------------------------------------------------

const DISPLAY: Record<LedgerLine['outcome'], string> = { pass: 'pass', fail: 'FAIL', pending: 'pending', 'n/a': 'n/a', prerequisite_missing: 'PREREQ' };

/** What the matrix lets `outcome` be for a cell: the one outcome each status allows. */
function allowedOutcome(status: 'runs' | 'n/a' | 'pending'): LedgerLine['outcome'] {
  return status === 'runs' ? 'pass' : status;
}

/**
 * Check a unit's ledger text against the matrix: every (case, arm) of the unit appears exactly once with the outcome its cell
 * allows. Returns the failures and the display text of each cell found.
 */
export function checkLedger(unit: Pick<EngineUnit, 'id' | 'arms' | 'ledger'>, matrix: readonly MwCase[], text: string | null, rerun: string): { failures: BarFailure[]; cells: Map<string, string> } {
  const failures: BarFailure[] = [];
  const cells = new Map<string, string>();
  const fail = (code: string, message: string) => failures.push({ code, message: `[${unit.id}] ${message}`, log: unit.ledger, rerun });
  if (text === null) {
    fail('ledger_missing', `the ledger file ${unit.ledger} does not exist`);
    return { failures, cells };
  }
  const parsed = parseLedger(text);
  if (text === '') {
    fail('ledger_empty', 'the conformance run wrote no ledger lines');
    return { failures, cells };
  }
  for (const problem of parsed.malformed) fail('ledger_malformed', problem);
  const expected = new Map<string, { row: MwEntry; arm: LedgerArm }>();
  for (const row of mwEntries(matrix)) for (const arm of unit.arms) expected.set(`${row.id}:${arm}`, { row, arm });
  const seen = new Map<string, LedgerLine>();
  for (const line of parsed.lines) {
    const key = `${line.case}:${line.arm}`;
    if (!expected.has(key)) { fail('ledger_unexpected', `${key} is not a (case, arm) this process runs (arms ${unit.arms.join(', ')}; ${mwEntries(matrix).length} matrix entries)`); continue; }
    if (seen.has(key)) { fail('ledger_duplicate', `${key} appears more than once in the ledger`); continue; }
    seen.set(key, line);
  }
  for (const [key, { row, arm }] of expected) {
    const line = seen.get(key);
    if (line === undefined) { fail('ledger_missing', `${key} has no ledger line`); continue; }
    cells.set(key, DISPLAY[line.outcome]);
    const status = row.cells[cellArm(arm)].status;
    if (line.outcome === allowedOutcome(status)) continue;
    if (line.outcome === 'prerequisite_missing') fail('prerequisite_missing', `${key} could not run: ${line.detail}`);
    else if (line.outcome === 'fail') fail('case_failed', `${key} failed: ${line.detail}`);
    else fail('outcome_mismatch', `${key}: the matrix cell is ${status}, so the ledger must say ${allowedOutcome(status)}, but it says ${line.outcome} (${line.detail}); flip the cell or fix the case`);
  }
  return { failures, cells };
}

// ---- Rust store half -------------------------------------------------------------------------------------------

/** Names of the ignored tests from `cargo test -- --list --ignored` output. */
export function parseIgnoredList(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const found = /^(\S+): test$/.exec(line.trim());
    if (found) names.add(found[1]!);
  }
  return names;
}

export interface StoreResults { running: number | null; results: Map<string, string[]> }

/** `test <name> ... <result>` lines and the `running N tests` count of one libtest run. */
export function parseStoreRun(text: string): StoreResults {
  const results = new Map<string, string[]>();
  let running: number | null = null;
  for (const line of text.split('\n')) {
    const count = /^running (\d+) tests?$/.exec(line.trim());
    if (count) running = (running ?? 0) + Number(count[1]);
    const result = /^test (\S+) \.\.\. (ok|FAILED|ignored)(?:,.*)?$/.exec(line.trim());
    if (result) results.set(result[1]!, [...(results.get(result[1]!) ?? []), result[2]!]);
  }
  return { running, results };
}

const STORE_ENV: Record<MwStoreArm, Record<string, string | undefined>> = {
  'store-single': { GBRAIN_RUST_CONCURRENT_WRITES: undefined, GBRAIN_RUST_MULTIUSER: undefined },
  'store-optimistic': { GBRAIN_RUST_CONCURRENT_WRITES: '1', GBRAIN_RUST_MULTIUSER: undefined },
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// ---- orchestration ---------------------------------------------------------------------------------------------

function describeEnd(result: BoundedResult): { code: 'launch_failed' | 'timeout' | 'killed' | null; text: string } {
  if (result.launchError !== undefined) return { code: 'launch_failed', text: `could not start: ${result.launchError}` };
  if (result.timedOut) return { code: 'timeout', text: 'ran past its deadline and was killed' };
  if (result.signal !== null) return { code: 'killed', text: `was killed by ${result.signal}` };
  return { code: null, text: `exited ${result.exitCode}` };
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Cell display ranking when two processes report the same cell: the worse one is shown. */
const WORSE = ['ERROR', 'FAIL', 'PREREQ', 'MISSING', 'pass', 'pending', 'n/a', '-'];

function merge(cells: Map<string, string>, key: string, value: string): void {
  const had = cells.get(key);
  if (had === undefined || WORSE.indexOf(value) < WORSE.indexOf(had)) cells.set(key, value);
}

export async function runBar(opts: BarOptions): Promise<BarReport> {
  mkdirSync(opts.logDir, { recursive: true });
  const repo = opts.repoDir ?? REPO;
  const cmds = { ...DEFAULT_COMMANDS, ...opts.commands };
  const timeouts = { setup: 60_000, build: 1_800_000, engine: 900_000, store: 900_000, ...opts.timeouts };
  const selected = new Set(opts.arms);
  const failures: BarFailure[] = [];
  const cells = new Map<string, string>();
  const entries = mwEntries(opts.matrix);
  const selectedStore = MW_STORE_ARMS.filter((a) => selected.has(a));

  /** `ok`; `failed` (it ran and exited non-zero: its output is still worth reading); `abnormal` (never started, killed or timed out). */
  const runStep = async (step: BarStep, log: string, rerun: string): Promise<'ok' | 'failed' | 'abnormal'> => {
    const result = await runBounded(step.cmd, { cwd: step.cwd ?? repo, env: step.env ?? {}, timeoutMs: step.timeoutMs, logPath: log });
    const end = describeEnd(result);
    if (end.code === null && result.exitCode === 0) return 'ok';
    failures.push({ code: end.code ?? step.code, message: `${step.name} ${end.text}`, log, rerun });
    return end.code === null ? 'failed' : 'abnormal';
  };

  // Engine arms.
  const { units, problems } = planEngineUnits(opts);
  failures.push(...problems);
  for (const unit of units) {
    const rerun = `bun test/engine-parity/multi-writer-bar.ts --arms ${unit.arms.filter((a) => selected.has(a)).join(',') || unit.arms.join(',')}`;
    writeFileSync(unit.ledger, '');
    writeFileSync(unit.log, '');
    let status: 'ok' | 'failed' | 'abnormal' = 'ok';
    for (const step of unit.setup) if (status === 'ok' && (await runStep(step, unit.log, rerun)) !== 'ok') status = 'abnormal';
    if (status === 'ok') status = await runStep(unit.run, unit.log, rerun);
    if (status === 'abnormal') {
      for (const arm of unit.arms) for (const row of entries) if (selected.has(arm)) merge(cells, `${row.id}:${arm}`, 'ERROR');
      continue;
    }
    // A run that exited non-zero is already a failure; its ledger still says which cases failed.
    const checked = checkLedger(unit, opts.matrix, readText(unit.ledger), rerun);
    failures.push(...checked.failures);
    for (const row of entries) {
      for (const arm of unit.arms) {
        if (!selected.has(arm)) continue;
        merge(cells, `${row.id}:${arm}`, checked.cells.get(`${row.id}:${arm}`) ?? 'MISSING');
      }
    }
  }

  // Rust store arms.
  if (selectedStore.length > 0) {
    const rerun = `bun test/engine-parity/multi-writer-bar.ts --arms ${selectedStore.join(',')}`;
    const log = (name: string) => join(opts.logDir, `store-${name}.log`);
    const markAll = (value: string) => { for (const arm of selectedStore) for (const row of entries) merge(cells, `${row.id}:${arm}`, value); };
    const build: BarStep = { name: 'cargo test --no-run (build the store conformance tests)', code: 'build_failed', cmd: cmds.storeBuild(), cwd: join(repo, 'rust'), timeoutMs: timeouts.build };
    writeFileSync(log('build'), '');
    if ((await runStep(build, log('build'), rerun)) !== 'ok') {
      markAll('ERROR');
    } else {
      writeFileSync(log('list'), '');
      const listStep: BarStep = { name: 'cargo test -- --list --ignored (list the pending store tests)', code: 'store_run_failed', cmd: cmds.storeList(), cwd: join(repo, 'rust'), timeoutMs: timeouts.store };
      if ((await runStep(listStep, log('list'), rerun)) !== 'ok') {
        markAll('ERROR');
      } else {
        const ignored = parseIgnoredList(readText(log('list')) ?? '');
        // Every declared pending name must be an `#[ignore]`d test of the file, whatever the row's cells say: a runnable test with
        // a pending twin (a plain cNN plus cNN_multi_writer) is checked here too, and a missing twin fails the bar.
        const absentPending = new Map<string, string[]>();
        for (const row of entries) {
          const absent = row.storeTests.pending.filter((n) => !ignored.has(n));
          if (absent.length === 0) continue;
          absentPending.set(row.id, absent);
          failures.push({ code: 'store_pending_missing', message: `[store] ${row.id}: the matrix lists pending store tests that are not \`#[ignore]\`d tests of ${STORE_TEST_TARGET}: ${absent.join(', ')}`, log: log('list'), rerun });
        }
        for (const arm of selectedStore) {
          const runnable = unique(entries.filter((r) => r.cells[arm].status === 'runs').flatMap((r) => [...r.storeTests.runnable]));
          const armLog = log(`run-${arm}`);
          for (const row of entries) {
            const status = row.cells[arm].status;
            if (status === 'n/a') { merge(cells, `${row.id}:${arm}`, 'n/a'); continue; }
            const names = status === 'runs' ? row.storeTests.runnable : row.storeTests.pending;
            if (names.length === 0) {
              failures.push({ code: 'store_cell_empty', message: `[${arm}] ${row.id}: the cell is ${status} but the matrix names no ${status === 'runs' ? 'runnable' : 'pending'} store test`, rerun });
              merge(cells, `${row.id}:${arm}`, 'MISSING');
            } else if (status === 'pending') {
              merge(cells, `${row.id}:${arm}`, absentPending.has(row.id) ? 'MISSING' : 'pending');
            }
          }
          if (runnable.length === 0) continue;
          writeFileSync(armLog, '');
          const step: BarStep = { name: `cargo test --exact (${arm}: ${runnable.length} runnable store tests)`, code: 'store_run_failed', cmd: cmds.storeRun(runnable),
            cwd: join(repo, 'rust'), env: STORE_ENV[arm], timeoutMs: timeouts.store };
          const ran = await runStep(step, armLog, rerun);
          if (ran === 'abnormal') {
            for (const row of entries) if (row.cells[arm].status === 'runs') merge(cells, `${row.id}:${arm}`, 'ERROR');
            continue;
          }
          const parsed = parseStoreRun(readText(armLog) ?? '');
          const verdict = new Map<string, string>();
          for (const name of runnable) {
            const got = parsed.results.get(name);
            if (got === undefined) { failures.push({ code: 'store_result_missing', message: `[${arm}] no result line for ${name}`, log: armLog, rerun }); verdict.set(name, 'MISSING'); continue; }
            if (got.length > 1) { failures.push({ code: 'store_result_unexpected', message: `[${arm}] ${name} reported ${got.length} times`, log: armLog, rerun }); verdict.set(name, 'FAIL'); continue; }
            if (got[0] === 'FAILED') { failures.push({ code: 'store_case_failed', message: `[${arm}] ${name} failed`, log: armLog, rerun }); verdict.set(name, 'FAIL'); continue; }
            if (got[0] === 'ignored') { failures.push({ code: 'store_result_unexpected', message: `[${arm}] ${name} is #[ignore]d, so it did not run, but the matrix says it is runnable`, log: armLog, rerun }); verdict.set(name, 'FAIL'); continue; }
            verdict.set(name, 'pass');
          }
          if (parsed.running !== runnable.length && ![...verdict.values()].includes('MISSING')) {
            failures.push({ code: 'store_result_unexpected', message: `[${arm}] cargo reported ${parsed.running ?? 'no'} tests running, the matrix named ${runnable.length}`, log: armLog, rerun });
          }
          for (const name of parsed.results.keys()) {
            if (!runnable.includes(name)) failures.push({ code: 'store_result_unexpected', message: `[${arm}] cargo ran ${name}, which the matrix did not name`, log: armLog, rerun });
          }
          for (const row of entries) {
            if (row.cells[arm].status !== 'runs') continue;
            const parts = row.storeTests.runnable.map((n) => verdict.get(n) ?? 'MISSING');
            const worst = parts.length === 0 ? 'MISSING' : parts.reduce((a, b) => (WORSE.indexOf(b) < WORSE.indexOf(a) ? b : a));
            merge(cells, `${row.id}:${arm}`, worst);
          }
        }
      }
    }
  }

  // The table, for the selected arms.
  const shown = BAR_ARMS.filter((a) => selected.has(a));
  const header = ['case', ...shown, 'reference'];
  const rows = entries.map((row) => [row.id, ...shown.map((arm) => cells.get(`${row.id}:${arm}`) ?? '-'), row.reference]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  const count = (text: string, reference?: MwEntry['reference']) => entries.reduce((n, row) => n + shown.filter((arm) => cells.get(`${row.id}:${arm}`) === text && (reference === undefined || row.reference === reference)).length, 0);
  const summary = `cells: ${count('pass', 'compare')} pass (compare), ${count('pass', 'standalone')} pass (standalone, invariant only), ${count('pending')} pending, ${count('n/a')} n/a, `
    + `${count('FAIL')} fail, ${count('PREREQ')} prerequisite missing, ${count('MISSING')} missing, ${count('ERROR')} error`;
  const table = [line(header), ...rows.map(line), '', summary, `failures: ${failures.length}`].join('\n');
  return { failures, cells, table, logDir: opts.logDir };
}

/** Print each failure as `code message / log / rerun` lines, the format the CLI writes to stderr. */
export function renderFailures(failures: readonly BarFailure[]): string {
  return failures.map((f) => [`multi-writer bar FAILED [${f.code}] ${f.message}`, ...(f.log ? [`  log: ${f.log}`] : []), `  rerun: ${f.rerun}`].join('\n')).join('\n');
}

export function parseArms(arg: string | undefined): BarArm[] | string {
  if (arg === undefined) return [...BAR_ARMS];
  // `rust-mu` is shorthand for both routes to the multi-user switch.
  const arms = arg.split(',').map((a) => a.trim()).filter((a) => a !== '').flatMap((a) => (a === 'rust-mu' ? ['rust-mu-env', 'rust-mu-config'] : [a]));
  const unknown = arms.filter((a) => !(BAR_ARMS as readonly string[]).includes(a));
  if (arms.length === 0 || unknown.length > 0) return `unknown arm ${unknown.join(', ') || '(none given)'}; arms are ${BAR_ARMS.join(', ')} (rust-mu means the two rust-mu routes)`;
  return unique(arms) as BarArm[];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const arms = parseArms(flag('--arms'));
  const usage = (message: string): never => {
    process.stderr.write(`multi-writer bar FAILED [usage] ${message}\n  rerun: bun test/engine-parity/multi-writer-bar.ts --arms ${BAR_ARMS.join(',')}\n`);
    process.exit(1);
  };
  if (typeof arms === 'string') usage(arms);
  if (MW_CASES.length === 0) usage('the support matrix has no rows (test/engine-parity/multi-writer-cases.ts), so there is nothing to run');
  const timeoutMs = flag('--timeout-ms') === undefined ? undefined : Number(flag('--timeout-ms'));
  if (timeoutMs !== undefined && !(timeoutMs > 0)) usage('--timeout-ms needs a positive number');
  const logDir = flag('--log-dir') ?? mkdtempSync(join(tmpdir(), 'gbrain-mw-bar-'));
  const report = await runBar({ arms: arms as BarArm[], matrix: MW_CASES, env: process.env, logDir,
    ...(timeoutMs === undefined ? {} : { timeouts: { setup: timeoutMs, build: timeoutMs, engine: timeoutMs, store: timeoutMs } }) });
  process.stdout.write(`${report.table}\nlogs: ${report.logDir}\n`);
  if (report.failures.length > 0) {
    process.stderr.write(`${renderFailures(report.failures)}\n`);
    process.exit(1);
  }
}
