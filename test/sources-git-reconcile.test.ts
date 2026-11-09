/**
 * `gbrain sources git-reconcile`: one idempotent call brings every source checkout level with its upstream.
 * Protects: a stranded local commit is published (merged in memory, the old remote tip kept as an ancestor, never a
 * force-push); a checkout behind fast-forwards; one level is a no-op that pushes nothing; a same-file conflict, a
 * secret in the local commits and a rewritten upstream each refuse with nothing pushed; eight concurrent callers
 * while another clone pushes mid-run all succeed and lose no commit, and a ninth call reports in_sync; a managed
 * worktree is reconciled through refresh (Git durability on publishes, off needs the user); a brain whose sources
 * have no Git checkout reports no_repo.
 * Seams: GBRAIN_JOB_CHILD_CLI for refresh's publish child; otherwise real repositories, a bare remote, a pushing
 * clone, child processes for the concurrent callers, and PGLite (Postgres too where configured) for the managed case.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { reconcileCheckout, upstreamFetch } from '../src/core/git/reconcile.ts';
import { reconcileSources } from '../src/commands/sources-git-reconcile.ts';
import { runSources } from '../src/commands/sources.ts';
import { REFRESH_PUBLISH_DIVERGED_KEY } from '../src/core/persistence/worktree-refresh.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { page, withRefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-reconcile-')));
const identity = { GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const childCli = join(dir, 'bin', 'gbrain');

beforeAll(async () => {
  mkdirSync(join(dir, 'bin'));
  writeFileSync(childCli, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, '..', 'src', 'cli.ts')}' "$@"\n`);
  chmodSync(childCli, 0o755);
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
  rmSync(dir, { recursive: true, force: true });
});

interface Repo { remote: string; root: string; sibling: string }
function repo(name: string): Repo {
  const remote = join(dir, `${name}.git`), root = join(dir, name), sibling = join(dir, `${name}-sibling`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
  git(root, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(root, 'readme.md'), 'start\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'init'); git(root, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', '-b', 'main', remote, sibling], { stdio: 'ignore' });
  return { remote, root, sibling };
}
const commit = (root: string, file: string, content: string) => {
  mkdirSync(join(root, file, '..'), { recursive: true });
  writeFileSync(join(root, file), content); git(root, 'add', file); git(root, 'commit', '-qm', `edit ${file}`);
  return git(root, 'rev-parse', 'HEAD');
};
const siblingPush = (r: Repo, file: string, content: string) => { git(r.sibling, 'pull', '-q', '--no-rebase', 'origin', 'main'); const sha = commit(r.sibling, file, content); git(r.sibling, 'push', '-q', 'origin', 'main'); return sha; };
const onRemoteSha = (root: string, sha: string) => { try { git(root, 'fetch', '-q', 'origin'); git(root, 'merge-base', '--is-ancestor', sha, 'origin/main'); return true; } catch { return false; } };
const tip = (r: Repo) => git(r.remote, 'rev-parse', 'refs/heads/main');
const onRemote = (r: Repo, sha: string) => { try { git(r.remote, 'merge-base', '--is-ancestor', sha, 'refs/heads/main'); return true; } catch { return false; } };
const refusal = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected a refusal'); }, e => e as { code: string; message: string });
const childEnv = { ...identity, GBRAIN_JOB_CHILD_CLI: childCli };
const reconcile = (root: string) => withEnv(childEnv, () => reconcileCheckout(root));
const reconcileAll = (engine: BrainEngine, ids?: string[]) => withEnv(childEnv, () => reconcileSources(engine, ids ? { sourceIds: ids } : {}));

test('the upstream fetch carries the transport hardening of every other remote git call and never prompts', () => {
  const { argv, env } = upstreamFetch('/checkout', 'origin', 'main');
  expect(argv).toEqual(expect.arrayContaining(['http.followRedirects=false', 'protocol.ext.allow=never']));
  expect(argv.indexOf('--no-recurse-submodules')).toBeGreaterThan(argv.indexOf('fetch'));
  expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
});

test('no Git checkout and no upstream report themselves and change nothing', async () => {
  const plain = join(dir, 'plain'); mkdirSync(plain);
  expect(await reconcileCheckout(plain)).toMatchObject({ status: 'no_repo' });
  const local = join(dir, 'local'); execFileSync('git', ['init', '-q', '-b', 'main', local]); commit(local, 'a.md', 'a\n');
  expect(await reconcileCheckout(local)).toMatchObject({ status: 'no_upstream' });
});

test('a level checkout is a no-op; a stranded commit is published; a checkout behind fast-forwards', async () => {
  const r = repo('level');
  expect(await reconcile(r.root)).toMatchObject({ status: 'in_sync', ahead: 0, behind: 0, sha: tip(r) });
  const local = commit(r.root, 'notes/a.md', 'stranded\n');
  expect(await reconcile(r.root)).toMatchObject({ status: 'published', ahead: 1, behind: 0 });
  expect(tip(r)).toBe(local);
  expect(await reconcile(r.root)).toMatchObject({ status: 'in_sync' });
  const theirs = siblingPush(r, 'notes/b.md', 'from the sibling\n');
  expect(await reconcile(r.root)).toMatchObject({ status: 'fast_forwarded', ahead: 0, behind: 1 });
  expect(git(r.root, 'rev-parse', 'HEAD')).toBe(theirs);
}, 60_000);

test('a diverged checkout publishes a merge that keeps both sides and the old remote tip; a same-file conflict pushes nothing', async () => {
  const r = repo('diverged');
  const theirs = siblingPush(r, 'notes/b.md', 'from the sibling\n');
  const ours = commit(r.root, 'notes/a.md', 'local\n');
  const result = await reconcile(r.root);
  expect(result).toMatchObject({ status: 'published', ahead: 1, behind: 1, integrated: 1 });
  expect(onRemote(r, ours) && onRemote(r, theirs)).toBe(true);
  expect(git(r.root, 'rev-parse', 'HEAD')).toBe(tip(r));

  siblingPush(r, 'readme.md', 'sibling version\n');
  commit(r.root, 'readme.md', 'local version\n');
  const before = tip(r);
  expect((await refusal(reconcile(r.root))).code).toBe('integrate_conflict');
  expect(tip(r)).toBe(before);
}, 60_000);

test('a secret in the local commits and a rewritten upstream each refuse with nothing pushed', async () => {
  const r = repo('guards');
  commit(r.root, 'notes/key.md', `token ${'ghp_' + 'Zt4q'.repeat(9)}\n`);
  const before = tip(r);
  expect((await refusal(reconcile(r.root))).code).toBe('publish_secret_found');
  expect(tip(r)).toBe(before);

  const w = repo('rewrite');
  const purged = commit(w.root, 'notes/purge-me.md', 'published, then purged\n');
  git(w.root, 'push', '-q', 'origin', 'main');
  git(w.sibling, 'fetch', '-q', 'origin'); git(w.sibling, 'reset', '-q', '--hard', `${purged}~1`);
  commit(w.sibling, 'notes/other.md', 'rewritten history\n'); git(w.sibling, 'push', '-q', '--force', 'origin', 'main');
  const rewritten = tip(w);
  commit(w.root, 'notes/local.md', 'local\n');
  const error = await refusal(reconcile(w.root));
  expect(error.code).toBe('upstream_rewritten');
  expect(error.message).toContain(purged);
  expect(tip(w)).toBe(rewritten);
}, 60_000);

test('a force-push between the rewrite check and the push is not merged back: the publish is bound to the checked upstream', async () => {
  const w = repo('race');
  const purged = commit(w.root, 'notes/purge-me.md', 'published, then purged\n');
  git(w.root, 'push', '-q', 'origin', 'main');
  commit(w.root, 'notes/local.md', 'local\n');
  const mark = join(dir, 'race.mark'), racer = join(dir, 'bin', 'racer');
  writeFileSync(racer, `#!/bin/sh
case " $* " in *" --push-only "*) if [ ! -f '${mark}' ]; then touch '${mark}'
  git -C '${w.sibling}' fetch -q origin && git -C '${w.sibling}' reset -q --hard '${purged}~1'
  echo rewritten > '${join(w.sibling, 'notes', 'other.md')}' 2>/dev/null || { mkdir -p '${join(w.sibling, 'notes')}'; echo rewritten > '${join(w.sibling, 'notes', 'other.md')}'; }
  git -C '${w.sibling}' add -A && git -C '${w.sibling}' -c user.name=Example -c user.email=example@example.invalid commit -qm rewrite && git -C '${w.sibling}' push -q --force origin main
fi;; esac
exec '${childCli}' "$@"
`);
  chmodSync(racer, 0o755);
  const error = await refusal(withEnv({ ...identity, GBRAIN_JOB_CHILD_CLI: racer }, () => reconcileCheckout(w.root)));
  expect(error.code).toBe('upstream_rewritten');
  expect(error.message).toContain(purged);
  expect(onRemote(w, purged)).toBe(false);
}, 120_000);

test('eight concurrent callers while another clone pushes mid-run: all succeed, no commit is lost, and a ninth call is in_sync', async () => {
  const r = repo('concurrent');
  const start = tip(r);
  const ours = [commit(r.root, 'notes/l1.md', 'one\n'), commit(r.root, 'notes/l2.md', 'two\n')];
  const script = join(dir, 'reconcile-child.ts');
  writeFileSync(script, `import { reconcileCheckout } from '${join(import.meta.dir, '..', 'src', 'core', 'git', 'reconcile.ts')}';\n`
    + `try { console.log(JSON.stringify(await reconcileCheckout(process.argv[2]))); } catch (e) { console.log(JSON.stringify({ code: (e as { code?: string }).code, message: String((e as Error).message) })); process.exit(1); }\n`);
  const run = () => new Promise<{ code: number | null; out: string }>(resolve => {
    const child = spawn(process.execPath, [script, r.root], { env: { ...process.env, ...childEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
  });
  const callers = Array.from({ length: 8 }, run);
  const theirs = siblingPush(r, 'notes/sibling.md', 'pushed mid-run\n');
  const results = await Promise.all(callers);
  for (const result of results) expect(result.code, result.out).toBe(0);
  const statuses = results.map(result => (JSON.parse(result.out) as { status: string }).status);
  expect(statuses.every(s => ['published', 'in_sync', 'fast_forwarded'].includes(s))).toBe(true);
  for (const sha of [start, ...ours]) expect(onRemote(r, sha)).toBe(true);
  const last = await reconcile(r.root);
  if (last.status !== 'in_sync') expect(last.status).toBe('published');
  expect(onRemote(r, theirs)).toBe(true);
  expect(await reconcile(r.root)).toMatchObject({ status: 'in_sync', sha: tip(r) });
  expect(git(r.root, 'rev-parse', 'HEAD')).toBe(tip(r));
}, 180_000);

test('managed worktree: Git durability on publishes through refresh and a repeat is in_sync; durability off needs the user', () => (async () => {
  for (const engine of engines) {
    await withEnv({ GBRAIN_JOB_CHILD_CLI: childCli }, () => withRefreshFixture(engine, async f => {
      f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
      git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid');
      const local = commit(f.root, 'beta/local.md', page('Local', 'A local commit nobody pushed.'));
      const off = await reconcileSources(engine, { sourceIds: [f.alpha, f.beta] });
      expect(off).toHaveLength(1);
      expect(off[0]).toMatchObject({ managed: true, status: 'needs_user', error: { code: 'refresh_diverged' } });
      expect(off[0].sources.sort()).toEqual([f.alpha, f.beta].sort());
      await engine.executeRaw(`UPDATE persistence_host_bindings SET git_durability='enabled' WHERE local_path LIKE $1`, [`${f.root}%`]);
      try {
        const [done] = await reconcileSources(engine, { sourceIds: [f.alpha, f.beta] });
        expect(done).toMatchObject({ managed: true, status: 'published', ahead: 1, behind: 1 });
        git(f.root, 'merge-base', '--is-ancestor', local, 'HEAD');
        expect(f.head()).toBe(git(f.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]);
        expect(await reconcileSources(engine, { sourceIds: [f.alpha, f.beta] })).toMatchObject([{ status: 'in_sync' }]);
        await engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'false');
        const unpushed = commit(f.root, 'beta/later.md', page('Later', 'Another local commit.'));
        expect(await reconcileSources(engine, { sourceIds: [f.alpha, f.beta] })).toMatchObject([{ managed: true, status: 'unpublished', ahead: 1 }]);
        expect(onRemoteSha(f.root, unpushed)).toBe(false);
      } finally {
        await engine.executeRaw(`UPDATE persistence_host_bindings SET git_durability=NULL WHERE local_path LIKE $1`, [`${f.root}%`]);
        await engine.unsetConfig(REFRESH_PUBLISH_DIVERGED_KEY);
      }
    }));
  }
})(), 240_000);

let plain: PGLiteEngine;
beforeAll(async () => { plain = new PGLiteEngine(); await plain.connect({}); await plain.initSchema(); }, 60_000);
afterAll(async () => { await plain.disconnect(); });
const resetPlain = async () => {
  await plain.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
  await plain.unsetConfig(REFRESH_PUBLISH_DIVERGED_KEY);
};

test('a brain whose sources have no Git checkout reports no_repo', async () => {
  const engine = plain;
  try {
    const path = join(dir, 'plain-source');
    mkdirSync(path, { recursive: true });
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['plain-source', path]);
    expect(await reconcileSources(engine, { sourceIds: ['plain-source'] })).toEqual([{ sources: [], root: '', managed: false, status: 'no_repo', ahead: 0, behind: 0 }]);
    expect(await reconcileSources(engine)).toEqual([{ sources: [], root: '', managed: false, status: 'no_repo', ahead: 0, behind: 0 }]);
    const printed: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
    try { await runSources(engine, ['git-reconcile', 'plain-source', '--json']); } finally { console.log = log; }
    expect(JSON.parse(printed.join('\n'))).toEqual({ results: [{ sources: [], root: '', managed: false, status: 'no_repo', ahead: 0, behind: 0 }], exit: 0 });
  } finally { await resetPlain(); }
}, 60_000);

test('with automatic publishing turned off, local commits stay unpublished while a checkout behind still fast-forwards', async () => {
  const engine = plain;
  try {
    const r = repo('optout');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::jsonb)', ['optout-source', r.root, JSON.stringify({ remote_url: r.remote, managed_clone: true })]);
    await engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'false');
    const theirs = siblingPush(r, 'notes/theirs.md', 'from the sibling\n');
    expect(await reconcileAll(engine)).toMatchObject([{ sources: ['optout-source'], status: 'fast_forwarded', behind: 1 }]);
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(theirs);
    const local = commit(r.root, 'notes/mine.md', 'mine\n');
    expect(await reconcileAll(engine)).toMatchObject([{ sources: ['optout-source'], status: 'unpublished', ahead: 1, behind: 0 }]);
    expect(tip(r)).toBe(theirs);
    await engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, '');
    expect(await reconcileAll(engine)).toMatchObject([{ sources: ['optout-source'], status: 'published', ahead: 1 }]);
    expect(tip(r)).toBe(local);
  } finally { await resetPlain(); }
}, 120_000);

test('a checkout gbrain did not clone for the source is never published by default; a sync-disabled or missing source is skipped', async () => {
  const engine = plain;
  try {
    const r = repo('foreign');
    mkdirSync(join(r.root, 'notes'), { recursive: true });
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['inside-a-repo', join(r.root, 'notes')]);
    const before = tip(r);
    commit(r.root, 'notes/unpushed.md', 'someone else\'s commit\n');
    const [held] = await reconcileAll(engine);
    expect(held).toMatchObject({ sources: ['inside-a-repo'], status: 'unpublished', ahead: 1 });
    expect(held.reason).toContain('did not clone');
    expect(tip(r)).toBe(before);
    await engine.executeRaw(`UPDATE sources SET config = '{"syncEnabled": false}'::jsonb WHERE id = 'inside-a-repo'`);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['moved-away', join(dir, 'no-such-folder')]);
    expect(await reconcileAll(engine)).toEqual([{ sources: [], root: '', managed: false, status: 'no_repo', ahead: 0, behind: 0 }]);
    expect(await reconcileAll(engine, ['inside-a-repo'])).toMatchObject([{ status: 'unpublished' }]);
    await engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
    expect(await reconcileAll(engine, ['inside-a-repo'])).toMatchObject([{ status: 'published', ahead: 1 }]);
    expect(tip(r)).not.toBe(before);
  } finally { await resetPlain(); }
}, 120_000);

test('a checkout that fails with a plain error is reported for that checkout and the other checkouts still reconcile', async () => {
  const engine = plain;
  const broken = repo('plain-error'), healthy = repo('plain-healthy');
  try {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$4::jsonb),($3,$3,$5,$6::jsonb)',
      ['broken-source', broken.root, 'healthy-source', JSON.stringify({ remote_url: broken.remote, managed_clone: true }), healthy.root, JSON.stringify({ remote_url: healthy.remote, managed_clone: true })]);
    commit(broken.root, 'notes/stuck.md', 'stuck\n');
    const local = commit(healthy.root, 'notes/mine.md', 'mine\n');
    chmodSync(join(broken.root, '.git'), 0o555);
    const results = await reconcileAll(engine);
    expect(results.find(r => r.sources.includes('broken-source'))).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('EACCES') } });
    expect(results.find(r => r.sources.includes('healthy-source'))).toMatchObject({ status: 'published', ahead: 1 });
    expect(tip(healthy)).toBe(local);
  } finally {
    chmodSync(join(broken.root, '.git'), 0o755);
    await resetPlain();
  }
}, 120_000);

test('a checkout with a recorded remote that gbrain did not clone keeps its local commits by default', async () => {
  const engine = plain;
  const r = repo('recorded-remote');
  try {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::jsonb)', ['recorded-remote', r.root, JSON.stringify({ remote_url: r.remote })]);
    const before = tip(r);
    const local = commit(r.root, 'notes/private.md', 'not for the remote\n');
    expect(await reconcileAll(engine)).toMatchObject([{ sources: ['recorded-remote'], status: 'unpublished', ahead: 1 }]);
    expect(tip(r)).toBe(before);
    expect(onRemote(r, local)).toBe(false);
  } finally { await resetPlain(); }
}, 120_000);
