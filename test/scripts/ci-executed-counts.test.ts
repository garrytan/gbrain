import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildSide, compare, loadReceiptDir, parseDeltas, parseJUnit, missingKeySkips, canonicalTestName, render, testBackend,
  DELTA_COLUMNS, JUnitError,
} from '../../scripts/ci-executed-counts.ts';

const REPO = join(import.meta.dir, '../..');
const HEADER = DELTA_COLUMNS.join('\t');

type Case = { file: string; name: string; describe?: string[]; status?: 'pass' | 'fail' | 'skip' | 'todo' };

/** Bun-shaped JUnit: one file-level testsuite per file, nested describe suites. */
function junit(cases: Case[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const files = [...new Set(cases.map(c => c.file))];
  const body = files.map(file => {
    const inner = cases.filter(c => c.file === file).map(c => {
      const child = c.status === 'fail' ? '<failure type="AssertionError" message="boom" />'
        : c.status === 'skip' ? '<skipped />' : c.status === 'todo' ? '<skipped message="TODO" />' : '';
      let xml = `<testcase name="${esc(c.name)}" classname="" file="${file}">${child}</testcase>`;
      for (const d of [...(c.describe ?? [])].reverse()) xml = `<testsuite name="${esc(d)}" file="${file}">${xml}</testsuite>`;
      return xml;
    }).join('\n');
    return `  <testsuite name="${file}" file="${file}">\n${inner}\n  </testsuite>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${cases.length}">\n${body}\n</testsuites>\n`;
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gbrain-x2-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

interface ReceiptSpec {
  artifact: string; id: string; lane?: string; kind?: string; shard?: number; of?: number; arm?: string;
  files: string[]; cases?: Case[]; junit?: string | null; exit?: number | null; runId?: string; attempt?: number; started?: number;
  extra?: string[];
}
function writeReceipt(side: string, spec: ReceiptSpec): void {
  const dir = join(root, side, spec.artifact);
  mkdirSync(dir, { recursive: true });
  const meta = [
    'version=1', `lane=${spec.lane ?? 'unit'}`, `kind=${spec.kind ?? 'primary'}`, `tag=${spec.id}`,
    `shard=${spec.shard ?? ''}`, `of=${spec.of ?? ''}`, `arm=${spec.arm ?? ''}`, 'sha=abc123', `root=/repo`,
    `run_id=${spec.runId ?? ''}`, `run_attempt=${spec.attempt ?? ''}`, 'job=test', `started=${spec.started ?? 100}`,
    ...(spec.extra ?? []),
  ];
  if (spec.exit !== null) meta.push(`exit=${spec.exit ?? 0}`);
  writeFileSync(join(dir, `${spec.id}.receipt`), `${meta.join('\n')}\n`);
  writeFileSync(join(dir, `${spec.id}.files`), spec.files.map(f => `${f}\n`).join(''));
  if (spec.junit !== null) writeFileSync(join(dir, `${spec.id}.junit.xml`), spec.junit ?? junit(spec.cases ?? []));
}
const side = (name: string, expect?: Map<string, number>) => buildSide(name, loadReceiptDir(join(root, name)), expect);
const noDeltas = { rows: [], errors: [] };

const A: Case = { file: 'test/a.test.ts', name: 'adds', describe: ['math'] };
const B: Case = { file: 'test/a.test.ts', name: 'subtracts', describe: ['math'] };
const C: Case = { file: 'test/a.test.ts', name: 'multiplies', describe: ['math'] };

describe('parseJUnit', () => {
  test('reads Bun nesting, skips, todos and failures as one identity per testcase', () => {
    const cases = parseJUnit(junit([
      { file: 'test/x.test.ts', name: 'ok', describe: ['outer', 'inner'] },
      { file: 'test/x.test.ts', name: 'later', status: 'skip' },
      { file: 'test/x.test.ts', name: 'planned', status: 'todo' },
      { file: 'test/y.test.ts', name: 'broken', status: 'fail' },
    ]));
    expect(cases).toEqual([
      { file: 'test/x.test.ts', test: 'outer > inner > ok', status: 'pass' },
      { file: 'test/x.test.ts', test: 'later', status: 'skip' },
      { file: 'test/x.test.ts', test: 'planned', status: 'todo' },
      { file: 'test/y.test.ts', test: 'broken', status: 'fail' },
    ]);
  });

  test('a truncated or miscounted report throws instead of reading as fewer tests', () => {
    const full = junit([A, B]);
    expect(() => parseJUnit(full.slice(0, full.indexOf('subtracts')))).toThrow(JUnitError);
    expect(() => parseJUnit(full.replace('</testsuites>', ''))).toThrow(/truncated/);
    expect(() => parseJUnit(full.replace('tests="2"', 'tests="3"'))).toThrow(/declares 3 tests/);
  });

  test('unstable fragments canonicalize so reruns keep one identity; fixed dates stay', () => {
    expect(canonicalTestName('writes /tmp/gbrain-x-AbC123/out as 3f2b1c4d-1111-2222-3333-444455556666 on 2026-10-04T10:00:00Z'))
      .toBe('writes <tmp> as <uuid> on 2026-10-04T10:00:00Z');
  });

  test('repeated names in one file (test.each templates) stay distinct identities by occurrence', () => {
    const each = (status?: 'skip'): Case => ({ file: 'test/a.test.ts', name: 'case %s', status });
    writeReceipt('base', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [each(), each(), each()] });
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [each(), each()] });
    expect([...side('base').identities.values()].map(i => i.test)).toEqual(['case %s', 'case %s [#2]', 'case %s [#3]']);
    expect(compare(side('head'), side('base'), noDeltas).drops.map(d => d.identity.test)).toEqual(['case %s [#3]']);
  });
});

describe('identity comparison', () => {
  test('identical identity sets pass', () => {
    for (const s of ['base', 'head']) writeReceipt(s, { artifact: 'receipts-unit-1', id: 'u1', shard: 1, of: 1, files: ['test/a.test.ts'], cases: [A, B] });
    const result = compare(side('head'), side('base'), noDeltas);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('an equal-count substitution fails and prints the row that would declare the dropped test', () => {
    writeReceipt('base', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [A, B] });
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [A, C] });
    const result = compare(side('head'), side('base'), noDeltas);
    expect(result.ok).toBe(false);
    expect(result.drops.map(d => [d.identity.test, d.verdict])).toEqual([['math > subtracts', 'undeclared']]);
    expect(result.additions.map(a => a.test)).toEqual(['math > multiplies']);
    expect(result.suggestions).toEqual([
      ['retire', 'unit', 'test/a.test.ts', 'math > subtracts', '', '', '', '', 'TODO: why this test no longer runs here', 'TODO: docs/test-audit/2026-10-04/implementation/<lane>.md#<retiring-a-test row>'].join('\t'),
    ]);
  });

  test('a declared file-level move passes only when the tests execute at the new location', () => {
    const moved = (file: string): Case[] => [A, B].map(c => ({ ...c, file }));
    writeReceipt('base', { artifact: 'receipts-serial-1', id: 's1', lane: 'serial', files: ['test/a.serial.test.ts'], cases: moved('test/a.serial.test.ts') });
    writeReceipt('head', { artifact: 'receipts-serial-1', id: 's1', lane: 'serial', files: [], cases: [] , extra: ['empty=1'], junit: null });
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: moved('test/a.test.ts') });
    const undeclared = compare(side('head'), side('base'), noDeltas);
    expect(undeclared.ok).toBe(false);
    expect(undeclared.suggestions).toEqual([['move', 'serial', 'test/a.serial.test.ts', '*', '', 'unit', 'test/a.test.ts', '', 'TODO: why this test no longer runs here', ''].join('\t')]);
    const row = ['move', 'serial', 'test/a.serial.test.ts', '*', '', 'unit', 'test/a.test.ts', '', 'D6: isolation check proved the file parallel-safe', ''].join('\t');
    const declared = compare(side('head'), side('base'), parseDeltas(`${HEADER}\n${row}\n`));
    expect(declared.drops.map(d => d.verdict)).toEqual(['moved', 'moved']);
    expect(declared.ok).toBe(true);
    const wrongTarget = row.replace('unit\ttest/a.test.ts', 'unit\ttest/elsewhere.test.ts');
    const missing = compare(side('head'), side('base'), parseDeltas(`${HEADER}\n${wrongTarget}\n`));
    expect(missing.ok).toBe(false);
    expect(missing.drops[0].verdict).toBe('move-target-missing');
  });

  test('a retirement passes with its evidence row and is refused without one', () => {
    writeReceipt('base', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [A, B] });
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [A] });
    const row = (evidence: string) => ['retire', 'unit', 'test/a.test.ts', 'math > subtracts', '', '', '', '', 'pinned an abandoned contract', evidence].join('\t');
    const retired = compare(side('head'), side('base'), parseDeltas(`${HEADER}\n${row('docs/test-audit/2026-10-04/implementation/s3.md#subtracts')}\n`));
    expect(retired.drops[0].verdict).toBe('retired');
    expect(retired.ok).toBe(true);
    const noEvidence = parseDeltas(`${HEADER}\n${row('TODO')}\n`);
    expect(noEvidence.errors[0]).toContain('Retiring-a-test evidence');
    expect(compare(side('head'), side('base'), noEvidence).ok).toBe(false);
  });

  test('a declared pass-to-skip passes only while head reports the test skipped', () => {
    writeReceipt('base', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [A, B] });
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [A, { ...B, status: 'skip' }] });
    const row = ['skip', 'unit', 'test/a.test.ts', 'math > subtracts', '', '', '', '', 'D14: covered by the e2e arm', ''].join('\t');
    expect(compare(side('head'), side('base'), parseDeltas(`${HEADER}\n${row}\n`)).ok).toBe(true);
    expect(compare(side('head'), side('base'), noDeltas).suggestions[0].startsWith('skip\t')).toBe(true);
  });

  test('backend arms of one file are separate identities', () => {
    for (const arm of ['postgres-direct', 'pgbouncer']) {
      writeReceipt('base', { artifact: 'receipts-tier1', id: `m-${arm}`, lane: 'backend-matrix', arm, files: ['test/e2e/m.test.ts'], cases: [{ file: 'test/e2e/m.test.ts', name: 'binds' }] });
    }
    writeReceipt('head', { artifact: 'receipts-tier1', id: 'm-postgres-direct', lane: 'backend-matrix', arm: 'postgres-direct', files: ['test/e2e/m.test.ts'], cases: [{ file: 'test/e2e/m.test.ts', name: 'binds' }] });
    const result = compare(side('head'), side('base'), noDeltas);
    expect(side('base').identities.size).toBe(2);
    expect(result.drops.map(d => d.identity.arm)).toEqual(['pgbouncer']);
  });

  test('each identity carries the backend its test name pins', () => {
    expect(testBackend('pglite: semantic writes > adds')).toBe('pglite');
    expect(testBackend('A-1 managed link extraction (PGLite) > isolates')).toBe('pglite');
    expect(testBackend('postgres: semantic writes > adds')).toBe('postgres');
    expect(testBackend('migrate (postgresql target) > copies')).toBe('postgres');
    expect(testBackend('pglite and postgres agree')).toBe('');
    expect(testBackend('pgliteish postgresify')).toBe('');
    expect(testBackend('a publish held past the ceiling (pglite) > commits once (on Postgres after a requeue)')).toBe('pglite');
    expect(testBackend('postgres-unit-arms list > the shards cover every file')).toBe('');
    expect(testBackend('math > adds')).toBe('');
  });

  // The Bun 1.4.3 PostgreSQL-arm cell runs only the PostgreSQL side of
  // testBackends() suites (GBRA-135 E1b): their PGLite tests leave the
  // pg-arms lane (arm postgres) and keep running in unit (no arm).
  const ARMS = 'pg-arms-bun-1.4.3';
  const backendCases = (file: string, names: string[]): Case[] => names.map(name => ({ file, name, describe: [] }));
  test('a PGLite test leaving the PostgreSQL-arm lane reads as moved when it runs on PGLite in unit', () => {
    const f = 'test/w.test.ts';
    writeReceipt('base', { artifact: 'receipts-pg-arms-1-bun-1.4.3', id: 'p1', lane: ARMS, shard: 1, of: 1, arm: 'postgres', files: [f], cases: backendCases(f, ['pglite: writes', 'pglite: reads', 'postgres: writes', 'postgres: reads']) });
    writeReceipt('head', { artifact: 'receipts-pg-arms-1-bun-1.4.3', id: 'p1', lane: ARMS, shard: 1, of: 1, arm: 'postgres', files: [f], cases: backendCases(f, ['postgres: writes', 'postgres: reads']) });
    for (const s of ['base', 'head']) writeReceipt(s, { artifact: 'receipts-unit-1', id: 'u1', shard: 1, of: 1, files: [f], cases: backendCases(f, ['pglite: writes', 'pglite: reads']) });
    const undeclared = compare(side('head'), side('base'), noDeltas);
    expect(undeclared.drops.map(d => [d.identity.test, d.identity.backend, d.verdict])).toEqual([['pglite: writes', 'pglite', 'undeclared'], ['pglite: reads', 'pglite', 'undeclared']]);
    const row = ['move', ARMS, f, '*', 'postgres', 'unit', '', '', 'E1b: the PGLite side runs in the unit shards', ''].join('\t');
    expect(undeclared.suggestions).toEqual([row.replace('E1b: the PGLite side runs in the unit shards', 'TODO: why this test no longer runs here')]);
    const declared = compare(side('head'), side('base'), parseDeltas(`${HEADER}\n${row}\n`));
    expect(declared.drops.map(d => d.verdict)).toEqual(['moved', 'moved']);
    expect(declared.ok).toBe(true);
    expect(render(declared)).toContain(`| ${ARMS} | 0 | 2 | 0 |`);
  });

  test('a move that changes arm is refused for a PostgreSQL test and for a test whose name pins no backend', () => {
    const f = 'test/w.test.ts';
    writeReceipt('base', { artifact: 'receipts-pg-arms-1-bun-1.4.3', id: 'p1', lane: ARMS, shard: 1, of: 1, arm: 'postgres', files: [f], cases: backendCases(f, ['postgres: writes', 'engines agree']) });
    writeReceipt('head', { artifact: 'receipts-pg-arms-1-bun-1.4.3', id: 'p1', lane: ARMS, shard: 1, of: 1, arm: 'postgres', files: [f], cases: backendCases(f, ['pglite: writes']) });
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', shard: 1, of: 1, files: [f], cases: backendCases(f, ['postgres: writes', 'engines agree']) });
    const row = ['move', ARMS, f, '*', 'postgres', 'unit', '', '', 'claimed move', ''].join('\t');
    const result = compare(side('head'), side('base'), parseDeltas(`${HEADER}\n${row}\n`));
    expect(result.drops.map(d => [d.identity.test, d.verdict])).toEqual([['postgres: writes', 'move-target-missing'], ['engines agree', 'move-target-missing']]);
    expect(result.ok).toBe(false);
    expect(compare(side('head'), side('base'), noDeltas).suggestions.every(s => s.startsWith('retire\t'))).toBe(true);
  });

  test('a base artifact missing from head fails unless a job row declares it', () => {
    writeReceipt('base', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [A] });
    writeReceipt('base', { artifact: 'receipts-slow-eval', id: 'e1', lane: 'slow', files: ['test/e.slow.test.ts'], cases: [{ file: 'test/e.slow.test.ts', name: 'evals' }] });
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts', 'test/e.slow.test.ts'], cases: [A, { file: 'test/e.slow.test.ts', name: 'evals' }] });
    const moveRow = ['move', 'slow', 'test/e.slow.test.ts', '*', '', 'unit', '', '', 'B10: the 5s file rides the unit matrix', ''].join('\t');
    const missing = compare(side('head'), side('base'), parseDeltas(`${HEADER}\n${moveRow}\n`));
    expect(missing.issues.map(i => i.kind)).toEqual(['missing-artifact']);
    expect(missing.ok).toBe(false);
    const jobRow = ['job', 'receipts-slow-*', '', '', '', '', '', '', 'B10: slow-eval job removed', ''].join('\t');
    expect(compare(side('head'), side('base'), parseDeltas(`${HEADER}\n${moveRow}\n${jobRow}\n`)).ok).toBe(true);
  });
});

