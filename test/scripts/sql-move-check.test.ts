/**
 * scripts/sql-move-check.mjs — the byte-identical SQL gate for engine-sql modules.
 *
 * Protects: the claim "every statement moved or copied into src/core/engine-sql/ is byte-identical to the text it
 * came from", which the no-behaviour-change landings rest on.
 * Fails when: an identical copy stops passing, a one-character change to a copied statement stops failing, a
 * statement written as a quoted string (not a template) goes unchecked, or the removed-statement half stops
 * flagging a statement that left src/ without a new home.
 * Seams: a throwaway git repo with a base commit and a head commit; the script runs against it with `--repo`. The last
 * describe reads the real repository files: the eleven statements that split-a copied into src/core/engine-sql/ must
 * stay byte-identical to the text still inline in the files they came from.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '..', '..', 'scripts/sql-move-check.mjs');

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'sql-move-check-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function git(...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}
function put(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(resolve(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}
function commit(msg: string): void {
  git('add', '-A');
  git('commit', '-q', '-m', msg);
}
function check(...extra: string[]) {
  const r = spawnSync('node', [SCRIPT, '--base', 'base', '--head', 'HEAD', '--repo', repo, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const CALLER = 'export const A = `SELECT id, slug FROM pages WHERE source_id = $1`;\nexport const B = "DELETE FROM takes WHERE page_id = $1";\n';

function baseRepo(): void {
  git('init', '-q', '-b', 'main');
  put('src/core/caller.ts', CALLER);
  commit('base');
  git('tag', 'base');
}

describe('sql-move-check', () => {
  it('passes a copy whose statements are byte-identical to the caller text, quoted strings included', () => {
    baseRepo();
    put('src/core/engine-sql/copy.ts', CALLER.replace(/A =/, 'COPY_A =').replace(/B =/, 'COPY_B ='));
    commit('copy');
    const { code, out } = check('--removed-paths', 'none');
    expect(out).toContain('RESULT: PASS');
    expect(out).toContain('NOT-IDENTICAL: 0');
    expect(out).toContain('IDENTICAL (byte-identical): 2');
    expect(code).toBe(0);
  });

  it('fails a copy that changes one character of a template statement', () => {
    baseRepo();
    put('src/core/engine-sql/copy.ts', 'export const A = `SELECT id, slug FROM pages WHERE source_id = $2`;\n');
    commit('copy');
    const { code, out } = check('--removed-paths', 'none');
    expect(out).toMatch(/^NOT-IDENTICAL/m);
    expect(out).toContain('RESULT: FAIL');
    expect(code).toBe(1);
  });

  it('fails a copy that changes a statement written as a quoted string', () => {
    baseRepo();
    put('src/core/engine-sql/copy.ts', 'export const B = "DELETE FROM takes WHERE page_id = $2";\n');
    commit('copy');
    const { code, out } = check('--removed-paths', 'none');
    expect(out).toMatch(/^NOT-IDENTICAL/m);
    expect(code).toBe(1);
  });

  it('flags a statement removed from a caller that has no new home', () => {
    baseRepo();
    put('src/core/caller.ts', 'export const A = `SELECT id, slug FROM pages WHERE source_id = $1`;\n');
    put('src/core/engine-sql/other.ts', 'export const A2 = `SELECT id, slug FROM pages WHERE source_id = $1`;\n');
    commit('drop one');
    const { code, out } = check();
    expect(out).toMatch(/^NO-NEW-HOME/m);
    expect(code).toBe(1);
  });

  it('fails a lowercase copy that drops a predicate', () => {
    baseRepo();
    put('src/core/caller.ts', 'export const L = `select id from pages where source_id = $1`;\n');
    commit('lowercase caller');
    git('tag', '-f', 'base');
    put('src/core/engine-sql/copy.ts', 'export const L = `select id from pages`;\n');
    commit('copy');
    const { code, out } = check('--removed-paths', 'none');
    expect(out).toMatch(/^NOT-IDENTICAL/m);
    expect(out).toContain('RESULT: FAIL');
    expect(code).toBe(1);
  });

  // The lexer must not mistake the slashes inside a regular expression for a comment: the SQL after it on the same
  // line would go unchecked and a changed copy would pass with nothing compared.
  for (const [name, prefix] of [
    ['an escaped slash', 'const slash = /\\//;'],
    ['a slash inside a character class', 'const slash = /[//]x/g;'],
    ['a regular expression after return', 'function f(s: string) { return /\\//.test(s); }'],
    ['a regular expression after an if condition', 'if (ready) /\\//.test(path);'],
    ['a regular expression after a while condition', 'while (more()) /[//]/.exec(path);'],
  ] as const) {
    it(`still checks a statement written after ${name} on the same line`, () => {
      baseRepo();
      put('src/core/caller.ts', `export const A = \`SELECT id FROM pages WHERE source_id = $1\`;\n`);
      commit('caller');
      git('tag', '-f', 'base');
      put('src/core/engine-sql/copy.ts', `${prefix} export const COPY_A = \`SELECT id FROM pages\`;\n`);
      commit('copy');
      const { code, out } = check('--removed-paths', 'none');
      expect(out).toMatch(/^NOT-IDENTICAL/m);
      expect(out).toContain('RESULT: FAIL');
      expect(code).toBe(1);
    });
  }

  it('still skips a real line comment that follows a division', () => {
    baseRepo();
    put('src/core/engine-sql/copy.ts', 'const half = total / 2; // "SELECT nothing FROM nowhere"\nexport const A = `SELECT id, slug FROM pages WHERE source_id = $1`;\n');
    commit('copy');
    const { code, out } = check('--removed-paths', 'none');
    expect(out).toContain('IDENTICAL (byte-identical): 1');
    expect(out).toContain('RESULT: PASS');
    expect(code).toBe(0);
  });
});

// The eleven statements #9812 copied into engine-sql, each found by the text it starts with, and the file that held
// the inline text. #9812 kept the inline copies until the cut that switches the callers over; on this branch that cut
// is done (the callers delegate to engine-sql), so each row now pins the single home: the statement is in engine-sql
// and its old origin no longer holds it.
const REPO = resolve(import.meta.dir, '..', '..');
const COPIED: { module: string; start: string; origin: string }[] = [
  { module: 'code-traversal-cache', start: 'SELECT response_json, computed_at', origin: 'code-intel/traversal-cache.ts' },
  { module: 'code-traversal-cache', start: 'INSERT INTO code_traversal_cache', origin: 'code-intel/traversal-cache.ts' },
  { module: 'code-traversal-cache', start: 'WITH deleted AS (DELETE FROM code_traversal_cache RETURNING 1)', origin: 'code-intel/traversal-cache.ts' },
  { module: 'code-traversal-cache', start: 'WITH deleted AS (\n       DELETE FROM code_traversal_cache WHERE source_id', origin: 'code-intel/traversal-cache.ts' },
  { module: 'wanted-links', start: 'SELECT id FROM sources WHERE id = ANY', origin: 'wanted-links-store.ts' },
  { module: 'wanted-links', start: 'DELETE FROM wanted_links w', origin: 'wanted-links-store.ts' },
  { module: 'wanted-links', start: 'INSERT INTO wanted_links\n', origin: 'wanted-links-store.ts' },
  { module: 'takes', start: 'SELECT k.row_num FROM takes k', origin: 'persistence/canonical-projections.ts' },
  { module: 'takes', start: 'DELETE FROM takes WHERE page_id=$1 AND row_num=ANY', origin: 'persistence/canonical-projections.ts' },
  { module: 'timeline', start: 'DELETE FROM timeline_entries t USING jsonb_to_recordset', origin: 'persistence/canonical-projections.ts' },
  { module: 'timeline', start: 'UPDATE timeline_entries t SET detail=r.next', origin: 'persistence/canonical-projections.ts' },
];

/** The literal (template or quoted string) in `src` that begins right after a quote at `start`, or null. */
function literalStartingWith(src: string, start: string): string | null {
  for (const quote of ['`', "'"]) {
    const at = src.indexOf(quote + start);
    if (at < 0) continue;
    const end = src.indexOf(quote, at + 1);
    if (end > at) return src.slice(at + 1, end);
  }
  return null;
}

describe('sql-move-check: the real engine-sql copies', () => {
  // test-reads-source-ok[structural]: the claim under test is where a statement's text lives (engine-sql only), so the text itself is the subject.
  const read = (rel: string) => readFileSync(join(REPO, 'src/core', rel), 'utf8');

  it('lists eleven statements', () => {
    expect(COPIED.length).toBe(11);
  });

  for (const { module, start, origin } of COPIED) {
    it(`${module}: \"${start.replace(/\n/g, ' ').slice(0, 44)}\" lives in engine-sql only; ${origin} no longer holds it`, () => {
      const text = literalStartingWith(read(`engine-sql/${module}.ts`), start);
      expect(text).not.toBeNull();
      expect(read(origin)).not.toContain(text!);
    });
  }
});
