/**
 * #6712 PR 4b lane C: a recorded failure is retried by the next plain sync, on the live pass.
 *
 * Replaces what sync-knock-on-recovery-6643, sync-legacy-retry-actions-6696 and sync-checkpoint-moved-6834 pinned through a
 * non-company cursor (re-freezing a stopped entry, folding older cursors in on --retry-failed, finishing a checkpoint whose
 * source moved). Protects:
 * - a page whose import fails in one pass is imported by the next plain sync, and by its --retry-failed alias: the source
 *   checkpoints HEAD, no failure row of the source remains and sync status shows no error;
 * - a brain an older binary left with a blocked unfinished cursor and its recorded checkpoint failure converges on the
 *   next plain sync (and on its --retry-failed alias): the cursor and its failure row are gone and sync status is clean.
 * Synthetic content only.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { readManagedSyncFailures, recordManagedSyncFailure } from '../src/core/persistence/sync-failures.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { managedSyncAuthority } from '../src/core/persistence/sync-authority.ts';
import { syncCursorOptions } from '../src/core/persistence/sync-slices.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-pass-failure-retry-'));
let engine: PGLiteEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const NAMES = ['a', 'b', 'c'];
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterEach(() => installFaultHook(undefined));
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});
const isolated = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, fn);
async function fixture() {
  const id = `retry-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const name of NAMES) writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\nA durable observation named ${name} at fund-a.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } as SyncOpts };
}
const livePages = async (id: string) => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [id])).map(row => row.slug);
const lastCommit = async (id: string) => (await engine.executeRaw<{ c: string | null }>('SELECT last_commit AS c FROM sources WHERE id=$1', [id]))[0]!.c;
const cursorRows = async (id: string) => (await engine.executeRaw<{ key: string }>(
  "SELECT fingerprint AS key FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [id])).map(row => row.key);

for (const retryFailed of [false, true]) {
  test(`a page whose import failed in one pass is imported by the next ${retryFailed ? '--retry-failed (plain sync alias)' : 'plain'} sync, which checkpoints HEAD`, async () => isolated(async () => {
    const f = await fixture();
    let failed = 0;
    installFaultHook(async (point, detail) => {
      if (point !== 'consumer:preparing' || !detail.requestId || failed) return;
      const [row] = await engine.executeRaw<{ slug: string; kind: string }>("SELECT slug, intent->>'kind' AS kind FROM persistence_requests WHERE request_id=$1::uuid", [detail.requestId]);
      if (row?.kind === 'managed_sync_import' && row.slug === 'b') { failed++; throw new Error('an injected preparation failure of page b'); }
    });
    const first = await performManagedSync(engine, f.opts).then(result => result.status, (error: { code?: string }) => `threw:${error.code ?? 'unknown'}`);
    installFaultHook(undefined);
    expect(failed).toBe(1);
    expect(first).not.toBe('first_sync');
    expect(await livePages(f.id)).not.toContain('b');
    expect(await lastCommit(f.id)).toBeNull();
    const retried = await performManagedSync(engine, { ...f.opts, retryFailed });
    expect(['first_sync', 'synced']).toContain(retried.status);
    expect(await livePages(f.id)).toEqual(NAMES);
    expect(await lastCommit(f.id)).toBe(git(f.root, 'rev-parse', 'HEAD'));
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    expect((await readSyncStatus(engine, f.id)).last_error).toBeNull();
  }), 180_000);

  test(`an older binary's blocked cursor and its recorded checkpoint failure converge on the next ${retryFailed ? '--retry-failed (plain sync alias)' : 'plain'} sync`, async () => isolated(async () => {
    const f = await fixture();
    const incarnation = (await engine.executeRaw<{ i: string }>('SELECT incarnation::text AS i FROM sources WHERE id=$1', [f.id]))[0]!.i;
    const context = await resolveManagedSyncContext(engine, f.opts);
    const authority = await managedSyncAuthority(engine, f.id, incarnation, f.root);
    const head = git(f.root, 'rev-parse', 'HEAD');
    const key = `legacy-blocked-${f.id}`, runId = `run-${key}`;
    const entries = NAMES.map(name => ({ path: `${name}.md`, sourcePath: `${name}.md`, action: 'import', working: false, slug: name, pageId: null, revision: null }));
    const binding = { ...context.binding, owner_epoch: String((context.binding as { owner_epoch?: unknown }).owner_epoch), topology_generation: String(context.binding.topology_generation) };
    const syncOptions = syncCursorOptions(f.opts);
    const cursor = { binding, root: context.root, gitRoot: context.gitRoot, sourceId: f.id, incarnation, from: null, target: head, slugMode: 'git-root', discoveredAt: new Date().toISOString(),
      runId, index: entries.length, total: entries.length, authority, processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: false }, syncOptions,
      counts: { added: 0, modified: 0, deleted: 0, chunks: 0 } };
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)", [key, JSON.stringify([cursor])]);
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync-manifest',$1,$2::text::jsonb)", [runId, JSON.stringify(entries)]);
    await recordManagedSyncFailure(engine, { source_id: f.id, source_incarnation: incarnation, path: '__managed_sync_checkpoint__', code: 'revision_conflict',
      message: 'The source checkpoint changed during this sync.', request_id: randomUUID(), run_id: runId, target: head, cursor_key: key, phase: 'checkpoint', state: 'conflict',
      observation_id: randomUUID(), syncOptions, processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: false } });
    expect((await readManagedSyncFailures(engine, [f.id])).map(row => [row.code, row.phase])).toEqual([['revision_conflict', 'checkpoint']]);
    const converged = await performManagedSync(engine, { ...f.opts, retryFailed });
    expect(converged.status).toBe('first_sync');
    expect(await cursorRows(f.id)).toEqual([]);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    expect((await readSyncStatus(engine, f.id)).last_error).toBeNull();
    expect(await livePages(f.id)).toEqual(NAMES);
    expect(await lastCommit(f.id)).toBe(head);
  }), 180_000);
}