describe('completeness', () => {
  test('a killed shard re-run by its rescue is complete and reports the rescue result', () => {
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', shard: 1, of: 1, files: ['test/a.test.ts', 'test/b.test.ts'], junit: null, exit: null });
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'rescue', kind: 'rescue', started: 200, files: ['test/a.test.ts', 'test/b.test.ts'], cases: [A, { file: 'test/b.test.ts', name: 'b' }] });
    const head = side('head');
    expect(head.issues).toEqual([]);
    expect(head.lanes.get('unit')).toMatchObject({ executed: 2, superseded: 2 });
    expect(compare(head, undefined, noDeltas).ok).toBe(true);
  });

  test('a rescue supersedes the failing primary for the files it re-ran', () => {
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [{ ...A, status: 'fail' }] });
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'rescue', kind: 'rescue', files: ['test/a.test.ts'], cases: [A] });
    expect([...side('head').identities.values()].map(i => i.status)).toEqual(['pass']);
  });

  test('a killed shard without a rescue is incomplete and names the attempt', () => {
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', shard: 1, of: 1, files: ['test/a.test.ts'], junit: null, exit: null });
    const result = compare(side('head'), undefined, noDeltas);
    expect(result.ok).toBe(false);
    expect(result.issues[0].detail).toContain('test/a.test.ts has no valid receipt from any attempt');
    expect(result.issues[0].detail).toContain('interrupted');
  });

  test('a truncated JUnit report is incomplete', () => {
    const cut = junit([A, B]);
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], junit: cut.slice(0, cut.length - 30), exit: 1 });
    const result = compare(side('head'), undefined, noDeltas);
    expect(result.ok).toBe(false);
    expect(result.issues[0].detail).toContain('truncated JUnit');
  });

  test('a receipt from an earlier run attempt is incomplete, not silently mixed in', () => {
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', runId: '42', attempt: 1, files: ['test/a.test.ts'], cases: [A] });
    writeReceipt('head', { artifact: 'receipts-unit-2', id: 'u2', runId: '42', attempt: 2, files: ['test/b.test.ts'], cases: [{ file: 'test/b.test.ts', name: 'b' }] });
    const result = compare(side('head'), undefined, noDeltas);
    expect(result.issues.map(i => i.kind)).toEqual(['prior-attempt']);
    expect(result.issues[0].detail).toContain('attempt 1 of run 42');
    const expected = side('head', new Map([['42', 3]]));
    expect(expected.issues.filter(i => i.kind === 'prior-attempt')).toHaveLength(2);
  });

  test('a missing shard and a lane that executed nothing are incomplete; empty assignments are not', () => {
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', shard: 1, of: 3, files: ['test/a.test.ts'], cases: [A] });
    writeReceipt('head', { artifact: 'receipts-unit-3', id: 'u3', shard: 3, of: 3, files: [], junit: null, extra: ['empty=1'] });
    writeReceipt('head', { artifact: 'receipts-slow', id: 's', lane: 'slow', files: ['test/s.slow.test.ts'], cases: [{ file: 'test/s.slow.test.ts', name: 'gated', status: 'skip' }] });
    const kinds = side('head').issues.map(i => i.kind).sort();
    expect(kinds).toEqual(['empty-lane', 'missing-shard']);
  });

  test('an all-skipped lane passes only when skip rows cover every file in it', () => {
    const gated: Case = { file: 'test/e2e/skills.test.ts', name: 'needs keys', status: 'skip' };
    for (const name of ['base', 'head']) writeReceipt(name, { artifact: 'receipts-tier2', id: 't', lane: 'tier2', files: [gated.file], cases: [gated] });
    expect(compare(side('head'), side('base'), noDeltas).issues.map(i => i.kind)).toEqual(['empty-lane', 'empty-lane']);
    const row = ['skip', 'tier2', gated.file, '*', '', '', '', '', 'D-1: provider secrets unset', ''].join('\t');
    const result = compare(side('head'), side('base'), parseDeltas(`${HEADER}\n${row}\n`));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.unusedRows).toEqual([]);
  });

  test('drops in a lane declared empty (doc-only E2E selection) are reported, not failed', () => {
    writeReceipt('base', { artifact: 'receipts-e2e-1', id: 'e', lane: 'e2e', files: ['test/e2e/x.test.ts'], cases: [{ file: 'test/e2e/x.test.ts', name: 'x' }] });
    writeReceipt('head', { artifact: 'receipts-e2e-1', id: 'e', lane: 'e2e', files: [], junit: null, extra: ['declared_empty=1'] });
    const result = compare(side('head'), side('base'), noDeltas);
    expect(result.drops[0].verdict).toBe('lane-declared-empty');
    expect(result.ok).toBe(true);
  });
});

