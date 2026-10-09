import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { nextGroupSize, resolveBulkSettings } from '../src/core/persistence/sync-group.ts';
import { withEnv } from './helpers/with-env.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { WINDOW_CANCEL_MESSAGE, cancelOrphanedWindowGroup, windowPredecessor, windowPredecessorCommitted } from '../src/core/persistence/sync-window.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-bulk-'));
let engine: BrainEngine | undefined;
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function fixture(e: BrainEngine, files: Record<string, string>) {
  const id = `bulk-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, body); }
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
const notes = (count: number, edit: (i: number) => string | null = () => null) => Object.fromEntries(Array.from({ length: count }, (_, i) =>
  [`notes/n${i}.md`, edit(i) ?? `---\ntitle: Note ${i}\n---\nA durable observation number ${i}.\n`]));

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engine = pg.engine; closePostgres = pg.close;
}, 120_000);
afterAll(async () => {
  if (engine) await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine!); await engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const id of sources) await engine!.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('group sizing follows the transaction budget and bulk settings follow flag > env > config', async () => {
  const settings = { enabled: true, reason: null, size: 16, maxTxnMs: 10_000 };
  expect(nextGroupSize(settings, null)).toBe(4);
  expect(nextGroupSize(settings, 2000)).toBe(5);
  expect(nextGroupSize(settings, 100)).toBe(16);
  expect(nextGroupSize(settings, 60_000)).toBe(1);
  const laned = { ...settings, maxTxnMs: 15_000, lanes: 6 };
  expect(nextGroupSize(laned, 1400, { first: true })).toBe(2);
  expect(nextGroupSize(laned, null)).toBe(16);
  expect(nextGroupSize(laned, 400)).toBe(12);
  expect(nextGroupSize(laned, 400, { foreground: true })).toBe(5);
  expect(nextGroupSize({ ...laned, maxTxnMs: 1_000, maxTxnExplicit: true }, 400)).toBe(2);
  expect(nextGroupSize({ ...laned, maxTxnMs: 60_000, maxTxnExplicit: true }, 400)).toBe(12);
  if (!engine) return;
  expect(await resolveBulkSettings(engine, true)).toMatchObject({ enabled: false, reason: 'disabled by --no-bulk' });
  await withEnv({ GBRAIN_SYNC_BULK: '0' }, async () => expect(await resolveBulkSettings(engine!, false)).toMatchObject({ enabled: false, reason: 'disabled by GBRAIN_SYNC_BULK=0' }));
  await engine.setConfig('sync.bulk', 'false');
  try { expect(await resolveBulkSettings(engine, false)).toMatchObject({ enabled: false, reason: 'disabled by config sync.bulk=false' }); }
  finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.bulk'"); }
  expect(await resolveBulkSettings(engine, false)).toMatchObject({ enabled: true, reason: null, size: 16 });
});

test('a bulk drain publishes groups in one transaction while every page keeps its own request and receipt', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(14));
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  expect(result).toMatchObject({ status: 'first_sync', added: 14 });
  expect(result.drain).toMatchObject({ outcome: 'synced', written: 14, bulk: { enabled: true } });
  expect(result.drain!.bulk!.groups).toBeGreaterThan(0);
  const rows = await engine.executeRaw<{ slug: string; state: string; grp: string | null; published: string }>(
    `SELECT slug,state,intent->>'group' AS grp,published_at::text AS published FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [f.id]);
  expect(rows).toHaveLength(14);
  expect(rows.every(row => row.state === 'committed')).toBe(true);
  expect(new Set(rows.map(row => row.slug)).size).toBe(14);
  const sharedTransaction = new Map<string, number>();
  for (const row of rows) sharedTransaction.set(row.published, (sharedTransaction.get(row.published) ?? 0) + 1);
  expect(Math.max(...sharedTransaction.values())).toBeGreaterThan(1);
  for (let i = 0; i < 14; i++) expect((await engine.getPage(`notes/n${i}`, { sourceId: f.id }))?.title).toBe(`Note ${i}`);
  // Every page revision is attributed to its own request, also inside a shared group transaction.
  const attributed = await engine.executeRaw<{ slug: string; mismatched: boolean }>(`SELECT p.slug, p.revision_write_request_id IS DISTINCT FROM r.id AS mismatched
    FROM pages p JOIN persistence_requests r ON r.source_id=p.source_id AND r.slug=p.slug AND r.intent->>'kind'='managed_sync_import' WHERE p.source_id=$1`, [f.id]);
  expect(attributed).toHaveLength(14);
  expect(attributed.filter(row => row.mismatched)).toEqual([]);
  const [cursor] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0 ? 'group'");
  expect(cursor!.n).toBe(0);
}), 300_000);

