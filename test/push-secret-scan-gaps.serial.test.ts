/**
 * Ways a commit could reach the remote past the push secret scan, found by an outside review of the managed-push gate
 * (#8903). Protects: a commit changing the allowlist a managed root in a subfolder loads is a gate change, and that
 * allowlist's path globs match paths relative to the root; an uncommitted allowlist is honoured (documented: it is the
 * user's local answer to the scan); a strict door commit whose blob a clean filter changed is scanned, and one with a
 * harmless filter still publishes; every commitAndPush scans what it publishes, with or without a scan option, only what
 * the remote lacks, a missing tracking ref included; on a managed worktree the derived write-through only commits, and a
 * commit holding a token behind it shows in doctor git_convergence, whose push fix refuses until it is allowlisted; a replace ref on HEAD changes nothing a Git effect or a
 * door commit holds; a Git effect target whose staged entry another process reset is never reported committed with its
 * old blob, and the retry commits it.
 * Seams: a PATH git wrapper for the index race; real repositories, bare remotes and synthetic credentials otherwise.
 * GBRAIN_HOME, PATH and the file transport switch are process-wide.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commitGitTargets, pushGitRoot } from '../src/core/persistence/effect-git.ts';
import { commitThroughDoor } from '../src/core/persistence/git-door.ts';
import { hashFile } from '../src/core/persistence/large-file.ts';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { rangeSecretRefusal, scanRange } from '../src/core/git/range-secret-scan.ts';
import { resetLedgerCacheForTests } from '../src/core/git/commit-ledger.ts';
import { git } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { gitConvergenceCheck } from '../src/commands/doctor/checks/git-convergence.ts';
import { scanText } from '../src/core/secret-scan.ts';
import { bindSource, createGitCoalescingFixture, harden } from './helpers/git-coalescing-fixture.ts';

const { makeRepo, withBrain, dispose } = createGitCoalescingFixture('scan-gaps');

const token = 'ghp_' + 'Wq3e'.repeat(9);
const dirs: string[] = [];
afterAll(dispose);
afterEach(() => { resetLedgerCacheForTests(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Checkout { home: string; top: string; remote: string }
/** A repository on main, with brain/notes/a.md and b.md, pushed to a bare remote. */
function checkout(): Checkout {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-scan-gaps-'))); dirs.push(home);
  const remote = join(home, 'remote.git'), top = join(home, 'repo');
  git(home, 'init', '-q', '--bare', '-b', 'main', remote);
  mkdirSync(join(top, 'brain', 'notes'), { recursive: true });
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.name', 'Example Writer'); git(top, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(top, 'brain', 'notes', 'a.md'), 'Before a\n');
  writeFileSync(join(top, 'brain', 'notes', 'b.md'), 'Before b\n');
  git(top, 'add', '-A'); git(top, 'commit', '-q', '-m', 'Initial');
  git(top, 'remote', 'add', 'origin', remote); git(top, 'push', '-q', '-u', 'origin', 'main');
  return { home, top, remote };
}
/** A script's plain `git commit`, never through gbrain's write path. */
function scriptCommit(root: string, files: Record<string, string>, message = 'script edit'): string {
  for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); git(root, 'add', '--', path); }
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD').trim();
}
const head = (root: string) => git(root, 'rev-parse', 'HEAD').trim();
const remoteTip = (c: Checkout) => git(c.remote, 'rev-parse', 'refs/heads/main').trim();
const env = (c: Checkout, extra: Record<string, string | undefined> = {}) => ({ GBRAIN_HOME: join(c.home, 'gbrain-home'), GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1',
  DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, ...extra });
const outcome = (run: () => unknown) => Promise.resolve().then(run).then(value => ({ value, code: null as string | null }), (e: { code?: string }) => ({ value: null, code: e.code ?? String(e) }));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const refusalOf = (c: Checkout, root: string, base: string, target: string) => withEnv(env(c), async () => rangeSecretRefusal(root, base, target, scanRange(root, base, target))?.code ?? null);
const tracked = (root: string, commit: string) => git(root, '--no-replace-objects', 'ls-tree', '-r', '--name-only', commit).split('\n').filter(Boolean);
/** A publish that passes no scan option (the options src/core/cycle/derived-write-through.ts passes), on a checkout that is not a managed worktree, so commitAndPush publishes. */
const unscannedPublish = (c: Checkout, body: string) => {
  writeFileSync(join(c.top, 'brain', 'notes', 'b.md'), body);
  return withEnv(env(c), () => outcome(() => commitAndPush({ repo: c.top, cwd: c.top, paths: ['brain/notes/b.md'], message: 'gbrain: derived write-through' })));
};

