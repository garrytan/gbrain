/**
 * The multi-writer support matrix (multi-writer-cases.ts) and the engine conformance file
 * (multi-writer-conformance.test.ts) must agree: one row per case in order, the design table's titles, one parityTest per
 * case whose name, `methods` and `mwCase` are the row's, and cells that follow the design's rules. The Rust store tests
 * the matrix names must exist in multi_writer_conformance.rs, plain where the matrix says they run and `#[ignore]` where
 * it says they are pending.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the matrix is the one place that says where each case runs; the harness, `coverage.ts` and the bar script
 *    read it, so the case file and the matrix can never drift apart without this test failing.
 *  - Regression: a case renamed or dropped in one file only, a `methods` list that no longer matches the members the
 *    matrix reports, a title that stops matching the design table the shared evals suite uses, or a pending case turned
 *    into `runs` on one arm and not its twin arm.
 *  - Why existing coverage misses it: the conformance cases run or skip on their own; nothing relates their declarations
 *    to the matrix.
 *  - Seam: none. The matrix is imported; the case file, the design note and the Rust suite are parsed as text (the
 *    TypeScript compiler API for the case file, as coverage.ts does for the parity files).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  acknowledgedWriteViolations, crashBody, crashKey, crashSlug, stressBody, stressKey, stressSlug, stressViolations,
  type CrashObservation, type StressObservation,
} from './engine-parity/multi-writer-support.ts';
import { MW_ARMS, MW_CASES, MW_CASE_IDS, MW_ENGINE_ARMS, MW_STORE_ARMS, MW_VARIANT_IDS, mwCase, mwCell, mwVariant, mwVariantCell } from './engine-parity/multi-writer-cases.ts';

const REPO = join(import.meta.dir, '..');
// test-reads-source-ok[structural]: the matrix must agree with the case file, the design table and the Rust suite it names.
const read = (...path: string[]) => readFileSync(join(REPO, ...path), 'utf8');

/** The owners a pending cell may name (the lane names every pending reason uses). */
const OWNERS = new Set(['L1 optimistic transactions', 'L2 commit log', 'L3 server', 'L4 access', 'L5 hosts', 'L1 sim seam']);

interface Declaration { name: string; methods: string[]; mwCase: string | null }

/** Every `parityTest(name, { methods: [...], mwCase: '...' }, fn)` of the conformance file, in source order. */
function declarations(): Declaration[] {
  const path = join(import.meta.dir, 'engine-parity', 'multi-writer-conformance.test.ts');
  const sf = ts.createSourceFile(path, read('test', 'engine-parity', 'multi-writer-conformance.test.ts'), ts.ScriptTarget.Latest, true);
  const out: Declaration[] = [];
  const literal = (node: ts.Node | undefined): string => {
    if (node === undefined || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) throw new Error('parityTest name, methods and mwCase must be string literals');
    return node.text;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'parityTest') {
      const [nameArg, optsArg] = node.arguments;
      if (!optsArg || !ts.isObjectLiteralExpression(optsArg)) throw new Error('parityTest needs an inline options object');
      const prop = (key: string) => optsArg.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key);
      const methods = prop('methods')?.initializer;
      if (!methods || !ts.isArrayLiteralExpression(methods)) throw new Error('parityTest needs an inline { methods: [...] } array literal');
      const mw = prop('mwCase');
      out.push({ name: literal(nameArg), methods: methods.elements.map(e => literal(e)), mwCase: mw ? literal(mw.initializer) : null });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The design table's case column: `C01 same-page writers lose no update`, by id. */
function designTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of read('docs', 'designs', 'rust-engine', 'multi-user-server.md').split('\n')) {
    const m = /^\| (C\d\d) ([^|]+?) \|/.exec(line);
    if (m) titles.set(m[1]!, m[2]!);
  }
  return titles;
}

/** The Rust suite's test names, and whether each is `#[ignore]`d. */
function rustTests(): Map<string, { ignored: boolean }> {
  const lines = read('rust', 'crates', 'gbrain-store', 'tests', 'multi_writer_conformance.rs').split('\n');
  const tests = new Map<string, { ignored: boolean }>();
  lines.forEach((line, i) => {
    const m = /^fn (c\d\d_\w+)\(\)/.exec(line);
    if (m) tests.set(m[1]!, { ignored: lines.slice(Math.max(0, i - 3), i).some(l => l.startsWith('#[ignore')) });
  });
  return tests;
}

