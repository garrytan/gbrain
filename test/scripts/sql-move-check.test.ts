/**
 * scripts/sql-move-check.mjs — the byte-identical SQL gate for engine-sql modules.
 *
 * Protects: the claim "every statement moved or copied into src/core/engine-sql/ is byte-identical to the text it
 * came from", which the no-behaviour-change landings rest on.
 * Fails when: an identical copy stops passing, a one-character change to a copied statement stops failing, a
 * statement written as a quoted string (not a template) goes unchecked, or the removed-statement half stops
 * flagging a statement that left src/ without a new home.
 * Seams: a throwaway git repo with a base commit and a head commit; the script runs against it with `--repo`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
