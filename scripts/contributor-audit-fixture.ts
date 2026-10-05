#!/usr/bin/env bun
/**
 * scripts/contributor-audit-fixture.ts — builds the tiny offline repository
 * that `bun run audit:contributors` is demonstrated and tested on.
 *
 *   bun scripts/contributor-audit-fixture.ts <empty-dir>
 *
 * The range <base>..<head> holds six merges, each a shape the audit must tell
 * apart, plus one open PR that conflicts with head:
 *
 *   #101 fix clamp     product fix + a test that pins it      → discriminates
 *   #102 greet suffix  product change + a test that never calls it → does_not_discriminate
 *   #103 parse ints    product change + a test that is red at head → setup_failed
 *   #104 docs          README only                            → not_audited (no_product_change)
 *   #106 score note    a comment + a test that only #107 makes green → does_not_discriminate
 *                      (a whole-file revert would also drop #107's fix and call it discriminating)
 *   #107 fix score     product fix, no test change            → not_audited (no_tests)
 *   PR #105            rewrites the clamp line #101 fixed     → conflict
 *
 * No package.json, so nothing installs and nothing touches the network.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Fixture { dir: string; base: string; head: string; prsManifest: string }

const SCORE = '// score helpers\nexport function score(): number {\n  const a = 1;\n  const b = 1;\n  const c = 1;\n  const d = 1;\n  return 0;\n}\n';

export function buildFixture(dir: string): Fixture {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (rel: string, body: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
  const as = (who: string) => { git('config', 'user.name', who); git('config', 'user.email', `${who}@example.invalid`); };
  const commit = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg); };
  const mergePr = (n: number, branch: string, who: string, change: () => void) => {
    git('checkout', '-qb', branch, 'master');
    as(who);
    change();
    commit(`${branch}: contributor change`);
    git('checkout', '-q', 'master');
    as('maintainer-example');
    git('merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${n} from ${who}/${branch}`);
  };

  mkdirSync(dir, { recursive: true });
  git('init', '-q', '-b', 'master');
  git('config', 'commit.gpgsign', 'false');
  as('maintainer-example');
  write('README.md', '# audit fixture\n');
  write('src/clamp.ts', 'export function clamp(x: number, lo: number, hi: number): number {\n  return x;\n}\n');
  write('src/greet.ts', 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n');
  write('src/parse.ts', 'export function parseInts(s: string): number[] {\n  return [];\n}\n');
  write('src/score.ts', SCORE.replace('// score helpers\n', ''));
  commit('base');
  const base = git('rev-parse', 'HEAD');

  mergePr(101, 'fix-clamp', 'alice-example', () => {
    write('src/clamp.ts', 'export function clamp(x: number, lo: number, hi: number): number {\n  return Math.min(hi, Math.max(lo, x));\n}\n');
    write('test/clamp.test.ts', "import { expect, test } from 'bun:test';\nimport { clamp } from '../src/clamp';\n\ntest('clamps into range', () => {\n  expect(clamp(15, 0, 10)).toBe(10);\n  expect(clamp(-3, 0, 10)).toBe(0);\n});\n");
  });
  mergePr(102, 'greet-suffix', 'charlie-example', () => {
    write('src/greet.ts', 'export function greet(name: string): string {\n  return `hello ${name}!`;\n}\n');
    write('test/greet.test.ts', "import { expect, test } from 'bun:test';\nimport { greet } from '../src/greet';\n\ntest('greet exists', () => {\n  expect(typeof greet).toBe('function');\n});\n");
  });
  mergePr(103, 'parse-ints', 'dana-example', () => {
    write('src/parse.ts', "export function parseInts(s: string): number[] {\n  return s.split(',').map(Number);\n}\n");
    write('test/parse.test.ts', "import { expect, test } from 'bun:test';\nimport { parseInts } from '../src/parse';\n\ntest('parses a list', () => {\n  expect(parseInts('1,2')).toEqual([1, 2, 3]);\n});\n");
  });
  mergePr(104, 'docs', 'erin-example', () => write('README.md', '# audit fixture\n\nA tiny repository for the contributor audit.\n'));
  mergePr(106, 'score-note', 'gina-example', () => {
    write('src/score.ts', SCORE);
    write('test/score.test.ts', "import { expect, test } from 'bun:test';\nimport { score } from '../src/score';\n\ntest('scores two', () => {\n  expect(score()).toBe(2);\n});\n");
  });
  mergePr(107, 'fix-score', 'hana-example', () => write('src/score.ts', SCORE.replace('return 0;', 'return a + b;')));
  const head = git('rev-parse', 'HEAD');

  git('checkout', '-qb', 'pr-105', base);
  as('frank-example');
  write('src/clamp.ts', 'export function clamp(x: number, lo: number, hi: number): number {\n  return x < lo ? lo : x > hi ? hi : x;\n}\n');
  commit('pr-105: alternative clamp');
  git('checkout', '-q', 'master');

  const prsManifest = join(dir, 'prs.json');
  writeFileSync(prsManifest, JSON.stringify({ prs: [{ number: 105, ref: 'refs/heads/pr-105' }] }, null, 2) + '\n');
  return { dir, base, head, prsManifest };
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('usage: bun scripts/contributor-audit-fixture.ts <empty-dir>\n');
    process.exit(2);
  }
  const f = buildFixture(resolve(target));
  const tool = join(import.meta.dir, 'contributor-audit.ts');
  process.stdout.write(`Built ${f.dir}. Audit it with:\n\n  cd ${f.dir} && bun ${tool} ${f.base.slice(0, 9)}..${f.head.slice(0, 9)} --prs prs.json --skip-security --skip-lanes\n`);
}
