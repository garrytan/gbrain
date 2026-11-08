/** #8828: drain-completed ledgered writes must not consume both refresh attempts.
 * Real Git commits/pushes at the drained boundary model checkout effects finishing
 * after precheck. Assert persisted recovery heads, member sync and divergent refusal.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { recordCommit } from '../src/core/git/commit-ledger.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { REFRESH_PUBLISH_DIVERGED_KEY, refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { waitForWrite } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { commitFile, git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
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
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});
const each = async (fn: (f: RefreshFixture) => Promise<void>) => { for (const engine of engines) await withRefreshFixture(engine, fn); };

function drainedWrite(f: RefreshFixture, publish: boolean): { local: string; target: string } {
  const local = commitFile(f.root, 'alpha/drained.md', page('Drained', 'A canonical write that finished during drain.'));
  recordCommit(f.root, { sha: local, writer: 'effect' });
  if (!publish) return { local, target: git(f.upstream, 'rev-parse', 'HEAD') };
  git(f.upstream, 'fetch', '-q', f.root, 'HEAD');
  git(f.upstream, 'merge', '--no-edit', '--quiet', 'FETCH_HEAD');
  git(f.upstream, 'push', '-q', 'origin', 'main');
  return { local, target: git(f.upstream, 'rev-parse', 'HEAD') };
}

test('own drained commits replan within one fenced refresh and sync both sources to fresh upstream', () => each(async f => {
  f.push('beta/incoming.md', page('Incoming', 'An upstream change.'));
  let drained = 0;
  let landed!: ReturnType<typeof drainedWrite>;
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => {
    if (point === 'drained' && ++drained === 1) landed = drainedWrite(f, true);
  } } });
  expect(drained).toBe(1);
  expect(result).toMatchObject({ status: 'completed', old_head: landed.local, target_head: landed.target });
  expect(f.head()).toBe(landed.target);
  expect((await f.refreshRows()).map(row => row.state)).toEqual(['completed']);
  for (const source of [f.alpha, f.beta]) expect(await f.lastCommit(source)).toBe(landed.target);
  expect((await f.engine.getPage('drained', { sourceId: f.alpha }))?.compiled_truth).toContain('canonical write');
  expect((await f.engine.getPage('incoming', { sourceId: f.beta }))?.compiled_truth).toContain('upstream change');
}), 180_000);

test('unpushed drained commits refuse genuine divergence without spending another tick attempt', () => each(async f => {
  f.push('beta/incoming.md', page('Incoming', 'An upstream change.'));
  let drained = 0;
  let landed!: ReturnType<typeof drainedWrite>;
  const error = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => {
    if (point === 'drained') { drained++; landed = drainedWrite(f, false); }
  } } }).then(() => null, (e: unknown) => e as { code?: string });
  expect(error?.code).toBe('refresh_diverged');
  expect(drained).toBe(1);
  expect(f.head()).toBe(landed.local);
  expect((await f.refreshRows()).map(row => row.state)).toEqual(['aborted']);
}), 180_000);

test('a crash after replanning persists the new recovery base before the fenced boundary', () => each(async f => {
  f.push('beta/incoming.md', page('Incoming', 'An upstream change.'));
  let landed!: ReturnType<typeof drainedWrite>;
  await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => {
    if (point === 'drained') landed = drainedWrite(f, true);
    if (point === 'fenced') throw new Error('synthetic crash after replan');
  } } }).catch(() => undefined);
  const [row] = await f.engine.executeRaw<{ state: string; old_head: string; target_head: string }>(
    'SELECT state,old_head,target_head FROM persistence_worktree_refreshes WHERE worktree_id=$1::uuid', [f.worktreeId]);
  expect(row).toMatchObject({ state: 'fenced', old_head: landed.local, target_head: landed.target });
  const resumed = await refreshWorktree(f.engine, f.alpha, { resume: true });
  expect(resumed.status).toBe('abandoned');
  expect(f.head()).toBe(landed.local);
  const next = await refreshWorktree(f.engine, f.alpha);
  expect(next.status).toBe('completed');
  expect(f.head()).toBe(landed.target);
}), 180_000);

test('standing publish consent still integrates an unpushed drained write without lifting the barrier', () => each(async f => {
  const child = join(f.dir, 'gbrain');
  writeFileSync(child, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, '..', 'src', 'cli.ts')}' "$@"\n`);
  chmodSync(child, 0o755);
  git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid');
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  try {
    await withEnv({ GBRAIN_JOB_CHILD_CLI: child, GBRAIN_REFRESH_BARRIER: '1' }, async () => {
      resetWriteSwitches();
      f.push('beta/incoming.md', page('Incoming', 'An upstream change.'));
      let drained = 0;
      let deferred!: WriteRequest;
      let heldAtFence = false;
      const done = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
        if (point === 'drained' && ++drained === 1) {
          drainedWrite(f, false);
          const out = await dispatchToolCall(f.engine, 'put_page', { slug: 'held', content: page('Held', 'A later admitted write.') },
            { remote: true, transport: 'stdio', sourceId: f.alpha, admissionOrigin: 'interactive' });
          const body = JSON.parse(out.content[0]!.text);
          [deferred] = await f.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [body.request_id]);
        }
        if (point === 'fenced') {
          const [stored] = await f.engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE id=$1::uuid', [deferred.id]);
          heldAtFence = stored?.state === 'deferred';
        }
      } } });
      expect(drained).toBe(1);
      expect(deferred.state).toBe('deferred');
      expect(heldAtFence).toBe(true);
      expect(done.status).toBe('completed');
      expect(done.published).toMatchObject({ local_commits: 1, integrated: 1 });
      expect(done.target_head).toBe(done.published!.sha);
      expect(f.head()).toBe(done.target_head!);
      expect((await f.refreshRows()).map(row => row.state)).toEqual(['completed']);
      expect((await waitForWrite(f.engine, deferred, { engine: f.engine.kind } as never, 30_000)).state).toBe('committed');
    });
  } finally { resetWriteSwitches(); await f.engine.unsetConfig(REFRESH_PUBLISH_DIVERGED_KEY); }
}), 180_000);

test('post-drain dirty overlaps refuse before merging and preserve local commits and uncommitted bytes', () => each(async f => {
  f.push('beta/incoming.md', page('Incoming', 'An upstream change.'));
  let landed!: ReturnType<typeof drainedWrite>;
  const dirty = page('Incoming', 'An uncommitted local change.');
  const error = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => {
    if (point === 'drained') {
      landed = drainedWrite(f, true);
      writeFileSync(join(f.root, 'beta/incoming.md'), dirty);
    }
  } } }).then(() => null, (e: unknown) => e as { code?: string });
  expect(error?.code).toBe('refresh_dirty');
  expect(f.head()).toBe(landed.local);
  expect((await f.refreshRows()).map(row => row.state)).toEqual(['aborted']);
  expect(await Bun.file(join(f.root, 'beta/incoming.md')).text()).toBe(dirty);
}), 180_000);

for (const seam of ['fetch', 'fenced'] as const) {
  test(`a foreign HEAD move during post-drain ${seam} is not adopted as a verified base`, () => each(async f => {
    f.push('beta/incoming.md', page('Incoming', 'An upstream change.'));
    let foreign = '';
    let drained = 0;
    const error = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => {
      if (point === 'drained' && ++drained === 1) {
        drainedWrite(f, true);
        writeFileSync(join(f.root, 'beta/foreign.md'), page('Foreign', 'Not a ledgered write.'));
        git(f.root, 'add', 'beta/foreign.md');
        if (seam === 'fetch') {
          const wrapper = join(f.dir, 'upload-pack');
          writeFileSync(wrapper, `#!/bin/sh\ngit -C '${f.root}' -c user.name=Example -c user.email=example@example.invalid -c commit.gpgsign=false commit -qm foreign >/dev/null 2>&1\nexec git-upload-pack "$@"\n`);
          chmodSync(wrapper, 0o755);
          git(f.root, 'config', 'remote.origin.uploadpack', wrapper);
        }
      }
      if (point === 'fenced' && seam === 'fenced') git(f.root, 'commit', '-qm', 'foreign');
    } } }).then(() => null, (e: unknown) => e as { code?: string });
    foreign = f.head();
    expect(error?.code).toBe('refresh_source_changed');
    expect(drained).toBe(1);
    expect((await f.refreshRows()).map(row => row.state)).toEqual(['aborted']);
    expect(git(f.root, 'log', '-1', '--format=%s')).toBe('foreign');
    expect(git(f.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]).not.toBe(foreign);
  }), 180_000);
}
