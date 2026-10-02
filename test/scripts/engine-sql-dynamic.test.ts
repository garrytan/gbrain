/**
 * T-G11 (refactor wave 1, A2b / CQ3 / EO17): scripts/check-engine-sql-dynamic.ts
 * allows only constant text to be spliced into engine-sql SQL, bans composed
 * `$n` placeholders and expanded IN lists, and exempts only the renderer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-engine-sql-dynamic.ts');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PRELUDE = [
  "import { sqlFragment, trustedSql } from './fragment.ts';",
  "import { ENRICH_ORDER_SQL, OTHER_MAP } from '../types.ts';",
  'declare const db: { query(s: string, p?: unknown[]): unknown; unsafe(s: string, p: unknown[]): unknown; executeRaw(s: string, p?: unknown[]): unknown };',
  'declare function executeRawJsonb(e: unknown, s: string, a: unknown[], b: unknown[]): unknown;',
  'declare function unvetted(a: string): string;',
  '',
].join('\n');

function run(body: string, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-engine-sql-dynamic-'));
  dirs.push(root);
  const files = { 'src/core/engine-sql/domain.ts': PRELUDE + body + '\n', ...extra };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const r = spawnSync('bun', [GUARD], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: root } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('check-engine-sql-dynamic.ts: rejected forms', () => {
  test.each([
    ['raw parameter into trustedSql', 'export const f = (col: string) => trustedSql(col);', 'splices text that is not constant'],
    ['let variable into trustedSql', "export function f() { let c = 'slug'; return trustedSql(c); }", 'splices text that is not constant'],
    ['module const that is not a literal', "const C = String(1);\nexport const f = () => trustedSql(C);", 'splices text that is not constant'],
    ['object const without as const', "const M = { a: 'slug' };\nexport const f = (k: 'a') => trustedSql(M[k]);", 'splices text that is not constant'],
    ['imported name outside the allowlist', "export const f = (k: 'a') => trustedSql(OTHER_MAP[k]);", 'splices text that is not constant'],
    ['non-vetted builder call', "export const f = () => trustedSql(unvetted('p'));", 'splices text that is not constant'],
    ['unguarded numeric in a template', 'export const f = (n: number) => trustedSql(`LIMIT ${n}`);', 'splices text that is not constant'],
    ['Number.isFinite checked after the use', 'export function f(n: number) { const t = trustedSql(`LIMIT ${n}`); Number.isFinite(n); return t; }', 'splices text that is not constant'],
    ['conditional with one untrusted branch', "export const f = (b: boolean, c: string) => trustedSql(b ? 'slug' : c);", 'splices text that is not constant'],
    ['vector literal built by join', "export const f = (e: number[]) => trustedSql('[' + e.join(',') + ']');", 'splices text that is not constant'],
    ['$1 in a composed template', 'export const f = (c: string) => `SELECT ${c} FROM pages WHERE slug = $1`;', 'literal $<digit> placeholder in a composed SQL string'],
    ['hand-numbered $${n}', 'export const f = (n: number) => `WHERE slug = $${n}`;', 'literal $<digit> placeholder in a composed SQL string'],
    ['$1 in a sqlFragment template', 'export const f = () => sqlFragment`WHERE slug = $1`;', 'literal $<digit> placeholder in a composed SQL string'],
    ['$1 in a + concatenation', "export const f = (w: string) => 'WHERE slug = $1 ' + w;", 'literal $<digit> placeholder in a concatenated SQL string'],
    ['IN (${...}) in a fragment', 'export const f = (ids: number[]) => sqlFragment`WHERE id IN (${ids})`;', 'expanded IN (...) list built from a substitution'],
    ['IN ( + join concatenation', "export const f = (ids: number[]) => 'WHERE id IN (' + ids.join(',') + ')';", 'expanded IN (...) list built by concatenation'],
    ['value concatenated into .query(', "export const f = (s: string) => db.query('SELECT 1 FROM pages WHERE slug = ' + s);", "untrusted operand 's' concatenated into SQL passed to db.query()"],
    ['template via const into .unsafe(', 'export function f(s: string) { const sql = `SELECT ${s}`; return db.unsafe(sql, []); }', 'untrusted ${s} in SQL passed to db.unsafe()'],
    ['let += into .executeRaw(', "export function f(s: string) { let sql = 'SELECT 1'; sql += s; return db.executeRaw(sql); }", "untrusted 's' appended to SQL passed to db.executeRaw()"],
    ['template as executeRawJsonb second argument', 'export const f = (s: string) => executeRawJsonb(db, `SELECT ${s}`, [], []);', 'untrusted ${s} in SQL passed to executeRawJsonb()'],
  ])('%s fails with FAIL/Fix/Why/See', (_label, body, what) => {
    const r = run(body);
    expect(r.code).toBe(1);
    const lastLine = PRELUDE.split('\n').length + body.split('\n').length - 1;
    const failLine = r.out.split('\n').find((l) => l.startsWith(`FAIL: src/core/engine-sql/domain.ts:${lastLine} `));
    expect(failLine).toContain(what);
    for (const label of ['Fix:', 'Why:', 'See:  docs/TESTING.md#engine-sql-dynamic-sql']) expect(r.out).toContain(label);
  });
});

describe('check-engine-sql-dynamic.ts: allowed forms', () => {
  test('constants, allowlists, vetted builders, guarded numbers and bound values pass', () => {
    const r = run([
      "const ORDER = { recent: 'updated_at DESC' } as const;",
      "const KINDS = ['a', 'b'] as const;",
      "const COLS = 'slug, title';",
      'const COLS_TEMPLATE = `${COLS}, type`;',
      'declare function pageReadFilter(...a: unknown[]): string;',
      'declare function buildRecencyComponentSql(...a: unknown[]): string;',
      'declare function privatePagesFilterFragment(...a: unknown[]): string;',
      'declare function currentCodeEdgeFilter(...a: unknown[]): string;',
      'declare function buildCJKKeywordSql(...a: unknown[]): string;',
      'declare function currentTextProjectionFilter(...a: unknown[]): string;',
      "export function f(o: 'recent', i: 0 | 1, k: 'recent', n: number, ids: number[], live: boolean, slug: string, sql: string, p: unknown[]) {",
      '  if (!Number.isFinite(n)) throw new Error();',
      '  return [',
      "    trustedSql('slug'), trustedSql(ORDER[o]), trustedSql(KINDS[i]), trustedSql(COLS), trustedSql(COLS_TEMPLATE),",
      '    trustedSql(ENRICH_ORDER_SQL[k]),',
      "    trustedSql(pageReadFilter('p')), trustedSql(buildRecencyComponentSql({})), trustedSql(privatePagesFilterFragment('p')),",
      "    trustedSql(currentCodeEdgeFilter('e', true)), trustedSql(buildCJKKeywordSql('q')), trustedSql(currentTextProjectionFilter('c')),",
      "    trustedSql(`LIMIT ${n}`), trustedSql(live ? 'AND deleted_at IS NULL' : ''), trustedSql(`${n}` + ' ROWS'),",
      '    sqlFragment`SELECT slug FROM pages WHERE slug = ${slug} AND id = ANY(${ids}::int[])`,',
      "    db.query('SELECT slug FROM pages WHERE slug = $1', [slug]), db.unsafe(sql, p), db.executeRaw(sql, p),",
      '    db.query(`SELECT ${COLS} FROM pages LIMIT ${n}`),',
      '  ];',
      '}',
    ].join('\n'));
    expect(r.out).toContain('check-engine-sql-dynamic: ok (1 files)');
    expect(r.code).toBe(0);
  });

  test('fragment.ts (the renderer) is exempt, every other file is scanned', () => {
    const renderer = 'export const render = (i: number, s: string[]) => `$${i + 1}` + s[i];\n';
    const exempt = run("export const ok = trustedSql('slug');", { 'src/core/engine-sql/fragment.ts': renderer });
    expect(exempt.code).toBe(0);
    const nested = run("export const ok = trustedSql('slug');", { 'src/core/engine-sql/nested/render.ts': renderer });
    expect(nested.code).toBe(1);
    expect(nested.out).toContain('FAIL: src/core/engine-sql/nested/render.ts:1 literal $<digit> placeholder');
  });
});
