/**
 * #7759: the door keeps its own paths literal per path (`:(literal)<path>`), never with git's global
 * `--literal-pathspecs` flag, which git exports to every hook and child process as GIT_LITERAL_PATHSPECS=1.
 * Protects:
 *   - a repository pre-commit guard that selects files by glob pathspec refuses `gbrain git commit-push` exactly as it
 *     refuses a plain git commit (red before: the guard's '*.json' matched nothing, so a JSON file with conflict
 *     markers was committed and pushed); the refusal leaves HEAD, the index and the remote as they were;
 *   - no hook of a commit-push, and no child of the persistence door (clean filter, receive-pack), sees
 *     GIT_LITERAL_PATHSPECS, also when gbrain's own environment sets it; the door's session runs no repository hook;
 *   - files literally named with glob characters or a leading colon commit alone, never the files their glob or magic
 *     reading matches, through commit-push, the Git effect and the plumbing door.
 * Seams: none; real repositories and a bare remote, the real CLI for commit-push.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { commitGitTargets, pushGitRoot } from '../src/core/persistence/effect-git.ts';
import { commitThroughDoor } from '../src/core/persistence/git-door.ts';
import { hashFile } from '../src/core/persistence/large-file.ts';
import { gitChildEnv, GIT_PATHSPEC_ENV_VARS } from '../src/core/git-env.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const env = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const dirs: string[] = [];
const scratch = (name: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), `gbrain-7759-${name}-`))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function put(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
function script(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}

/** A checkout on main with `files` committed, its own core.hooksPath outside the worktree (a global one cannot hide it), and optionally a bare origin. */
function checkout(files: Record<string, string>, remote: boolean): { root: string; bare: string | null; hooks: string; log: string } {
  const dir = scratch('repo');
  const root = join(dir, 'work');
  git(dir, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  git(root, 'config', 'core.hooksPath', join(dir, 'hooks'));
  for (const [path, body] of Object.entries({ 'seed.md': 'seed\n', ...files })) put(root, path, body);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  let bare: string | null = null;
  if (remote) {
    bare = join(dir, 'origin.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', '-u', 'origin', 'main');
  }
  return { root, bare, hooks: join(dir, 'hooks'), log: join(dir, 'hooks.log') };
}
const logLines = (log: string) => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
const commitPaths = (root: string, rev = 'HEAD') => git(root, 'show', '--name-only', '--format=', '-z', rev).split('\0').filter(Boolean).sort();
const cli = (root: string, args: string[], extra: Record<string, string> = {}) =>
  runCli(['git', 'commit-push', '--path', root, '--json', ...args], { home: scratch('home'), env: { GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', ...extra } });

const CONFLICTED = '{\n<<<<<<< ours\n  "a": 1\n=======\n  "a": 2\n>>>>>>> theirs\n}\n';

/** The issue's guard: lists staged JSON files by glob pathspec and refuses any that holds conflict markers. */
function installGlobGuard(hooks: string, log: string): void {
  script(join(hooks, 'pre-commit'), `files=$(git diff --cached --name-only -- '*.json' '*.jsonl')
echo "pre-commit files=[$(echo $files)]" >> '${log}'
for f in $files; do
  if git show ":$f" | grep -qE '^(<<<<<<<|=======|>>>>>>>)'; then echo "pre-commit guard: conflict markers in $f" >&2; exit 1; fi
done
exit 0
`);
}

test('gitChildEnv drops Git\'s global pathspec switches; a caller may still set one explicitly', () => {
  const source = { ...Object.fromEntries(GIT_PATHSPEC_ENV_VARS.map(key => [key, '1'])), PATH: '/usr/bin' };
  expect(gitChildEnv({}, source)).toEqual({ PATH: '/usr/bin' });
  expect(gitChildEnv({ GIT_LITERAL_PATHSPECS: '1' }, source)).toEqual({ PATH: '/usr/bin', GIT_LITERAL_PATHSPECS: '1' });
});

describe('a glob-pathspec pre-commit guard holds for gbrain git commit-push', () => {
  test('a plain git commit and the door commit both refuse; nothing reaches HEAD, the index or the remote', async () => {
    const { root, bare, hooks, log } = checkout({}, true);
    installGlobGuard(hooks, log);
    put(root, 'bad.json', CONFLICTED);
    const head = git(root, 'rev-parse', 'HEAD');
    git(root, 'add', 'bad.json');
    expect(() => git(root, 'commit', '-m', 'plain')).toThrow();
    git(root, 'reset', '-q', '--', 'bad.json');

    const refused = await cli(root, ['-m', 'bad', '--', 'bad.json']);
    expect(refused.exitCode).toBe(1);
    const envelope = JSON.parse(refused.stdout) as { code: string; message: string; suggestion: string };
    expect(envelope.code).toBe('git_unavailable');
    expect(envelope.message).toContain('git commit failed');
    expect(envelope.suggestion).toContain('pre-commit guard: conflict markers in bad.json');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(bare!, 'rev-parse', 'main')).toBe(head);
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('?? bad.json');
    expect(logLines(log)).toEqual(['pre-commit files=[bad.json]', 'pre-commit files=[bad.json]']);

    put(root, 'good.json', '{ "a": 1 }\n');
    const pushed = await cli(root, ['-m', 'good', '--', 'good.json']);
    expect(pushed.exitCode).toBe(0);
    expect(JSON.parse(pushed.stdout)).toMatchObject({ outcome: 'pushed', confirmed: 'push', paths: ['good.json'] });
    expect(commitPaths(bare!, 'main')).toEqual(['good.json']);
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('?? bad.json');
  });

  test('a checkout with no remote refuses too and commits nothing', async () => {
    const { root, hooks, log } = checkout({}, false);
    installGlobGuard(hooks, log);
    put(root, 'notes/bad.jsonl', CONFLICTED);
    const head = git(root, 'rev-parse', 'HEAD');
    const refused = await cli(root, ['-m', 'bad', '--', 'notes/bad.jsonl']);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'git_unavailable' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('?? notes/bad.jsonl');
    expect(logLines(log)).toEqual(['pre-commit files=[notes/bad.jsonl]']);
  });
});

describe('no hook or door child sees GIT_LITERAL_PATHSPECS', () => {
  const probe = (log: string, name: string) => `echo "${name} \${GIT_LITERAL_PATHSPECS-unset}" >> '${log}'\n`;

  for (const inherited of [undefined, '1']) {
    test(`commit-push hooks${inherited ? ' when gbrain\'s own environment sets it' : ''}; a post-commit hook's :(literal) pathspec works`, async () => {
      const { root, bare, hooks, log } = checkout({ 'tracked.txt': 'v1\n' }, true);
      for (const name of ['pre-commit', 'commit-msg', 'pre-push']) script(join(hooks, name), probe(log, name));
      script(join(hooks, 'post-commit'), `${probe(log, 'post-commit')}echo regenerated >> tracked.txt
git add -- ':(literal)tracked.txt' && echo "post-commit add ok" >> '${log}'
`);
      put(root, 'notes/a.md', 'a\n');
      const result = await cli(root, ['-m', 'add a', '--', 'notes/a.md'], inherited ? { GIT_LITERAL_PATHSPECS: inherited } : {});
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'pushed', paths: ['notes/a.md'] });
      expect(commitPaths(bare!, 'main')).toEqual(['notes/a.md']);
      expect(logLines(log)).toEqual(['pre-commit unset', 'commit-msg unset', 'post-commit unset', 'post-commit add ok', 'pre-push unset']);
      expect(git(root, 'status', '--porcelain')).toBe('M  tracked.txt');
    });
  }

  /** A clean filter on *.md that records what its process inherited, and repository hooks that would record a run. */
  function doorProbes(root: string, hooks: string, log: string): void {
    const filter = join(dirname(root), 'clean-probe');
    script(filter, `${probe(log, 'clean')}exec cat\n`);
    git(root, 'config', 'filter.probe.clean', filter);
    put(root, '.gitattributes', '*.md filter=probe\n');
    git(root, 'add', '.gitattributes'); git(root, 'commit', '-qm', 'attributes');
    for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction']) script(join(hooks, name), probe(log, `hook ${name}`));
  }

  test('the Git effect and its push, also when gbrain\'s own environment sets it; the session runs no repository hook', async () => {
    const { root, bare, hooks, log } = checkout({}, true);
    doorProbes(root, hooks, log);
    const receive = join(dirname(root), 'receive-probe');
    script(receive, `${probe(log, 'receive-pack')}exec git-receive-pack "$@"\n`);
    git(root, 'config', 'remote.origin.receivepack', receive);
    for (const inherited of [undefined, '1']) {
      rmSync(log, { force: true });
      put(root, 'notes/a.md', `a ${inherited ?? 'none'}\n`);
      await withEnv({ GIT_LITERAL_PATHSPECS: inherited }, async () => {
        expect((await commitGitTargets(root, ['notes/a.md'])).get('notes/a.md')).toEqual({ git: 'committed' });
        expect(await pushGitRoot(root)).toEqual({ push: 'committed' });
      });
      expect(git(bare!, 'show', 'main:notes/a.md')).toBe(`a ${inherited ?? 'none'}`);
      const lines = logLines(log);
      expect(lines.filter(line => line.startsWith('hook '))).toEqual([]);
      expect([...new Set(lines)]).toEqual(['clean unset', 'receive-pack unset']);
    }
  });

  test('the plumbing door commit, also when gbrain\'s own environment sets it; no repository hook runs', async () => {
    const { root, hooks, log } = checkout({ 'notes/a.md': 'a\n' }, false);
    doorProbes(root, hooks, log);
    for (const inherited of [undefined, '1']) {
      rmSync(log, { force: true });
      put(root, 'notes/a.md', `a ${inherited ?? 'none'}\n`);
      await withEnv({ GIT_LITERAL_PATHSPECS: inherited }, async () => {
        expect(await commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: hashFile(join(root, 'notes/a.md')) }])).toBe(git(root, 'rev-parse', 'HEAD'));
      });
      expect(git(root, 'show', 'HEAD:notes/a.md')).toBe(`a ${inherited ?? 'none'}`);
      expect([...new Set(logLines(log))]).toEqual(['clean unset']);
      expect(git(root, 'status', '--porcelain')).toBe('');
    }
  });
});

