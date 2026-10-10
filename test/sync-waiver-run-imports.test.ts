/**
 * GBRA-75 wave 8: a run of unchanged imports (a full re-sync, or the first sync of an
 * already-imported source) is waived in waiver-run transactions of up to 64 entries,
 * with one cursor write each, instead of a pending save and a waiver per file. The
 * screen of an entry the cursor does not yet name validates against this run's cursor
 * with nothing pending; the run's transaction re-checks each file's bytes and the
 * owner epoch, so an edit or an owner change after the screens still ends the run.
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
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-waiver-run-imports-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { noPull: true, noEmbed: true, noExtract: true };
const note = (i: number) => `---\ntitle: N${i}\n---\nA synthetic observation ${i}.\n`;

beforeAll(async () => {
  if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
  if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

/** A synced source of `n` notes; the next `full` sync screens every file as an unchanged import. */
async function syncedSource(engine: BrainEngine, n: number) {
  const id = `wri-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(home, id);
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < n; i++) writeFileSync(join(root, `n${String(i).padStart(2, '0')}.md`), note(i));
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect((await performManagedSync(engine, { sourceId: id, ...OPTS })).status).toBe('first_sync');
  await disposePersistenceConsumer(engine);
  return { id, root };
}
const importRequests = (engine: BrainEngine, id: string) => engine.executeRaw<{ slug: string; state: string }>(
  "SELECT slug,state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence", [id]);
function countTransactions(engine: BrainEngine): { engine: BrainEngine; count: () => number } {
  let count = 0;
  return { count: () => count, engine: new Proxy(engine, { get(target, key) {
    if (key === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => { count++; return target.transaction(fn); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}

test('a full re-sync of unchanged files waives them in one waiver-run transaction, not a pending save and a waiver per file', () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await syncedSource(engine, 12);
    const before = (await importRequests(engine, f.id)).length;
    const counted = countTransactions(engine);
    const waived: number[] = [];
    try {
      const result = await performManagedSync(counted.engine, { sourceId: f.id, ...OPTS, full: true,
        onProgress: event => { if (event.phase === 'managed_sync.page_committed' && event.waived) waived.push(event.bankedFiles!); } });
      expect(result).toMatchObject({ status: 'synced', modified: 0, waived: { imports: 12, deletes: 0 } });
      expect(waived).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect((await importRequests(engine, f.id)).length).toBe(before);
      // The per-entry path takes two transactions per file (24 here); the run takes one for all twelve.
      expect(counted.count()).toBeLessThan(8);
    } finally { await disposePersistenceConsumer(counted.engine); }
  }
}), 120_000);

test('a file edited after its screen ends the waiver run before it: earlier files are waived, the edited one is not', () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await syncedSource(engine, 8);
    const before = (await importRequests(engine, f.id)).length;
    let fired = 0;
    installFaultHook(point => {
      if (point !== 'sync:mid_waiver_run' || fired++) return;
      writeFileSync(join(f.root, 'n03.md'), note(3) + 'An uncommitted edit made during the run.\n');
    });
    try {
      const result = await performManagedSync(engine, { sourceId: f.id, ...OPTS, full: true });
      expect(fired).toBeGreaterThan(0);
      expect(result).toMatchObject({ status: 'synced', modified: 0, waived: { imports: 7, deletes: 0 } });
      // The edited file is not waived: only it is admitted, and its publication refuses the changed bytes (a conflict).
      const admitted = (await importRequests(engine, f.id)).slice(before);
      expect(new Set(admitted.map(row => row.slug))).toEqual(new Set(['n03']));
      expect(admitted[0]!.state).toBe('conflict');
      const [cursor] = await engine.executeRaw<{ index: number; done: boolean }>("SELECT (completed_keys->0->>'index')::int AS index,(completed_keys->0->>'done')::boolean AS done FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]);
      expect(cursor).toMatchObject({ index: 8, done: true });
    } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
  }
}), 120_000);

test('an owner change during a waiver run\'s screens waives nothing: the run falls back and the sync refuses the old owner', () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await syncedSource(engine, 8);
    let bumped = false;
    // n04 is first read by its freeze, after n00..n03 were screened and before the run's transaction.
    const proxy = new Proxy(engine, { get(target, key) {
      if (key === 'readPageSnapshot') return async (slug: string, opts: Parameters<BrainEngine['readPageSnapshot']>[1]) => {
        if (slug === 'n04' && !bumped) {
          bumped = true;
          await target.executeRaw('UPDATE persistence_worktrees SET owner_epoch=owner_epoch+1 WHERE id=(SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$1)', [f.id]);
        }
        return target.readPageSnapshot(slug, opts);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      const outcome = await performManagedSync(proxy, { sourceId: f.id, ...OPTS, full: true }).then(result => ({ result }), (error: unknown) => ({ error }));
      expect(bumped).toBe(true);
      // The run re-reads the owner epoch under its lock and passes nothing; the head's per-entry screen then admits it,
      // and its publication refuses the stale owner, so the cursor stays at the head.
      expect('result' in outcome).toBe(true);
      const result = (outcome as { result: Awaited<ReturnType<typeof performManagedSync>> }).result;
      expect(result).toMatchObject({ status: 'blocked_by_failures', waived: { imports: 0, deletes: 0 }, managedCursor: { index: 0 }, failureCodes: [{ code: 'owner_unavailable' }] });
    } finally { await disposePersistenceConsumer(proxy); }
  }
}), 120_000);

test('a crash inside a waiver run of imports skips nothing and waives nothing twice', () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await syncedSource(engine, 10);
    const before = (await importRequests(engine, f.id)).length;
    let fired = 0;
    installFaultHook(point => { if (point === 'sync:mid_waiver_run' && fired++ === 0) throw new Error('injected crash inside the waiver run'); });
    try {
      await expect(performManagedSync(engine, { sourceId: f.id, ...OPTS, full: true })).rejects.toThrow('injected crash');
      await disposePersistenceConsumer(engine);
      const result = await performManagedSync(engine, { sourceId: f.id, ...OPTS, full: true });
      expect(result).toMatchObject({ status: 'synced', modified: 0, waived: { imports: 10, deletes: 0 } });
      expect((await importRequests(engine, f.id)).length).toBe(before);
    } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
  }
}), 120_000);