describe('missing-key skip count (A9)', () => {
  test('counts skipped tests only in files that read a missing key', () => {
    mkdirSync(join(root, 'src/test/e2e'), { recursive: true });
    writeFileSync(join(root, 'src/test/e2e/live.test.ts'), 'const k = process.env.OPENAI_API_KEY;');
    writeFileSync(join(root, 'src/test/e2e/plain.test.ts'), 'export {};');
    writeReceipt('head', { artifact: 'receipts-e2e-1', id: 'e', lane: 'e2e', files: ['test/e2e/live.test.ts', 'test/e2e/plain.test.ts'], cases: [
      { file: 'test/e2e/live.test.ts', name: 'embeds', status: 'skip' },
      { file: 'test/e2e/live.test.ts', name: 'chats', status: 'skip' },
      { file: 'test/e2e/live.test.ts', name: 'offline' },
      { file: 'test/e2e/plain.test.ts', name: 'optional', status: 'skip' },
    ] });
    expect(missingKeySkips(side('head'), ['OPENAI_API_KEY'], join(root, 'src'))).toEqual({ tests: 2, files: ['test/e2e/live.test.ts'] });
  });
});

describe('CLI', () => {
  const cli = (...args: string[]) => spawnSync('bun', ['scripts/ci-executed-counts.ts', ...args], { cwd: REPO, encoding: 'utf8' });

  test('local directories: exit 1 on an undeclared drop with the row to add, 0 when identical, 2 on usage errors', () => {
    writeReceipt('base', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [A, B] });
    writeReceipt('head', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [A, C] });
    const deltas = join(root, 'deltas.tsv');
    writeFileSync(deltas, `${HEADER}\n`);
    const summary = join(root, 'summary.md');
    const json = join(root, 'out.json');
    const fail = cli('--base-dir', join(root, 'base'), '--head-dir', join(root, 'head'), '--deltas', deltas, '--summary', summary, '--json', json);
    expect(fail.status, fail.stderr).toBe(1);
    expect(fail.stdout).toContain('retire\tunit\ttest/a.test.ts\tmath > subtracts');
    expect(readFileSync(summary, 'utf8')).toContain('| unit | 2 | 2 | 0 | 0 | 1 | 0 | 1 |');
    expect(JSON.parse(readFileSync(json, 'utf8')).drops).toHaveLength(1);
    expect(cli('--base-dir', join(root, 'base'), '--head-dir', join(root, 'head'), '--deltas', deltas, '--report-only').status).toBe(0);
    expect(cli('--base-dir', join(root, 'base'), '--head-dir', join(root, 'base'), '--deltas', deltas).status).toBe(0);
    writeReceipt('grown', { artifact: 'receipts-unit-1', id: 'u1', files: ['test/a.test.ts'], cases: [A, B, C] });
    expect(cli('--base-dir', join(root, 'base'), '--head-dir', join(root, 'grown'), '--deltas', deltas).status).toBe(0);
    expect(cli('--base-dir', join(root, 'base'), '--head-dir', join(root, 'grown'), '--deltas', deltas, '--fail-on-additions').status).toBe(1);
    const usage = cli('--base-run', '1');
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('--head-run');
  });

  test('the committed expected-deltas.tsv parses', () => {
    const parsed = parseDeltas(readFileSync(join(REPO, 'docs/test-audit/2026-10-04/expected-deltas.tsv'), 'utf8'));
    expect(parsed.errors).toEqual([]);
  });
});
