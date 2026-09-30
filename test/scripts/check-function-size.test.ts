/**
 * Failing-side proof for every scripts/check-function-size.ts rule (W5), driven
 * through GBRAIN_GUARD_ROOT temp trees with a small limit so each rule is
 * exercised without 300-line fixtures. The guard-self-test fixtures prove the
 * default 300-line limit end to end.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { measureSource } from '../../scripts/check-function-size.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO_ROOT, 'scripts', 'check-function-size.ts');
const HEADER = 'path\tname\tlines\tjustification';
const LIMIT = 10;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `n` body lines, so a `{`/`}`-wrapped function spans n + 2 lines. */
const body = (n: number, indent = '    ') => Array.from({ length: n }, (_, i) => `${indent}total += ${i};`).join('\n');

function makeTree(files: Record<string, string>, rows: string[] = [], base?: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-function-size-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'function-size-baseline.tsv'), [HEADER, ...rows].join('\n') + '\n');
  if (base) writeFileSync(join(root, 'scripts', 'function-size-baseline.base.tsv'), [HEADER, ...base].join('\n') + '\n');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function runGuard(root: string, args: string[] = [], env: Record<string, string> = {}) {
  const res = spawnSync('bun', [GUARD, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GBRAIN_GUARD_ROOT: root, GBRAIN_FUNCTION_SIZE_LIMIT: String(LIMIT), GBRAIN_FUNCTION_SIZE_SLACK: '5', ...env },
    timeout: 30_000,
  });
  return { code: res.status ?? -1, out: `${res.stdout}\n${res.stderr}`, stderr: res.stderr };
}

describe('function forms are all measured and keyed by name path', () => {
  const src = [
    'export function declared(total: number) {',
    body(12, '  '),
    '  return total;',
    '}',
    'export class Engine {',
    '  method(total: number) {',
    body(12),
    '    return total;',
    '  }',
    '  get value() {',
    '    let total = 0;',
    body(12),
    '    return total;',
    '  }',
    '  handler = (total: number) => {',
    body(12),
    '    return total;',
    '  };',
    '}',
    'export const table = {',
    '  run: function (total: number) {',
    body(12),
    '    return total;',
    '  },',
    '  arrow: (total: number) => {',
    body(12),
    '    return total;',
    '  },',
    '};',
    'export const MIGRATIONS = [',
    '  { version: 131, handler: async (total: number) => {',
    body(12),
    '    return total;',
    '  } },',
    '];',
    'export function server(app: { post(p: string, h: (total: number) => number): void }) {',
    "  app.post('/mcp', (total: number) => {",
    body(12),
    '    return total;',
    '  });',
    '}',
  ].join('\n');

  test('declarations, methods, accessors, class properties, object-literal forms, array elements and route handlers', () => {
    const names = measureSource('src/x.ts', src)
      .filter((m) => m.lines > LIMIT)
      .map((m) => m.name);
    expect(names).toEqual([
      'declared',
      'Engine.method',
      'Engine.get value',
      'Engine.handler',
      'table.run',
      'table.arrow',
      'MIGRATIONS[v131].handler',
      'server',
      "server>app.post('/mcp')",
    ]);
  });

  test('a repeated key gets an ordinal instead of a line number', () => {
    const twice = ["describe('a', () => {", '  it(1);', '});', "describe('a', () => {", '  it(2);', '});'].join('\n');
    expect(measureSource('src/y.ts', twice).map((m) => m.name)).toEqual(["describe('a')", "describe('a')#2"]);
  });
});