test('a failing member is attributed to its own page, earlier members commit and later members are cancelled, not published', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(10, i => i === 3 ? '---\ntitle: Conflict\nslug: notes/other\n---\nA conflicting identity must not be imported.\n' : null));
  // #5988 holds such a file by default; the fail-closed policy keeps it a publication failure inside the group.
  await engine.setConfig('sync.holds', 'fail');
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true })
    .finally(() => engine!.unsetConfig('sync.holds'));
  expect(result).toMatchObject({ status: 'blocked_by_failures', failedFiles: 1 });
  expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'blocked_by_failures' });
  expect(result.managedWrite?.slug).toBe('notes/n3');
  for (let i = 0; i < 3; i++) expect(await engine.getPage(`notes/n${i}`, { sourceId: f.id })).not.toBeNull();
  for (let i = 3; i < 10; i++) expect(await engine.getPage(`notes/n${i}`, { sourceId: f.id })).toBeNull();
  const states = await engine.executeRaw<{ slug: string; state: string }>(
    `SELECT slug,state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [f.id]);
  expect(states.find(row => row.slug === 'notes/n3')?.state).toBe('failed');
  expect(states.filter(row => row.state === 'committed').map(row => row.slug)).toEqual(['notes/n0', 'notes/n1', 'notes/n2']);
  expect(states.filter(row => !['committed', 'failed'].includes(row.state)).every(row => row.state === 'cancelled')).toBe(true);
}), 300_000);

test('a held file ends the group before it: it is held without a request and every other page commits (#5988)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(10, i => i === 3 ? '---\ntitle: Conflict\nslug: notes/other\n---\nA conflicting identity must not be imported.\n' : null));
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  expect(result.drain).toMatchObject({ outcome: 'synced' });
  expect(result).toMatchObject({ holds_outstanding: 1 });
  const states = await engine.executeRaw<{ slug: string; state: string }>(
    `SELECT slug,state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [f.id]);
  expect(states.map(row => row.slug)).not.toContain('notes/n3');
  expect(states.every(row => row.state === 'committed')).toBe(true);
  expect(states).toHaveLength(9);
  expect(await engine.getPage('notes/n3', { sourceId: f.id })).toBeNull();
}), 300_000);

