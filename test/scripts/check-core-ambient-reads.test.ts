/**
 * scripts/check-core-ambient-reads.ts: which nodes count as ambient reads of
 * each kind, how per-file, per-kind counts compare with the baseline (over
 * fails, under nudges), and the bash entry's exit code, FAIL/Why/Fix/See block
 * and --write-baseline round trip, driven through GBRAIN_GUARD_ROOT temp trees.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compareBaseline, findAmbientReads, formatBaseline, totals } from '../../scripts/check-core-ambient-reads.ts';
import type { AmbientRead } from '../../scripts/check-core-ambient-reads.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
const GUARD = join(ROOT, 'scripts', 'check-core-ambient-reads.sh');
const BASELINE = 'scripts/core-ambient-reads.baseline.tsv';
const HEADER = 'path\tkind\tcount';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const reads = (src: string) => findAmbientReads('src/core/x.ts', src).map(r => [r.kind, r.line]);

describe('findAmbientReads', () => {
  test('every config-loader call counts, bare or as a member, through parentheses and casts', () => {
    const src = [
      'const a = loadConfig();',
      'const b = loadConfigFileOnly();',
      'const c = await loadConfigWithEngine(engine);',
      'const d = config.loadConfig();',
      'const e = (loadConfig as () => unknown)();',
      'function loadConfig() { return null; }',
      'import { loadConfig } from "./config.ts";',
    ].join('\n');
    expect(reads(src)).toEqual([['config-load', 1], ['config-load', 2], ['config-load', 3], ['config-load', 4], ['config-load', 5]]);
  });

  test('every form of a process.env read counts once per occurrence', () => {
    const src = [
      'const home = process.env.HOME;',
      "const path = process.env['PATH'];",
      'const { SHELL, TERM } = process.env;',
      'spawn(cmd, { env: { ...process.env, X: "1" } });',
      "const env = process['env'];",
      'const twice = process.env.A ?? process.env.B;',
    ].join('\n');
    expect(reads(src)).toEqual([
      ['process-env', 1], ['process-env', 2], ['process-env', 3], ['process-env', 4], ['process-env', 5], ['process-env', 6], ['process-env', 6],
    ]);
  });

  test('a top-level Map, Set, WeakMap or WeakSet declaration counts, exported or not, through casts and type arguments', () => {
    const src = [
      'const a = new Map();',
      'export const b = new Set<string>();',
      'let c = new WeakMap<object, number>();',
      'var d = new WeakSet();',
      'export const e = new Map<string, string>() as ReadonlyMap<string, string>;',
      'const f = (new Set<number>());',
      'const g = new Map(), h = 1, i = new Set();',
    ].join('\n');
    expect(reads(src)).toEqual([
      ['module-collection', 1], ['module-collection', 2], ['module-collection', 3], ['module-collection', 4],
      ['module-collection', 5], ['module-collection', 6], ['module-collection', 7], ['module-collection', 7],
    ]);
  });

  test('a collection inside a function, class, block or object literal, and other names or reads, do not count', () => {
    const src = [
      'function build() { const local = new Map<string, string>(); return local; }',
      'class Index { private readonly seen = new Set<string>(); }',
      '{ const scoped = new Map(); }',
      'export const bundle = { cache: new Map<string, string>() };',
      'const arr = new Array<string>();',
      'const view = process.argv;',
      'const envLike = options.env.HOME;',
      'const setting = await engine.getConfig("key");',
      'const made = () => new Map();',
    ].join('\n');
    expect(reads(src)).toEqual([]);
  });
});

describe('compareBaseline', () => {
  const site = (path: string, kind: AmbientRead['kind'], line: number): AmbientRead => ({ path, kind, line });
  const sites = [
    site('src/core/a.ts', 'process-env', 3), site('src/core/a.ts', 'process-env', 9),
    site('src/core/a.ts', 'module-collection', 1), site('src/core/b.ts', 'config-load', 4),
  ];
  const exact = `${HEADER}\nsrc/core/a.ts\tmodule-collection\t1\nsrc/core/a.ts\tprocess-env\t2\nsrc/core/b.ts\tconfig-load\t1\n`;

  test('an exact match passes with nothing to say, and formatBaseline writes it', () => {
    expect(formatBaseline(sites, '')).toBe(exact);
    expect(compareBaseline(sites, exact)).toEqual({ problems: [], below: [] });
    expect(totals(sites)).toBe('config-load 1, process-env 2, module-collection 1');
  });

  test('a count over its row, and reads in a file with no row, fail with the sites', () => {
    const { problems, below } = compareBaseline(sites, `${HEADER}\nsrc/core/a.ts\tmodule-collection\t1\nsrc/core/a.ts\tprocess-env\t1\n`);
    expect(below).toEqual([]);
    expect(problems).toEqual([
      'FAIL: src/core/a.ts has 2 process-env read(s), over its baseline of 1\n      sites: src/core/a.ts:3, src/core/a.ts:9',
      'FAIL: src/core/b.ts has 1 config-load read(s), over its baseline of 0\n      sites: src/core/b.ts:4',
    ]);
  });

  test('a count under its row, or a row with no reads left, is a nudge and not a failure', () => {
    const text = `${HEADER}\nsrc/core/a.ts\tmodule-collection\t1\nsrc/core/a.ts\tprocess-env\t5\nsrc/core/b.ts\tconfig-load\t1\nsrc/core/gone.ts\tprocess-env\t2\n`;
    expect(compareBaseline(sites, text)).toEqual({
      problems: [],
      below: ['src/core/a.ts process-env 5 -> 2', 'src/core/gone.ts process-env 2 -> 0'],
    });
  });

  test('malformed, unknown-kind, zero, duplicate and unsorted rows and a missing header fail', () => {
    const rows = 'src/core/a.ts\tmodule-collection\t1\nsrc/core/a.ts\tprocess-env\t2\nsrc/core/b.ts\tconfig-load\t1';
    const problems = (text: string) => compareBaseline(sites, text).problems.join('\n');
    expect(problems(`${HEADER}\n${rows}\nsrc/core/c.ts\tprocess-env\n`)).toContain(':5 malformed row');
    expect(problems(`${HEADER}\n${rows}\nsrc/core/c.ts\tglobal\t1\n`)).toContain(':5 malformed row');
    expect(problems(`${HEADER}\n${rows}\nsrc/core/c.ts\tprocess-env\t0\n`)).toContain(':5 malformed row');
    expect(problems(`${HEADER}\n${rows}\nsrc/core/b.ts\tconfig-load\t1\n`)).toContain(':5 duplicate row for src/core/b.ts config-load');
    expect(problems(`${HEADER}\nsrc/core/a.ts\tprocess-env\t2\nsrc/core/a.ts\tmodule-collection\t1\nsrc/core/b.ts\tconfig-load\t1\n`))
      .toContain(':3 rows must be sorted by path, then kind');
    expect(problems(`${rows}\n`)).toContain('missing the header line');
  });
});

describe('CLI', () => {
  const envRead = 'export function home(): string | undefined {\n  return process.env.HOME;\n}\n';
  const mapDecl = 'export const cache = new Map<string, string>();\n';

  function makeTree(files: Record<string, string>, baseline: string | null): string {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-core-ambient-'));
    tempDirs.push(root);
    const all = baseline === null ? files : { ...files, [BASELINE]: baseline };
    for (const [rel, content] of Object.entries(all)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    return root;
  }

  function runGuard(root: string, args: string[] = []) {
    const res = spawnSync('bash', [GUARD, ...args], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: root }, timeout: 30_000 });
    return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
  }

  test('growth exits 1 with FAIL/Why/Fix/See; a match exits 0 with the three totals; tests and generated files are not scanned', () => {
    const files = {
      'src/core/a.ts': envRead + mapDecl,
      'src/core/a.test.ts': envRead,
      'src/core/a.generated.ts': mapDecl,
      'src/core/a.d.ts': 'export declare const x: number;\n',
      'src/commands/b.ts': envRead,
    };
    const bad = runGuard(makeTree(files, `${HEADER}\nsrc/core/a.ts\tprocess-env\t1\n`));
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('FAIL: src/core/a.ts has 1 module-collection read(s), over its baseline of 0');
    expect(bad.stderr).toContain('sites: src/core/a.ts:4');
    for (const label of ['Why:', 'engine library a host embeds', 'Fix:', 'bash scripts/check-core-ambient-reads.sh --write-baseline',
      'See:  docs/architecture/key-files/ci-health-and-test-guards.md', 'core-ambient-reads: 1 violation(s)']) {
      expect(bad.stderr).toContain(label);
    }
    const good = runGuard(makeTree(files, `${HEADER}\nsrc/core/a.ts\tmodule-collection\t1\nsrc/core/a.ts\tprocess-env\t1\n`));
    expect({ code: good.code, stdout: good.stdout.trim() }).toEqual({
      code: 0,
      stdout: `OK: core ambient reads within ${BASELINE} (2 read(s) in 1 of 1 file(s): config-load 0, process-env 1, module-collection 1)`,
    });
  });

  test('a count under its row passes with one nudge line naming the row and the write command', () => {
    const root = makeTree({ 'src/core/a.ts': envRead }, `${HEADER}\nsrc/core/a.ts\tprocess-env\t3\nsrc/core/gone.ts\tconfig-load\t1\n`);
    const res = runGuard(root);
    expect(res.code).toBe(0);
    const lines = res.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith('OK: core ambient reads within');
    expect(lines[1]).toBe('note: 2 row(s) sit above the tree (src/core/a.ts process-env 3 -> 1, src/core/gone.ts config-load 1 -> 0); '
      + 'run bash scripts/check-core-ambient-reads.sh --write-baseline so the ceiling comes down');
  });

  test('--write-baseline rewrites the baseline from the tree, keeps the comment preamble, and the next run is quiet', () => {
    const root = makeTree({ 'src/core/b.ts': mapDecl, 'src/core/a.ts': envRead + envRead }, `# only down\n${HEADER}\nsrc/core/a.ts\tprocess-env\t1\nsrc/core/z.ts\tconfig-load\t1\n`);
    expect(runGuard(root).code).toBe(1);
    const written = runGuard(root, ['--write-baseline']);
    expect(written.code).toBe(0);
    expect(written.stdout.trim()).toBe(`wrote ${BASELINE}: 3 read(s) in 2 of 2 file(s): config-load 0, process-env 2, module-collection 1; review the diff (rows only come down)`);
    expect(readFileSync(join(root, BASELINE), 'utf8')).toBe(`# only down\n${HEADER}\nsrc/core/a.ts\tprocess-env\t2\nsrc/core/b.ts\tmodule-collection\t1\n`);
    const after = runGuard(root);
    expect(after.code).toBe(0);
    expect(after.stdout).not.toContain('note:');
  });

  test('a missing baseline fails and names the write command; --write-baseline then creates it with the default preamble', () => {
    const root = makeTree({ 'src/core/a.ts': envRead }, null);
    const missing = runGuard(root);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(`FAIL: ${BASELINE} not found`);
    expect(missing.stderr).toContain('bash scripts/check-core-ambient-reads.sh --write-baseline');
    expect(runGuard(root, ['--write-baseline']).code).toBe(0);
    const text = readFileSync(join(root, BASELINE), 'utf8');
    expect(text).toStartWith('# Ambient reads in src/core/');
    expect(text).toEndWith(`${HEADER}\nsrc/core/a.ts\tprocess-env\t1\n`);
    expect(runGuard(root).code).toBe(0);
  });

  test('an unknown argument exits 2 with usage', () => {
    const res = runGuard(makeTree({}, `${HEADER}\n`), ['--prune']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('usage: bash scripts/check-core-ambient-reads.sh [--write-baseline]');
  });

  test('the committed baseline matches the tree, so the check passes on this checkout', () => {
    const res = spawnSync('bash', [GUARD], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, GBRAIN_GUARD_ROOT: ROOT }, timeout: 60_000 });
    expect({ code: res.status, stderr: res.stderr }).toEqual({ code: 0, stderr: '' });
  });
});