describe('a managed worktree\'s derived write-through behind a commit holding a token', () => {
  test('commits only; doctor git_convergence warns at once, its push fix refuses publish_secret_found, and an allowlisted fingerprint releases it', () => withBrain('pglite', async ({ engine, home }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    harden(repo);
    const before = git(repo.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!.trim();
    scriptCommit(repo.root, { 'notes/deploy.md': `Deploy token ${token}\n` });
    writeFileSync(join(repo.root, 'notes', 'generated.md'), 'Generated page\n');
    const derived = await outcome(() => commitAndPush({ repo: repo.root, cwd: repo.root, paths: ['notes/generated.md'], message: 'gbrain: derived write-through' }));
    expect(derived).toMatchObject({ code: null, value: { outcome: 'committed_local', managed: true, unpublished: 2 } });
    expect(git(repo.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!.trim()).toBe(before);

    const check = await gitConvergenceCheck(engine);
    expect(check).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--scan-secrets', '--path', repo.root], actor: 'agent' } });
    expect((check!.details as { roots: unknown[] }).roots).toEqual([expect.objectContaining({ root: repo.root, ahead: 2, stranded: true })]);
    const fix = await outcome(() => commitAndPush({ repo: repo.root, cwd: repo.root, paths: [], pushOnly: true, keepCheckout: true }));
    expect(fix.code).toBe('publish_secret_found');
    expect(git(repo.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!.trim()).toBe(before);

    writeFileSync(join(repo.root, '.gbrain-scan-allow'), `${scanText(`Deploy token ${token}\n`)[0]!.fingerprint}\n`);
    expect((await outcome(() => commitAndPush({ repo: repo.root, cwd: repo.root, paths: [], pushOnly: true, keepCheckout: true }))).code).toBeNull();
    expect(git(repo.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!.trim()).toBe(head(repo.root));
    expect((await gitConvergenceCheck(engine))?.status).toBe('ok');
  }), 300_000);
});

describe('a managed root below the repository top level', () => {
  test('a commit changing the root\'s own .gbrain-scan-allow is a gate change, so the secret it hides is not pushed', async () => {
    const c = checkout();
    const before = remoteTip(c);
    scriptCommit(c.top, { 'brain/.gbrain-scan-allow': '**\n', 'brain/notes/deploy.md': `Deploy token ${token}\n` });
    const result = await withEnv(env(c), () => outcome(() => pushGitRoot(join(c.top, 'brain'))));
    expect(result.code).toBe('publish_secret_found');
    expect(remoteTip(c)).toBe(before);
  }, 60_000);

  test('the same commit at the top level is refused as a gate change', async () => {
    const c = checkout();
    const before = remoteTip(c);
    scriptCommit(c.top, { '.gbrain-scan-allow': '**\n', 'brain/notes/deploy.md': `Deploy token ${token}\n` });
    const result = await withEnv(env(c), () => outcome(() => pushGitRoot(c.top)));
    expect(result.code).toBe('publish_secret_found');
    expect(remoteTip(c)).toBe(before);
  }, 60_000);

  test('a path glob in the root\'s allowlist matches paths relative to that root, and nothing outside it', async () => {
    const c = checkout();
    const base = head(c.top);
    writeFileSync(join(c.top, 'brain', '.gbrain-scan-allow'), 'notes/**\n');
    const inside = scriptCommit(c.top, { 'brain/notes/deploy.md': `Deploy token ${token}\n` });
    expect(await refusalOf(c, join(c.top, 'brain'), base, inside)).toBeNull();
    const outside = scriptCommit(c.top, { 'notes/deploy.md': `Deploy token ${token}\n` });
    expect(await refusalOf(c, join(c.top, 'brain'), inside, outside)).toBe('publish_secret_found');
  }, 60_000);
});

describe('an uncommitted .gbrain-scan-allow (documented: the user\'s local answer to the scan)', () => {
  test('a path glob in an untracked allowlist is honoured and the commit publishes', async () => {
    const c = checkout();
    const added = scriptCommit(c.top, { 'brain/notes/deploy.md': `Deploy token ${token}\n` });
    writeFileSync(join(c.top, '.gbrain-scan-allow'), '**\n');
    const result = await withEnv(env(c), () => outcome(() => pushGitRoot(c.top)));
    expect(result.code).toBeNull();
    expect(remoteTip(c)).toBe(added);
  }, 60_000);
});

describe('a strict (canonical: git) door commit through a clean filter', () => {
  function filtered(c: Checkout, clean: string): void {
    writeFileSync(join(c.top, '.git', 'info', 'attributes'), '*.md filter=example\n');
    git(c.top, 'config', 'filter.example.clean', clean);
  }
  const door = (c: Checkout, body: string) => {
    const file = join(c.top, 'brain', 'notes', 'a.md');
    writeFileSync(file, body);
    return withEnv(env(c), () => commitThroughDoor(c.top, [{ path: file, planned: hashFile(file) }]));
  };

  test('a blob the filter changed is scanned, so a value it added is refused', async () => {
    const c = checkout();
    const base = head(c.top);
    filtered(c, `sed 's/$/ ${token}/'`);
    const created = (await door(c, 'After a\n'))!;
    expect(git(c.top, 'show', `${created}:brain/notes/a.md`)).toContain(token);
    expect(await refusalOf(c, c.top, base, created)).toBe('publish_secret_found');
  }, 60_000);

  test('a filter that adds nothing secret still publishes: scanned, not refused', async () => {
    const c = checkout();
    const base = head(c.top);
    filtered(c, `sed 's/$/ reviewed/'`);
    const created = (await door(c, 'After a\n'))!;
    expect(git(c.top, 'show', `${created}:brain/notes/a.md`)).toBe('After a reviewed\n');
    expect(await refusalOf(c, c.top, base, created)).toBeNull();
  }, 60_000);

  test('an unfiltered door commit stays a page write: its raw body is not scanned', async () => {
    const c = checkout();
    const base = head(c.top);
    const created = (await door(c, `Saved note with ${token}\n`))!;
    expect(await refusalOf(c, c.top, base, created)).toBeNull();
  }, 60_000);
});

describe('every commitAndPush scans what it publishes', () => {
  test('a publish that passes no scan option does not publish a script commit holding a token', async () => {
    const c = checkout();
    const before = remoteTip(c);
    scriptCommit(c.top, { 'brain/notes/deploy.md': `Deploy token ${token}\n` });
    const result = await unscannedPublish(c, 'Generated page\n');
    expect(result.code).toBe('publish_secret_found');
    expect(remoteTip(c)).toBe(before);
    expect(git(c.top, 'show', 'HEAD:brain/notes/b.md')).toBe('Generated page\n');
  }, 60_000);

  test('it scans only what the remote lacks: a value already on the remote does not hold the next publish', async () => {
    const c = checkout();
    scriptCommit(c.top, { 'brain/notes/deploy.md': `Deploy token ${token}\n` });
    git(c.top, 'push', '-q');
    const result = await unscannedPublish(c, 'Generated page\n');
    expect(result.code).toBeNull();
    expect(remoteTip(c)).toBe(head(c.top));
  }, 60_000);

  test('a missing tracking ref is fetched first: a clean commit pushes, and history the remote holds is not rescanned', async () => {
    const c = checkout();
    scriptCommit(c.top, { 'brain/notes/deploy.md': `Deploy token ${token}\n` });
    git(c.top, 'push', '-q');
    const created = scriptCommit(c.top, { 'brain/notes/b.md': 'A clean page\n' });
    git(c.top, 'update-ref', '-d', 'refs/remotes/origin/main');
    const result = await withEnv(env(c), () => outcome(() => commitAndPush({ repo: c.top, cwd: c.top, paths: [], message: '', pushOnly: true })));
    expect(result.code).toBeNull();
    expect(remoteTip(c)).toBe(created);
  }, 60_000);
});

describe('replace refs', () => {
  /** HEAD with a replacement commit that adds a file holding a token. */
  function replaced(c: Checkout): string {
    const real = head(c.top);
    const fake = scriptCommit(c.top, { 'brain/notes/deploy.md': `Deploy token ${token}\n` }, 'replacement');
    git(c.top, 'reset', '-q', '--hard', real);
    git(c.top, 'replace', real, fake);
    return real;
  }

  test('a Git effect commit is built from HEAD\'s real tree, so it carries nothing the replacement adds', async () => {
    const c = checkout();
    const base = replaced(c);
    writeFileSync(join(c.top, 'brain', 'notes', 'a.md'), 'After a\n');
    const result = await withEnv(env(c), () => commitGitTargets(c.top, ['brain/notes/a.md'], undefined, undefined, undefined, new Map([['brain/notes/a.md', sha256('After a\n')]])));
    expect(result.get('brain/notes/a.md')).toEqual({ git: 'committed' });
    const created = head(c.top);
    expect(git(c.top, '--no-replace-objects', 'rev-parse', `${created}^`).trim()).toBe(base);
    expect(tracked(c.top, created).sort()).toEqual(['brain/notes/a.md', 'brain/notes/b.md']);
    expect(git(c.top, '--no-replace-objects', 'show', `${created}:brain/notes/a.md`)).toBe('After a\n');
    expect(await refusalOf(c, c.top, base, created)).toBeNull();
    const pushed = await withEnv(env(c), () => outcome(() => pushGitRoot(c.top)));
    expect(pushed.code).toBeNull();
    expect(remoteTip(c)).toBe(created);
  }, 60_000);

  test('a door commit is built from HEAD\'s real tree too', async () => {
    const c = checkout();
    const base = replaced(c);
    const file = join(c.top, 'brain', 'notes', 'a.md');
    writeFileSync(file, 'After a\n');
    const created = (await withEnv(env(c), () => commitThroughDoor(c.top, [{ path: file, planned: hashFile(file) }])))!;
    expect(git(c.top, '--no-replace-objects', 'rev-parse', `${created}^`).trim()).toBe(base);
    expect(tracked(c.top, created).sort()).toEqual(['brain/notes/a.md', 'brain/notes/b.md']);
    expect(await refusalOf(c, c.top, base, created)).toBeNull();
  }, 60_000);
});

describe('an index entry reset between staging and commit', () => {
  test('a target whose staged entry another process reset is not reported committed with its old blob, and the retry commits it', async () => {
    const c = checkout();
    const root = c.top, before = head(root);
    writeFileSync(join(root, 'brain', 'notes', 'a.md'), 'After a\n');
    writeFileSync(join(root, 'brain', 'notes', 'b.md'), 'After b\n');
    const path = process.env.PATH ?? '', real = `PATH='${path}' '${Bun.which('git')!}'`;
    const bin = join(c.home, 'race-bin'), mark = join(c.home, 'raced');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), ['#!/bin/sh', `${real} "$@"`, 'code=$?',
      `case " $* " in *" diff --cached "*) if [ $code -eq 0 ] && [ ! -f '${mark}' ]; then touch '${mark}'; ${real} -C '${root}' reset -q -- brain/notes/a.md; fi;; esac`,
      'exit $code', ''].join('\n'));
    chmodSync(join(bin, 'git'), 0o755);
    const targets = ['brain/notes/a.md', 'brain/notes/b.md'];
    const raced = await withEnv(env(c, { PATH: `${bin}:${path}` }), () => commitGitTargets(root, targets));
    expect(raced.get('brain/notes/a.md')).toBeInstanceOf(Error);
    expect(head(root)).toBe(before);
    const retried = await withEnv(env(c), () => commitGitTargets(root, targets));
    expect([retried.get(targets[0]!), retried.get(targets[1]!)]).toEqual([{ git: 'committed' }, { git: 'committed' }]);
    expect(git(root, 'show', 'HEAD:brain/notes/a.md')).toBe('After a\n');
    expect(git(root, 'show', 'HEAD:brain/notes/b.md')).toBe('After b\n');
    expect(readFileSync(join(root, 'brain', 'notes', 'a.md'), 'utf8')).toBe('After a\n');
  }, 60_000);
});
