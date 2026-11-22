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

  test('literal bracket-access calls count like the dot spelling', () => {
    const c = countFile([
      'declare const e: any, db: any;',
      'e["executeRaw"]("SELECT 1");',
      'e[`executeRawJsonb`]("UPDATE pages SET frontmatter = $1::jsonb", [o]);',
      'db["unsafe"](text);',
      'db["query"]("SELECT id FROM pages");',
      'e[name]("SELECT 1");',
    ].join('\n'));
    expect(c.execute_raw).toBe(2);
    expect(c.driver_call).toBe(2);
  });

  test('an executeRaw tag counts once, as execute_raw', () => {
    expect(countFile('declare const e: any;\ne.executeRaw`SELECT id FROM pages`;')).toEqual({ execute_raw: 1, sql_template: 0, driver_call: 0 });
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

  // Value: protects=SQL built by concatenation, interpolation, casts or wrapped callees still counts; fails_when=literalText or calleeName stops unwrapping a supported form; why_new=earlier cases use direct literals and plain callees only; seam=none
  test('concatenated, interpolated and wrapped SQL still counts; non-SQL text does not', () => {
    const c = countFile([
      'declare const db: any, e: any, t: string;',
      'db.query("SELECT id " + "FROM pages WHERE slug = " + t);',
      'db.query(`SELECT ${t} FROM pages`);',
      'db.query(("SELECT 1") as string);',
      '(db.query)("SELECT 1");',
      'db!.unsafe(t);',
      '(e!.executeRaw)("SELECT 1");',
      'db.query("hello " + t);',
      'db.exec(`say ${t} twice`);',
    ].join('\n'));
    expect(c).toEqual({ execute_raw: 1, sql_template: 0, driver_call: 5 });
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

  test('a missing baseline fails closed', () => {
    const root = tree(RAW.baseline, { 'src/core/a.ts': site });
    rmSync(join(root, RAW.baseline));
    const r = run(RAW.guard, root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('baseline file missing');
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

  // Value: protects=a baseline row with a bad count or shape fails instead of loosening the ratchet; fails_when=parseRows accepts zero, negative, fractional or text counts, wrong columns or an empty path; why_new=the malformed case above covers unknown metrics only; seam=none
  test('rows with a bad count, the wrong column count or an empty path are malformed', () => {
    for (const row of ['src/core/a.ts\texecute_raw\t0', 'src/core/a.ts\texecute_raw\t-1', 'src/core/a.ts\texecute_raw\t1.5',
      'src/core/a.ts\texecute_raw\tone', 'src/core/a.ts\texecute_raw', 'src/core/a.ts\texecute_raw\t1\twhy\textra', '\texecute_raw\t1']) {
      const root = tree(RAW.baseline, { [RAW.baseline]: `# baseline\nsrc/core/a.ts\texecute_raw\t1\n${row}\n`, 'src/core/a.ts': site });
      const r = run(RAW.guard, root);
      expect(r.code, row).toBe(1);
      expect(r.out, row).toContain('malformed row');
    }
  });

  test('a raised row with a note passes; --prune keeps the note; an empty note is malformed', () => {
    const raised = tree(RAW.baseline, {
      [RAW.baseline]: '# baseline\nsrc/core/a.ts\texecute_raw\t1\tfix #1: needs one read until links move\n',
      'src/core/a.ts': site,
    });
    expect(run(RAW.guard, raised).code).toBe(0);
    const stale = tree(RAW.baseline, {
      [RAW.baseline]: '# baseline\nsrc/core/a.ts\texecute_raw\t3\tfix #1: why\n',
      'src/core/a.ts': site,
    });
    run(RAW.guard, stale, ['--prune']);
    expect(readFileSync(join(stale, RAW.baseline), 'utf8')).toBe('# baseline\nsrc/core/a.ts\texecute_raw\t1\tfix #1: why\n');
    const empty = tree(RAW.baseline, {
      [RAW.baseline]: '# baseline\nsrc/core/a.ts\texecute_raw\t1\t \n',
      'src/core/a.ts': site,
    });
    const r = run(RAW.guard, empty);
    expect(r.code).toBe(1);
    expect(r.out).toContain('the note column is empty');
  });

  test('a rise names both ways out: a typed method, or a raised row with a note', () => {
    const root = tree(RAW.baseline, { 'src/core/a.ts': site });
    const r = run(RAW.guard, root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('call a typed engine method');
    expect(r.out).toContain('with a note column saying why');
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

  // Value: protects=bracket, backtick and wrapped spellings of an engine-kind branch still count; fails_when=isKindExpr or isKindLiteral stops unwrapping one of these forms; why_new=the case above uses dot access and quoted literals only; seam=none
  test('bracket access, backtick literals and wrapped subjects count too', () => {
    const c = countKinds([
      'declare const e: any, kind: any;',
      'e["kind"] === "pglite";',
      'e[`engineKind`] === "postgres";',
      'kind === `postgres`;',
      '(e.kind as string) === "pglite";',
      'e!.engine !== "postgres";',
      'e["mode"] === "pglite";',
      'switch ((e.kind)) { case `pglite`: break; }',
    ].join('\n'));
    expect(c).toEqual({ kind_compare: 5, kind_case: 1 });
  });

  test('an exhaustive switch whose default asserts never does not count; an incomplete one does', () => {
    const exhaustive = (tail: string) => countKinds([
      "type Kind = 'pglite' | 'postgres'; declare const kind: Kind; declare function assertNever(x: never): never;",
      `switch (kind) { case 'pglite': break; case 'postgres': break; default: ${tail} }`,
    ].join('\n')).kind_case;
    expect(exhaustive('{ const unreachable: never = kind; throw new Error(String(unreachable)); }')).toBe(0);
    expect(exhaustive('assertNever(kind);')).toBe(0);
    expect(exhaustive('kind satisfies never; throw new Error("unreachable");')).toBe(0);
    expect(exhaustive('return assertNever(kind);')).toBe(0);
    expect(exhaustive('throw assertNever(kind);')).toBe(0);
    expect(exhaustive('throw new Error("unknown engine");')).toBe(2);
    // A cast or a never check on another value proves nothing.
    expect(exhaustive('void (kind as never);')).toBe(2);
    expect(exhaustive('{ declare const other: never; const x: never = other; }')).toBe(2);
    expect(exhaustive('assertNever(other as never);')).toBe(2);
    // The check must be the clause's first statement: earlier control flow can
    // narrow the value to never after an unknown kind has already escaped.
    expect(exhaustive('{ if (kind) return 2; const unreachable: never = kind; return unreachable; }')).toBe(2);
    expect(exhaustive('console.log(kind); assertNever(kind);')).toBe(2);
    expect(exhaustive('throw new Error(String(kind satisfies never));')).toBe(2);
    // A never check in a nested function, or on a name that shadows the
    // switched value, says nothing about the outer switch.
    expect(exhaustive('{ const check = (kind: never) => kind satisfies never; return 2; }')).toBe(2);
    expect(exhaustive('{ const check = (kind: never) => { const u: never = kind; }; return 2; }')).toBe(2);
    expect(countKinds([
      "type Kind = 'pglite' | 'postgres'; declare const kind: Kind;",
      "switch (kind) { case 'pglite': const kind2 = 1; break; case 'postgres': { break; } default: { const unreachable: never = kind; const kind = 0 as never; } }",
    ].join('\n')).kind_case).toBe(2);
    expect(countKinds([
      "declare const engine: { kind: 'pglite' | 'postgres' };",
      "switch (engine.kind) { case 'pglite': let engine = { kind: 0 as never }; break; case 'postgres': break; default: const u: never = engine.kind; }",
    ].join('\n')).kind_case).toBe(2);
    expect(countKinds([
      "declare const engine: { kind: 'pglite' | 'postgres' };",
      "switch (engine.kind) { case 'pglite': break; case 'postgres': break; default: const u: never = engine.kind; }",
    ].join('\n')).kind_case).toBe(0);
    // A switch that leaves a kind out keeps counting even with a never check that does not compile.
    expect(countKinds("declare const kind: 'pglite' | 'postgres';\nswitch (kind) { case 'pglite': break; default: break; }").kind_case).toBe(1);
    expect(countKinds("declare const kind: string;\nswitch (kind) { case 'pglite': break; case 'postgres': break; }").kind_case).toBe(2);
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

