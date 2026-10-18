/**
 * Wave B large pages (spec 4.2): scripts/check-chunk-visibility.ts fails on a
 * new `FROM/JOIN content_chunks` reader without the generation predicate, on
 * stale, duplicate and malformed baseline rows and on an empty marker reason;
 * a covered reader (direct call, same-file helper, visibility clause with a
 * chunk alias, marker) never counts, and `--prune` only lowers rows.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-chunk-visibility.ts');
const BASELINE = 'scripts/chunk-visibility-baseline.tsv';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-chunk-visibility-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries({ [BASELINE]: '# baseline\n', ...files })) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function run(root: string, args: string[] = []) {
  const r = spawnSync('bun', [GUARD, ...args], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: root } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('check-chunk-visibility.ts', () => {
  test('an uncovered reader fails with its file, lines and the fix; writes and prose never count', () => {
    const root = tree({
      'src/core/reader.ts': [
        "export const a = 'SELECT id FROM content_chunks WHERE page_id = $1';",
        'export const b = `SELECT p.slug FROM pages p JOIN content_chunks cc ON cc.page_id = p.id`;',
        "export const del = 'DELETE FROM content_chunks WHERE page_id = $1';",
        '// prose: rows from content_chunks are read elsewhere',
      ].join('\n'),
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: src/core/reader.ts:1 2 content_chunks reader(s) without the chunk-visibility predicate (lines 1, 2), the baseline allows 0');
    for (const label of ["Fix:  add ${chunkVisibleFilter('p', 'cc')}", 'Why:', 'See:  scripts/check-chunk-visibility.ts (header)']) {
      expect(r.out).toContain(label);
    }
  });

  test('direct calls, same-file helpers, a chunk-aliased visibility clause and markers cover a reader', () => {
    const root = tree({
      'src/core/covered.ts': [
        "import { chunkVisibleFilter, chunkGenerationFilter, chunkGenerationProbe } from './safe-chunks.ts';",
        "import { buildVisibilityClause } from './sql-ranking.ts';",
        "export const direct = `SELECT 1 FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE ${chunkVisibleFilter('p', 'cc')}`;",
        "export const probe = `SELECT 1 FROM content_chunks cc WHERE ${chunkGenerationProbe('cc')}`;",
        "const live = chunkGenerationFilter('p', 'cc');",
        'const where = `AND ${live}`;',
        'export const viaHelper = `SELECT 1 FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE true ${where}`;',
        "export const clause = `SELECT 1 FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE ${buildVisibilityClause('p', 's', { chunkAlias: 'cc' })}`;",
        "export const sqlMarker = 'SELECT count(*) FROM content_chunks -- chunk-visibility-ok: storage statistics';",
        '// chunk-visibility-ok: code pages are never segmented',
        "export const lineMarker = 'SELECT id FROM content_chunks WHERE symbol_name_qualified = $1';",
      ].join('\n'),
    });
    const r = run(root);
    expect(r.out).toContain('check-chunk-visibility: ok (6 covered, 0 baselined content_chunks readers)');
    expect(r.code).toBe(0);
  });

  test('a visibility clause without a chunk alias does not cover a reader', () => {
    const root = tree({
      'src/core/pages-only.ts': "export const q = `SELECT 1 FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE ${buildVisibilityClause('p', 's')}`;",
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: src/core/pages-only.ts:1 1 content_chunks reader(s)');
  });

  test('an empty marker reason fails', () => {
    const root = tree({
      'src/core/empty.ts': "// chunk-visibility-ok:\nexport const q = 'SELECT id FROM content_chunks';",
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: src/core/empty.ts:1 chunk-visibility-ok marker has no reason');
  });

  test('a baselined reader passes; a stale, duplicate or malformed row fails; --prune only lowers', () => {
    const reader = "export const a = 'SELECT id FROM content_chunks';\nexport const b = 'SELECT id FROM content_chunks';";
    expect(run(tree({ 'src/core/r.ts': reader, [BASELINE]: '# baseline\nsrc/core/r.ts\t2\n' })).code).toBe(0);

    const staleRoot = tree({ 'src/core/r.ts': reader, [BASELINE]: '# baseline\nsrc/core/r.ts\t3\nsrc/core/gone.ts\t1\n' });
    const stale = run(staleRoot);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('stale row: src/core/r.ts has 2 uncovered content_chunks reader(s), the row allows 3');
    expect(stale.out).toContain('stale row: src/core/gone.ts has 0 uncovered');
    expect(run(staleRoot, ['--prune']).code).toBe(0);
    expect(readFileSync(join(staleRoot, BASELINE), 'utf8')).toBe('# baseline\nsrc/core/r.ts\t2\n');
    expect(run(staleRoot).code).toBe(0);

    const dup = run(tree({ 'src/core/r.ts': reader, [BASELINE]: '# baseline\nsrc/core/r.ts\t2\nsrc/core/r.ts\t2\n' }));
    expect(dup.code).toBe(1);
    expect(dup.out).toContain('duplicate row for src/core/r.ts');

    const bad = run(tree({ 'src/core/r.ts': reader, [BASELINE]: '# baseline\nsrc/core/r.ts\ttwo\n' }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("malformed row 'src/core/r.ts\ttwo'");

    const grown = tree({ 'src/core/r.ts': `${reader}\nexport const c = 'SELECT id FROM content_chunks';`, [BASELINE]: '# baseline\nsrc/core/r.ts\t2\n' });
    expect(run(grown).code).toBe(1);
    run(grown, ['--prune']);
    expect(readFileSync(join(grown, BASELINE), 'utf8')).toBe('# baseline\nsrc/core/r.ts\t2\n');
  });

  test('a missing baseline fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-chunk-visibility-'));
    dirs.push(root);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL: ${BASELINE}:1 baseline file missing`);
  });
});