describe('check-function-size.ts rules', () => {
  const long = (lines: number) => `export function big(total: number) {\n${body(lines - 3, '  ')}\n  return total;\n}\n`;

  test('rule 1: a new over-limit function fails with FAIL/Why/Fix/See and the computed key, within 30 lines', () => {
    const r = runGuard(makeTree({ 'src/a.ts': long(14) }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: src/a.ts:1 big is 14 lines, over the 10-line limit (no baseline row)');
    expect(r.out).toContain('key: src/a.ts\tbig');
    for (const label of ['Why:', 'Fix:', 'See:  docs/TESTING.md#function-size-ratchet']) expect(r.stderr).toContain(label);
    expect(r.stderr.trim().split('\n').length).toBeLessThanOrEqual(30);
  });

  test('a baselined function passes, and shifting it down 10 lines leaves the baseline untouched', () => {
    const rows = ['src/a.ts\tbig\t14\tseed'];
    expect(runGuard(makeTree({ 'src/a.ts': long(14) }, rows)).code).toBe(0);
    const shifted = '\n'.repeat(10) + long(14);
    expect(runGuard(makeTree({ 'src/a.ts': shifted }, rows)).code).toBe(0);
  });

  test('rule 2: growth past the baseline row fails', () => {
    const r = runGuard(makeTree({ 'src/a.ts': long(16) }, ['src/a.ts\tbig\t14\tseed']));
    expect(r.code).toBe(1);
    expect(r.out).toContain('big grew to 16 lines, over its 14-line baseline');
  });

  test('rule 3: a function that shrank to the limit must drop its row', () => {
    const r = runGuard(makeTree({ 'src/a.ts': long(9) }, ['src/a.ts\tbig\t14\tseed']));
    expect(r.code).toBe(1);
    expect(r.out).toContain('shrank to 9 lines, under the 10-line limit: remove its baseline row');
  });

  test('rule 4: stale slack after a shrink must lower the row', () => {
    const r = runGuard(makeTree({ 'src/a.ts': long(14) }, ['src/a.ts\tbig\t30\tseed']));
    expect(r.code).toBe(1);
    expect(r.out).toContain('lower its baseline row from 30 to 14');
  });

  test('rule 5: a row for a function that no longer exists fails, with a transfer hint for a likely move', () => {
    const r = runGuard(makeTree({ 'src/b.ts': long(14) }, ['src/a.ts\tbig\t14\tseed']));
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/a.ts big no longer exists');
    expect(r.out).toContain('bun scripts/check-function-size.ts --transfer');
  });

  test('rule 6: a raise or an added row needs an issue/TODO id; accepted raises are printed', () => {
    const base = ['src/a.ts\tbig\t14\tseed'];
    const bad = runGuard(makeTree({ 'src/a.ts': long(16) }, ['src/a.ts\tbig\t16\tneeded more room'], base));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('big raised 14 -> 16 without an issue/TODO id');
    const ok = runGuard(makeTree({ 'src/a.ts': long(16) }, ['src/a.ts\tbig\t16\tsplit tracked in #1234'], base));
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('raise: src/a.ts\tbig raised 14 -> 16: split tracked in #1234');
    const added = runGuard(makeTree({ 'src/a.ts': long(14), 'src/c.ts': long(12).replace('big', 'other') }, [...base, 'src/c.ts\tother\t12\tno id'], base));
    expect(added.code).toBe(1);
    expect(added.out).toContain('other added at 12 without an issue/TODO id');
  });

  test('rule 7: duplicate, unsorted and malformed rows fail', () => {
    const files = { 'src/a.ts': long(14), 'src/b.ts': long(14) };
    expect(runGuard(makeTree(files, ['src/b.ts\tbig\t14\tseed', 'src/a.ts\tbig\t14\tseed'])).out).toContain('rows must be sorted');
    expect(runGuard(makeTree(files, ['src/a.ts\tbig\t14\tseed', 'src/a.ts\tbig\t14\tseed', 'src/b.ts\tbig\t14\tseed'])).out).toContain('duplicate row');
    expect(runGuard(makeTree(files, ['src/a.ts\tbig\tfourteen\tseed'])).out).toContain('malformed row');
  });

  test('scope (EO15): *.generated.ts, .d.ts and files outside src/ are ignored', () => {
    const r = runGuard(makeTree({ 'src/t.generated.ts': long(40), 'src/t.d.ts': 'export declare const x: number;\n', 'test/long.test.ts': long(40) }));
    expect(r.code).toBe(0);
  });

  test('--transfer moves a row to the identical function at its new path, and leaves edited functions alone', () => {
    const root = makeTree({ 'src/old.ts': long(14) }, ['src/old.ts\tbig\t14\tseed']);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-qm', 'base');
    rmSync(join(root, 'src/old.ts'));
    writeFileSync(join(root, 'src/new.ts'), '// moved\n' + long(14));
    const moved = runGuard(root, ['--transfer']);
    expect(moved.code).toBe(0);
    expect(readFileSync(join(root, 'scripts/function-size-baseline.tsv'), 'utf8')).toContain('src/new.ts\tbig\t14\tseed');
    expect(runGuard(root).code).toBe(0);

    writeFileSync(join(root, 'scripts/function-size-baseline.tsv'), `${HEADER}\nsrc/old.ts\tbig\t14\tseed\n`);
    writeFileSync(join(root, 'src/new.ts'), long(14).replace('total += 1;', 'total += 99;'));
    expect(runGuard(root, ['--transfer']).out).toContain('skip: src/old.ts\tbig (0 identical candidates)');
    expect(runGuard(root).code).toBe(1);
  });

  test('--transfer sees through an added `export` and re-relativized specifiers, but not a retargeted one', () => {
    const fn = (spec: string, exported: boolean) =>
      `${exported ? 'export ' : ''}async function big(total: number) {\n  await import('${spec}');\n${body(9, '  ')}\n  return total;\n}\n`;
    const root = makeTree({ 'src/cmd/old.ts': fn('../core/x.ts', false) }, ['src/cmd/old.ts\tbig\t14\tseed']);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-qm', 'base');
    rmSync(join(root, 'src/cmd/old.ts'));
    mkdirSync(join(root, 'src/cmd/old'), { recursive: true });
    writeFileSync(join(root, 'src/cmd/old/moved.ts'), fn('../../core/y.ts', true));
    expect(runGuard(root, ['--transfer']).out).toContain('skip: src/cmd/old.ts\tbig (0 identical candidates)');
    writeFileSync(join(root, 'src/cmd/old/moved.ts'), fn('../../core/x.ts', true));
    const moved = runGuard(root, ['--transfer']);
    expect(moved.code).toBe(0);
    expect(readFileSync(join(root, 'scripts/function-size-baseline.tsv'), 'utf8')).toContain('src/cmd/old/moved.ts\tbig\t14\tseed');
    expect(runGuard(root).code).toBe(0);
  });
});
