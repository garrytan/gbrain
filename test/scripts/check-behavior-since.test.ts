/**
 * check:behavior-since (scripts/check-behavior-since.ts): a BEHAVIOR_CHANGES
 * row with since: 'TBD' passes on an unstamped development branch and is
 * refused on a stamped tree (VERSION has a CHANGELOG release header and differs
 * from the base ref's), on master, and under --stamped (release:restamp's drift
 * check and the Release workflow). release:restamp rewrites the rows first.
 * Fixtures are throwaway git repos; origin/master is a local ref.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main, NOTICE_FILE, tbdLines } from '../../scripts/check-behavior-since.ts';
import { DEFAULT_CHECKS } from '../../scripts/release-restamp.ts';
import { BEHAVIOR_NOTICE_FILE, restampSinceLines, stampTbdSince } from '../../scripts/lib/restamp.ts';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function put(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function notice(...sinces: string[]): string {
  return ['export const BEHAVIOR_CHANGES = [', ...sinces.map((since, i) => '  { since: \'' + since + '\', text: \'Row ' + i + '.\' },'), '];', ''].join('\n');
}

function changelog(...versions: string[]): string {
  return '# Changelog\n\n' + versions.map((v) => '## [' + v + '] - 2026-10-20\n\nEntry.\n').join('\n');
}

function commit(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

/** A repo whose origin/master is at 0.60.322.0 with only released rows, checked out on a feature branch. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-behavior-since-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'master');
  git(root, 'config', 'user.email', 't@t.co');
  git(root, 'config', 'user.name', 't');
  put(root, { VERSION: '0.60.322.0\n', 'CHANGELOG.md': changelog('0.60.322.0'), [NOTICE_FILE]: notice('0.60.321.0', '0.60.322.0') });
  commit(root, 'master');
  git(root, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'feature');
  return root;
}

function run(root: string, argv: string[] = [], env: Record<string, string> = {}): { code: number; out: string } {
  const lines: string[] = [];
  const code = main(argv, { cwd: root, env, log: (line) => lines.push(line) });
  return { code, out: lines.join('\n') };
}

describe('check:behavior-since', () => {
  test('an unstamped branch (VERSION equals origin/master) may carry TBD rows', () => {
    const root = repo();
    put(root, { [NOTICE_FILE]: notice('0.60.321.0', '0.60.322.0', 'TBD') });
    commit(root, 'feature');
    const r = run(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('unstamped branch');
  });

  test('a stamped tree with one TBD row is refused with a fix line', () => {
    const root = repo();
    put(root, { VERSION: '0.60.323.0\n', 'CHANGELOG.md': changelog('0.60.323.0', '0.60.322.0'), [NOTICE_FILE]: notice('0.60.321.0', '0.60.322.0', '0.60.323.0', 'TBD') });
    commit(root, 'stamp by hand, one row missed');
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: 1 BEHAVIOR_CHANGES row(s)');
    expect(r.out).toContain('line 5');
    expect(r.out).toContain('a stamped tree');
    expect(r.out).toContain("Fix:  run bun run release:restamp");
    expect(r.out).toContain("since: '0.60.323.0'");
  });

  test('a stamped tree whose rows carry the release passes', () => {
    const root = repo();
    put(root, { VERSION: '0.60.323.0\n', 'CHANGELOG.md': changelog('0.60.323.0', '0.60.322.0'), [NOTICE_FILE]: notice('0.60.322.0', '0.60.323.0', '0.60.323.0') });
    commit(root, 'stamp');
    expect(run(root).code).toBe(0);
  });

  test('--stamped refuses any TBD row, even on an unstamped branch, and passes without one', () => {
    const root = repo();
    expect(run(root, ['--stamped']).code).toBe(0);
    put(root, { [NOTICE_FILE]: notice('0.60.322.0', 'TBD') });
    commit(root, 'feature');
    const r = run(root, ['--stamped']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('a tree being stamped or released');
  });

  test('--stamped refuses when the registry is missing (a sparse checkout without it)', () => {
    const root = repo();
    rmSync(join(root, NOTICE_FILE));
    expect(run(root, ['--stamped']).code).toBe(1);
  });

  test('master refuses a TBD row: by GITHUB_REF, by HEAD at the base, and when the base itself ships one', () => {
    const root = repo();
    put(root, { [NOTICE_FILE]: notice('0.60.322.0', 'TBD') });
    commit(root, 'feature');
    expect(run(root, [], { GITHUB_REF: 'refs/heads/master' }).code).toBe(1);
    git(root, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
    const atBase = run(root);
    expect(atBase.code).toBe(1);
    expect(atBase.out).toContain('the base ref origin/master itself');
    put(root, { 'README.md': 'later\n' });
    commit(root, 'a branch off a master that ships TBD');
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('already ships a TBD row');
  });

  test('without the base ref: refused under CI, skipped locally', () => {
    const root = repo();
    put(root, { [NOTICE_FILE]: notice('0.60.322.0', 'TBD') });
    commit(root, 'feature');
    git(root, 'update-ref', '-d', 'refs/remotes/origin/master');
    expect(run(root, [], { CI: 'true' }).code).toBe(1);
    const local = run(root);
    expect(local.code).toBe(0);
    expect(local.out).toContain('GBRAIN_CHECK_SKIPPED');
  });

  test('unknown arguments are a usage error', () => {
    expect(run(repo(), ['--nope']).code).toBe(2);
  });
});

describe('release:restamp and the TBD rows', () => {
  test('stampTbdSince gives every TBD row the new version and leaves released rows alone', () => {
    const text = notice('0.60.322.0', 'TBD', 'TBD');
    const stamped = stampTbdSince(text, '0.60.323.0');
    expect(tbdLines(stamped)).toEqual([]);
    expect(stamped).toBe(notice('0.60.322.0', '0.60.323.0', '0.60.323.0'));
    expect(stampTbdSince(stamped, '0.60.324.0')).toBe(stamped);
    expect(BEHAVIOR_NOTICE_FILE).toBe(NOTICE_FILE);
  });

  test('restampSinceLines moves only branch-added rows from the old version to the new one', () => {
    const text = notice('0.60.323.0', '0.60.323.0', '0.60.323.0');
    expect(restampSinceLines(text, new Set([3, 4]), '0.60.323.0', '0.60.324.0')).toBe(notice('0.60.323.0', '0.60.324.0', '0.60.324.0'));
    expect(restampSinceLines(text, new Set([3]), '0.60.324.0', '0.60.324.0')).toBe(text);
  });

  test("restamp's drift checks run the guard with --stamped", () => {
    expect(DEFAULT_CHECKS.map((c) => c.argv.join(' '))).toContain('bun scripts/check-behavior-since.ts --stamped');
  });
});
