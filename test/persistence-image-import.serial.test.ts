import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

let embeddingCalls = 0;
let provider: (() => Promise<void>) | undefined;
mock.module('../src/core/embedding.ts', () => ({ ...realEmbedding, embedMultimodal: async (inputs: unknown[]) => {
  embeddingCalls++;
  await provider?.();
  return inputs.map(() => new Float32Array(1024).fill(0.125));
} }));
const { importManagedFile } = await import('../src/core/persistence/import-mutations.ts');
const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
const { claimWorktree } = await import('../src/core/persistence/ownership.ts');
const { registerLocalWriter } = await import('../src/core/persistence/identity.ts');
const { importImageFile } = await import('../src/core/import-file.ts');
const { preparePageAdmission } = await import('../src/core/persistence/page-mutations.ts');
import type { OperationContext } from '../src/core/ops/contract.ts';

const home = mkdtempSync(join(tmpdir(), 'managed-image-import-'));
const env = { GBRAIN_HOME: home, GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBEDDING_IMAGE_OCR: 'false',
  OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const engines: BrainEngine[] = [];
let closePg: (() => Promise<void>) | undefined;
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePg = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } await closePg?.(); });
  const trash = join(homedir(), '.Trash'); mkdirSync(trash, { recursive: true });
  renameSync(home, join(trash, `managed-image-test-${randomUUID()}`));
  mock.restore();
});
async function fixture(engine: BrainEngine) {
  const sourceId = `image-${randomUUID().slice(0, 8)}`, root = join(home, sourceId), input = join(home, `${sourceId}-input`);
  mkdirSync(root); mkdirSync(input);
  const file = join(input, 'photo.png'); writeFileSync(file, bytes);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await registerLocalWriter(engine, 'cli'); await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { sourceId, root, file };
}

test('coordinated images preserve binary bytes, file metadata and image vectors with provider work before publication', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine), slug = 'photos/photo.png', target = join(f.root, slug);
    provider = async () => {
      expect(await engine.getPage(slug, { sourceId: f.sourceId })).toBeNull();
      expect(existsSync(target)).toBe(false);
    };
    const before = embeddingCalls;
    expect(await importManagedFile(engine, f.file, slug, { sourceId: f.sourceId })).toMatchObject({ status: 'imported', slug, chunks: 1 });
    provider = undefined;
    expect(embeddingCalls).toBe(before + 1);
    expect(readFileSync(target)).toEqual(bytes);
    const page = (await engine.getPage(slug, { sourceId: f.sourceId }))!;
    expect(page).toMatchObject({ type: 'image', source_path: slug });
    expect(await engine.executeRaw('SELECT page_kind FROM pages WHERE id=$1', [page.id])).toEqual([{ page_kind: 'image' }]);
    const storedFile = await engine.getFile(f.sourceId, slug);
    expect(storedFile).toMatchObject({ page_id: page.id, source_id: f.sourceId, mime_type: 'image/png' });
    expect(Number(storedFile!.size_bytes)).toBe(bytes.length);
    expect(await engine.getChunks(slug, { sourceId: f.sourceId, requireSafeChunks: true })).toHaveLength(1);
    expect(await engine.executeRaw('SELECT vector_dims(embedding_image) AS dimensions,modality FROM content_chunks WHERE page_id=$1', [page.id]))
      .toEqual([{ dimensions: 1024, modality: 'image' }]);
    expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE source_id=$1 AND kind='embedding'", [f.sourceId])).toHaveLength(0);
    expect(await importManagedFile(engine, f.file, slug, { sourceId: f.sourceId })).toMatchObject({ status: 'skipped' });
    expect(embeddingCalls).toBe(before + 1);
    await expect(importImageFile(engine, f.file, slug, { sourceId: f.sourceId, noEmbed: true })).rejects.toThrow('legacy writer');
  }
}), 120_000);

test('no-embed imports image metadata without any provider or embedding outbox work', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine), before = embeddingCalls;
    provider = async () => { throw new Error('A no-embed image must not call a provider'); };
    expect(await importManagedFile(engine, f.file, 'photo.png', { sourceId: f.sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
    expect(embeddingCalls).toBe(before);
    expect(readFileSync(join(f.root, 'photo.png'))).toEqual(bytes);
    expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE source_id=$1 AND kind='embedding'", [f.sourceId])).toHaveLength(0);
    provider = undefined;
  }
}), 120_000);

