/**
 * #7686: an opt-in refresh publishes a diverged managed checkout before it
 * fast-forwards.
 *
 * Protects: with `sources.refresh_publish_diverged` on (standing consent, default
 * off) a refresh of a checkout that has local commits while its upstream moved
 * on pushes HEAD merged with the upstream in memory (the keep-checkout publish,
 * which never moves the checkout), then fast-forwards, keeping the local commits;
 * with the setting off it refuses `refresh_diverged` as before; a conflicting path
 * refuses `integrate_conflict` naming the path and changes nothing; an uncommitted
 * edit on an incoming path refuses `refresh_dirty` before anything is pushed; a dry
 * run never publishes; with gbrain.quarantine on, the refresh names the parked
 * local version; a refusal after the publish says the remote already holds it.
 * Regression it catches: a refresh that pushes local commits without the
 * setting, one that moves the checkout or drops the local commits while
 * publishing, and one that pushes or fences anything when the merge conflicts or
 * the refresh is about to refuse a dirty overlap.
 * Seams: the `hooks.boundary` callback for the refusal after a publish, and
 * GBRAIN_JOB_CHILD_CLI naming the child gbrain that publishes; otherwise
 * a real bare remote, a pushing clone and the managed checkout.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { runSourcesRefresh } from '../src/commands/sources-refresh.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { REFRESH_PUBLISH_DIVERGED_KEY, refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { commitFile, git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
/** The publish runs in a child `gbrain`; under bun test that is this checkout's CLI through a wrapper. */
const bin = mkdtempSync(join(tmpdir(), 'gbrain-7686-bin-'));
const childCli = join(bin, 'gbrain');

beforeAll(async () => {
  writeFileSync(childCli, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, '..', 'src', 'cli.ts')}' "$@"\n`);
  chmodSync(childCli, 0o755);
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
  rmSync(bin, { recursive: true, force: true });
});

const each = async (fn: (f: RefreshFixture) => Promise<void>, cli = childCli) => {
  for (const engine of engines) {
    await withEnv({ GBRAIN_JOB_CHILD_CLI: cli }, () => withRefreshFixture(engine, async f => {
      try { await fn(f); } finally { await engine.unsetConfig(REFRESH_PUBLISH_DIVERGED_KEY); }
    }));
  }
};
const refusedWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(() => null, e => e as { code?: string; message?: string; suggestion?: string; detail?: string });
  expect(error, `expected refusal ${code}`).not.toBeNull();
  expect(error!.code).toBe(code);
  return error!;
};
const remoteHead = (f: RefreshFixture) => git(f.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
/** The upstream moves on while the managed checkout gains a local commit: a diverged checkout. */
function diverge(f: RefreshFixture, local = { path: 'beta/local.md', content: page('Local', 'A local commit nobody pushed.') }): string {
  f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid');
  writeFileSync(join(f.root, local.path), local.content);
  git(f.root, 'add', local.path); git(f.root, 'commit', '-qm', 'local only');
  return f.head();
}

test('the setting is a registered knob, default off', () => {
  expect(REFRESH_PUBLISH_DIVERGED_KEY).toBe('sources.refresh_publish_diverged');
  expect(KNOWN_CONFIG_KEYS).toContain(REFRESH_PUBLISH_DIVERGED_KEY);
  expect(KNOWN_CONFIG_KEYS).toEqual(expect.arrayContaining(['sources.refresh_fetch_timeout_ms', 'sources.refresh_drain_wait_ms']));
});

test('setting on: a diverged refresh publishes the local commits merged with the upstream, then fast-forwards and keeps them', () => each(async f => {
  const local = diverge(f);
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  const done = await refreshWorktree(f.engine, f.alpha);
  expect(done).toMatchObject({ status: 'completed', old_head: local, published: { local_commits: 1, integrated: 1 } });
  expect(done.published!.sha).toBe(remoteHead(f));
  expect(done.target_head).toBe(done.published!.sha);
  expect(f.head()).toBe(done.published!.sha);
  git(f.root, 'merge-base', '--is-ancestor', local, 'HEAD');
  expect(readFileSync(join(f.root, 'alpha/two.md'), 'utf8')).toContain('Upstream side.');
  expect(readFileSync(join(f.root, 'beta/local.md'), 'utf8')).toContain('A local commit nobody pushed.');
  expect(await f.lastCommit(f.alpha)).toBe(done.published!.sha);
  expect(await f.lastCommit(f.beta)).toBe(done.published!.sha);
}), 120_000);

test('setting on: the text result names the publish', () => each(async f => {
  diverge(f);
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'on');
  const out: string[] = [];
  const log = console.log;
  _resetCliExitVerdictForTests();
  console.log = (line: string) => { out.push(line); };
  try { await runSourcesRefresh(f.engine, [f.alpha]); } finally { console.log = log; _resetCliExitVerdictForTests(); process.exitCode = 0; }
  expect(out.join('\n')).toContain('Published 1 local commit(s) merged with 1 upstream commit(s) as ');
  expect(out.join('\n')).toContain('Refresh completed');
}), 120_000);

