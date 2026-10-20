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
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

// #6696 C1: `sync --all` passes the source's configured strategy while a single-source CLI run, autopilot's cycle and a
// serve-delegated run pass none, so the same source got two cursor keys (two unfinished cursors that could not resume each
// other). #6712 PR 1 took every option out of the cursor key; #6712 PR 4b replaced a non-company source's cursor with one
// live pass row per source incarnation (`managed-sync-pass`, `<source>:<incarnation>`). Every caller's pass of the source,
// whatever strategy it passes, reads and writes that one row and leaves no cursor row behind. The legacy-key handover
// (an older binary's cursor) is covered by sync-pass-handover-6712.test.ts and sync-pass-cursor-retirement-6712.test.ts.
//
// Regression guarded: an option creeping back into the pass row's key (two rows for one source), or a pass of one caller
// unable to finish another's.

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
const lastCommit = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ c: string | null }>('SELECT last_commit AS c FROM sources WHERE id=$1', [id]))[0]!.c;
const rootOf = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ p: string }>('SELECT local_path AS p FROM sources WHERE id=$1', [id]))[0]!.p;
const isolated = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
  for (const engine of engines) await fn(engine);
});
const stateRows = async (engine: BrainEngine, id: string) => engine.executeRaw<{ op: string; key: string }>(
  "SELECT op, fingerprint AS key FROM op_checkpoints WHERE op IN ('managed-sync','managed-sync-pass') AND (completed_keys->0->>'sourceId'=$1 OR completed_keys->0->>'source_id'=$1) ORDER BY op, fingerprint", [id]);
const refused = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state IN ('failed','conflict','cancelled')", [id]))[0]!.n;
const incarnation = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ i: string }>('SELECT incarnation::text AS i FROM sources WHERE id=$1', [id]))[0]!.i;
// What each caller passes: the single-source CLI, the cycle and a delegated run pass no strategy; `sync --all` passes the configured one.
const single = (sourceId: string): SyncOpts => ({ sourceId, noPull: true, noEmbed: true });
const all = (sourceId: string): SyncOpts => ({ ...single(sourceId), strategy: 'markdown' });

test('a single-source run and a `sync --all` run of a source configured with a strategy share one pass row', async () => isolated(async engine => {
  const id = await fixture(engine, { strategy: 'markdown' });
  expect(await performManagedSync(engine, single(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  const pass = [{ op: 'managed-sync-pass', key: `${id}:${await incarnation(engine, id)}` }];
  expect(await stateRows(engine, id)).toEqual(pass);
  const finished = await performManagedSync(engine, all(id));
  expect(finished.status).toBe('first_sync');
  expect(await stateRows(engine, id)).toEqual(pass);
  expect(await refused(engine, id)).toBe(0);
  for (const name of ['a', 'b', 'c', 'd']) expect(await engine.getPage(name, { sourceId: id })).not.toBeNull();
  expect(await lastCommit(engine, id)).toBe(git(await rootOf(engine, id), 'rev-parse', 'HEAD'));
}), 120_000);

test('an explicit --strategy that differs from the configured one runs on the same pass row, and the next plain pass checkpoints HEAD', async () => isolated(async engine => {
  const id = await fixture(engine, { strategy: 'markdown' });
  expect(await performManagedSync(engine, single(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  expect((await performManagedSync(engine, { ...single(id), strategy: 'auto' })).status).not.toBe('blocked_by_failures');
  expect(await stateRows(engine, id)).toEqual([{ op: 'managed-sync-pass', key: `${id}:${await incarnation(engine, id)}` }]);
  expect((await performManagedSync(engine, single(id))).status).not.toBe('blocked_by_failures');
  for (const name of ['a', 'b', 'c', 'd']) expect(await engine.getPage(name, { sourceId: id })).not.toBeNull();
  expect(await lastCommit(engine, id)).toBe(git(await rootOf(engine, id), 'rev-parse', 'HEAD'));
}), 120_000);