test('provider failures and input changes during image preparation never publish partial image state', async () => withEnv(env, async () => {
  for (const engine of engines) for (const race of [false, true]) {
    const f = await fixture(engine);
    provider = async () => {
      if (race) writeFileSync(f.file, Buffer.from('newer image bytes'));
      else throw new Error('synthetic multimodal provider failure');
    };
    await expect(importManagedFile(engine, f.file, 'photo.png', { sourceId: f.sourceId })).rejects.toThrow(race ? 'file changed' : 'synthetic multimodal provider failure');
    provider = undefined;
    expect(await engine.getPage('photo.png', { sourceId: f.sourceId })).toBeNull();
    expect(await engine.getFile(f.sourceId, 'photo.png')).toBeNull();
    expect(existsSync(join(f.root, 'photo.png'))).toBe(false);
    expect(await engine.executeRaw('SELECT state FROM persistence_requests WHERE source_id=$1', [f.sourceId])).toEqual([{ state: race ? 'conflict' : 'failed' }]);
  }
}), 120_000);

test('disk opt-out imports an already-canonical image with its owner fence, vectors and no file effect', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine), file = join(f.root, 'photo.png'); writeFileSync(file, bytes);
    await engine.setConfig('sync.write_through', 'false');
    const before = embeddingCalls, stamp = statSync(file, { bigint: true }).mtimeNs;
    try {
      expect(await importManagedFile(engine, file, 'photo.png', { sourceId: f.sourceId })).toMatchObject({ status: 'imported', chunks: 1 });
      const page = (await engine.getPage('photo.png', { sourceId: f.sourceId }))!;
      expect(page).toMatchObject({ type: 'image', source_path: 'photo.png' });
      expect(await engine.executeRaw('SELECT vector_dims(embedding_image) AS dimensions FROM content_chunks WHERE page_id=$1', [page.id])).toEqual([{ dimensions: 1024 }]);
      expect(await engine.executeRaw("SELECT worktree_id IS NOT NULL AS fenced,authority->>'databaseOnlyReason' AS reason FROM persistence_requests WHERE source_id=$1", [f.sourceId])).toEqual([{ fenced: true, reason: 'disabled_by_config' }]);
      expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1', [f.sourceId])).toHaveLength(0);
      expect(readFileSync(file)).toEqual(bytes); expect(statSync(file, { bigint: true }).mtimeNs).toBe(stamp);
      expect(await engine.getConfig('sync.write_through')).toBe('false');
      expect(await importManagedFile(engine, file, 'photo.png', { sourceId: f.sourceId })).toMatchObject({ status: 'skipped' });
      expect(embeddingCalls).toBe(before + 1);
      // An ordinary page write still has no worktree or disk sink.
      const ordinary = await preparePageAdmission({ engine, remote: false, sourceId: f.sourceId } as OperationContext,
        { operation: 'put_page', params: { slug: 'notes/plain', content: 'A normal note.' } });
      expect(ordinary.admission?.worktreeId).toBeNull();
      expect(ordinary.admission?.authority.databaseOnlyReason).toBe('disabled_by_config');
    } finally { provider = undefined; await engine.setConfig('sync.write_through', 'true'); }
  }
}), 120_000);

test('disk opt-out refuses copying an outside image and still fences canonical bytes changed during provider work', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine); await engine.setConfig('sync.write_through', 'false');
    try {
      const before = embeddingCalls;
      await expect(importManagedFile(engine, f.file, 'outside.png', { sourceId: f.sourceId })).rejects.toThrow('canonical owner');
      expect(embeddingCalls).toBe(before); expect(existsSync(join(f.root, 'outside.png'))).toBe(false);
      const file = join(f.root, 'raced.png'); writeFileSync(file, bytes);
      provider = async () => { writeFileSync(file, Buffer.from('newer canonical bytes')); };
      await expect(importManagedFile(engine, file, 'raced.png', { sourceId: f.sourceId })).rejects.toThrow('file changed');
      expect(await engine.getPage('raced.png', { sourceId: f.sourceId })).toBeNull();
      expect(readFileSync(file).toString()).toBe('newer canonical bytes');
    } finally { provider = undefined; await engine.setConfig('sync.write_through', 'true'); }
  }
}), 120_000);

test('disk opt-out still refuses an owner epoch change during image preparation', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine), file = join(f.root, 'owner-race.png'); writeFileSync(file, bytes);
    await engine.setConfig('sync.write_through', 'false');
    try {
      provider = async () => { await engine.executeRaw('UPDATE persistence_worktrees SET owner_epoch=owner_epoch+1 WHERE id=(SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$1)', [f.sourceId]); };
      await expect(importManagedFile(engine, file, 'owner-race.png', { sourceId: f.sourceId })).rejects.toThrow();
      expect(await engine.getPage('owner-race.png', { sourceId: f.sourceId })).toBeNull();
      expect(readFileSync(file)).toEqual(bytes);
    } finally { provider = undefined; await engine.setConfig('sync.write_through', 'true'); }
  }
}), 120_000);