test('setting off (unset or false): the refresh refuses refresh_diverged, pushes nothing and names the setting', () => each(async f => {
  const local = diverge(f);
  const remote = remoteHead(f);
  for (const value of [null, 'false']) {
    if (value !== null) await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, value);
    const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_diverged');
    expect(error.suggestion).toContain('gbrain config set sources.refresh_publish_diverged true');
    expect(remoteHead(f)).toBe(remote);
    expect(f.head()).toBe(local);
    expect(await f.refreshRows()).toEqual([]);
  }
}), 120_000);

test('setting on: a conflicting path refuses integrate_conflict naming it, and nothing is pushed, fenced or moved', () => each(async f => {
  const local = diverge(f, { path: 'alpha/two.md', content: page('Alpha two', 'Local side.') });
  const remote = remoteHead(f);
  const lastAlpha = await f.lastCommit(f.alpha);
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'integrate_conflict') as { detail?: string; suggestion?: string };
  expect(JSON.parse(error.detail!).paths).toEqual(['alpha/two.md']);
  expect(error.suggestion).toContain('--keep-checkout');
  expect(error.suggestion).toContain('--resolve alpha/two.md=ours|theirs');
  expect(remoteHead(f)).toBe(remote);
  expect(f.head()).toBe(local);
  expect(readFileSync(join(f.root, 'alpha/two.md'), 'utf8')).toContain('Local side.');
  expect(git(f.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  expect(await f.refreshRows()).toEqual([]);
  expect(await f.lastCommit(f.alpha)).toBe(lastAlpha);
}), 120_000);

test('setting on: an uncommitted edit on an incoming path refuses refresh_dirty before publishing, so nothing is pushed, fenced or moved', () => each(async f => {
  const local = diverge(f);
  const remote = remoteHead(f);
  writeFileSync(join(f.root, 'alpha/two.md'), page('Alpha two', 'An uncommitted local edit.'));
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_dirty');
  expect(error.message).toContain('alpha/two.md');
  expect(remoteHead(f)).toBe(remote);
  expect(f.head()).toBe(local);
  expect(readFileSync(join(f.root, 'alpha/two.md'), 'utf8')).toContain('An uncommitted local edit.');
  expect(await f.refreshRows()).toEqual([]);
}), 120_000);

test('setting on with gbrain.quarantine: a conflicting path is published as the remote version and the refresh names the parked local version', () => each(async f => {
  diverge(f, { path: 'alpha/two.md', content: page('Alpha two', 'Local side.') });
  git(f.root, 'config', 'gbrain.quarantine', 'true');
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  const out: string[] = [];
  const log = console.log;
  _resetCliExitVerdictForTests();
  console.log = (line: string) => { out.push(line); };
  try { await runSourcesRefresh(f.engine, [f.alpha]); } finally { console.log = log; _resetCliExitVerdictForTests(); process.exitCode = 0; }
  const ref = git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/gbrain/quarantine/').trim();
  expect(ref).toMatch(/^refs\/gbrain\/quarantine\//);
  expect(git(f.root, 'show', `${ref}:alpha/two.md`)).toContain('Local side.');
  expect(out.join('\n')).toContain(`this machine's version is kept under ${ref}`);
  expect(out.join('\n')).toContain('alpha/two.md');
}), 120_000);

test('setting on: a refusal after the publish says the local commits were already published', () => each(async f => {
  diverge(f);
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  const error = await refusedWith(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => {
    if (point === 'drained') git(f.root, 'commit', '-q', '--allow-empty', '-m', 'external');
  } } }), 'refresh_source_changed');
  expect(error.message).toContain(`already published the checkout's 1 local commit(s) merged with the upstream as ${remoteHead(f)}`);
}), 120_000);

