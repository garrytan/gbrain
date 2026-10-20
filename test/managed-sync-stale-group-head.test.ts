/**
 * #6075: a bulk drain groups a frozen head under its request ID (adding `group`, and `lane` under lanes)
 * while another owner loop that read the head before it was grouped admits it on the single path. The
 * drain admits a group with the cursor save that records it (#5984 Phase 1), so the race was between
 * that admission and the single path's.
 *
 * #6712 PR 4b: that race cannot arise any more, so this file now pins the exclusion that replaced it. A
 * non-company sync is a pass: it runs under the source's drain lease (one drainer per source, sync-lease.ts)
 * and keeps its batch cursor in memory, with no `managed-sync` row for a second owner loop to read the head
 * from. A company-brain source keeps that row but never forms bulk groups (`opts.bulk && !company` in
 * sync-run.ts, as on master), so no source reaches a grouped head from two loops. Each test keeps its #6075
 * name and says, after the arrow, what it asserts now: a second sync that arrives while the drain is about to
 * admit a group follows or refuses on the lease, admits nothing of its own, and every page is admitted once.
 * Bulk groups are Postgres-only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { SyncLockBusyError } from '../src/core/sync-lock.ts';
import type { SyncResult } from '../src/commands/sync.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-stale-head-'));
let engine: BrainEngine | undefined;
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];

function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function fixture(e: BrainEngine, count: number) {
  const id = `head-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nObservation ${i} from acme-example.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return id;
}
/** Holds the drain at its first group admission until `release()`; `reached` resolves once it is there. */
function holdFirstGroupAdmission(sourceId: string) {
  let reach!: () => void, release!: () => void, seen = false;
  const reached = new Promise<void>(resolve => { reach = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  installFaultHook(async (point, detail) => {
    if (point !== 'sync:before_group_admission' || detail.sourceId !== sourceId || seen) return;
    seen = true; reach(); await gate;
  });
  return { reached, release, get seen() { return seen; } };
}
async function importRequests(e: BrainEngine, sourceId: string) {
  return e.executeRaw<{ request_id: string; path: string; grp: string | null; state: string }>(`SELECT request_id,intent->>'path' AS path,intent->>'group' AS grp,state
    FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [sourceId]);
}
const drainOpts = (sourceId: string, extra: Record<string, unknown> = {}) => ({ sourceId, noPull: true, noEmbed: true, noExtract: true, drain: true, ...extra });
async function importedTitles(e: BrainEngine, sourceId: string, count: number) {
  const titles: Array<string | undefined> = [];
  for (let i = 0; i < count; i++) titles.push((await e.getPage(`notes/n${i}`, { sourceId }))?.title);
  return titles;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL, 'instance', 10);
  engine = pg.engine; closePostgres = pg.close;
}, 120_000);
afterAll(async () => {
  installFaultHook(undefined);
  if (engine) await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine!); await engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const id of sources) await engine!.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

for (const lanes of [1, 2]) {
  test(`a group whose head was already admitted on the single path is dropped and the drain finishes (lanes=${lanes}) → a second sync at the group admission follows the drain lease and admits nothing twice`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
    if (!engine) return;
    const e = engine, sourceId = await fixture(e, 10);
    const held = holdFirstGroupAdmission(sourceId);
    const lines: string[] = [];
    const origError = console.error;
    let drained: Promise<SyncResult> | undefined, followed: Promise<SyncResult> | undefined;
    try {
      drained = performSync(e, drainOpts(sourceId, { lanes }));
      await held.reached;
      const before = (await importRequests(e, sourceId)).length;
      console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
      // Started outside the drain's async context, so it cannot re-enter the drain's lease.
      followed = performSync(e, drainOpts(sourceId, { lanes, followDrainLease: true, drainHolder: { kind: 'cli', id: null } }));
      for (let i = 0; i < 400 && !lines.join('').includes('is being drained by'); i++) await new Promise(resolve => setTimeout(resolve, 25));
      expect(lines.join('')).toContain('is being drained by');
      expect((await importRequests(e, sourceId)).length).toBe(before);
      held.release();
      expect(await drained).toMatchObject({ status: 'first_sync', added: 10 });
      expect(['up_to_date', 'synced']).toContain((await followed).status);
    } finally { console.error = origError; held.release(); installFaultHook(undefined); await drained?.catch(() => undefined); await followed?.catch(() => undefined); }
    expect(held.seen).toBe(true);
    expect(await importedTitles(e, sourceId, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `Note ${i}`));
    const rows = await importRequests(e, sourceId);
    expect(rows).toHaveLength(10);
    expect(rows.every(row => row.state === 'committed')).toBe(true);
    expect(new Set(rows.map(row => row.path)).size).toBe(10);
  }), 120_000);
}

test('a head admitted under its request ID with a different intent still refuses with idempotency_conflict → a sync job at the group admission refuses on the drain lease with SyncLockBusyError and admits nothing', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const e = engine, sourceId = await fixture(e, 6);
  const held = holdFirstGroupAdmission(sourceId);
  let drained: Promise<SyncResult> | undefined;
  try {
    drained = performSync(e, drainOpts(sourceId));
    await held.reached;
    const before = await importRequests(e, sourceId);
    await expect(performSync(e, { sourceId, noPull: true, noEmbed: true, noExtract: true, drainHolder: { kind: 'job', id: '6075' } })).rejects.toBeInstanceOf(SyncLockBusyError);
    expect(await importRequests(e, sourceId)).toEqual(before);
    held.release();
    expect(await drained).toMatchObject({ status: 'first_sync', added: 6 });
  } finally { held.release(); installFaultHook(undefined); await drained?.catch(() => undefined); }
  const rows = await importRequests(e, sourceId);
  expect(rows).toHaveLength(6);
  expect(rows.every(row => row.state === 'committed')).toBe(true);
}), 120_000);

test('a non-bulk pass that read the head before a drain grouped it does not admit the stale intent → a non-bulk sync at the group admission refuses on the drain lease; the head is admitted once, grouped', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const e = engine, sourceId = await fixture(e, 10);
  const held = holdFirstGroupAdmission(sourceId);
  let drained: Promise<SyncResult> | undefined;
  try {
    drained = performSync(e, drainOpts(sourceId));
    await held.reached;
    const before = await importRequests(e, sourceId);
    await expect(performSync(e, { sourceId, noPull: true, noEmbed: true, noExtract: true, drainHolder: { kind: 'serve', id: null } })).rejects.toBeInstanceOf(SyncLockBusyError);
    expect(await importRequests(e, sourceId)).toEqual(before);
    held.release();
    expect(await drained).not.toHaveProperty('error');
  } finally { held.release(); installFaultHook(undefined); await drained?.catch(() => undefined); }
  const resumed = await performSync(e, drainOpts(sourceId));
  expect(['synced', 'first_sync', 'up_to_date']).toContain(resumed.status);
  expect(await importedTitles(e, sourceId, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `Note ${i}`));
  // Only the drain admitted: the head once, grouped under its own request ID with its followers in the same group.
  const requests = await importRequests(e, sourceId);
  expect(requests).toHaveLength(10);
  expect(requests.every(row => row.state === 'committed')).toBe(true);
  expect(new Set(requests.map(row => row.path)).size).toBe(10);
  const head = requests[0]!;
  expect(head.grp).toBe(head.request_id);
  expect(requests.filter(row => row.grp === head.request_id).length).toBeGreaterThan(1);
}), 120_000);
