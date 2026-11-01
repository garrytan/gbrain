/**
 * #8117: a refresh's fenced ff-merge and `gbrain git commit-push` used different locks, so a door commit holding
 * .git/index.lock made the merge fail as refresh_dirty (caller-class) for a transient collision. The HEAD check through
 * the merge now runs under the checkout's commit lock; a lockless git holding the index lock is retried briefly and then
 * refused as retryable git_index_locked; a commit lock held past its wait is commit_lock_busy. Each refusal aborts the
 * fenced row with HEAD unchanged.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { acquireCommitLockAsync } from '../src/core/git/commit-push.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { page, withRefreshFixture } from './helpers/worktree-refresh-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine as BrainEngine); await engine.disconnect(); });

test('a door commit holding the commit lock and index.lock at the fence is waited out, and the refresh completes', () => withRefreshFixture(engine, async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  const indexLock = join(f.root, '.git', 'index.lock');
  let done: Promise<void> | undefined;
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point !== 'fenced') return;
    const door = await acquireCommitLockAsync(f.root, 0);
    writeFileSync(indexLock, '');
    done = new Promise(resolve => setTimeout(async () => { rmSync(indexLock, { force: true }); await door.release(); resolve(); }, 1500));
  } } });
  await done;
  expect(result.status).toBe('completed');
  expect(f.head()).toBe(target);
}), 120_000);

test('a lockless git holding index.lock is refused as retryable git_index_locked, not refresh_dirty, and the next run completes', () => withRefreshFixture(engine, async f => {
  const before = f.head();
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  const indexLock = join(f.root, '.git', 'index.lock');
  const failure = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === 'fenced') writeFileSync(indexLock, ''); } } })
    .then(() => null, error => error).finally(() => rmSync(indexLock, { force: true }));
  expect(failure).toBeInstanceOf(OperationError);
  expect(failure.code).toBe('git_index_locked');
  expect(failure.retryable).toBe(true);
  const [row] = await f.refreshRows();
  expect(row!.state).toBe('aborted');
  expect(f.head()).toBe(before);
  expect(existsSync(indexLock)).toBe(false);
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  expect(f.head()).toBe(target);
}), 120_000);

test('a commit lock held past its wait aborts the fenced refresh as commit_lock_busy with HEAD unchanged', () => withRefreshFixture(engine, async f => {
  const before = f.head();
  f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  let door: { release(): Promise<void> } | undefined;
  const failure = await withEnv({ GBRAIN_COMMIT_LOCK_WAIT_SECONDS: '1', GBRAIN_PUSH_LOCK_WAIT_SECONDS: undefined }, () => refreshWorktree(f.engine, f.alpha,
    { hooks: { boundary: async point => { if (point === 'fenced') door = await acquireCommitLockAsync(f.root, 0); } } }))
    .then(() => null, error => error).finally(() => door?.release());
  expect(failure).toBeInstanceOf(OperationError);
  expect(failure.code).toBe('commit_lock_busy');
  const [row] = await f.refreshRows();
  expect(row!.state).toBe('aborted');
  expect(f.head()).toBe(before);
}), 120_000);
