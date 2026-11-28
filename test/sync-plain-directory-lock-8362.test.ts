/**
 * #8362 item 2: a plain-directory sync takes the same locks as a Git sync of that source, so an autopilot sync and a
 * manual one never import the same directory at once.
 * Fails when: a plain import runs while another holder has the source's sync lease (managed or classic) or the classic
 * filesystem-writer lock, a managed import inside a drain lease this process already holds refuses itself, or a dry run
 * waits on a lease it never needs.
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { performSync } from '../src/commands/sync.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { syncLockId, tryAcquireDbLock } from '../src/core/db-lock.ts';
import { SyncLockBusyError } from '../src/core/sync-lock.ts';
import { withSourceFilesystemLock } from '../src/core/minions/source-filesystem.ts';
import { withDrainLease } from '../src/core/persistence/sync-lease.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const backends: Array<string | undefined> = [undefined, ...(process.env.DATABASE_URL ? [process.env.DATABASE_URL] : [])];
const engineName = (url: string | undefined) => url ? 'postgres' : 'pglite';
const note = (body: string) => `---\ntitle: "Example note"\ntype: "note"\n---\n\n# Example note\n\n${body}\n`;

async function lastSync(engine: BrainEngine, sourceId: string): Promise<unknown> {
  const [row] = await engine.executeRaw<{ last_sync_at: unknown }>('SELECT last_sync_at FROM sources WHERE id=$1', [sourceId]);
  return row?.last_sync_at ?? null;
}

async function withPlainSource(url: string | undefined, run: (brain: ManagedBrain) => Promise<void>): Promise<void> {
  await managedBrain(async brain => {
    const dir = join(brain.root, '..', 'plain-notes');
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'example.md'), note('Imported only by the lease holder.'));
    expect(await runManagedSourceLifecycle(brain.engine, { operation: 'add', sourceId: 'source-a', path: dir })).toMatchObject({ state: 'committed' });
    await run(brain);
  }, { databaseUrl: url });
}

describe.each(backends.map(url => [engineName(url), url] as const))('managed plain-directory sync lease (%s)', (_name, url) => {
  test('another holder of the source lease keeps a plain import out, and the next sync imports once it is free', () => withPlainSource(url, async ({ engine }) => {
    const sync = () => performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true });
    const held = await tryAcquireDbLock(engine, syncLockId('source-a'));
    expect(held).not.toBeNull();
    try {
      await expect(sync()).rejects.toBeInstanceOf(SyncLockBusyError);
      expect(await engine.getPage('notes/example', { sourceId: 'source-a' })).toBeNull();
      expect(await lastSync(engine, 'source-a')).toBeNull();
      expect(await performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true, dryRun: true })).toMatchObject({ status: 'dry_run', added: 1 });
    } finally { await held!.release(); }
    expect(await sync()).toMatchObject({ status: 'synced', added: 1 });
    expect(await lastSync(engine, 'source-a')).not.toBeNull();
    const after = await tryAcquireDbLock(engine, syncLockId('source-a'));
    expect(after).not.toBeNull();
    await after!.release();
  }), 180_000);

  test('a plain import inside a drain lease this process already holds runs under that lease', () => withPlainSource(url, async ({ engine }) => {
    const result = await withDrainLease(engine, 'source-a', { holder: { kind: 'cli', id: null } },
      () => performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true }));
    expect(result).toMatchObject({ status: 'synced', added: 1 });
    expect((await engine.getPage('notes/example', { sourceId: 'source-a' }))?.compiled_truth).toContain('Imported only by the lease holder.');
  }), 180_000);
});

describe('classic plain-directory sync locks', () => {
  let engine: PGLiteEngine;
  let home: string;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    home = mkdtempSync(join(tmpdir(), 'gbrain-plain-lock-'));
  });
  afterAll(async () => {
    await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  });

  async function plainSource(sourceId: string): Promise<string> {
    const dir = join(home, sourceId); mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'example.md'), note('Imported only by the lock holder.'));
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, dir]);
    return dir;
  }

  test('a held filesystem-writer lock stops the import before it starts, and a later sync imports', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const dir = await plainSource('source-fs');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withSourceFilesystemLock(engine, dir, async () => { entered.resolve(); await release.promise; });
    try {
      await entered.promise;
      const result = await performSync(engine, { sourceId: 'source-fs', noPull: true, noEmbed: true, signal: AbortSignal.timeout(300) });
      expect(result).toMatchObject({ status: 'partial', reason: 'timeout', added: 0 });
      expect(await engine.getPage('notes/example', { sourceId: 'source-fs' })).toBeNull();
      expect(await lastSync(engine, 'source-fs')).toBeNull();
    } finally { release.resolve(); await holder; }
    expect(await performSync(engine, { sourceId: 'source-fs', noPull: true, noEmbed: true })).toMatchObject({ status: 'synced', added: 1 });
    expect(await lastSync(engine, 'source-fs')).not.toBeNull();
  }), 120_000);

  test('a held classic sync lease refuses busy without importing; skipLock leaves the lease to its caller', () => withEnv({ GBRAIN_HOME: home }, async () => {
    await plainSource('source-lease');
    const held = await tryAcquireDbLock(engine, syncLockId('source-lease'));
    expect(held).not.toBeNull();
    try {
      await expect(performSync(engine, { sourceId: 'source-lease', noPull: true, noEmbed: true })).rejects.toBeInstanceOf(SyncLockBusyError);
      expect(await engine.getPage('notes/example', { sourceId: 'source-lease' })).toBeNull();
      expect(await lastSync(engine, 'source-lease')).toBeNull();
      expect(await performSync(engine, { sourceId: 'source-lease', noPull: true, noEmbed: true, skipLock: true })).toMatchObject({ status: 'synced', added: 1 });
    } finally { await held!.release(); }
  }), 120_000);
});
