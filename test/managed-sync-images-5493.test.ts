/**
 * #5493: with multimodal embedding on, the sync admission set includes images,
 * but the managed sync importer has no image branch. One committed image used
 * to refuse the whole managed sync (`writer_coordinator_required`) before any
 * page write, so the checkpoint never advanced. Each image import now gets a
 * named refusal (`managed_image_sync_unsupported`) and the rest of the run imports:
 *
 *   - first sync and incremental sync both skip a committed image and import
 *     the Markdown beside it, and the checkpoint advances;
 *   - deleting or renaming an image whose page predates managed persistence
 *     deletes that page, on full and incremental sync; a renamed-to path is refused;
 *   - a run lists the first 20 refused images and counts the rest.
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
import { printManagedSyncNotes } from '../src/commands/sync-diagnostics.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'gbrain-5493-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const IMAGE = 'test/fixtures/images/tiny.avif';
const DOCS = 'docs/guides/write-refusals.md#managed_image_sync_unsupported';
const suggestion = (sourceId: string) =>
  `Later syncs do not retry a committed image. Once managed sync imports images, run gbrain sync --source ${sourceId} --no-pull --full to import the images it skipped.`;
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
  test('a committed image is a named refusal on first and incremental sync; the Markdown imports and the checkpoint advances', async () =>
    withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      for (const engine of engines) {
        const { sourceId, root, head } = await managedSource(engine, {
          'notes/plain.md': NOTE, 'notes/photo.png': IMAGE });

        const first = await performManagedSync(engine, { sourceId, noPull: true });
        expect(first.status).toBe('first_sync');
        expect(first.fileRefusals).toEqual([{ path: 'notes/photo.png', code: 'managed_image_sync_unsupported',
          message: 'notes/photo.png is an image, which managed sync does not import yet; sync skipped it.',
          suggestion: suggestion(sourceId), docs: DOCS }]);
        expect(await engine.getPage('notes/plain', { sourceId })).not.toBeNull();
        expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND source_path=$2', [sourceId, 'notes/photo.png'])).toEqual([]);
        expect(await lastCommit(engine, sourceId)).toBe(head);
        const lines: string[] = [];
        printManagedSyncNotes(first, line => lines.push(line));
        expect(lines).toContain(`  Refused managed_image_sync_unsupported: ${first.fileRefusals![0].message} ${suggestion(sourceId)} (${DOCS})`);

        copyFileSync(IMAGE, join(root, 'notes', 'second.webp'));
        writeFileSync(join(root, 'notes', 'later.md'), '---\ntitle: Later\n---\nA note committed after the first sync.\n');
        const next = commit(root, 'incremental');
        const incremental = await performManagedSync(engine, { sourceId, noPull: true });
        expect(incremental.status).toBe('synced');
        expect(incremental.fileRefusals?.map(refusal => [refusal.path, refusal.code])).toEqual([['notes/second.webp', 'managed_image_sync_unsupported']]);
        expect(await engine.getPage('notes/later', { sourceId })).not.toBeNull();
        expect(await lastCommit(engine, sourceId)).toBe(next);
      }
    }), 180_000);

  test('deleting or renaming an image deletes its page on full and incremental sync; the renamed-to path is refused', async () =>
    withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      for (const engine of engines) {
        // Both image pages predate managed persistence: the unmanaged importer wrote them.
        const { sourceId, root } = await managedSource(engine, { 'notes/plain.md': NOTE, 'notes/old.png': IMAGE, 'notes/moved.png': IMAGE },
          async (id, dir) => {
            for (const path of ['notes/old.png', 'notes/moved.png']) expect((await importImageFile(engine, join(dir, path), path, { sourceId: id, noEmbed: true })).error).toBeUndefined();
          });
        const live = async (path: string) => (await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND source_path=$2 AND deleted_at IS NULL', [sourceId, path])).length;
        expect((await performManagedSync(engine, { sourceId, noPull: true })).status).toBe('first_sync');
        expect([await live('notes/old.png'), await live('notes/moved.png')]).toEqual([1, 1]);

        git(root, 'rm', '-q', 'notes/old.png');
        commit(root, 'remove image');
        const full = await performManagedSync(engine, { sourceId, noPull: true, full: true });
        expect(full.fileRefusals?.map(refusal => refusal.path)).toEqual(['notes/moved.png']);
        expect([await live('notes/old.png'), await live('notes/moved.png')]).toEqual([0, 1]);

        git(root, 'mv', 'notes/moved.png', 'notes/archived.png');
        const next = commit(root, 'rename image');
        const renamed = await performManagedSync(engine, { sourceId, noPull: true });
        expect(renamed.status).toBe('synced');
        expect(renamed.fileRefusals?.map(refusal => [refusal.path, refusal.code])).toEqual([['notes/archived.png', 'managed_image_sync_unsupported']]);
        expect([await live('notes/moved.png'), await live('notes/archived.png')]).toEqual([0, 0]);
        expect(await lastCommit(engine, sourceId)).toBe(next);
      }
    }), 180_000);

  test('a run lists the first 20 refused images and counts the rest', async () =>
    withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      for (const engine of engines) {
        const images = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`notes/img-${String(i).padStart(2, '0')}.png`, 'not decoded']));
        const { sourceId } = await managedSource(engine, { 'notes/plain.md': NOTE, ...images });
        const result = await performManagedSync(engine, { sourceId, noPull: true });
        expect(result.status).toBe('first_sync');
        expect(result.fileRefusals).toHaveLength(20);
        expect(result.fileRefusals!.every(refusal => refusal.code === 'managed_image_sync_unsupported')).toBe(true);
        expect(result.imageRefusalsOmitted).toBe(2);
        expect(await engine.getPage('notes/plain', { sourceId })).not.toBeNull();
        const lines: string[] = [];
        printManagedSyncNotes(result, line => lines.push(line));
        expect(lines).toContain(`  Refused managed_image_sync_unsupported: 2 more image(s) skipped the same way and not listed. (${DOCS})`);
      }
    }), 180_000);
});
