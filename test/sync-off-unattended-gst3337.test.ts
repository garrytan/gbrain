/**
 * GST-3337: a source with automatic sync off (`config.syncEnabled=false`, `gbrain sources set-sync <id> off`) is synced by no
 * unattended path. The dispatchers already skipped it (fan-out, freshness loop, queued freshness jobs, `sync --all`), but the
 * cycle's own sync phase did not: `gbrain dream --source <id>` (doctor's cycle_freshness fix) and an autopilot-cycle job whose
 * phases name sync ran the source's sync, and for a Google source that resumed a paused contacts re-list and wrote pages.
 * Red on master: the sync phase runs (the checkout's note is imported, the Google source attempts its sync).
 * The explicit `gbrain sync --source <id>` still syncs.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { makeAutopilotCycleHandler } from '../src/core/minions/handlers/autopilot-cycle.ts';
import { performSync } from '../src/commands/sync.ts';
import { dispatchFreshnessSyncs } from '../src/commands/autopilot-dispatch.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { makeSyncHandler } from '../src/core/minions/handlers/sync.ts';
import { recordConnectorSyncAttempt } from '../src/core/persistence/connector-state.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { checkCycleFreshness } from '../src/commands/doctor.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-off-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

const each = (run: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const engine of engines) { try { await run(engine); } finally { await disposePersistenceConsumer(engine); } }
});

/** Inserts a source row outside writer administration (persistence briefly off), as the managed-sync tests do. */
async function insertSource(engine: BrainEngine, id: string, localPath: string | null, config: Record<string, unknown>, claim = false): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::jsonb)', [id, localPath, JSON.stringify(config)]);
  if (claim && localPath) await claimWorktree(engine, id, localPath);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}

/** A checkout source with one committed note and automatic sync off. */
async function checkoutSource(engine: BrainEngine): Promise<{ id: string; repo: string; pages: () => Promise<number> }> {
  const id = `source-a-${randomUUID().replace(/-/g, '').slice(0, 12)}`, repo = join(home, id);
  mkdirSync(repo, { recursive: true }); git(repo, 'init', '-q');
  writeFileSync(join(repo, 'note.md'), '---\ntitle: Note\ntype: note\n---\n\nA short synthetic note.\n');
  git(repo, 'add', '-A'); git(repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'note');
  await insertSource(engine, id, repo, { syncEnabled: false }, true);
  const pages = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [id]))[0].n;
  return { id, repo, pages };
}

const syncPhase = (report: { phases: Array<{ phase: string; status: string; details?: Record<string, unknown> }> }) => report.phases.find(p => p.phase === 'sync');

test('gbrain dream --source <id> skips the sync phase of a source with sync off and imports nothing', () => each(async engine => {
  const { id, repo, pages } = await checkoutSource(engine);
  const report = await runCycle(engine, { brainDir: repo, sourceId: id, phases: ['sync'] });
  expect(syncPhase(report)).toMatchObject({ status: 'skipped', details: { reason: 'sync_disabled', source_id: id } });
  expect(await pages()).toBe(0);
}), 120_000);

test('a dream over the checkout directory alone (no --source) skips it too', () => each(async engine => {
  const { id, repo, pages } = await checkoutSource(engine);
  const report = await runCycle(engine, { brainDir: repo, phases: ['sync'] });
  expect(syncPhase(report)).toMatchObject({ status: 'skipped', details: { reason: 'sync_disabled', source_id: id } });
  expect(await pages()).toBe(0);
}), 120_000);

test('an autopilot-cycle job whose phases name sync (a legacy payload) does not sync a source with sync off', () => each(async engine => {
  const { id, pages } = await checkoutSource(engine);
  await makeAutopilotCycleHandler(engine)({ id: 1, data: { source_id: id, repoPath: null, pull: false, phases: ['sync'] }, signal: new AbortController().signal } as never);
  expect(await pages()).toBe(0);
}), 120_000);

test('a Google source with sync off and a materialize directory on disk is not synced by a dream', () => each(async engine => {
  const id = `source-g-${randomUUID().replace(/-/g, '').slice(0, 12)}`, dir = join(home, id);
  mkdirSync(dir, { recursive: true });
  await insertSource(engine, id, dir, { kind: 'google', syncEnabled: false });
  const report = await runCycle(engine, { brainDir: dir, sourceId: id, phases: ['sync'] });
  expect(syncPhase(report)).toMatchObject({ status: 'skipped', details: { reason: 'sync_disabled', source_id: id } });
}), 120_000);

test('the freshness loop queues no sync for a Google source with sync off, even after its first sync', () => each(async engine => {
  const id = `source-g-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await insertSource(engine, id, null, { kind: 'google', syncEnabled: false });
  await recordConnectorSyncAttempt(engine, id);
  await dispatchFreshnessSyncs(engine, new MinionQueue(engine), { baseInterval: 60, slot: `slot-${randomUUID()}`, timeoutMs: 60_000, jsonMode: true });
  const queued = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE name='sync' AND data->>'sourceId'=$1", [id]);
  expect(queued[0].n).toBe(0);
}), 120_000);

test('a queued freshness sync job of a source with sync off is skipped and imports nothing', () => each(async engine => {
  const { id, repo, pages } = await checkoutSource(engine);
  const result = await makeSyncHandler(engine)({ id: 1, name: 'sync', data: { sourceId: id, repoPath: repo, pull: false, embed_reason: 'autopilot_freshness' }, signal: new AbortController().signal } as never);
  expect(result).toMatchObject({ skipped: true, reason: 'sync_disabled', source_id: id });
  expect(await pages()).toBe(0);
}), 120_000);

test('doctor cycle_freshness reads a never-cycled source with sync off as sync off, not stale, and never names it in its fix', () => each(async engine => {
  const id = `source-g-${randomUUID().replace(/-/g, '').slice(0, 12)}`, dir = join(home, id);
  mkdirSync(dir, { recursive: true });
  await insertSource(engine, id, dir, { kind: 'google', syncEnabled: false });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO pages (source_id, slug, type, title, created_at) VALUES ($1, 'note-a', 'note', 'Note A', now() - interval '30 days')", [id]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const result = await checkCycleFreshness(engine);
  expect(result.message).toContain(`Sync off (not checked; only an explicit gbrain sync --source <id> syncs `);
  expect(result.message).toContain(`'${id}'`);
  expect(result.message).not.toContain(`Source '${id}' has never completed a full cycle`);
  expect(JSON.stringify(result.fix ?? null)).not.toContain(id);
}), 120_000);

test('the explicit gbrain sync --source <id> still syncs a source with sync off', () => each(async engine => {
  const { id, repo, pages } = await checkoutSource(engine);
  await performSync(engine, { sourceId: id, repoPath: repo, noPull: true, noEmbed: true, noExtract: true });
  expect(await pages()).toBe(1);
}), 120_000);
