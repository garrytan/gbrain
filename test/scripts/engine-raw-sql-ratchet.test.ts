/**
 * D6 (docs/designs/RUST_ENGINE.md): scripts/check-engine-raw-sql-ratchet.ts
 * counts raw SQL per file under src/ outside the engines and fails when a
 * count rises above its baseline row, when a file has no row, or when a count
 * falls without its row falling too. The engine-kind branch ratchet shares the
 * same runner (scripts/lib/count-ratchet.ts) and is covered here too.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { countFile, isEngineFile } from '../../scripts/check-engine-raw-sql-ratchet.ts';
import { countFile as countKinds } from '../../scripts/check-engine-kind-branches.ts';

const REPO = resolve(import.meta.dir, '..', '..');
const RAW = { guard: join(REPO, 'scripts', 'check-engine-raw-sql-ratchet.ts'), baseline: 'scripts/engine-raw-sql-baseline.tsv' };
const KIND = { guard: join(REPO, 'scripts', 'check-engine-kind-branches.ts'), baseline: 'scripts/engine-kind-branches-baseline.tsv' };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(baselineRel: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-engine-raw-sql-ratchet-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries({ [baselineRel]: '# baseline\n', ...files })) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function run(guard: string, root: string, args: string[] = []) {
  const r = spawnSync('bun', [guard, ...args], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: root } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('check-engine-raw-sql-ratchet.ts: what counts', () => {
  test('executeRaw, executeRawDirect and executeRawJsonb count on any receiver', () => {
    const c = countFile([
      'declare const engine: any, tx: any, exec: any;',
      'engine.executeRaw("SELECT 1");',
      'tx.executeRawDirect(q);',
      'exec.executeRawJsonb("UPDATE pages SET frontmatter = $1::jsonb", [o]);',
      'const f = engine.executeRaw;',
    ].join('\n'));
    expect(c.execute_raw).toBe(3);
  });

  test('SQL tagged templates count; non-SQL templates and comments do not', () => {
    const c = countFile([
      'declare const sql: any, html: any;',
      'sql`SELECT id FROM pages WHERE slug = ${s}`;',
      'html`<p>select a page from the list</p>`;',
      '// sql`SELECT id FROM pages`',
      'const plain = `SELECT id FROM pages`;',
    ].join('\n'));
    expect(c.sql_template).toBe(1);
    expect(c.execute_raw).toBe(0);
  });

  test('driver_call: unsafe always, query and exec only with SQL text', () => {
    const c = countFile([
      'declare const db: any, re: any;',
      'db.unsafe(text);',
      'db.query("SELECT id FROM pages WHERE id = $1", [1]);',
      'db.exec("CREATE TABLE t (a int)");',
      'db.query(text);',
      're.exec("hello world");',
    ].join('\n'));
    expect(c.driver_call).toBe(3);
  });

  test('the engines are out of scope; everything else under src/ is in', () => {
    for (const rel of [
      'src/core/engine.ts', 'src/core/pglite-engine.ts', 'src/core/postgres-engine.ts',
      'src/core/pglite-engine/pages.ts', 'src/core/postgres-engine/facts.ts', 'src/core/engine-sql/pages.ts',
    ]) expect(isEngineFile(rel)).toBe(true);
    for (const rel of ['src/core/search/hybrid.ts', 'src/commands/doctor.ts', 'src/core/engine-factory.ts'])
      expect(isEngineFile(rel)).toBe(false);
  });
});

describe('check-engine-raw-sql-ratchet.ts: shrink-only baseline', () => {
  const site = 'declare const e: any;\nexport const a = () => e.executeRaw("SELECT 1");\n';

  test('a matching baseline passes and engine files are never counted', () => {
    const root = tree(RAW.baseline, {
      [RAW.baseline]: '# baseline\nsrc/core/a.ts\texecute_raw\t1\n',
      'src/core/a.ts': site,
      'src/core/engine-sql/pages.ts': site + site,
      'src/core/pglite-engine.ts': site,
    });
    const r = run(RAW.guard, root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('check-engine-raw-sql-ratchet: ok (1 sites in 1 files: execute_raw 1, sql_template 0, driver_call 0)');
  });

  test('a rise above the row fails with the fix', () => {
    const root = tree(RAW.baseline, {
      [RAW.baseline]: '# baseline\nsrc/core/a.ts\texecute_raw\t1\n',
      'src/core/a.ts': site + 'export const b = () => e.executeRaw("SELECT 2");\n',
    });
    const r = run(RAW.guard, root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: src/core/a.ts execute_raw: baseline 1, actual 2');
    expect(r.out).toContain('typed engine method');
  });

  test('a new file with no row fails', () => {
    const root = tree(RAW.baseline, { 'src/commands/new.ts': site });
    const r = run(RAW.guard, root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: src/commands/new.ts execute_raw: baseline 0, actual 1');
  });

  test('a stale row fails, and --prune lowers it without raising anything', () => {
    const root = tree(RAW.baseline, {
      [RAW.baseline]: '# baseline\nsrc/core/a.ts\texecute_raw\t3\nsrc/core/gone.ts\tsql_template\t2\n',
      'src/core/a.ts': site,
    });
    const r = run(RAW.guard, root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('stale row: src/core/a.ts execute_raw: baseline 3, actual 1');
    expect(r.out).toContain('stale row: src/core/gone.ts sql_template: baseline 2, actual 0');
    const p = run(RAW.guard, root, ['--prune']);
    expect(p.out).toContain('pruned 2 row(s)');
    expect(readFileSync(join(root, RAW.baseline), 'utf8')).toBe('# baseline\nsrc/core/a.ts\texecute_raw\t1\n');
    expect(run(RAW.guard, root).code).toBe(0);
  });

  test('--prune never adds a row for a rise', () => {
    const root = tree(RAW.baseline, { 'src/core/a.ts': site });
    run(RAW.guard, root, ['--prune']);
    expect(readFileSync(join(root, RAW.baseline), 'utf8')).toBe('# baseline\n');
    expect(run(RAW.guard, root).code).toBe(1);
  });

  test('duplicate and malformed rows fail', () => {
    const root = tree(RAW.baseline, {
      [RAW.baseline]: '# baseline\nsrc/core/a.ts\texecute_raw\t1\nsrc/core/a.ts\texecute_raw\t1\nsrc/core/b.ts\tnot_a_metric\t1\n',
      'src/core/a.ts': site,
    });
    const r = run(RAW.guard, root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('duplicate row for src/core/a.ts execute_raw');
    expect(r.out).toContain('malformed row');
  });

  test('--print emits the current rows in the baseline format', () => {
    const root = tree(RAW.baseline, { 'src/core/a.ts': site, 'src/b.ts': 'declare const sql: any;\nsql`DELETE FROM pages`;\n' });
    const r = spawnSync('bun', [RAW.guard, '--print'], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: root } });
    expect(r.stdout).toBe('src/b.ts\tsql_template\t1\nsrc/core/a.ts\texecute_raw\t1\n');
  });
});

describe('check-engine-kind-branches.ts', () => {
  test('counts two-way comparisons and switch cases on engine-kind names only', () => {
    const c = countKinds([
      'declare const engine: any, cfg: any, kind: string, opts: any, mode: string;',
      'engine.kind === "pglite";',
      '"postgres" !== cfg.engine;',
      'kind == "pglite";',
      'opts.engineKind != "postgres";',
      'mode === "pglite";',
      'engine.kind === "sqlite";',
      'switch (engine.kind) { case "pglite": break; case "postgres": break; default: break; }',
      'switch (mode) { case "pglite": break; }',
    ].join('\n'));
    expect(c.kind_compare).toBe(4);
    expect(c.kind_case).toBe(2);
  });

  test('a new branch outside the engines fails; inside the engines it is ignored', () => {
    const root = tree(KIND.baseline, {
      'src/core/pglite-engine.ts': 'declare const e: any;\nexport const x = e.kind === "pglite";\n',
      'src/core/b.ts': 'declare const e: any;\nexport const x = e.kind === "postgres";\n',
    });
    const r = run(KIND.guard, root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: src/core/b.ts kind_compare: baseline 0, actual 1');
    expect(r.out).toContain('capability');
  });

  test('a matching baseline passes', () => {
    const root = tree(KIND.baseline, {
      [KIND.baseline]: '# baseline\nsrc/core/b.ts\tkind_compare\t1\n',
      'src/core/b.ts': 'declare const e: any;\nexport const x = e.kind === "postgres";\n',
    });
    expect(run(KIND.guard, root).code).toBe(0);
  });
});

