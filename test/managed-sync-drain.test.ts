import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import postgres from '#postgres';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readManagedSyncBacklog, runDrain } from '../src/core/persistence/sync-drain.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-drain-'));
const engines: BrainEngine[] = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function fixture(engine: BrainEngine, count: number) {
  const id = `drain-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nA durable observation number ${i}.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
/**
 * The fold's proof (sync-pass-confirm.ts) counts a row unchanged since its round's snapshot only when the row's xid is older
 * than that snapshot's xmin, and any open transaction in the cluster holds the xmin back. A page an earlier pass of the drain
 * wrote then reads as written since the snapshot by another pass (`foreign_page_write`), and the stamp takes its own
 * checkpoint request: correct, and what the parallel Postgres lane does when another file's brain in the same cluster has a
 * transaction open. A pass whose fold is asserted starts once every transaction older than the writes before it has ended.
 */
async function clusterSettled(engine: BrainEngine): Promise<void> {
  if (engine.kind !== 'postgres') return;
  const [{ next }] = await engine.executeRaw<{ next: string }>('SELECT txid_snapshot_xmax(txid_current_snapshot())::text AS next');
  for (const deadline = Date.now() + 60_000; ;) {
    const [{ low }] = await engine.executeRaw<{ low: string }>('SELECT txid_snapshot_xmin(txid_current_snapshot())::text AS low');
    if (BigInt(low) >= BigInt(next)) return;
    if (Date.now() > deadline) throw new Error(`a transaction in the cluster held the snapshot xmin below ${next} for 60 s`);
    await Bun.sleep(20);
  }
}
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]); await engine.disconnect(); }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('a drain re-enters sliced passes over one cursor until it is synced and records its drain window', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, 5);
    const drainStartedAt = Date.now();
    const result = await runDrain({ pass: async (signal, onProgress) => { await clusterSettled(engine); return performManagedSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, signal, onProgress, drainStartedAt }, { maxPages: 1, maxMs: 60_000 }); } });
    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(5);
    expect(result.drain).toMatchObject({ outcome: 'synced', written: 5, waived: 0, remaining: 0 });
    expect(result.drain!.passes).toBeGreaterThanOrEqual(5);
    // Five imports; the last carries the checkpoint (#6926, folded into 4b).
    const requests = await engine.executeRaw<{ kind: string; stamp: string | null }>("SELECT intent->>'kind' AS kind, outcome->>'pass_stamp' AS stamp FROM persistence_requests WHERE source_id=$1 ORDER BY sequence", [f.id]);
    expect(requests).toEqual([...Array.from({ length: 4 }, () => ({ kind: 'managed_sync_import', stamp: null })), { kind: 'managed_sync_import', stamp: 'folded' }]);
  }
}), 180_000);

test('a transaction open elsewhere in the cluster, holding back the cluster xmin, does not keep the drain from folding its stamp into the last import', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const engine = engines.find(candidate => candidate.kind === 'postgres');
  if (!engine) return;
  const f = await fixture(engine, 3);
  const other = postgres(process.env.DATABASE_URL!, { max: 1 });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let opened!: () => void;
  const open = new Promise<void>(resolve => { opened = resolve; });
  const held = other.begin(async sql => { await sql`SELECT txid_current()`; opened(); await released; });
  try {
    await open;
    const drainStartedAt = Date.now();
    const result = await runDrain({ pass: (signal, onProgress) =>
      performManagedSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, signal, onProgress, drainStartedAt }, { maxPages: 1, maxMs: 60_000 }) });
    expect(result.drain).toMatchObject({ outcome: 'synced', written: 3, remaining: 0 });
  } finally { release(); await held; await other.end(); }
  const requests = await engine.executeRaw<{ kind: string; state: string; stamp: string | null; skipped: string | null }>(`SELECT intent->>'kind' AS kind, state, outcome->>'pass_stamp' AS stamp,
    outcome->>'pass_stamp_skipped' AS skipped FROM persistence_requests WHERE source_id=$1 ORDER BY sequence`, [f.id]);
  expect(requests).toEqual([
    ...Array.from({ length: 2 }, () => ({ kind: 'managed_sync_import', state: 'committed', stamp: null, skipped: null })),
    { kind: 'managed_sync_import', state: 'committed', stamp: 'folded', skipped: null }]);
  const [source] = await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]);
  expect(source!.last_commit).toBe(git(f.root, 'rev-parse', 'HEAD'));
}), 180_000);

test('a stopped drain is resumable, its backlog is readable from any process, and a rerun finishes it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, 6);
    const stop = new AbortController();
    let committed = 0;
    const drainStartedAt = Date.now();
    const first = await runDrain({ signal: stop.signal, pass: (signal, onProgress) => performManagedSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, signal, drainStartedAt,
      onProgress: e => { onProgress(e); if (e.phase === 'managed_sync.page_committed' && ++committed === 2) stop.abort(); } }, { maxPages: 1, maxMs: 60_000 }) });
    expect(first.drain).toMatchObject({ outcome: 'resumable', stop_reason: 'deadline' });
    // #6712 PR 4b (design v3.2 §3.7): a pass's backlog is its newest round (total = |C_k|, remaining = |C_k| - |S|); the rate and
    // ETA are null for a non-company source (§9: round-local progress lives in convergence).
    const imported = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.id]))[0]!.n;
    const before = await imported();
    expect(before).toBeGreaterThan(0);
    const [backlog] = await readManagedSyncBacklog(engine, [f.id]);
    expect(backlog).toMatchObject({ source_id: f.id, remaining: 6 - before, resume_command: `gbrain sync --source ${f.id} --no-pull --no-embed`,
      rate_pages_per_min: null, pass: { outcome: 'resumable', stop_reason: 'timeout' } });
    expect(backlog!.index + backlog!.remaining).toBe(backlog!.total);
    const second = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, drain: true });
    expect(second.drain?.outcome).toBe('synced');
    expect(second.added).toBe(6 - before);
    expect(await imported()).toBe(6);
    expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'", [f.id]))[0]!.n).toBe(6);
    expect(await readManagedSyncBacklog(engine, [f.id])).toEqual([]);
  }
}), 180_000);

test('the CLI reports outcome, drain and next in one JSON envelope with the outcome exit code', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_NO_DELEGATE: '1' }, async () => {
  const { runSyncInner } = await import('../src/commands/sync/run.ts');
  const { currentExitCode, _resetCliExitVerdictForTests } = await import('../src/core/cli-force-exit.ts');
  const { registerRunDeadline } = await import('../src/core/forward-progress.ts');
  const engine = engines[0]!;
  const capture = async (args: string[]) => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
    _resetCliExitVerdictForTests();
    try { await runSyncInner(engine, args); } finally { console.log = original; }
    const json = lines.filter(line => line.startsWith('{'));
    expect(json).toHaveLength(1);
    return { envelope: JSON.parse(json[0]!), exit: currentExitCode() ?? 0 };
  };
  const stopped = await fixture(engine, 3);
  registerRunDeadline({ atMs: Date.now() - 1, strict: true });
  try {
    const { envelope, exit } = await capture(['--source', stopped.id, '--no-pull', '--no-embed', '--json']);
    expect(exit).toBe(0);
    expect(envelope).toMatchObject({ outcome: 'resumable', drain: { outcome: 'resumable', stop_reason: 'deadline' },
      next: { safe_to_loop: true, command: expect.stringContaining(`sync --source ${stopped.id} --no-pull --no-embed --json`) } });
  } finally { registerRunDeadline(null); }
  const { envelope, exit } = await capture(['--source', stopped.id, '--no-pull', '--no-embed', '--json']);
  expect(exit).toBe(0);
  expect(envelope).toMatchObject({ sync_status: 'first_sync', outcome: 'synced', drain: { outcome: 'synced', remaining: 0 } });
  expect(envelope.next).toBeUndefined();
}), 180_000);
