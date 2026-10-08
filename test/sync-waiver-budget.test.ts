/**
 * #6278 (B3, plan 1.10): a sync preparation that runs outside the consumer (a
 * no-op waiver screen, the #5522 origin-equivalence check) races the sync
 * budget (`persistence.sync_preparation_ms`) and the run's signal. Past the
 * budget nothing is waived and the origin refusal stands (fail open: the entry
 * is admitted and the consumer's own deadline covers it); a cancelled run
 * propagates. The forced probe sets a 1 ms budget: a full re-sync that waives
 * every unchanged file under the default budget admits every file instead. It
 * runs on Postgres: PGLite's WASM queries block the event loop, so a timer
 * cannot interrupt them (the plan's ceiling covers that case), and the probe
 * would see the preparation win every race there.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { raceSyncBudget, resetSyncPreparationBudget, SYNC_PREPARATION_DEFAULT_MS, SYNC_PREPARATION_MS_KEY, SyncPreparationBudgetExceeded, syncPreparationBudgetMs } from '../src/core/persistence/sync-waivers.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-waiver-budget-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(async () => {
  if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
  if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

test('raceSyncBudget: a fast preparation wins, a hung one rejects at the budget, an aborted run rejects with its reason', async () => {
  expect(await raceSyncBudget(Promise.resolve('prepared'), 1000)).toBe('prepared');
  const hung = new Promise<never>(() => {});
  await expect(raceSyncBudget(hung, 20)).rejects.toBeInstanceOf(SyncPreparationBudgetExceeded);
  const controller = new AbortController();
  const raced = raceSyncBudget(hung, 60_000, controller.signal);
  controller.abort(new Error('run cancelled'));
  await expect(raced).rejects.toThrow('run cancelled');
  const aborted = new AbortController(); aborted.abort(new Error('already cancelled'));
  await expect(raceSyncBudget(Promise.resolve('late'), 60_000, aborted.signal)).rejects.toThrow('already cancelled');
  await expect(raceSyncBudget(Promise.reject(new Error('refused')), 60_000)).rejects.toThrow('refused');
});

test('syncPreparationBudgetMs: the documented default, a configured value, a malformed value, and a memo within its TTL', async () => {
  const fake = (value: string | null) => ({ getConfig: async () => value }) as unknown as Pick<BrainEngine, 'getConfig'>;
  expect(await syncPreparationBudgetMs(fake(null))).toBe(SYNC_PREPARATION_DEFAULT_MS);
  expect(SYNC_PREPARATION_DEFAULT_MS).toBe(120_000);
  expect(await syncPreparationBudgetMs(fake('45000'))).toBe(45_000);
  expect(await syncPreparationBudgetMs(fake('soon'))).toBe(SYNC_PREPARATION_DEFAULT_MS);
  expect(await syncPreparationBudgetMs(fake('-5'))).toBe(SYNC_PREPARATION_DEFAULT_MS);
  let reads = 0;
  const counted = { getConfig: async () => { reads++; return '30000'; } } as unknown as Pick<BrainEngine, 'getConfig'>;
  expect(await syncPreparationBudgetMs(counted, 1000)).toBe(30_000);
  expect(await syncPreparationBudgetMs(counted, 2000)).toBe(30_000);
  expect(reads).toBe(1);
  expect(await syncPreparationBudgetMs(counted, 10_000)).toBe(30_000);
  expect(reads).toBe(2);
  const failing = { getConfig: async () => { throw new Error('database away'); } } as unknown as Pick<BrainEngine, 'getConfig'>;
  expect(await syncPreparationBudgetMs(failing)).toBe(SYNC_PREPARATION_DEFAULT_MS);
});

test('forced probe: under a 1 ms budget the waiver screen cannot decide, so a full re-sync admits every unchanged file instead of waiving it', () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) await probe(engine);
}), 240_000);

async function probe(engine: BrainEngine) {
  const id = `budget-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(home, id);
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < 3; i++) { mkdirSync(join(root, 'notes'), { recursive: true }); writeFileSync(join(root, `notes/n${i}.md`), `---\ntitle: N${i}\n---\nA synthetic observation ${i}.\n`); }
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = (full = false) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, full });
  const requests = () => engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'", [id]).then(rows => rows[0]!.n);
  expect((await sync()).status).toBe('first_sync');
  expect(await requests()).toBe(3);
  try {
    // Default budget: the full re-sync waives every unchanged import without a request.
    expect(await sync(true)).toMatchObject({ status: 'synced', waived: { imports: 3, deletes: 0 } });
    expect(await requests()).toBe(3);
    // 1 ms budget: the screen fails open and each entry is admitted (a no-op publication), nothing is held or failed.
    await engine.setConfig(SYNC_PREPARATION_MS_KEY, '1');
    resetSyncPreparationBudget();
    const admitted = await sync(true);
    expect(admitted).toMatchObject({ status: 'synced', added: 0, modified: 0 });
    expect(admitted.held_count ?? 0).toBe(0);
    if (engine.kind === 'postgres') {
      expect(admitted.waived).toEqual({ imports: 0, deletes: 0 });
      expect(await requests()).toBe(6);
    }
    expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND state<>'committed' AND intent->>'kind'='managed_sync_import'", [id])).toEqual([]);
  } finally {
    await engine.unsetConfig(SYNC_PREPARATION_MS_KEY);
    resetSyncPreparationBudget();
    await disposePersistenceConsumer(engine);
  }
}
