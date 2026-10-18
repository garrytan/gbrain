/**
 * scripts/check-item-allowlist-catches.ts (GBRA-130): which catches count as
 * per-item allowlist-and-rethrow sites, how per-file counts compare with the
 * shrink-only baseline, and the CLI's exit code and FAIL/Why/Fix/See block,
 * driven through GBRAIN_GUARD_ROOT temp trees.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compareBaseline, findAllowlistCatches, formatBaseline } from '../../scripts/check-item-allowlist-catches.ts';

const GUARD = join(resolve(import.meta.dir, '..', '..'), 'scripts', 'check-item-allowlist-catches.ts');
const HEADER = 'path\tcount';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const lines = (src: string) => findAllowlistCatches('src/x.ts', src).map(s => s.line);
const allowlistCatch = (v = 'e') => `catch (${v}) { if (!SKIP.has((${v} as any).code)) throw ${v}; }`;

describe('findAllowlistCatches', () => {
  test('an allowlist-and-rethrow catch inside for, for-of, for-in, while and do-while counts', () => {
    const src = [
      'for (const slug of slugs) {',
      `  try { put(slug); } ${allowlistCatch()}`,
      '}',
      `for (let i = 0; i < n; i++) { try { put(i); } ${allowlistCatch()} }`,
      `for (const k in table) { try { put(k); } ${allowlistCatch()} }`,
      `while (more()) { try { put(next()); } ${allowlistCatch()} }`,
      `do { try { put(next()); } ${allowlistCatch()} } while (more());`,
    ].join('\n');
    expect(lines(src)).toEqual([2, 4, 5, 6, 7]);
  });

  test('inside a .forEach or .map callback it counts', () => {
    const src = [
      `slugs.forEach((slug) => { try { put(slug); } ${allowlistCatch('err')} });`,
      `await Promise.all(slugs.map(async function (slug) { try { await put(slug); } ${allowlistCatch()} }));`,
    ].join('\n');
    expect(lines(src)).toEqual([1, 2]);
  });

  test('every code-test form counts, through casts, optional chains and aliases', () => {
    const forms = [
      "if (e.code === '23503') { blocked.push(slug); continue; } throw e;",
      "if (e?.code !== 'ENOENT') throw e;",
      "if (![\"a\", \"b\"].includes((e as { code: string }).code)) throw e;",
      "const code = (e as { code?: string }).code; if (code === 'ENOENT') continue; throw e;",
      'const { code } = e as NodeJS.ErrnoException; if (!SKIP.has(code!)) throw e;',
      "const err = e as PgError; if (err.code !== CODES.FK) { throw err; }",
      "switch (e.code) { case 'ENOENT': continue; default: throw e; }",
      "if (e instanceof OperationError && e.code === 'page_not_found') { skipped++; } else { if (ready) throw e; }",
    ];
    const src = forms.map(body => `for (const slug of slugs) { try { put(slug); } catch (e) { ${body} } }`).join('\n');
    expect(lines(src)).toEqual(forms.map((_, i) => i + 1));
  });

  test('a loop catch without a code test, without a rethrow, or rethrowing something else does not count', () => {
    const src = [
      'for (const s of slugs) { try { put(s); } catch (e) { log(e); throw e; } }',
      "for (const s of slugs) { try { put(s); } catch (e) { if (SKIP.has(e.code)) skipped.push(s); } }",
      "for (const s of slugs) { try { put(s); } catch (e) { if (e.code !== 'x') throw new Error('wrapped'); } }",
      "for (const s of slugs) { try { put(s); } catch (e) { if (e.code === undefined) throw e; } }",
      "for (const s of slugs) { try { put(s); } catch (e) { if (e.code !== 'x') later(() => { throw e; }); } }",
      "for (const s of slugs) { try { put(s); } catch { skipped++; } }",
    ].join('\n');
    expect(lines(src)).toEqual([]);
  });

  test('outside a loop, in a loop header, or in a function declared in a loop body it does not count', () => {
    const src = [
      `function once() { try { put(); } ${allowlistCatch()} }`,
      `for (const s of (() => { try { return load(); } ${allowlistCatch()} })()) put(s);`,
      `for (const s of slugs) { const run = () => { try { put(s); } ${allowlistCatch()} }; queue(run); }`,
      `slugs.filter((s) => { try { return check(s); } ${allowlistCatch()} });`,
    ].join('\n');
    expect(lines(src)).toEqual([]);
  });

  test('a loop inside a nested function counts at that function\'s level', () => {
    const src = [
      'function outer() {',
      `  const each = (slugs: string[]) => { for (const s of slugs) { try { put(s); } ${allowlistCatch()} } };`,
      '}',
    ].join('\n');
    expect(lines(src)).toEqual([2]);
  });
});

describe('compareBaseline', () => {
  const sites = [{ path: 'src/a.ts', line: 3 }, { path: 'src/a.ts', line: 9 }, { path: 'src/b.ts', line: 1 }];

  test('an exact match passes and formatBaseline writes it', () => {
    const text = formatBaseline(sites);
    expect(text).toBe(`${HEADER}\nsrc/a.ts\t2\nsrc/b.ts\t1\n`);
    expect(compareBaseline(sites, text)).toEqual([]);
  });

  test('growth past a row, and sites in a file with no row, fail with the site lines', () => {
    const problems = compareBaseline(sites, `${HEADER}\nsrc/a.ts\t1\n`);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('src/a.ts has 2 allowlist-and-rethrow catch(es) in per-item loops, over its baseline of 1');
    expect(problems[0]).toContain('sites: src/a.ts:3, src/a.ts:9');
    expect(problems[1]).toContain('src/b.ts has 1 allowlist-and-rethrow catch(es) in per-item loops, over its baseline of 0');
  });

  test('a shrink without lowering the row fails', () => {
    expect(compareBaseline(sites, `${HEADER}\nsrc/a.ts\t3\nsrc/b.ts\t1\n`))
      .toEqual(['FAIL: src/a.ts dropped to 2 site(s); lower its baseline row from 3 to 2']);
  });

  test('a row for a file with no sites, or a missing file, fails', () => {
    const text = `${HEADER}\nsrc/a.ts\t2\nsrc/b.ts\t1\nsrc/c.ts\t1\nsrc/gone.ts\t1\n`;
    expect(compareBaseline(sites, text, path => path !== 'src/gone.ts')).toEqual([
      'FAIL: src/c.ts has no allowlist-and-rethrow catches left: remove its baseline row',
      'FAIL: src/gone.ts no longer exists: remove its baseline row',
    ]);
  });

  test('malformed, zero, duplicate and unsorted rows and a missing header fail', () => {
    const ok = 'src/a.ts\t2\nsrc/b.ts\t1';
    expect(compareBaseline(sites, `${HEADER}\n${ok}\nsrc/c.ts\ttwo\n`).join('\n')).toContain(':4 malformed row');
    expect(compareBaseline(sites, `${HEADER}\n${ok}\nsrc/c.ts\t0\n`).join('\n')).toContain(':4 malformed row');
    expect(compareBaseline(sites, `${HEADER}\n${ok}\nsrc/b.ts\t1\n`).join('\n')).toContain(':4 duplicate row for src/b.ts');
    expect(compareBaseline(sites, `${HEADER}\nsrc/b.ts\t1\nsrc/a.ts\t2\n`).join('\n')).toContain(':3 rows must be sorted by path');
    expect(compareBaseline(sites, `${ok}\n`).join('\n')).toContain('missing the header line');
  });
});

describe('CLI', () => {
  const site = `for (const s of slugs) { try { put(s); } ${allowlistCatch()} }\n`;

  function makeTree(files: Record<string, string>, baseline: string): string {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-item-allowlist-'));
    tempDirs.push(root);
    for (const [rel, content] of Object.entries({ ...files, 'scripts/item-allowlist-catches-baseline.tsv': baseline })) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    return root;
  }

  function runGuard(root: string, args: string[] = []) {
    const res = spawnSync('bun', [GUARD, ...args], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: root }, timeout: 30_000 });
    return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
  }

  test('growth exits 1 with FAIL/Why/Fix/See pointing at item-failure.ts and test/pathological/; a match exits 0 with a summary', () => {
    const files = { 'src/a.ts': site + site, 'src/a.generated.ts': site, 'src/a.d.ts': 'export declare const x: number;\n', 'test/a.test.ts': site };
    const bad = runGuard(makeTree(files, `${HEADER}\nsrc/a.ts\t1\n`));
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('FAIL: src/a.ts has 2 allowlist-and-rethrow catch(es) in per-item loops, over its baseline of 1');
    for (const label of ['Why:', 'Fix:', 'src/core/item-failure.ts', 'classifyItemFailure / ItemRun', 'test/pathological/', 'See:  docs/TESTING.md#pathological-states']) {
      expect(bad.stderr).toContain(label);
    }
    const good = runGuard(makeTree(files, `${HEADER}\nsrc/a.ts\t2\n`));
    expect({ code: good.code, stdout: good.stdout.trim() }).toEqual({ code: 0, stdout: 'OK: item allowlist catches match scripts/item-allowlist-catches-baseline.tsv (2 site(s) in 1 file(s))' });
  });

  test('--update rewrites the baseline from the tree, keeping the comment preamble', () => {
    const root = makeTree({ 'src/b.ts': site, 'src/a.ts': site }, `# shrink-only\n${HEADER}\nsrc/a.ts\t3\nsrc/z.ts\t1\n`);
    expect(runGuard(root).code).toBe(1);
    expect(runGuard(root, ['--update']).code).toBe(0);
    expect(readFileSync(join(root, 'scripts/item-allowlist-catches-baseline.tsv'), 'utf8')).toBe(`# shrink-only\n${HEADER}\nsrc/a.ts\t1\nsrc/b.ts\t1\n`);
    expect(runGuard(root).code).toBe(0);
  });
});
