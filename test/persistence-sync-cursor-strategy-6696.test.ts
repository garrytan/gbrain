import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedCursorKey } from '../src/core/persistence/sync-cursor-key.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

// #6696 C1: `sync --all` passes the source's configured strategy while a single-source CLI run, autopilot's cycle and a
// serve-delegated run pass none, so the same source got two cursor keys (two unfinished cursors that could not resume each
// other). #6712 PR 1 rewrote these tests: the key no longer digests any option (`managedCursorKey(incarnation, company)`),
// so the strategy normalization (`selectManagedCursor`) is deleted. Every run of the source selects the same cursor, a run
// with other options finishes the unfinished one under its frozen options, and a cursor written under an older key is
// finished in place under that key (the requests it admitted name it), after which the next run takes the current key.
//
// Regression guarded: an option creeping back into the key (the keys diverge again), or an older key's live cursor moved
// to the current key (its queued requests are fenced out by the cursor they no longer match).

const home = mkdtempSync(join(tmpdir(), 'gbrain-cursor-strategy-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
async function fixture(engine: BrainEngine, config: Record<string, unknown>) {
  const id = `strategy-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\nA durable observation named ${name} at fund-a.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, JSON.stringify(config)]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return id;
}
const rootOf = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ p: string }>('SELECT local_path AS p FROM sources WHERE id=$1', [id]))[0]!.p;
const isolated = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
  for (const engine of engines) await fn(engine);
});
const cursors = async (engine: BrainEngine, id: string) => engine.executeRaw<{ key: string; done: string | null; strategy: string | null }>(
  "SELECT fingerprint AS key,completed_keys->0->>'done' AS done,completed_keys->0->'syncOptions'->>'strategy' AS strategy FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [id]);
const refused = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state IN ('failed','conflict','cancelled')", [id]))[0]!.n;
const incarnation = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ i: string }>('SELECT incarnation::text AS i FROM sources WHERE id=$1', [id]))[0]!.i;
// What each caller passes: the single-source CLI, the cycle and a delegated run pass no strategy; `sync --all` passes the configured one.
const single = (sourceId: string): SyncOpts => ({ sourceId, noPull: true, noEmbed: true });
const all = (sourceId: string): SyncOpts => ({ ...single(sourceId), strategy: 'markdown' });

test('a single-source run and a `sync --all` run of a source configured with a strategy select one cursor key', async () => isolated(async engine => {
  const id = await fixture(engine, { strategy: 'markdown' });
  expect(await performManagedSync(engine, single(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  const key = managedCursorKey(await incarnation(engine, id), undefined);
  expect(await cursors(engine, id)).toEqual([{ key, done: null, strategy: null }]);
  // `sync --all`'s strategy differs from the cursor's frozen (absent) one: it finishes that run and says so.
  const finished = await performManagedSync(engine, all(id));
  expect(finished.status).toBe('first_sync');
  expect(finished.cursorAdopted).toMatchObject({ writer_changed: false, legacy_key: false, sync_options: expect.objectContaining({ strategy: null }) });
  expect(await cursors(engine, id)).toEqual([{ key, done: 'true', strategy: null }]);
  expect(await refused(engine, id)).toBe(0);
}), 120_000);

test('an unfinished cursor under an older key finishes under that key; the next fresh run takes the current key', async () => isolated(async engine => {
  const id = await fixture(engine, {});
  expect(await performManagedSync(engine, single(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  // The same cursor as an older binary keyed it (the key digested principal, authority and options).
  const legacy = `legacy-${randomUUID()}`;
  await engine.executeRaw("UPDATE op_checkpoints SET fingerprint=$2 WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [id, legacy]);
  await engine.executeRaw(`UPDATE sources SET config='{"strategy":"markdown"}'::jsonb WHERE id=$1`, [id]);
  const resumed = await performManagedSync(engine, single(id));
  expect(resumed.status).toBe('first_sync');
  expect(resumed.cursorFanIn).toEqual({ adopted: true, superseded: 0, retained: 0 });
  expect(await cursors(engine, id)).toEqual([{ key: legacy, done: 'true', strategy: null }]);
  expect(await refused(engine, id)).toBe(0);
  // Finished: the next run retires it and takes the current key, whichever caller it is.
  writeFileSync(join(await rootOf(engine, id), 'e.md'), '---\ntitle: e\n---\nA durable observation named e at fund-a.\n');
  git(await rootOf(engine, id), 'add', '.'); git(await rootOf(engine, id), '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'e');
  expect((await performManagedSync(engine, all(id))).status).toBe('synced');
  expect(await cursors(engine, id)).toEqual([{ key: managedCursorKey(await incarnation(engine, id), undefined), done: 'true', strategy: 'markdown' }]);
}), 120_000);

test('an explicit --strategy that differs from the configured one resumes the same cursor', async () => isolated(async engine => {
  const id = await fixture(engine, { strategy: 'markdown' });
  expect(await performManagedSync(engine, single(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  const finished = await performManagedSync(engine, { ...single(id), strategy: 'auto' });
  expect(finished.status).toBe('first_sync');
  expect(await cursors(engine, id)).toHaveLength(1);
}), 120_000);
