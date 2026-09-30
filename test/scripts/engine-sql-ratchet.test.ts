/**
 * Refactor wave 1, goal (a): scripts/check-engine-sql-ratchet.ts fails on a
 * new SQL-bearing engine member, on stale / duplicate baseline rows and on a
 * migrated domain with no engine-sql module. Detection matches SQL structure
 * in literal text only, so prose and comments never count.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-engine-sql-ratchet.ts');
const BASELINE = 'scripts/engine-sql-baseline.tsv';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-engine-sql-ratchet-'));
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

const flagged = (out: string) => [...out.matchAll(/new SQL-bearing engine member (\S+)/g)].map((m) => m[1]).sort();

describe('check-engine-sql-ratchet.ts: SQL structure detection', () => {
  test('every structural form is SQL-bearing, whatever the unit kind', () => {
    const root = tree({
      'src/core/pglite-engine/facts.ts': [
        'export function selectAcrossPieces(cols: string) { return `SELECT ${cols} FROM pages`; }',
        'export function insertInto() { return "INSERT INTO facts (a) VALUES ($1)"; }',
        'export function updateAliasSet() { return "UPDATE pages p SET title = $1"; }',
        'export function deleteFrom() { return "DELETE FROM facts WHERE id = $1"; }',
        'export function withCte() { return "WITH ranked AS (SELECT 1) SELECT 2"; }',
        'export function createUniqueIndex() { return "CREATE UNIQUE INDEX IF NOT EXISTS i ON t (c)"; }',
        'export function dropTable() { return "DROP TABLE facts"; }',
        'export function truncate() { return "TRUNCATE facts"; }',
        'export function setConfig() { return "SELECT set_config(\'app.scopes\', $1, true)"; }',
        'export function concatenated(w: string) { return "SELECT slug " + w + " FROM pages"; }',
        'export function lowercaseWithSignal() { return "select * from pages"; }',
        'export function paramCast(n: number) { return `te.date >= $${n}::date`; }',
        'export function setLocal() { return "SET LOCAL statement_timeout = \'8s\'"; }',
        'export const arrowConst = () => "SELECT id FROM pages";',
        'declare const sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown;',
        'export async function taggedTemplate(slug: string) { return sql`SELECT id FROM pages WHERE slug = ${slug}`; }',
      ].join('\n'),
      'src/core/postgres-engine.ts': [
        'export class PostgresEngine {',
        '  get countSql() { return "SELECT count(*) FROM pages"; }',
        '  arrowProp = () => "DELETE FROM links WHERE id = $1";',
        '  constructor() { void "ALTER TABLE pages ADD COLUMN x TEXT"; }',
        '}',
      ].join('\n'),
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(flagged(r.out)).toEqual([
      'PostgresEngine.arrowProp', 'PostgresEngine.constructor', 'PostgresEngine.countSql',
      'arrowConst', 'concatenated', 'createUniqueIndex', 'deleteFrom', 'dropTable', 'insertInto',
      'lowercaseWithSignal', 'paramCast', 'selectAcrossPieces', 'setConfig', 'setLocal', 'taggedTemplate',
      'truncate', 'updateAliasSet', 'withCte',
    ]);
    expect(r.out).toContain('FAIL: src/core/pglite-engine/facts.ts:1 new SQL-bearing engine member selectAcrossPieces');
    for (const label of ['Fix:  put the SQL in src/core/engine-sql/facts.ts and delegate', 'Why:', 'See:  docs/TESTING.md#engine-sql-ratchet']) {
      expect(r.out).toContain(label);
    }
  });

  test('prose, comments, identifiers and Title Case never count', () => {
    const root = tree({
      'src/core/postgres-engine.ts': [
        'export class PostgresEngine {',
        '  a() { return "Select a file"; }',
        '  b() { throw new Error("could not delete from cache"); }',
        '  c() { return "select a file from disk"; }',
        '  d() { return "Update the page, then set a title"; }',
        '  e() { /* SELECT slug FROM pages */ return 1; }',
        '  f() { const selectFromPages = 1; return selectFromPages; }',
        '  g() { return "Create table of contents"; }',
        '}',
      ].join('\n'),
    });
    const r = run(root);
    expect(r.out).toContain('check-engine-sql-ratchet: ok (0 baseline methods, 0 migrated domains)');
    expect(r.code).toBe(0);
  });
});