test('a draining sync admits the next group while the current one publishes; every page commits in manifest order', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(20));
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  expect(result.drain).toMatchObject({ outcome: 'synced' });
  const rows = await engine.executeRaw<{ slug: string; state: string; after: string | null; published: string; sequence: string }>(
    `SELECT slug,state,intent->>'after' AS after,published_at::text AS published,sequence::text FROM persistence_requests
     WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [f.id]);
  expect(rows).toHaveLength(20);
  expect(rows.every(row => row.state === 'committed')).toBe(true);
  // At least one group was admitted ahead, naming the request it waits for.
  const ahead = rows.filter(row => row.after);
  expect(ahead.length).toBeGreaterThan(0);
  const ids = await engine.executeRaw<{ request_id: string; slug: string }>(`SELECT request_id::text,slug FROM persistence_requests WHERE source_id=$1`, [f.id]);
  const slugOf = new Map(ids.map(row => [row.request_id, row.slug]));
  for (const row of ahead) expect(rows.findIndex(r => r.slug === slugOf.get(row.after!))).toBeLessThan(rows.findIndex(r => r.slug === row.slug));
  // Publication order follows manifest (admission) order.
  const published = rows.map(row => row.published);
  expect([...published].sort()).toEqual(published);
  const [cursor] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM op_checkpoints WHERE op='managed-sync' AND (completed_keys->0 ? 'window' OR completed_keys->0 ? 'group')");
  expect(cursor!.n).toBe(0);
}), 300_000);

test('a failed page cancels the group admitted ahead of it; nothing after the failure publishes', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(40, i => i === 2 ? '---\ntitle: Conflict\nslug: notes/other\n---\nA conflicting identity must not be imported.\n' : null));
  await engine.setConfig('sync.holds', 'fail');
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true })
    .finally(() => engine!.unsetConfig('sync.holds'));
  expect(result.drain).toMatchObject({ outcome: 'blocked' });
  expect(result.managedWrite?.slug).toBe('notes/n2');
  const rows = await engine.executeRaw<{ slug: string; state: string; after: string | null; grp: string | null; error_message: string | null }>(
    `SELECT slug,state,intent->>'after' AS after,intent->>'group' AS grp,error_message FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [f.id]);
  // Rows are in manifest (admission) order: every page before the failure committed, every page after it was cancelled.
  const failedAt = rows.findIndex(row => row.slug === 'notes/n2');
  expect(rows[failedAt]!.state).toBe('failed');
  expect(rows.slice(0, failedAt).every(row => row.state === 'committed')).toBe(true);
  expect(rows.slice(failedAt + 1).every(row => row.state === 'cancelled')).toBe(true);
  for (const row of rows.slice(failedAt)) expect(await engine.getPage(row.slug, { sourceId: f.id })).toBeNull();
  // The group admitted ahead of the failed one is cancelled with the window reason.
  const ahead = rows.slice(failedAt + 1).filter(row => row.after && row.grp !== rows[failedAt]!.grp);
  expect(ahead.length).toBeGreaterThan(0);
  for (const row of ahead) expect(row).toMatchObject({ state: 'cancelled', error_message: WINDOW_CANCEL_MESSAGE });
  const [cursor] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0 ? 'window' AND completed_keys->0->>'sourceId'=$1", [f.id]);
  expect(cursor!.n).toBe(0);
}), 300_000);

test('a claimed window group whose predecessor did not commit is cancelled by the consumer, not published', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(1));
  const [worktree] = await engine.executeRaw<{ worktree_id: string }>('SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$1', [f.id]);
  const missing = randomUUID();
  const head = { id: randomUUID(), request_id: randomUUID(), worktree_id: worktree!.worktree_id, principal_kind: 'local_cli', principal_id: randomUUID(),
    execution_token: null, state: 'queued', intent: { kind: 'managed_sync_import', after: missing } } as unknown as WriteRequest;
  expect(windowPredecessor(head)).toBe(missing);
  expect(await windowPredecessorCommitted(engine, head)).toBe(false);
  expect(await windowPredecessorCommitted(engine, { ...head, intent: { kind: 'managed_sync_import' } } as unknown as WriteRequest)).toBe(true);
  // A row that does not exist settles nothing and publishes nothing.
  expect(await cancelOrphanedWindowGroup(engine, head)).toEqual([]);
}), 300_000);

test('--no-bulk publishes one page per transaction', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(5));
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, noBulk: true });
  expect(result.drain).toMatchObject({ outcome: 'synced', bulk: { enabled: false, reason: 'disabled by --no-bulk', groups: 0 } });
  const grouped = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent ? 'group'", [f.id]);
  expect(grouped[0]!.n).toBe(0);
}), 300_000);