describe('multi-writer support matrix', () => {
  test('has one row per case id, once each, in order', () => {
    expect(MW_CASES.map(c => c.id)).toEqual([...MW_CASE_IDS]);
    expect(MW_CASES).toHaveLength(22);
  });

  test('every row\'s title is the design table\'s, verbatim', () => {
    const design = designTitles();
    expect([...design.keys()]).toEqual([...MW_CASE_IDS]);
    expect(MW_CASES.map(c => [c.id, c.title])).toEqual([...design.entries()]);
  });

  test('the conformance file declares one parityTest per case, in order, named id + title, with the row\'s members and mwCase', () => {
    const found = declarations();
    // A variant's parityTest follows its row's, as `<id>.<variant>`.
    expect(found.map(d => d.mwCase)).toEqual(MW_CASES.flatMap(c => [c.id, ...(c.variants ?? []).map(v => v.id)]));
    for (const row of MW_CASES) {
      const d = found.find(x => x.mwCase === row.id)!;
      expect(d.name, `${row.id}: the name must start with the id and the matrix title`).toBe(`${row.id} ${row.title}`);
      expect(d.methods, `${row.id}: methods must equal the row's members`).toEqual([...row.members]);
      expect(new Set(d.methods).size, `${row.id}: a member is listed twice`).toBe(d.methods.length);
    }
  });

  test('a variant is a dotted id of one row, named after the row\'s id and title, with its own members and engine cells', () => {
    const found = declarations();
    const variants = MW_CASES.flatMap(c => c.variants ?? []);
    expect(variants.map(v => v.id)).toEqual([...MW_VARIANT_IDS]);
    for (const v of variants) {
      const row = mwCase(v.of);
      expect(v.id.startsWith(`${v.of}.`), `${v.id} is a suffix of ${v.of}`).toBe(true);
      const d = found.find(x => x.mwCase === v.id)!;
      expect(d.name, `${v.id}: the name starts with the row's id and title, then the variant title`).toBe(`${row.id} ${row.title}: ${v.title}`);
      expect(d.methods, `${v.id}: methods must equal the variant's members`).toEqual([...v.members]);
      expect(Object.keys(v.cells).sort()).toEqual([...MW_ENGINE_ARMS].sort());
      for (const arm of MW_ENGINE_ARMS) {
        const cell = mwVariantCell(v.id, arm);
        if (cell.status === 'pending') expect(OWNERS.has(cell.owner), `${v.id} ${arm}`).toBe(true);
      }
    }
    // C06.partition: the cycle-lock fence runs on the SQL arms and the single-writer Rust arm; the store lease fence waits for the hosts work.
    for (const arm of ['pglite', 'postgres', 'rust'] as const) expect(mwVariantCell('C06.partition', arm).status, arm).toBe('runs');
    // With the hosts work merged the host fence runs on rust-mu too (verified on both routes with the switch on).
    expect(mwVariantCell('C06.partition', 'rust-mu').status).toBe('runs');
    expect(mwVariant('C06.partition').reference).toBe('compare');
  });

  test('every row names its design operation and invariant, and has a cell for every arm', () => {
    for (const row of MW_CASES) {
      expect(row.operation.length, `${row.id} operation`).toBeGreaterThan(0);
      expect(row.invariant.length, `${row.id} invariant`).toBeGreaterThan(0);
      expect(Object.keys(row.cells).sort(), row.id).toEqual([...MW_ARMS].sort());
      for (const arm of MW_ARMS) {
        const cell = mwCell(row.id, arm);
        if (cell.status === 'pending') {
          expect(OWNERS.has(cell.owner), `${row.id} ${arm}: owner "${cell.owner}" is not a lane name`).toBe(true);
          expect(cell.why.length, `${row.id} ${arm}: a pending cell says what it waits for`).toBeGreaterThan(0);
        }
        if (cell.status === 'n/a') expect(cell.why.length, `${row.id} ${arm}: an n/a cell says why`).toBeGreaterThan(0);
      }
    }
  });

  test('the design rules hold: C11 and the C21 token are pending everywhere, C13, C17 and C21 are n/a on PGLite, C22 needs the commit log, which only rust-mu keeps', () => {
    for (const arm of MW_ENGINE_ARMS) expect(mwCell('C11', arm).status, `C11 ${arm}`).toBe('pending');
    // C22: a SQL engine and a Rust engine with the log off keep no commit log (they refuse commit_log), so n/a; rust-mu keeps one and runs it.
    // (Plain checks, not asymmetric matchers: bun's toMatchObject replaces the checked field of the shared matrix with the matcher.)
    for (const arm of ['pglite', 'postgres', 'rust'] as const) {
      const cell = mwCell('C22', arm);
      expect(cell.status, `C22 ${arm}`).toBe('n/a');
      expect('why' in cell ? cell.why : '', `C22 ${arm} says why`).toMatch(/engine_capability_missing, reason commit_log/);
    }
    expect(mwCell('C22', 'rust-mu').status).toBe('runs');
    expect(mwCase('C22').needs).toBe('commit_log');
    expect(mwCase('C22').members).toEqual(['putPage', 'transaction', 'readCommitLog', 'lastCommitPosition']);
    for (const arm of MW_ENGINE_ARMS.filter(a => a !== 'pglite')) expect(mwCell('C21', arm).status, `C21 ${arm}`).toBe('pending');
    for (const id of ['C13', 'C17', 'C21'] as const) expect(mwCell(id, 'pglite').status, `${id} pglite`).toBe('n/a');
    // C16 drives the Rust commit-log format upgrade: n/a on plain Rust, runs on rust-mu; PostgreSQL has no scenario yet (pending).
    expect(mwCell('C16', 'postgres').status).toBe('pending');
    expect(mwCell('C16', 'rust').status).toBe('n/a');
    expect(mwCell('C16', 'rust-mu').status).toBe('runs');
    expect(mwCase('C16').needs).toBe('commit_log');
    // The cases that need an optimistic second writer need the capability the engine itself reports. C17 does not: a second
    // opener that becomes a client of the owner is the owner socket, which Rust has without optimistic transactions.
    for (const id of ['C13', 'C21'] as const) expect(mwCase(id).needs, id).toBe('multi_writer');
    expect(mwCase('C17').needs).toBeUndefined();
  });

  // Rows whose scenario exists only in multi-user mode: plain Rust is n/a, rust-mu runs (the log, its upgrade, the owner handover).
  const MULTIUSER_ONLY = ['C16', 'C17', 'C22'];

  test('rust-mu runs what rust runs and waits on the same owner where rust waits; the multi-user-only rows are n/a on plain Rust and run on rust-mu', () => {
    for (const id of MULTIUSER_ONLY) {
      const plain = mwCell(id as 'C16', 'rust');
      expect(plain.status, `${id} rust`).toBe('n/a');
      expect('why' in plain ? plain.why : '', `${id} rust says why`).toMatch(/multi-user|commit log|calls in flight/);
      expect(mwCell(id as 'C16', 'rust-mu').status, `${id} rust-mu`).toBe('runs');
    }
    for (const row of MW_CASES.filter(c => !MULTIUSER_ONLY.includes(c.id))) {
      const rust = row.cells.rust;
      const mu = row.cells['rust-mu'];
      if (rust.status === 'runs') expect(mu.status, `${row.id}: multi-user on must answer what single-writer answers`).toBe('runs');
      else if (rust.status === 'pending') expect(mu, `${row.id}`).toMatchObject({ status: 'pending', owner: rust.owner });
      else expect(mu.status, row.id).toBe('n/a');
    }
  });

  test('the single-writer Rust arm runs every case whose invariant holds there; the rest wait for a second connection, a new rule, or the multi-writer work', () => {
    expect(MW_CASES.filter(c => c.cells.rust.status !== 'runs').map(c => [c.id, c.cells.rust.status])).toEqual([
      ['C11', 'pending'], ['C13', 'pending'], ['C16', 'n/a'], ['C17', 'n/a'], ['C18', 'pending'], ['C21', 'pending'], ['C22', 'n/a'],
    ]);
  });

  test('C18 and C19 run writer processes: n/a on in-memory PGLite, and C19 (a real kill) runs on Postgres and on the Rust arm that owns its brain', () => {
    for (const id of ['C18', 'C19'] as const) {
      expect(mwCell(id, 'pglite').status, `${id} pglite`).toBe('n/a');
      expect(mwCell(id, 'postgres').status, `${id} postgres`).toBe('runs');
    }
    expect(mwCell('C19', 'rust').status).toBe('runs');
    // C18 on Rust: the eight processes run and the seven clients are refused admitJob; the reason names the refusal and its cause.
    for (const arm of ['rust', 'rust-mu'] as const) {
      const cell = mwCell('C18', arm);
      expect(cell.status, `C18 ${arm}`).toBe('pending');
      expect(cell.status === 'pending' ? cell.owner : '', `C18 ${arm} owner`).toBe('L3 server');
      expect(cell.status === 'pending' ? cell.why : '', `C18 ${arm} reason`).toMatch(/admitJob.*minion_queue.*functions/);
    }
  });

  test('the C19 check rejects a missing and a duplicated acknowledged write, and accepts a brain that kept them once', () => {
    const acknowledged = [0, 1, 2, 3];
    const whole = (): { jobRowsByKey: Map<string, number>; pageBodies: Map<string, string> } => ({
      jobRowsByKey: new Map(acknowledged.map(n => [crashKey(n), 1] as const)),
      pageBodies: new Map(acknowledged.map(n => [crashSlug(n), crashBody(n)] as const)),
    });
    const seen = (over: Partial<CrashObservation> = {}): CrashObservation => ({ acknowledged, ...whole(), ...over });
    // Control: a brain that kept every acknowledged write once, and one write that was in flight when the writer died (a row, no ack).
    const inFlight = seen(); inFlight.jobRowsByKey = new Map([...inFlight.jobRowsByKey, [crashKey(4), 1]]); inFlight.pageBodies = new Map([...inFlight.pageBodies, [crashSlug(4), crashBody(4)]]);
    expect(acknowledgedWriteViolations(seen())).toEqual([]);
    expect(acknowledgedWriteViolations(inFlight)).toEqual([]);
    // Missing: the job row, the page, or the page's body of an acknowledged write is gone.
    const noJob = whole(); noJob.jobRowsByKey.delete(crashKey(2));
    expect(acknowledgedWriteViolations(seen(noJob))).toEqual(['acknowledged write 2: its job row is missing']);
    const noPage = whole(); noPage.pageBodies.delete(crashSlug(1));
    expect(acknowledgedWriteViolations(seen(noPage))).toEqual(['acknowledged write 1: its page is missing']);
    const wrongBody = whole(); wrongBody.pageBodies.set(crashSlug(3), 'something else');
    expect(acknowledgedWriteViolations(seen(wrongBody))).toEqual(['acknowledged write 3: its page holds another body']);
    // Duplicated: a job under one acknowledged key has two rows (a replay that inserted again), or an ack was printed twice.
    const twice = whole(); twice.jobRowsByKey.set(crashKey(0), 2);
    expect(acknowledgedWriteViolations(seen(twice))).toEqual(['acknowledged write 0: its job has 2 rows']);
    expect(acknowledgedWriteViolations(seen({ acknowledged: [0, 1, 1, 2, 3] }))).toEqual(['write 1 was acknowledged 2 times']);
    // A write that was never acknowledged may exist, but not twice.
    const doubleUnacked = seen(); doubleUnacked.jobRowsByKey = new Map([...doubleUnacked.jobRowsByKey, [crashKey(9), 2]]);
    expect(acknowledgedWriteViolations(doubleUnacked)).toEqual([`request key ${crashKey(9)} has 2 rows`]);
  });

  test('the C18 check rejects a run that did not overlap, a wrong page body, a missing page, stray claim ids and a doubled key, and accepts a whole run', () => {
    type Mutable = { reports: StressObservation['reports'][number][]; pageBodies: Map<string, string>; jobIdsByKey: Map<string, number[]> };
    const whole = (): Mutable => {
      const reports = Array.from({ length: 8 }, (_, p) => ({
        startedAt: 1_000 + p, finishedAt: 2_000 + p,
        results: Array.from({ length: 8 }, (_, w) => { const id = p * 8 + w; return { id, pages: [stressSlug(id, 0), stressSlug(id, 1)], refused: [] as string[], job: 500 + id }; }),
      }));
      const pageBodies = new Map<string, string>();
      for (let id = 0; id < 64; id++) for (let r = 0; r < 2; r++) pageBodies.set(stressSlug(id, r), stressBody(id, r));
      const jobIdsByKey = new Map<string, number[]>(Array.from({ length: 64 }, (_, id) => [stressKey(id), [500 + id]] as const));
      return { reports, pageBodies, jobIdsByKey };
    };
    expect(stressViolations(whole())).toEqual([]);
    // The old check accepted each of these: pages only had to exist, claimed ids only had to be 64 distinct numbers.
    const apart = whole(); apart.reports[0]!.finishedAt = 1_003; // the first process finished before the last one started
    expect(stressViolations(apart)).toEqual(['the loads did not overlap: one process finished before another started']);
    const wrongBody = whole(); wrongBody.pageBodies.set(stressSlug(7, 1), 'body of another writer');
    expect(stressViolations(wrongBody)).toEqual([`${stressSlug(7, 1)}: its body is wrong`]);
    const noPage = whole(); noPage.pageBodies.delete(stressSlug(63, 0));
    expect(stressViolations(noPage)).toEqual([`${stressSlug(63, 0)}: the page is missing`]);
    const strayClaims = whole(); strayClaims.reports[1]!.results[0]!.job = 9_999; // distinct, but not a stored job
    expect(stressViolations(strayClaims)).toEqual(['the claimed ids are not the stored jobs\' ids']);
    const twice = whole(); twice.reports[2]!.results[0]!.job = 500; // a job claimed by two writers
    expect(stressViolations(twice)).toContain('a job was claimed twice');
    const doubled = whole(); doubled.jobIdsByKey.set(stressKey(3), [503, 777]);
    expect(stressViolations(doubled)).toEqual([`request key ${stressKey(3)} has 2 rows`, 'the claimed ids are not the stored jobs\' ids']);
    const busy = whole(); busy.reports[3]!.results[1]!.refused = ['owner_busy'];
    expect(stressViolations(busy)).toEqual([`writer ${3 * 8 + 1} was refused (owner_busy): a busy error`]);
  });

  test('C19 and C18 say what they do not prove, so a client-crash case is never read as a database-server crash test', () => {
    expect(mwCase('C19').scope).toMatch(/not a database-server crash/);
    expect(mwCase('C19').scope).toMatch(/Postgres durability \(WAL, fsync\) is not exercised/);
    expect(mwCase('C18').scope).toMatch(/Postgres runs/);
    expect(mwCase('C18').scope).toMatch(/Rust stays pending/);
    const header = read('test', 'engine-parity', 'multi-writer-conformance.test.ts');
    expect(header).toMatch(/NOT a database-server crash test/);
  });

  test('C21 stays pending on every engine that could run it, naming the missing typed member', () => {
    for (const arm of ['postgres', 'rust', 'rust-mu'] as const) {
      const cell = mwCell('C21', arm);
      expect(cell.status, `C21 ${arm}`).toBe('pending');
      expect(cell.status === 'pending' ? cell.owner : '', `C21 ${arm} owner`).toBe('L3 server');
      expect(cell.status === 'pending' ? cell.why : '', `C21 ${arm} reason`).toMatch(/no typed read-with-position member.*min_position/);
    }
  });

  test('a compared case has an SQL arm that runs it (or none runs it yet), and the standalone ones are the cases the arms cannot all run alike', () => {
    for (const row of MW_CASES) {
      const runsOnAnEngine = MW_ENGINE_ARMS.some(arm => row.cells[arm].status === 'runs');
      const referenceable = (['pglite', 'postgres'] as const).filter(arm => row.cells[arm].status === 'runs');
      // C11 is pending on every arm: it is compared once an arm runs it, so a reference must exist by then.
      if (row.reference === 'compare' && runsOnAnEngine) expect(referenceable.length, `${row.id} compares against an arm that runs it`).toBeGreaterThan(0);
    }
    // C13, C16, C17, C18, C19, C21, C22 need a second connection, spread their load over connections, or run on no arm yet.
    expect(MW_CASES.filter(c => c.reference === 'standalone').map(c => c.id)).toEqual(['C13', 'C16', 'C17', 'C18', 'C19', 'C21', 'C22']);
  });

  test('the Rust store tests the matrix names exist: plain where the case runs, ignored where it is pending', () => {
    const tests = rustTests();
    for (const row of MW_CASES) {
      for (const name of row.storeTests.runnable) expect(tests.get(name), `${row.id}: ${name} must exist`).toEqual({ ignored: false });
      for (const name of row.storeTests.pending) expect(tests.get(name), `${row.id}: ${name} must exist`).toEqual({ ignored: true });
      for (const arm of MW_STORE_ARMS) {
        // A store cell runs when a plain test exists, and is pending with an owner when only the ignored twin does.
        expect(row.cells[arm].status, `${row.id} ${arm}`).toBe(row.storeTests.runnable.length > 0 ? 'runs' : 'pending');
      }
    }
    // Every plain or ignored cNN test of the suite belongs to exactly one row.
    const named = new Set(MW_CASES.flatMap(c => [...c.storeTests.runnable, ...c.storeTests.pending]));
    // `c19_child_writer` is not a case: it is the child process C19 re-runs and kills (ignored with reason c19_child).
    const helpers = new Set(['c19_child_writer']);
    expect([...tests.keys()].filter(name => !named.has(name) && !helpers.has(name)), 'a Rust test is not in the matrix').toEqual([]);
  });
});
