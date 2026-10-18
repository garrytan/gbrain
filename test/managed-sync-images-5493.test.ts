/**
 * Managed sync and images. #5493: with multimodal embedding on, the sync
 * admission set includes images, but managed sync had no image branch, so
 * each image import was held as `managed_image_sync_unsupported` and the rest
 * of the run imported. #6529: the coordinated image importer takes the entry
 * instead. A committed image is frozen as its bytes (never a UTF-8 decode) and
 * imported through `importImageFile` under the owner's guarded transaction:
 * page, chunk with `embedding_image`, file row and `source_path`. An unchanged
 * image is a hash no-op (no provider call); a renamed image moves to its new
 * slug; a deleted image deletes its page. Holds an older release wrote are
 * re-screened and imported once the flag is on. With the flag off the hold
 * stays and names the flag.
 *
 * Both engines (PGLite in-memory; Postgres when DATABASE_URL is set). The
 * Voyage multimodal endpoint is a fetch stub ($0); text embedding is stubbed
 * through the gateway transport seam.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readGitSourceHolds, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { managedImageHold } from '../src/core/persistence/sync-screen.ts';
import { readTreeBlobs } from '../src/core/persistence/sync-blobs.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { importImageFile } from '../src/core/import-file.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'gbrain-5493-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const IMAGE = 'test/fixtures/images/tiny.avif';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const HOLD = 'managed_image_sync_unsupported';
const NOTE = '---\ntitle: Plain\n---\nAn ordinary note.\n';
const env = { GBRAIN_HOME: home, GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBEDDING_IMAGE_OCR: 'false' };
const origFetch = globalThis.fetch;
let providerCalls = 0;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(root: string, message: string): string {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}
/**
 * A Git source claimed by this host; `files` maps a path to Markdown text, the AVIF fixture or raw PNG bytes.
 * `legacyImages` are imported metadata-only through the legacy writer before managed persistence is on (vectorless pages).
 */
