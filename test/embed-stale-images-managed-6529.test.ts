/**
 * #6529: `gbrain embed --stale --images` on a managed brain. The sweep called
 * the legacy importer, which a managed brain refuses
 * (`assertUnmanagedCanonicalWriter`); it treated a NULL `pages.source_path` as
 * a missing file although an image slug is the repo-relative path; and a sweep
 * that found no file for any candidate exited 0. Plain `embed --stale` printed
 * the `--images` command instead of running the sweep on a multimodal install.
 *
 * Both engines (PGLite in-memory; Postgres when DATABASE_URL is set). The
 * Voyage multimodal endpoint is a fetch stub ($0); text embedding is stubbed
 * through the gateway transport seam.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { embedStaleImages, runEmbedStaleImagesCli } from '../src/core/embed-stale-images.ts';
import { importImageFile } from '../src/core/import-file.ts';
import { runEmbed } from '../src/commands/embed.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'gbrain-6529-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
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
 * A Git source claimed by this host; `files` maps a path to Markdown text or raw PNG bytes.
 * `legacyImages` are imported metadata-only through the legacy writer before managed persistence is on (vectorless pages).
 */
async function managedSource(engine: BrainEngine, files: Record<string, string | Buffer>, legacyImages: string[] = []) {
  const sourceId = `i${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const root = join(home, sourceId); mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) {
    writeFileSync(join(root, path), body);
  }
  const head = commit(root, 'initial');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [sourceId, root]);
  for (const path of legacyImages) expect((await importImageFile(engine, join(root, path), path, { sourceId, noEmbed: true })).status).toBe('imported');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { sourceId, root, head };
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

describe('#6529 embed --stale --images on a managed brain', () => {
  test('rebuilds a vectorless image through the coordinator, finds a NULL source_path page through its slug and records source_path', async () =>
    withEnv(env, async () => {
      for (const engine of engines) {
        providerCalls = 0;
        const { sourceId } = await managedSource(engine, { 'notes/plain.md': NOTE, 'notes/photo.png': PNG, 'notes/unpathed.png': PNG }, ['notes/photo.png', 'notes/unpathed.png']);
        expect(await imagePage(engine, sourceId, 'notes/photo.png')).toMatchObject({ source_path: 'notes/photo.png', has_vector: false });
        expect(providerCalls).toBe(0);
        // The page came from an importer that never recorded its origin (the production shape of #6529).
        await engine.executeRaw("UPDATE pages SET source_path=NULL WHERE source_id=$1 AND slug='notes/unpathed.png'", [sourceId]);

        const preview = await embedStaleImages(engine, { sourceId, dryRun: true });
        expect(preview.candidates).toBe(2);

        const swept = await embedStaleImages(engine, { sourceId, dryRun: false });
        expect(swept).toMatchObject({ candidates: 2, rebuilt: 2, missingFile: 0, missingSourcePath: 1, failures: 0, failure_samples: [] });
        expect(await imagePage(engine, sourceId, 'notes/photo.png')).toMatchObject({ has_vector: true, sealed: true });
        expect(await imagePage(engine, sourceId, 'notes/unpathed.png')).toMatchObject({ source_path: 'notes/unpathed.png', has_vector: true });
        expect(providerCalls).toBe(2);

        expect((await embedStaleImages(engine, { sourceId, dryRun: false })).candidates).toBe(0);
      }
    }), 240_000);

  test('explicit --images that finds no file for any candidate is a failure naming the path it tried, never a quiet success', async () =>
    withEnv(env, async () => {
      for (const engine of engines) {
        providerCalls = 0;
        const { sourceId, root } = await managedSource(engine, { 'notes/plain.md': NOTE, 'notes/gone.png': PNG }, ['notes/gone.png']);
        await engine.executeRaw("UPDATE pages SET source_path=NULL WHERE source_id=$1 AND slug='notes/gone.png'", [sourceId]);
        rmSync(join(root, 'notes', 'gone.png'));

        const swept = await runEmbedStaleImagesCli(engine, ['--stale', '--images', '--source', sourceId, '--json']);
        expect(swept).toMatchObject({ candidates: 1, rebuilt: 0, missingFile: 1, missingSourcePath: 1 });
        expect(swept.failures).toBeGreaterThan(0);
        expect(swept.failure_samples[0]).toContain(`${sourceId}:notes/gone.png`);
        expect(swept.failure_samples[0]).toContain(join(root, 'notes', 'gone.png'));
        expect(swept.missing_samples?.[0]).toContain(join(root, 'notes', 'gone.png'));
      }
    }), 240_000);

  test('plain embed --stale reports fileless image pages in `images` and leaves the exit code to the text run', async () =>
    withEnv(env, async () => {
      for (const engine of engines) {
        providerCalls = 0;
        const { sourceId, root } = await managedSource(engine, { 'notes/plain.md': NOTE, 'notes/gone.png': PNG }, ['notes/gone.png']);
        rmSync(join(root, 'notes', 'gone.png'));

        const result = await runEmbed(engine, ['--stale', '--source', sourceId, '--json']);
        const images = result && 'images' in result ? result.images : undefined;
        expect(images).toMatchObject({ candidates: 1, rebuilt: 0, missingFile: 1, failures: 0, failure_samples: [] });
        expect(images?.missing_samples[0]).toContain(join(root, 'notes', 'gone.png'));
        expect(result?.failures).toBe(0);
        expect(providerCalls).toBe(0);
      }
    }), 240_000);

  test('plain embed --stale runs the image sweep itself on a multimodal install and keeps the hint on a text-only one', async () =>
    withEnv(env, async () => {
      for (const engine of engines) {
        providerCalls = 0;
        const { sourceId } = await managedSource(engine, { 'notes/plain.md': NOTE, 'notes/photo.png': PNG }, ['notes/photo.png']);
        expect((await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true })).status).toBe('first_sync');
        expect(await imagePage(engine, sourceId, 'notes/photo.png')).toMatchObject({ has_vector: false });

        const textOnly = await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'false' }, () => runEmbed(engine, ['--stale', '--source', sourceId, '--dry-run', '--json']));
        expect(textOnly && 'images' in textOnly ? textOnly.images : undefined).toBeUndefined();

        const result = await runEmbed(engine, ['--stale', '--source', sourceId, '--json']);
        expect(result && 'images' in result ? result.images : undefined).toMatchObject({ candidates: 1, rebuilt: 1, failures: 0 });
        expect(result?.failures).toBe(0);
        expect(await imagePage(engine, sourceId, 'notes/photo.png')).toMatchObject({ has_vector: true });
      }
    }), 240_000);
});

describe('#6529 source_path is recorded on every image import path', () => {
  test('an unchanged, complete image re-imported through the legacy writer records the origin it never had', async () =>
    withEnv(env, async () => {
      for (const engine of engines) {
        const sourceId = `i${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, sourceId);
        mkdirSync(join(root, 'notes'), { recursive: true });
        writeFileSync(join(root, 'notes', 'legacy.png'), PNG);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        try {
          await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [sourceId, root]);
          expect((await importImageFile(engine, join(root, 'notes', 'legacy.png'), 'notes/legacy.png', { sourceId, noEmbed: true })).status).toBe('imported');
          await engine.executeRaw("UPDATE pages SET source_path=NULL WHERE source_id=$1 AND slug='notes/legacy.png'", [sourceId]);
          expect((await importImageFile(engine, join(root, 'notes', 'legacy.png'), 'notes/legacy.png', { sourceId, noEmbed: true })).status).toBe('skipped');
          expect(await imagePage(engine, sourceId, 'notes/legacy.png')).toMatchObject({ source_path: 'notes/legacy.png', has_vector: false });
        } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
      }
    }), 120_000);
});
