/**
 * #7189 (status half): `gbrain sync status` contradicted itself while a large source fell behind. Each case below is
 * red on master:
 * - freshness counted only commits that already synced (`commits`, `unresolved_commits: 0`, a healthy p50) while
 *   commits sat unsynced on HEAD; it now reports `behind` (commits after the last synced one, the oldest one's age);
 * - the notifier said "No resident … watches this source" while a sync held the source's drain lease; it now names the
 *   holder (`drain_holder`) and owes no fix while the holder makes progress;
 * - `last_error` kept driving `needs_human`, `state` and `next` after the source's sync committed a page past it;
 *   it now reads `superseded` and drives none of them;
 * - a top-level `needs_human: true` from a hold sat beside `last_error.needs_human: false` with nothing saying which
 *   one it came from; `needs_human_from` names it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { recordManagedSyncFailure } from '../src/core/persistence/sync-failures.ts';
import { readSyncFreshness, formatSyncFreshness } from '../src/core/persistence/sync-freshness.ts';
import { withDrainLease } from '../src/core/persistence/sync-lease.ts';
import { formatNotifierBlock, readNotifierBlock } from '../src/core/notifier/status.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-status-7189-'));
let engine: BrainEngine;
const git = (root: string, args: string[], env?: Record<string, string>) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
const commit = (root: string, message: string, at?: number) => {
  const env = at ? { GIT_COMMITTER_DATE: `@${at} +0000`, GIT_AUTHOR_DATE: `@${at} +0000` } : undefined;
  git(root, ['add', '.'], env);
  git(root, ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message], env);
  return git(root, ['rev-parse', 'HEAD']);
};
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;

/** A managed source with one synced commit. */
async function syncedSource(): Promise<{ id: string; root: string }> {
  const id = `st-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root); git(root, ['init', '-q']);
  writeFileSync(join(root, 'alice-example.md'), note('Alice one.'));
  commit(root, 'fixture', Math.floor(Date.now() / 1000) - 7200);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect((await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
  return { id, root };
}

beforeAll(async () => { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('freshness reports the commits on HEAD that have not synced yet and the oldest one\'s age', () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { id, root } = await syncedSource();
  const [before] = await readSyncFreshness(engine, { sourceIds: [id] });
  expect(before!.behind).toEqual({ commits: 0, oldest_seconds: null });
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(join(root, 'bob-example.md'), note('Bob.')); commit(root, 'two', now - 3600);
  writeFileSync(join(root, 'carol-example.md'), note('Carol.')); commit(root, 'three', now - 60);
  const [after] = await readSyncFreshness(engine, { sourceIds: [id] });
  expect(after!.behind!.commits).toBe(2);
  // GBRA-133 (#7243): the backlog is named beside unresolved_commits, which counts only synced commits git cannot date.
  expect(after!.waiting_commits).toBe(2);
  expect(after!.behind!.oldest_seconds).toBeGreaterThanOrEqual(3600);
  expect(after!.behind!.oldest_seconds).toBeLessThan(3600 + 300);
  expect(formatSyncFreshness(after!)).toMatch(/; 2 commit\(s\) not synced yet, oldest 6\d(\.\d)?m old$/);
}), 240_000);

test('the notifier names the process holding the drain lease instead of saying nothing watches the source', () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { id } = await syncedSource();
  const idle = await readNotifierBlock(engine, id);
  expect(idle!.resident).toBeNull();
  expect(idle!.drain_holder).toBeNull();
  expect(idle!.fix!.why).toContain('No resident');
  const seen: Array<Awaited<ReturnType<typeof readNotifierBlock>>> = [];
  await withDrainLease(engine, id, { holder: { kind: 'serve', id: 'serve-example' } }, async () => {
    seen.push(await readNotifierBlock(engine, id), await readNotifierBlock(engine, id, { remote: true }));
    return { status: 'synced' } as never;
  });
  const [held, remote] = seen;
  expect(held!.resident).toBeNull();
  expect(held!.drain_holder).toMatchObject({ kind: 'serve', id: 'serve-example', pid: process.pid });
  expect(held!.fix).toBeNull();
  expect(formatNotifierBlock(id, held!)).toContain('serve (PID');
  expect(formatNotifierBlock(id, held!)).toContain('holds the drain lease');
  expect(remote!.drain_holder).toMatchObject({ kind: 'serve', id: null, host: null, pid: null });
}), 240_000);

test('a last error the source\'s sync has committed past reads superseded and sets neither needs_human, state nor next', () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { id } = await syncedSource();
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
  const key = `${id}:cursor-example`;
  await recordManagedSyncFailure(engine, { source_id: id, source_incarnation: incarnation, path: 'big-example.md', code: 'file_too_large', message: 'The file is over the page size limit.',
    request_id: null, run_id: 'run-example', target: null, cursor_key: key, phase: 'receipt', state: 'failed', observation_id: 'run-example:0' });
  const live = await readSyncStatus(engine, id);
  expect(live.last_error).toMatchObject({ code: 'file_too_large', needs_human: true });
  expect(live.last_error!.superseded).toBeUndefined();
  expect(live.needs_human).toBe(true);
  expect(live.needs_human_from).toEqual({ kind: 'last_error', code: 'file_too_large' });
  expect(live.state).toBe('blocked');

  await engine.executeRaw("UPDATE op_checkpoints SET updated_at = now() - interval '2 hours' WHERE op='managed-sync-failure' AND fingerprint=$1", [key]);
  const past = await readSyncStatus(engine, id);
  expect(past.last_error).toMatchObject({ code: 'file_too_large', superseded: { at: expect.any(String) } });
  expect(past.needs_human).toBe(false);
  expect(past.needs_human_from).toBeNull();
  expect(past.state).not.toBe('blocked');
  expect(past.reason).not.toBe('last_error');
  expect(past.next?.user_message).toBeUndefined();
}), 240_000);