async function managedSource(engine: BrainEngine, files: Record<string, string | Buffer>, legacyImages: string[] = []) {
  const sourceId = `i${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const root = join(home, sourceId); mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) {
    if (body === IMAGE) copyFileSync(IMAGE, join(root, path)); else writeFileSync(join(root, path), body);
  }
  const head = commit(root, 'initial');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [sourceId, root]);
  for (const path of legacyImages) expect((await importImageFile(engine, join(root, path), path, { sourceId, noEmbed: true })).status).toBe('imported');
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
async function imagePage(engine: BrainEngine, sourceId: string, slug: string) {
  const [row] = await engine.executeRaw<{ source_path: string | null; page_kind: string; has_vector: boolean; sealed: boolean }>(
    `SELECT p.source_path, p.page_kind, p.text_projection_revision IS NOT DISTINCT FROM p.knowledge_revision AS sealed,
       EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id AND c.embedding_image IS NOT NULL) AS has_vector
     FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`, [sourceId, slug]);
  return row ?? null;
}

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);

beforeEach(() => {
  providerCalls = 0;
  // The Voyage multimodal endpoint is a fetch stub (one 1024-d vector per input); text embedding runs through the SDK transport seam (1536-d).
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (!String(url).includes('voyageai.com')) return origFetch(url as string, init as RequestInit);
    providerCalls++;
    const n = (init?.body ? JSON.parse(init.body) as { inputs?: unknown[] } : {}).inputs?.length ?? 1;
    return new Response(JSON.stringify({ data: Array.from({ length: n }, (_, index) => ({ embedding: Array.from({ length: 1024 }, () => 0.1), index })),
      model: 'voyage-multimodal-3', usage: { total_tokens: 10 * n } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  __setEmbedTransportForTests((async (args: { values: unknown[] }) => ({ embeddings: args.values.map(() => Array.from({ length: 1536 }, () => 0.1)) })) as never);
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_multimodal_model: 'voyage:voyage-multimodal-3', embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'test-key', VOYAGE_API_KEY: 'test-key' } });
});
afterEach(() => { globalThis.fetch = origFetch; __setEmbedTransportForTests(null); resetGateway(); });

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

describe('managed sync imports images when multimodal embedding is on (#5493 held them, #6529 imports them)', () => {
  test('a committed image imports with its image vector and source_path on the first and an incremental sync; nothing is held', async () =>
    withEnv(env, async () => {
      for (const engine of engines) {
        providerCalls = 0;
        const { sourceId, root, head } = await managedSource(engine, { 'notes/plain.md': NOTE, 'notes/photo.png': PNG });

        const preview = await performManagedSync(engine, { sourceId, noPull: true, dryRun: true });
        expect(preview.would_hold ?? []).toEqual([]);

        const first = await performManagedSync(engine, { sourceId, noPull: true });
        expect(first.status).toBe('first_sync');
        expect(first.added).toBe(2);
        expect(first.held_count ?? 0).toBe(0);
        expect(await heldPaths(engine, sourceId)).toEqual([]);
        expect(await lastCommit(engine, sourceId)).toBe(head);
        expect(await imagePage(engine, sourceId, 'notes/photo.png')).toEqual({ source_path: 'notes/photo.png', page_kind: 'image', has_vector: true, sealed: true });
        expect(providerCalls).toBeGreaterThanOrEqual(1);

        // An unchanged image is a hash no-op: no provider call on the next run.
        providerCalls = 0;
        copyFileSync(IMAGE, join(root, 'notes', 'second.avif'));
        writeFileSync(join(root, 'notes', 'later.md'), '---\ntitle: Later\n---\nA note committed after the first sync.\n');
        const next = commit(root, 'incremental');
        const incremental = await performManagedSync(engine, { sourceId, noPull: true });
        expect(incremental.status).toBe('synced');
        expect(incremental.held_count ?? 0).toBe(0);
        expect(await lastCommit(engine, sourceId)).toBe(next);
        expect(await imagePage(engine, sourceId, 'notes/second.avif')).toMatchObject({ source_path: 'notes/second.avif', has_vector: true });
        expect(providerCalls).toBe(1);

        providerCalls = 0;
        const again = await performManagedSync(engine, { sourceId, noPull: true, full: true });
        expect(again.status).not.toBe('blocked');
        expect(providerCalls).toBe(0);
        expect(await imagePage(engine, sourceId, 'notes/photo.png')).toMatchObject({ has_vector: true });
      }
    }), 240_000);

  test('a hold written before this release is re-screened and imported once multimodal embedding is on', async () =>
    withEnv(env, async () => {
      for (const engine of engines) {
        // The image is committed but synced while multimodal was off (not an entry); an older gbrain then held it.
        const { sourceId, root, head } = await managedSource(engine, { 'notes/plain.md': NOTE, 'notes/held.png': PNG });
        await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'false' }, async () => {
          expect((await performManagedSync(engine, { sourceId, noPull: true })).status).toBe('first_sync');
        });
        expect(await imagePage(engine, sourceId, 'notes/held.png')).toBeNull();
        const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
        const blob = readTreeBlobs(root, head, ['notes/held.png']).get('notes/held.png')!;
        const now = new Date().toISOString();
        await writeGitHold(engine, { source_id: sourceId, incarnation: source.incarnation, path: 'notes/held.png', source_path: 'notes/held.png', slug: 'notes/held.png', page_id: null,
          code: HOLD, message: 'notes/held.png is an image, which managed sync does not import yet; the rest of the source synced.', upstream_version: sha256(PNG.toString('utf8')),
          observed_at: now, run_id: null, mode: 'managed', meta: { recovery_version: 1, blob_oid: blob.oid } });
        expect(await heldPaths(engine, sourceId)).toEqual([['notes/held.png', HOLD]]);

        const synced = await performManagedSync(engine, { sourceId, noPull: true });
        expect(synced.status).not.toBe('blocked');
        expect(await imagePage(engine, sourceId, 'notes/held.png')).toMatchObject({ source_path: 'notes/held.png', has_vector: true });
        expect(await heldPaths(engine, sourceId)).toEqual([]);
      }
    }), 240_000);

  test('with multimodal embedding off, the image hold names the flag that turns the importer on', () => {
    const hold = managedImageHold({ path: 'notes/photo.png', sourcePath: 'notes/photo.png', working: false, slug: 'notes/photo.png' }, null, null);
    expect(hold.code).toBe(HOLD);
    expect(hold.message).toContain('GBRAIN_EMBEDDING_MULTIMODAL=true');
  });

  test('deleting an image deletes its page; renaming one moves it to the new slug', async () =>
    withEnv(env, async () => {
      for (const engine of engines) {
        providerCalls = 0;
        const { sourceId, root } = await managedSource(engine, { 'notes/plain.md': NOTE, 'notes/old.png': PNG, 'notes/moved.png': Buffer.concat([PNG, Buffer.from([0])]) });
        const live = async (path: string) => (await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND source_path=$2 AND deleted_at IS NULL', [sourceId, path])).length;
        expect((await performManagedSync(engine, { sourceId, noPull: true })).added).toBe(3);
        expect([await live('notes/old.png'), await live('notes/moved.png')]).toEqual([1, 1]);

        git(root, 'rm', '-q', 'notes/old.png');
        commit(root, 'remove image');
        const removed = await performManagedSync(engine, { sourceId, noPull: true });
        expect(removed.status).toBe('synced');
        expect(removed.deleted).toBe(1);
        expect([await live('notes/old.png'), await live('notes/moved.png')]).toEqual([0, 1]);

        providerCalls = 0;
        git(root, 'mv', 'notes/moved.png', 'notes/archived.png');
        const next = commit(root, 'rename image');
        const renamed = await performManagedSync(engine, { sourceId, noPull: true });
        expect(renamed.status).toBe('synced');
        expect(renamed.renamed).toBe(1);
        expect(await lastCommit(engine, sourceId)).toBe(next);
        expect([await live('notes/moved.png'), await live('notes/archived.png')]).toEqual([0, 1]);
        expect(await imagePage(engine, sourceId, 'notes/archived.png')).toMatchObject({ source_path: 'notes/archived.png', has_vector: true });
        expect(await heldPaths(engine, sourceId)).toEqual([]);
      }
    }), 240_000);
});
