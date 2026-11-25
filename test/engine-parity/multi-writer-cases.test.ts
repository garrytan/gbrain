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
import { MW_ARMS, MW_CASES, MW_CASE_IDS, MW_ENGINE_ARMS, MW_STORE_ARMS, MW_VARIANT_IDS, mwCase, mwCell, mwVariant, mwVariantCell } from './multi-writer-cases.ts';

const REPO = join(import.meta.dir, '..', '..');
// test-reads-source-ok[structural]: the matrix must agree with the case file, the design table and the Rust suite it names.
const read = (...path: string[]) => readFileSync(join(REPO, ...path), 'utf8');

/** The owners a pending cell may name (the lane names every pending reason uses). */
const OWNERS = new Set(['L1 optimistic transactions', 'L2 commit log', 'L3 server', 'L4 access', 'L5 hosts', 'L1 sim seam']);

interface Declaration { name: string; methods: string[]; mwCase: string | null }

/** Every `parityTest(name, { methods: [...], mwCase: '...' }, fn)` of the conformance file, in source order. */
function declarations(): Declaration[] {
  const path = join(import.meta.dir, 'multi-writer-conformance.test.ts');
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
    expect(mwVariantCell('C06.partition', 'rust-mu')).toMatchObject({ status: 'pending', owner: 'L5 hosts' });
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

  test('the design rules hold: C11 and the C21 token are pending everywhere, C13, C17 and C21 are n/a on PGLite, C22 waits on the commit log', () => {
    for (const arm of MW_ENGINE_ARMS) {
      expect(mwCell('C11', arm).status, `C11 ${arm}`).toBe('pending');
      expect(mwCell('C22', arm), `C22 ${arm}`).toMatchObject({ status: 'pending', owner: 'L2 commit log' });
    }
    for (const arm of MW_ENGINE_ARMS.filter(a => a !== 'pglite')) expect(mwCell('C21', arm).status, `C21 ${arm}`).toBe('pending');
    for (const id of ['C13', 'C17', 'C21'] as const) expect(mwCell(id, 'pglite').status, `${id} pglite`).toBe('n/a');
    // C16's engine cells name the observation that is missing, or stay pending; none claims an upgrade it cannot see.
    for (const arm of MW_ENGINE_ARMS.filter(a => a !== 'pglite')) expect(mwCell('C16', arm).status, `C16 ${arm}`).toBe('pending');
    // The cases that need two connections need the capability the engine itself reports.
    for (const id of ['C13', 'C17', 'C21'] as const) expect(mwCase(id).needs, id).toBe('multi_writer');
  });

  test('rust-mu runs what rust runs and waits on the same owner where rust waits', () => {
    for (const row of MW_CASES) {
      const rust = row.cells.rust;
      const mu = row.cells['rust-mu'];
      if (rust.status === 'runs') expect(mu.status, `${row.id}: multi-user on must answer what single-writer answers`).toBe('runs');
      else if (rust.status === 'pending') expect(mu, `${row.id}`).toMatchObject({ status: 'pending', owner: rust.owner });
      else expect(mu.status, row.id).toBe('n/a');
    }
  });

  test('the single-writer Rust arm runs every case whose invariant holds there; the rest wait for a second connection, a new rule, or the multi-writer work', () => {
    expect(MW_CASES.filter(c => c.cells.rust.status !== 'runs').map(c => [c.id, c.cells.rust.status])).toEqual([
      ['C11', 'pending'], ['C13', 'pending'], ['C16', 'pending'], ['C17', 'pending'], ['C18', 'pending'], ['C19', 'pending'], ['C21', 'pending'], ['C22', 'pending'],
    ]);
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
    expect([...tests.keys()].filter(name => !named.has(name)), 'a Rust test is not in the matrix').toEqual([]);
  });
});