test('setting on: the publish runs in a child gbrain, never in this process, so an unusable child refuses and nothing is pushed or fenced', () => each(async f => {
  const local = diverge(f);
  const remote = remoteHead(f);
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'push_unconfirmed');
  expect(error.message).toContain('did not report a push');
  expect(remoteHead(f)).toBe(remote);
  expect(f.head()).toBe(local);
  expect(await f.refreshRows()).toEqual([]);
}, '/bin/false'), 120_000);

test('setting on: a dry run publishes nothing and still refuses refresh_diverged', () => each(async f => {
  const local = diverge(f);
  const remote = remoteHead(f);
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  await refusedWith(refreshWorktree(f.engine, f.alpha, { dryRun: true }), 'refresh_diverged');
  expect(remoteHead(f)).toBe(remote);
  expect(f.head()).toBe(local);
}), 120_000);

for (const [label, forget] of [['', false], [' even when the first fetch to see the upstream is the one after the rewrite', true]] as const) {
  test(`setting on: an upstream rewritten by a force-push is never published${label}; the refresh refuses refresh_diverged and the remote keeps the rewrite`, () => each(async f => {
    f.push('alpha/purged.md', page('Purged', 'A page the upstream later removed by rewriting history.'));
    expect(await refreshWorktree(f.engine, f.alpha)).toMatchObject({ status: 'completed' });
    const purged = f.head();
    if (forget) {
      rmSync(git(f.root, 'rev-parse', '--path-format=absolute', '--git-path', 'logs/refs/remotes/origin/main').trim(), { force: true });
      await f.engine.executeRaw('DELETE FROM persistence_worktree_refreshes WHERE worktree_id=$1::uuid', [f.worktreeId]);
    }
    git(f.upstream, 'reset', '-q', '--hard', 'HEAD~1');
    commitFile(f.upstream, 'alpha/two.md', page('Alpha two', 'Rewritten upstream.'));
    git(f.upstream, 'push', '-q', '--force', 'origin', 'main');
    const rewritten = remoteHead(f);
    writeFileSync(join(f.root, 'beta/local.md'), page('Local', 'A local commit nobody pushed.'));
    git(f.root, 'add', 'beta/local.md'); git(f.root, 'commit', '-qm', 'local only');
    const local = f.head();
    await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
    const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_diverged');
    expect(error.message).toContain(`no longer contains ${purged}`);
    expect(error.suggestion).not.toContain('gbrain config set');
    expect(remoteHead(f)).toBe(rewritten);
    expect(() => git(f.root, 'cat-file', '-e', 'origin/main:alpha/purged.md')).toThrow();
    expect(f.head()).toBe(local);
    expect((await f.refreshRows()).filter(r => r.state !== 'completed')).toEqual([]);
  }), 120_000);
}