describe('check-engine-sql-ratchet.ts: baseline and marker rules', () => {
  const engine = (body: string) => `export class PostgresEngine {\n${body}\n}\n`;

  test('a baselined member passes; the key is the name, never the line', () => {
    const root = tree({
      [BASELINE]: 'migrated\tfacts\nmethod\tsrc/core/postgres-engine.ts\tPostgresEngine.getPage\n',
      'src/core/engine-sql/facts.ts': 'export const x = 1;\n',
      'src/core/postgres-engine.ts': engine('\n\n\n  getPage() { return "SELECT * FROM pages"; }'),
    });
    const r = run(root);
    expect(r.out).toContain('check-engine-sql-ratchet: ok (1 baseline methods, 1 migrated domains)');
    expect(r.code).toBe(0);
  });

  test('marker on the declaration line or the line above exempts; an empty reason fails', () => {
    const ok = tree({
      'src/core/postgres-engine.ts': engine([
        '  // engine-sql-ok: lock probe stays with the engine',
        '  lock() { return "SELECT pg_advisory_lock(1)"; }',
        '  unlock() { return "SELECT pg_advisory_unlock(1)"; } // engine-sql-ok: paired with lock',
      ].join('\n')),
    });
    expect(run(ok).code).toBe(0);
    const empty = tree({
      'src/core/postgres-engine.ts': engine('  // engine-sql-ok:\n  lock() { return "SELECT pg_advisory_lock(1)"; }'),
    });
    const r = run(empty);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: src/core/postgres-engine.ts:2 engine-sql-ok marker on PostgresEngine.lock has no reason');
  });

  test('stale rows fail: member gone, no longer SQL-bearing, or now marked', () => {
    const root = tree({
      [BASELINE]: [
        'method\tsrc/core/postgres-engine.ts\tPostgresEngine.gone',
        'method\tsrc/core/postgres-engine.ts\tPostgresEngine.plain',
        'method\tsrc/core/postgres-engine.ts\tPostgresEngine.marked',
      ].join('\n'),
      'src/core/postgres-engine.ts': engine([
        '  plain() { return 1; }',
        '  // engine-sql-ok: moved out of the ratchet on purpose',
        '  marked() { return "SELECT 1"; }',
      ].join('\n')),
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL: ${BASELINE}:1 stale row: src/core/postgres-engine.ts PostgresEngine.gone no longer exists`);
    expect(r.out).toContain('PostgresEngine.plain is no longer SQL-bearing');
    expect(r.out).toContain('PostgresEngine.marked now carries an engine-sql-ok marker');
    expect(r.out).toContain('Fix:  delete this line; rows only shrink');
  });

  test('duplicate, malformed and unbacked migrated rows fail', () => {
    const root = tree({
      [BASELINE]: [
        'method\tsrc/core/postgres-engine.ts\tPostgresEngine.getPage',
        'method\tsrc/core/postgres-engine.ts\tPostgresEngine.getPage',
        'migrated\ttakes',
        'method\tonly-two-columns',
      ].join('\n'),
      'src/core/postgres-engine.ts': engine('  getPage() { return "SELECT * FROM pages"; }'),
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL: ${BASELINE}:2 duplicate row`);
    expect(r.out).toContain(`FAIL: ${BASELINE}:3 migrated domain 'takes' has no src/core/engine-sql/takes.ts`);
    expect(r.out).toContain(`FAIL: ${BASELINE}:4 malformed row`);
  });

  test('--prune drops stale and duplicate rows only and never adds a row', () => {
    const root = tree({
      [BASELINE]: [
        '# header stays',
        'method\tsrc/core/postgres-engine.ts\tPostgresEngine.getPage',
        'method\tsrc/core/postgres-engine.ts\tPostgresEngine.getPage',
        'method\tsrc/core/postgres-engine.ts\tPostgresEngine.gone',
        '',
      ].join('\n'),
      'src/core/postgres-engine.ts': engine([
        '  getPage() { return "SELECT * FROM pages"; }',
        '  newSql() { return "DELETE FROM pages WHERE id = $1"; }',
      ].join('\n')),
    });
    expect(run(root, ['--prune']).code).toBe(0);
    expect(readFileSync(join(root, BASELINE), 'utf8')).toBe('# header stays\nmethod\tsrc/core/postgres-engine.ts\tPostgresEngine.getPage\n');
    const r = run(root);
    expect(r.code).toBe(1);
    expect(flagged(r.out)).toEqual(['PostgresEngine.newSql']);
  });
});
