/**
 * #5493: with multimodal embedding on, the sync admission set includes images,
 * but the managed sync importer has no image branch. One committed image used
 * to refuse the whole managed sync (`writer_coordinator_required`) before any
 * page write, so the checkpoint never advanced. Each image import is now held
 * (`managed_image_sync_unsupported`): the rest of the run imports, the image is
 * recorded as incomplete coverage (a durable hold, not an import), and a later
 * sync re-screens it when the file changes, leaves, or `sources retry-held` asks.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importImageFile } from '../src/core/import-file.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readGitSourceHolds, requestGitHoldRetry } from '../src/core/persistence/sync-holds.ts';
import { printHoldNotes } from '../src/commands/sync-diagnostics.ts';
import { gitHeldFilesCheck } from '../src/commands/doctor/checks/git-holds.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'gbrain-5493-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const IMAGE = 'test/fixtures/images/tiny.avif';
const CODE = 'managed_image_sync_unsupported';
const NOTE = '---\ntitle: Plain\n---\nAn ordinary note.\n';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(root: string, message: string): string {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}
/** A Git source claimed by this host; `before` runs while managed persistence is still off. */
async function managedSource(engine: BrainEngine, files: Record<string, string>, before?: (sourceId: string, root: string) => Promise<void>) {
  const sourceId = `i${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const root = join(home, sourceId); mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) {
    if (body === IMAGE) copyFileSync(IMAGE, join(root, path)); else writeFileSync(join(root, path), body);
  }
  const head = commit(root, 'initial');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [sourceId, root]);
  await before?.(sourceId, root);
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { sourceId, root, head };
}
async function lastCommit(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const [source] = await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]);
  return source.last_commit;
}
async function heldPaths(engine: BrainEngine, sourceId: string) {
  const [holds] = await readGitSourceHolds(engine, { sourceIds: [sourceId] });
  return (holds?.holds ?? []).map(hold => [hold.path, hold.code]).sort();
}

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

describe('#5493 managed sync with multimodal embedding on', () => {
  test('a committed image is held on first and incremental sync; the Markdown imports and the checkpoint advances', async () =>
    withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      for (const engine of engines) {
        const { sourceId, root, head } = await managedSource(engine, { 'notes/plain.md': NOTE, 'notes/photo.png': IMAGE });

        const preview = await performManagedSync(engine, { sourceId, noPull: true, dryRun: true });
        expect(preview.would_hold?.map(item => [item.path, item.code])).toEqual([['notes/photo.png', CODE]]);

        const first = await performManagedSync(engine, { sourceId, noPull: true });
        expect(first.status).toBe('first_sync');
        expect(first.added).toBe(1);
        expect(first.held_count).toBe(1);
        expect(first.held?.map(item => [item.path, item.code, item.stale])).toEqual([['notes/photo.png', CODE, false]]);
        expect(first.held![0].docs).toBe(`docs/guides/write-refusals.md#${CODE}`);
        expect(await engine.getPage('notes/plain', { sourceId })).not.toBeNull();
        expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND source_path=$2', [sourceId, 'notes/photo.png'])).toEqual([]);
        expect(await lastCommit(engine, sourceId)).toBe(head);
        expect(await heldPaths(engine, sourceId)).toEqual([['notes/photo.png', CODE]]);
        const lines: string[] = [];
        printHoldNotes(first, line => lines.push(line));
        expect(lines.some(line => line.startsWith(`  Held notes/photo.png: ${CODE}`))).toBe(true);

        copyFileSync(IMAGE, join(root, 'notes', 'second.webp'));
        writeFileSync(join(root, 'notes', 'later.md'), '---\ntitle: Later\n---\nA note committed after the first sync.\n');
        const next = commit(root, 'incremental');
        const incremental = await performManagedSync(engine, { sourceId, noPull: true });
        expect(incremental.status).toBe('synced');
        expect(incremental.held?.map(item => [item.path, item.code])).toEqual([['notes/second.webp', CODE]]);
        expect(await engine.getPage('notes/later', { sourceId })).not.toBeNull();
        expect(await lastCommit(engine, sourceId)).toBe(next);
        expect(await heldPaths(engine, sourceId)).toEqual([['notes/photo.png', CODE], ['notes/second.webp', CODE]]);
      }
    }), 180_000);

  test('held images are re-screened later: on change, on retry-held, and released when they leave the source', async () =>
    withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      for (const engine of engines) {
        const { sourceId, root } = await managedSource(engine, { 'notes/plain.md': NOTE, 'notes/a.png': IMAGE, 'notes/b.png': IMAGE });
        expect((await performManagedSync(engine, { sourceId, noPull: true })).held_count).toBe(2);

        writeFileSync(join(root, 'notes', 'a.png'), 'changed image bytes');
        commit(root, 'change image');
        const changed = await performManagedSync(engine, { sourceId, noPull: true });
        expect(changed.held?.map(item => item.path)).toEqual(['notes/a.png']);

        const [holds] = await readGitSourceHolds(engine, { sourceIds: [sourceId] });
        await requestGitHoldRetry(engine, sourceId, holds!.incarnation, ['notes/b.png']);
        const retried = await performManagedSync(engine, { sourceId, noPull: true });
        expect(retried.held?.map(item => item.path)).toEqual(['notes/b.png']);

        git(root, 'rm', '-q', 'notes/a.png');
        commit(root, 'remove image');
        await performManagedSync(engine, { sourceId, noPull: true });
        expect(await heldPaths(engine, sourceId)).toEqual([['notes/b.png', CODE]]);
      }
    }), 180_000);

  test('deleting or renaming an image deletes its page; the renamed-to path is held', async () =>
    withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      for (const engine of engines) {
        const { sourceId, root } = await managedSource(engine, { 'notes/plain.md': NOTE, 'notes/old.png': IMAGE, 'notes/moved.png': IMAGE },
          async (id, dir) => {
            for (const path of ['notes/old.png', 'notes/moved.png']) expect((await importImageFile(engine, join(dir, path), path, { sourceId: id, noEmbed: true })).error).toBeUndefined();
          });
        const live = async (path: string) => (await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND source_path=$2 AND deleted_at IS NULL', [sourceId, path])).length;
        const first = await performManagedSync(engine, { sourceId, noPull: true });
        expect(first.status).toBe('first_sync');
        expect(first.held?.map(item => [item.path, item.stale])).toEqual([['notes/moved.png', true], ['notes/old.png', true]]);
        expect([await live('notes/old.png'), await live('notes/moved.png')]).toEqual([1, 1]);

        git(root, 'rm', '-q', 'notes/old.png');
        commit(root, 'remove image');
        await performManagedSync(engine, { sourceId, noPull: true, full: true });
        expect([await live('notes/old.png'), await live('notes/moved.png')]).toEqual([0, 1]);
        expect(await heldPaths(engine, sourceId)).toEqual([['notes/moved.png', CODE]]);

        git(root, 'mv', 'notes/moved.png', 'notes/archived.png');
        const next = commit(root, 'rename image');
        const renamed = await performManagedSync(engine, { sourceId, noPull: true });
        expect(renamed.status).toBe('synced');
        expect(renamed.held?.map(item => [item.path, item.code])).toEqual([['notes/archived.png', CODE]]);
        expect(await lastCommit(engine, sourceId)).toBe(next);
      }
    }), 180_000);

  test('image holds are incomplete coverage, not a generator fault: they never escalate the sync result or doctor', async () =>
    withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      for (const engine of engines) {
        await engine.setConfig('sync.hold_escalate_count', '1');
        try {
          const { sourceId } = await managedSource(engine, { 'notes/plain.md': NOTE, 'notes/a.png': IMAGE, 'notes/b.png': IMAGE, 'notes/c.png': IMAGE });
          const result = await performManagedSync(engine, { sourceId, noPull: true });
          expect(result.held_count).toBe(3);
          expect(result.holds_escalated).toBeUndefined();
          const check = await gitHeldFilesCheck(engine, [sourceId]);
          expect(check.status).toBe('warn');
          expect((check.details as { held: number }).held).toBe(3);
        } finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.hold_escalate_count'"); }
      }
    }), 180_000);
});
