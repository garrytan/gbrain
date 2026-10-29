/**
 * The ignore filter in front of check-ignore (src/core/persistence/ignore-rules.ts). Protects:
 *   - soundness: over generated rule sets (nested .gitignore files, info/exclude, core.excludesFile, negations,
 *     wildcards, brackets, `**`, dir-only and anchored rules, escapes, trailing spaces, case) every path
 *     `git check-ignore` ignores is returned for Git to decide, and the filter still clears many of the others;
 *   - an edit of a .gitignore, info/exclude or the excludes file, or a changed core.excludesFile setting, is seen on the
 *     next call;
 *   - Git decides whenever the filter cannot see what Git reads: a sparse checkout, a skip-worktree entry, a gitlink or
 *     a symlinked directory on the path, a version 4 index holding a gitlink;
 *   - the index scan reads versions 2, 3 and 4.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitChildEnv } from '../src/core/git-env.ts';
import { ignoreCandidates, resetIgnoreCandidatesForTests, scanIndex } from '../src/core/persistence/ignore-rules.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: gitChildEnv() }).trim();
const roots: string[] = [];
afterEach(() => { resetIgnoreCandidatesForTests(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** Keeps the developer's global and system Git config and global ignore file out of the test: the filter reads what Git reads. */
const hermetic = (fn: () => unknown) => () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-git-config-')));
  roots.push(home);
  return withEnv({ XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }, async () => { await fn(); });
};

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-ignore-rules-')));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  return root;
}
function put(root: string, path: string, body = 'x\n'): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
/** The paths Git ignores among `paths`, from the checkout's own check-ignore (index included). */
function gitIgnored(root: string, paths: string[]): Set<string> {
  try {
    const out = execFileSync('git', ['-C', root, 'check-ignore', '-z', '--stdin'], { input: paths.map(path => path + '\0').join(''), env: gitChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    return new Set(out.toString('utf8').split('\0').filter(Boolean));
  } catch (error) {
    if ((error as { status?: number }).status === 1) return new Set();
    throw error;
  }
}

/** Deterministic generator (mulberry32). */
function random(seed: number): () => number {
  return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

const NAMES = ['notes', 'Notes', 'drafts', 'a', 'b', 'cache-1', 'keep.log', 'x.md', 'y.LOG', 'page.tmp', '.DS_Store', 'node_modules', 'dist', 'sub', 'page.md', 'foo bar', 'é.md', 'ab', 'abc.md', 'Build'];
const RULES = ['notes', 'NOTES/', '*.log', '!keep.log', '*.tmp', '/dist', 'dist/', 'a/b', 'a/**/x.md', '**/drafts', 'sub/**', 'cache-*', '?b', '[ab]*.md', 'a/*/page.md',
  '#notes', 'page.md   ', '\\#lit', 'x\\.md', '*', '!*.md', 'node_modules/', '.DS_Store', 'foo bar', 'é.md', '/a/', 'ab*c.md', 'Build/', '**', '!sub/', 'b/', '/notes/drafts/', 'NOTES', 'y.log'];

describe('ignore filter', () => {
  test('every path check-ignore ignores is returned for Git, over generated rule sets; many others are cleared', hermetic(async () => {
    const next = random(7);
    const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)]!;
    let cleared = 0, total = 0;
    for (let round = 0; round < 40; round++) {
      const root = repo();
      if (next() < 0.3) git(root, 'config', 'core.ignoreCase', 'true');
      const paths = new Set<string>();
      while (paths.size < 30) paths.add(Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(NAMES)).join('/'));
      const dirs = new Set([...paths].flatMap(path => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
      const rules = (count: number) => Array.from({ length: count }, () => pick(RULES)).join('\n') + '\n';
      const placed: string[] = [];
      for (const path of paths) {
        if ([...paths].some(other => other.startsWith(path + '/'))) continue;
        try { put(root, path); placed.push(path); } catch { /* a file where another path needs a directory */ }
      }
      const tracked = placed.filter(() => next() < 0.15);
      if (tracked.length) git(root, 'add', '-f', '--', ...tracked);
      writeFileSync(join(root, '.gitignore'), rules(2 + Math.floor(next() * 4)));
      for (const dir of dirs) if (next() < 0.3) { try { writeFileSync(join(root, dir, '.gitignore'), rules(1 + Math.floor(next() * 2))); } catch { /* not a directory */ } }
      if (next() < 0.5) writeFileSync(join(root, '.git', 'info', 'exclude'), rules(1));
      if (next() < 0.5) { const file = `${root}-excludes`; roots.push(file); writeFileSync(file, rules(1)); git(root, 'config', 'core.excludesFile', file); }
      const listed = [...paths];
      const ignored = gitIgnored(root, listed);
      const candidates = new Set(await ignoreCandidates(root, listed));
      for (const path of ignored) expect({ path, rules: readFileSync(join(root, '.gitignore'), 'utf8'), candidate: candidates.has(path) }).toMatchObject({ candidate: true });
      total += listed.length;
      cleared += listed.length - candidates.size;
    }
    expect(cleared).toBeGreaterThan(total / 10);
  }), 120_000);

  test('an edit of a .gitignore, info/exclude or the excludes file, or a new core.excludesFile, is seen on the next call', hermetic(async () => {
    const root = repo();
    put(root, 'notes/a.md'); put(root, '.gitignore', 'scratch/\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
    put(root, 'notes/.gitignore', 'new*\n');
    expect(await ignoreCandidates(root, ['notes/new.md', 'notes/other.md'])).toEqual(['notes/new.md']);
    put(root, 'notes/.gitignore', 'old*\n');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'notes/n*.md\n');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual(['notes/new.md']);
    writeFileSync(join(root, '.git', 'info', 'exclude'), '');
    const excludes = join(root, '.git', 'personal-excludes');
    writeFileSync(excludes, '*.md\n');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
    git(root, 'config', 'core.excludesFile', excludes);
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual(['notes/new.md']);
    writeFileSync(excludes, '*.txt\n');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
  }));

  test('Git decides on a sparse checkout, a skip-worktree entry, a gitlink or symlinked directory on the path, and a version 4 gitlink', hermetic(async () => {
    const root = repo();
    put(root, 'notes/a.md'); put(root, 'notes/b.md'); put(root, 'real/c.md');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
    git(root, 'update-index', '--skip-worktree', 'notes/b.md');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual(['notes/new.md']);
    git(root, 'update-index', '--no-skip-worktree', 'notes/b.md');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
    git(root, 'config', 'core.sparseCheckout', 'true');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual(['notes/new.md']);
    git(root, 'config', '--unset', 'core.sparseCheckout');
    symlinkSync(join(root, 'real'), join(root, 'linked'));
    expect(await ignoreCandidates(root, ['linked/new.md', 'notes/new.md'])).toEqual(['linked/new.md']);
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${git(root, 'rev-parse', 'HEAD')},vendor/lib`);
    expect(await ignoreCandidates(root, ['vendor/lib/new.md', 'vendor/other.md', 'notes/new.md'])).toEqual(['vendor/lib/new.md']);
    git(root, 'update-index', '--index-version', '4');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual(['notes/new.md']);
    git(root, 'update-index', '--force-remove', 'vendor/lib');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
  }));

  test('the index scan reads versions 2, 3 and 4 and names version 2 and 3 gitlinks', hermetic(() => {
    const root = repo();
    for (let i = 0; i < 50; i++) put(root, `dir-${i % 7}/${'long-name-'.repeat(i % 5)}page-${i}.md`);
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${git(root, 'rev-parse', 'HEAD')},dir-3/module`);
    const index = join(root, '.git', 'index');
    expect(scanIndex(readFileSync(index), 20)).toEqual({ decidable: true, gitlinks: new Set(['dir-3/module']) });
    put(root, 'dir-1/new.md');
    git(root, 'add', '--intent-to-add', '--', 'dir-1/new.md');
    expect(readFileSync(index).readUInt32BE(4)).toBe(3);
    expect(scanIndex(readFileSync(index), 20)).toEqual({ decidable: true, gitlinks: new Set(['dir-3/module']) });
    git(root, 'update-index', '--index-version', '4');
    expect(scanIndex(readFileSync(index), 20).decidable).toBe(false);
    git(root, 'update-index', '--force-remove', 'dir-3/module');
    expect(scanIndex(readFileSync(index), 20)).toEqual({ decidable: true, gitlinks: new Set() });
    expect(scanIndex(Buffer.from('not an index'), 20).decidable).toBe(false);
  }));

  // Generated by /ship Step 7 coverage audit (gstack), test-only.
  // Value: protects=a core.excludesFile set in an included config file (a relative include.path) is read, and an edit of that file is seen;
  //   fails_when=the probe stops resolving include paths or watching included files, so a stale probe clears a path Git now ignores;
  //   why_new=excludes edits are tested only through .git/config; seam=none; no_claim=includeIf conditions (onbranch, gitdir) are not exercised
  test('a core.excludesFile set through an included config file, and an edit of that file, is seen on the next call', hermetic(async () => {
    const root = repo();
    put(root, 'notes/a.md');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
    const markdown = join(root, '.git', 'markdown-excludes'), text = join(root, '.git', 'text-excludes');
    writeFileSync(markdown, '*.md\n'); writeFileSync(text, '*.txt\n');
    const included = join(root, '.git', 'included.gitconfig');
    writeFileSync(included, `[core]\n\texcludesFile = ${text}\n`);
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
    git(root, 'config', 'include.path', 'included.gitconfig');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
    writeFileSync(included, `[core]\n\texcludesFile = ${markdown}\n`);
    expect(gitIgnored(root, ['notes/new.md'])).toEqual(new Set(['notes/new.md']));
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual(['notes/new.md']);
    writeFileSync(included, `[core]\n\texcludesFile = ${text}\n`);
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
  }));

  // Generated by /ship Step 7 coverage audit (gstack), test-only.
  // Value: protects=a split index (entries and skip-worktree bits in the shared index file) is left to Git; fails_when=scanIndex accepts the
  //   required 'link' extension, so the filter decides without seeing the shared entries; why_new=sparse, skip-worktree and v4 are tested, a split
  //   index is not; seam=none; no_claim=a sparse index (sdir extension) is not exercised
  test('a split index is left to Git', hermetic(async () => {
    const root = repo();
    put(root, 'notes/a.md');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
    git(root, 'update-index', '--split-index');
    expect(scanIndex(readFileSync(join(root, '.git', 'index')), 20).decidable).toBe(false);
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual(['notes/new.md']);
    git(root, 'update-index', '--no-split-index');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
  }));

  // Generated by /ship Step 7 coverage audit (gstack), test-only.
  // Value: protects=a checkout whose branch switches into an includeIf onbranch config that sets core.excludesFile is probed again, so Git
  //   decides the path; fails_when=the probe stops watching HEAD, so a cached probe clears a path Git now ignores; why_new=only config-file edits
  //   invalidate the probe in the tests above; seam=none; no_claim=includeIf gitdir conditions are not exercised
  test('switching onto a branch whose includeIf onbranch config sets core.excludesFile is seen on the next call', hermetic(async () => {
    const root = repo();
    put(root, 'notes/a.md');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
    const excludes = join(root, '.git', 'branch-excludes');
    writeFileSync(excludes, '*.md\n');
    writeFileSync(join(root, '.git', 'feature.gitconfig'), `[core]\n\texcludesFile = ${excludes}\n`);
    git(root, 'config', 'includeIf.onbranch:feature.path', 'feature.gitconfig');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
    git(root, 'checkout', '-q', '-b', 'feature');
    expect(gitIgnored(root, ['notes/new.md'])).toEqual(new Set(['notes/new.md']));
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual(['notes/new.md']);
    git(root, 'checkout', '-q', 'main');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
  }));

  // Generated by /ship Step 7 coverage audit (gstack), test-only.
  // Value: protects=a relative core.excludesFile, or an include path whose expansion the filter does not reproduce, leaves every path to Git;
  //   fails_when=a relative excludesFile is resolved beside the config file instead of left to Git, or an unresolved include stops marking the probe undecidable;
  //   why_new=only absolute excludesFile and include paths are tested; seam=none; no_claim=the %(prefix) include names no real file
  test('a relative core.excludesFile or an include path the filter cannot expand leaves Git to decide', hermetic(async () => {
    const root = repo();
    put(root, 'notes/a.md');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
    put(root, 'personal-ignore', '*.md\n');
    git(root, 'config', 'core.excludesFile', 'personal-ignore');
    expect(gitIgnored(root, ['notes/new.md'])).toEqual(new Set(['notes/new.md']));
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual(['notes/new.md']);
    git(root, 'config', '--unset', 'core.excludesFile');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual([]);
    git(root, 'config', 'include.path', '%(prefix)/etc/example-included.gitconfig');
    expect(await ignoreCandidates(root, ['notes/new.md'])).toEqual(['notes/new.md']);
  }));
});
