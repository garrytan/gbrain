/**
 * GST-2250: `sources.auto_reconcile.source.<id>` false leaves one source out of automatic publishing. git-reconcile and
 * refresh never push its local commits, while its sync and fast-forwards go on and every other source publishes as
 * before; the global key and set-sync off behave as before; and a commit-push child stopped at its bound leaves none of
 * its descendants running.
 * Seams: GBRAIN_JOB_CHILD_CLI for the publish children (the real CLI, or a script that starts a grandchild and hangs);
 * otherwise real repositories, a bare remote, a pushing clone, and PGLite (Postgres too where configured).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { execFileBounded } from '../src/core/bounded-child-exec.ts';
import { commitPushChild } from '../src/core/git/reconcile.ts';
import { reconcileSources } from '../src/commands/sources-git-reconcile.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { REFRESH_PUBLISH_DIVERGED_KEY, refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { page, withRefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-reconcile-optout-')));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let plain: PGLiteEngine;
const childCli = join(dir, 'bin', 'gbrain');
const optOut = (id: string) => `sources.auto_reconcile.source.${id}`;

beforeAll(async () => {
  mkdirSync(join(dir, 'bin'));
  writeFileSync(childCli, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, '..', 'src', 'cli.ts')}' "$@"\n`);
  chmodSync(childCli, 0o755);
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  plain = new PGLiteEngine(); await plain.connect({}); await plain.initSchema();
}, 120_000);
afterAll(async () => {
  await plain?.disconnect();
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
  writeFileSync(join(root, 'readme.md'), page('Readme', 'Start.'));
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
const tip = (r: Repo) => git(r.remote, 'rev-parse', 'refs/heads/main');
const onRemote = (remote: string, sha: string) => { try { git(remote, 'merge-base', '--is-ancestor', sha, 'refs/heads/main'); return true; } catch { return false; } };
const reconcile = (engine: BrainEngine, opts: Parameters<typeof reconcileSources>[1] = {}) => withEnv({ GBRAIN_JOB_CHILD_CLI: childCli }, () => reconcileSources(engine, opts));
const livePage = async (engine: BrainEngine, sourceId: string, slug: string) =>
  (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0].n === 1;
async function statusJson(engine: BrainEngine, sourceId: string): Promise<Record<string, unknown>> {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
  try { await runSources(engine, ['status', sourceId, '--json']); } finally { console.log = log; }
  return (JSON.parse(printed.join('\n')) as { sources: Record<string, unknown>[] }).sources[0];
}

test('an unmanaged source opted out keeps its local commits unpublished and still syncs and fast-forwards; the other source publishes', async () => {
  for (const engine of engines) {
    const kept = repo(`kept-${engine.kind}`), other = repo(`other-${engine.kind}`);
    const keptId = `kept-${engine.kind}`, otherId = `other-${engine.kind}`;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb),($4,$4,$5,$6::text::jsonb)',
      [keptId, kept.root, JSON.stringify({ remote_url: kept.remote, managed_clone: true }), otherId, other.root, JSON.stringify({ remote_url: other.remote, managed_clone: true })]);
    try {
      await engine.setConfig(optOut(keptId), 'false');
      const theirs = siblingPush(kept, 'notes/theirs.md', page('Theirs', 'From the sibling.'));
      expect(await reconcile(engine, { sourceIds: [keptId] })).toMatchObject([{ sources: [keptId], status: 'fast_forwarded', behind: 1, publish_off: [keptId] }]);
      expect(git(kept.root, 'rev-parse', 'HEAD')).toBe(theirs);
      const mine = commit(kept.root, 'notes/mine.md', page('Mine', 'A local commit.'));
      const otherLocal = commit(other.root, 'notes/other.md', page('Other', 'Publishes as before.'));
      const preview = await reconcile(engine, { sourceIds: [keptId, otherId], dryRun: true });
      expect(preview.find(r => r.sources.includes(keptId))).toMatchObject({ status: 'unpublished', ahead: 1, publish_off: [keptId], reason: expect.stringContaining(`automatic publishing is off for ${keptId}`) });
      expect(preview.find(r => r.sources.includes(otherId))).toMatchObject({ status: 'published', reason: 'dry run: nothing changed' });
      expect(preview.find(r => r.sources.includes(otherId))!.publish_off).toBeUndefined();
      const done = await reconcile(engine, { sourceIds: [keptId, otherId] });
      expect(done.find(r => r.sources.includes(keptId))).toMatchObject({ status: 'unpublished', ahead: 1 });
      expect(done.find(r => r.sources.includes(otherId))).toMatchObject({ status: 'published', ahead: 1 });
      expect(tip(kept)).toBe(theirs);
      expect(onRemote(kept.remote, mine)).toBe(false);
      expect(tip(other)).toBe(otherLocal);
      await performSync(engine, { sourceId: keptId, repoPath: kept.root, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 } as never);
      expect(await livePage(engine, keptId, 'notes/mine')).toBe(true);
      expect(await statusJson(engine, keptId)).toMatchObject({ source_id: keptId, auto_reconcile: false });
      expect((await statusJson(engine, otherId)).auto_reconcile).toBeUndefined();
      await engine.unsetConfig(optOut(keptId));
      expect(await reconcile(engine, { sourceIds: [keptId] })).toMatchObject([{ status: 'published', ahead: 1 }]);
      expect(tip(kept)).toBe(mine);
    } finally {
      await engine.unsetConfig(optOut(keptId));
      await engine.executeRaw('DELETE FROM sources WHERE id = ANY($1::text[])', [[keptId, otherId]]);
    }
  }
}, 240_000);

test('an opted-out source holds every source in its Git repository, even with sync off and the global key true', async () => {
  for (const engine of engines) {
    const shared = repo(`shared-${engine.kind}`);
    const quiet = `quiet-${engine.kind}`, loud = `loud-${engine.kind}`;
    commit(shared.root, 'quiet/readme.md', page('Quiet', 'One folder.'));
    commit(shared.root, 'loud/readme.md', page('Loud', 'Another folder.'));
    git(shared.root, 'push', '-q', 'origin', 'main');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb),($4,$4,$5,$6::text::jsonb)',
      [quiet, join(shared.root, 'quiet'), JSON.stringify({ remote_url: shared.remote }), loud, join(shared.root, 'loud'), JSON.stringify({ remote_url: shared.remote })]);
    try {
      await engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
      await engine.setConfig(optOut(quiet), 'false');
      await runSources(engine, ['set-sync', quiet, 'off']);
      const local = commit(shared.root, 'quiet/private.md', page('Private', 'Committed under the opted-out folder.'));
      const held = await reconcile(engine, { sourceIds: [loud] });
      expect(held).toMatchObject([{ sources: [loud], status: 'unpublished', ahead: 1, publish_off: [quiet], reason: expect.stringContaining(`automatic publishing is off for ${quiet}`) }]);
      expect(onRemote(shared.remote, local)).toBe(false);
      await engine.unsetConfig(optOut(quiet));
      expect(await reconcile(engine, { sourceIds: [loud] })).toMatchObject([{ sources: [loud], status: 'published', ahead: 1 }]);
      expect(onRemote(shared.remote, local)).toBe(true);
    } finally {
      await engine.unsetConfig(optOut(quiet));
      await engine.unsetConfig(REFRESH_PUBLISH_DIVERGED_KEY);
      await engine.executeRaw('DELETE FROM sources WHERE id = ANY($1::text[])', [[quiet, loud]]);
    }
  }
}, 180_000);

test('a managed member opted out: refresh and git-reconcile never publish the worktree, its sync goes on, and removing the key publishes', () => (async () => {
  for (const engine of engines) {
    await withEnv({ GBRAIN_JOB_CHILD_CLI: childCli }, () => withRefreshFixture(engine, async f => {
      await engine.executeRaw(`UPDATE persistence_host_bindings SET git_durability='enabled' WHERE local_path LIKE $1`, [`${f.root}%`]);
      try {
        await engine.setConfig(optOut(f.beta), 'false');
        f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
        git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid');
        const local = commit(f.root, 'beta/local.md', page('Local', 'A local commit nobody pushed.'));
        expect(await reconcileSources(engine, { sourceIds: [f.alpha, f.beta] })).toMatchObject([{ managed: true, status: 'unpublished', ahead: 1, behind: 1, publish_off: [f.beta],
          reason: expect.stringContaining(`automatic publishing is off for ${f.beta}`) }]);
        const refused = await refreshWorktree(engine, f.alpha).then(() => null, error => error as { code: string; message: string });
        expect(refused).toMatchObject({ code: 'refresh_diverged', message: expect.stringContaining('sources.auto_reconcile.source.<id> false') });
        expect(onRemote(f.remote, local)).toBe(false);
        expect(f.head()).toBe(local);
        await performManagedSync(engine, { sourceId: f.beta, noPull: true, noEmbed: true });
        expect(await livePage(engine, f.beta, 'local')).toBe(true);
        expect(await statusJson(engine, f.beta)).toMatchObject({ auto_reconcile: false });
        await engine.unsetConfig(optOut(f.beta));
        expect(await reconcileSources(engine, { sourceIds: [f.alpha, f.beta] })).toMatchObject([{ managed: true, status: 'published', ahead: 1, behind: 1 }]);
        expect(onRemote(f.remote, local)).toBe(true);
      } finally {
        await engine.unsetConfig(optOut(f.beta));
        await engine.executeRaw(`UPDATE persistence_host_bindings SET git_durability=NULL WHERE local_path LIKE $1`, [`${f.root}%`]);
      }
    }));
  }
})(), 300_000);

test('the global key and set-sync off behave as before, and an opt-out set to true changes no default', async () => {
  const engine = plain;
  {
    const owned = repo('owned'), foreign = repo('foreign');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb),($4,$4,$5,$6::text::jsonb)',
      ['owned', owned.root, JSON.stringify({ remote_url: owned.remote, managed_clone: true }), 'foreign', foreign.root, JSON.stringify({ remote_url: foreign.remote })]);
    await engine.setConfig(optOut('owned'), 'true');
    await engine.setConfig(optOut('foreign'), 'true');
    const foreignLocal = commit(foreign.root, 'notes/private.md', page('Private', 'Stays local by default.'));
    await engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'false');
    const ownedLocal = commit(owned.root, 'notes/mine.md', page('Mine', 'Held by the global key.'));
    const held = await reconcile(engine);
    expect(held.find(r => r.sources.includes('owned'))).toMatchObject({ status: 'unpublished', reason: `automatic publishing is off (${REFRESH_PUBLISH_DIVERGED_KEY} false)` });
    expect(held.find(r => r.sources.includes('foreign'))).toMatchObject({ status: 'unpublished' });
    expect(held.every(r => r.publish_off === undefined)).toBe(true);
    await engine.unsetConfig(REFRESH_PUBLISH_DIVERGED_KEY);
    const after = await reconcile(engine);
    expect(after.find(r => r.sources.includes('owned'))).toMatchObject({ status: 'published' });
    expect(after.find(r => r.sources.includes('foreign'))).toMatchObject({ status: 'unpublished', reason: expect.stringContaining('did not clone') });
    expect(tip(owned)).toBe(ownedLocal);
    expect(onRemote(foreign.remote, foreignLocal)).toBe(false);
    await runSources(engine, ['set-sync', 'owned', 'off']);
    commit(owned.root, 'notes/later.md', page('Later', 'Sync is off for this source.'));
    expect((await reconcile(engine)).some(r => r.sources.includes('owned'))).toBe(false);
  }
}, 180_000);

test('a commit-push child stopped at its bound leaves none of its descendants running', async () => {
  const r = repo('hung-child');
  const script = join(dir, 'bin', 'hangs'), pidFile = join(dir, 'grandchild.pid');
  writeFileSync(script, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`);
  chmodSync(script, 0o755);
  const started = Date.now();
  const refused = await withEnv({ GBRAIN_JOB_CHILD_CLI: script }, () => commitPushChild(r.root, ['--pull'], 1_500)).then(() => null, error => error as { code: string });
  expect(refused).toMatchObject({ code: 'push_unconfirmed' });
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(existsSync(pidFile)).toBe(true);
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  const running = () => {
    try { process.kill(grandchild, 0); } catch { return false; }
    try { const stat = readFileSync(`/proc/${grandchild}/stat`, 'utf8'); return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z'); } catch { return process.platform !== 'linux'; }
  };
  try { expect(running()).toBe(false); } finally { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ } }
}, 60_000);

test('a stopped child settles only after a descendant that ignores SIGTERM and holds none of its pipes is gone', async () => {
  const script = join(dir, 'bin', 'stubborn'), pidFile = join(dir, 'stubborn.pid');
  writeFileSync(script, `#!/bin/sh\n(trap '' TERM; exec sleep 30) </dev/null >/dev/null 2>&1 &\necho $! > '${pidFile}'\nwait\n`);
  chmodSync(script, 0o755);
  const termGraceMs = 1_500;
  const started = Date.now();
  const done = await execFileBounded(script, [], { timeout: 500, termGraceMs, killTree: true });
  const stoppedAfter = Date.now() - started;
  expect(done.error).toMatchObject({ code: 'ETIMEDOUT' });
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  const gone = () => {
    try { const stat = readFileSync(`/proc/${grandchild}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z'); } catch { /* not Linux or gone */ }
    try { process.kill(grandchild, 0); return false; } catch { return true; }
  };
  try {
    expect(gone()).toBe(true);
    expect(stoppedAfter).toBeGreaterThanOrEqual(500 + termGraceMs - 50);
  } finally { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ } }
}, 30_000);