describe('paths named with glob characters or a leading colon match literally', () => {
  /** Each literal name has a decoy its glob or pathspec-magic reading would match instead. */
  const LITERAL = ['*.md', 'a?.md', '[x].md', ':lead.md', 'd/*.md'];
  const DECOYS = ['ab.md', 'x.md', 'lead.md', 'd/y.md'];
  const seed = Object.fromEntries([...LITERAL, ...DECOYS, ':gone.md', 'gone.md'].map(path => [path, `${path} v1\n`]));
  /** Edits every literal name and decoy, adds `new[1].md` beside the decoy `new1.md`, and removes `:gone.md`; returns the paths to commit. */
  function edit(root: string): string[] {
    for (const path of [...LITERAL, ...DECOYS]) put(root, path, `${path} v2\n`);
    put(root, 'new[1].md', 'new\n'); put(root, 'new1.md', 'decoy\n');
    unlinkSync(join(root, ':gone.md'));
    return [...LITERAL, 'new[1].md', ':gone.md'];
  }
  const leftOver = (root: string) => execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', env }).split('\n').filter(Boolean).sort();
  const DECOYS_LEFT = [' M ab.md', ' M d/y.md', ' M lead.md', ' M x.md', '?? new1.md'];
  const COMMITTED = ['*.md', ':gone.md', ':lead.md', '[x].md', 'a?.md', 'd/*.md', 'new[1].md'];
  const door = (root: string, paths: string[]) => commitThroughDoor(root, paths.map(path => ({ path: join(root, path), planned: hashFile(join(root, path)) })));

  test('commit-push', () => {
    const { root, bare } = checkout(seed, true);
    const paths = edit(root);
    expect(commitAndPush({ repo: root, cwd: root, paths, message: 'literal names' })).toMatchObject({ outcome: 'pushed', confirmed: 'push' });
    expect(commitPaths(bare!, 'main')).toEqual(COMMITTED);
    expect(git(bare!, 'show', 'main:*.md')).toBe('*.md v2');
    expect(leftOver(root)).toEqual(DECOYS_LEFT);
  });

  test('the Git effect', async () => {
    const { root } = checkout(seed, false);
    const paths = edit(root);
    const results = await commitGitTargets(root, paths);
    for (const path of paths) expect(results.get(path)).toEqual({ git: 'committed' });
    expect(commitPaths(root)).toEqual(COMMITTED);
    expect(leftOver(root)).toEqual(DECOYS_LEFT);
  });

  test('the plumbing door', async () => {
    const { root } = checkout(seed, false);
    expect(await door(root, edit(root))).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(commitPaths(root)).toEqual(COMMITTED);
    expect(git(root, 'show', 'HEAD::lead.md')).toBe(':lead.md v2');
    expect(leftOver(root)).toEqual(DECOYS_LEFT);
  });

  test('the plumbing door asks the ignore rules about a new colon-named file, not the decoy its magic reading names', async () => {
    const { root } = checkout({ '.gitignore': '*lead.md\n!:lead.md\n' }, false);
    put(root, ':lead.md', 'colon page\n');
    expect(await door(root, [':lead.md'])).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(commitPaths(root)).toEqual([':lead.md']);
  });

  /**
   * Value: protects=the Git effect's git_target_ignored refusal of a colon-named file names the rule that ignores it;
   * fails_when=refuseIgnoredTarget drops the ./ prefix, so check-ignore asks about lead.md and the detail falls back to
   * a bare .gitignore; why_new=only the plumbing door's colon check-ignore is covered; seam=none;
   * no_claim=Windows path spelling (real git and repository; Linux only)
   */
  test('the Git effect names the rule that ignores a colon-named file, not the decoy its magic reading names', async () => {
    const { root } = checkout({ '.gitignore': ':lead.md\n' }, false);
    put(root, ':lead.md', 'colon page\n');
    const head = git(root, 'rev-parse', 'HEAD');
    const refusal = (await commitGitTargets(root, [':lead.md'])).get(':lead.md');
    expect(refusal).toMatchObject({ code: 'git_target_ignored', detail: '.gitignore:1: :lead.md' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  });
});