test('setting on, reflog off and no completed refresh: the refusal\'s own fetch records the rewrite, so a second refresh refuses too, and with no record at all it refuses', () => each(async f => {
  const reflog = git(f.root, 'rev-parse', '--path-format=absolute', '--git-path', 'logs/refs/remotes/origin/main').trim();
  git(f.root, 'config', 'core.logAllRefUpdates', 'false');
  rmSync(reflog, { force: true });
  f.push('alpha/purged.md', page('Purged', 'A page the upstream later removed by rewriting history.'));
  git(f.root, 'fetch', '-q', 'origin'); git(f.root, 'merge', '-q', '--ff-only', 'origin/main');
  const purged = f.head();
  git(f.upstream, 'reset', '-q', '--hard', 'HEAD~1');
  commitFile(f.upstream, 'alpha/two.md', page('Alpha two', 'Rewritten upstream.'));
  git(f.upstream, 'push', '-q', '--force', 'origin', 'main');
  const rewritten = remoteHead(f);
  writeFileSync(join(f.root, 'beta/local.md'), page('Local', 'A local commit nobody pushed.'));
  git(f.root, 'add', 'beta/local.md'); git(f.root, 'commit', '-qm', 'local only');
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  for (let run = 0; run < 2; run++) expect((await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_diverged')).message).toContain(`no longer contains ${purged}`);
  rmSync(reflog, { force: true });
  expect((await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_diverged')).message).toContain('no record of what');
  expect(remoteHead(f)).toBe(rewritten);
}), 120_000);

for (const first of ['setting off', 'dry run'] as const) {
  test(`reflog off: a ${first} refresh that refuses after a force-push logs its own fetch, so a later setting-on refresh never publishes the removed commit`, () => each(async f => {
    const reflog = git(f.root, 'rev-parse', '--path-format=absolute', '--git-path', 'logs/refs/remotes/origin/main').trim();
    git(f.root, 'config', 'core.logAllRefUpdates', 'false');
    rmSync(reflog, { force: true });
    const before = f.push('alpha/one.md', page('Alpha one', 'Upstream before the local push.'));
    expect(await refreshWorktree(f.engine, f.alpha)).toMatchObject({ status: 'completed' });
    writeFileSync(join(f.root, 'beta/pushed.md'), page('Pushed', 'Pushed from this checkout, then rewritten away.'));
    git(f.root, 'add', 'beta/pushed.md'); git(f.root, 'commit', '-qm', 'pushed then removed');
    const removed = f.head();
    git(f.root, 'push', '-q', 'origin', 'HEAD:main');
    git(f.upstream, 'fetch', '-q', 'origin');
    git(f.upstream, 'reset', '-q', '--hard', before);
    commitFile(f.upstream, 'alpha/two.md', page('Alpha two', 'Rewritten upstream.'));
    git(f.upstream, 'push', '-q', '--force', 'origin', 'main');
    const rewritten = remoteHead(f);
    rmSync(reflog, { force: true });
    if (first === 'dry run') await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
    await refusedWith(refreshWorktree(f.engine, f.alpha, { dryRun: first === 'dry run' }), 'refresh_diverged');
    await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
    expect((await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_diverged')).message).toContain(`no longer contains ${removed}`);
    expect(remoteHead(f)).toBe(rewritten);
    expect(() => git(f.root, 'cat-file', '-e', 'origin/main:beta/pushed.md')).toThrow();
    expect(f.head()).toBe(removed);
  }), 120_000);
}

test('setting on: a local commit the upstream held inside a merge, then dropped by a force-push, is never published', () => each(async f => {
  const before = remoteHead(f);
  writeFileSync(join(f.root, 'beta/local.md'), page('Local', 'Merged upstream from this checkout, then rewritten away.'));
  git(f.root, 'add', 'beta/local.md'); git(f.root, 'commit', '-qm', 'local merged upstream');
  const local = f.head();
  git(f.upstream, 'fetch', '-q', f.root, 'HEAD');
  commitFile(f.upstream, 'alpha/side.md', page('Side', 'An upstream commit beside the merge.'));
  git(f.upstream, 'merge', '-q', '--no-edit', 'FETCH_HEAD');
  git(f.upstream, 'push', '-q', 'origin', 'main');
  git(f.root, 'fetch', '-q', 'origin');
  git(f.upstream, 'reset', '-q', '--hard', before);
  commitFile(f.upstream, 'alpha/two.md', page('Alpha two', 'Rewritten upstream.'));
  git(f.upstream, 'push', '-q', '--force', 'origin', 'main');
  const rewritten = remoteHead(f);
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  expect((await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_diverged')).message).toContain(`no longer contains ${local}`);
  expect(remoteHead(f)).toBe(rewritten);
  expect(f.head()).toBe(local);
}), 120_000);
