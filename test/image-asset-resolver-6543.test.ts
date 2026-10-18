/**
 * #6543 D3: one case-insensitive resolver for recorded image paths, shared by doctor `image_assets` and the #6539
 * `embed --stale --images` sweep. The exact recorded path wins; otherwise a bounded case-insensitive walk finds the
 * file and returns its real-case source-relative path separately from the containment verdict. Two case-fold matches
 * refuse (nothing imported or rewritten); a symlink out of the source root never resolves; one source's root never
 * resolves another source's file.
 *
 * Case-sensitive filesystem only (Linux CI); darwin and win32 skip, since their default filesystems fold case.
 *
 * Regression that fails it: the sweep reporting `IMG_1453.PNG` missing because the slug is lower-case, the managed
 * import recording the lower-case slug as source_path, doctor counting a case-only difference as missing, or a
 * case-fold choice made silently between two files.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveRecordedImageFile } from '../src/core/image-asset-resolver.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { embedStaleImages } from '../src/core/embed-stale-images.ts';
import { importImageFile } from '../src/core/import-file.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

const caseSensitive = process.platform === 'linux';
const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'gbrain-6543-d3-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const env = { GBRAIN_HOME: home, GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBEDDING_IMAGE_OCR: 'false' };
const origFetch = globalThis.fetch;
let engine: PGLiteEngine;

function dir(...parts: string[]): string {
  const path = join(home, ...parts); mkdirSync(path, { recursive: true }); return path;
}

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 120_000);

beforeEach(() => {
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (!String(url).includes('voyageai.com')) return origFetch(url as string, init as RequestInit);
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
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!caseSensitive)('resolveRecordedImageFile', () => {
  test('a lower-case slug finds IMG_1453.PNG and returns the real-case relative path', () => {
    const root = dir(`r-${randomUUID()}`);
    mkdirSync(join(root, 'Media', 'Launches'), { recursive: true });
    writeFileSync(join(root, 'Media', 'Launches', 'IMG_1453.PNG'), PNG);
    expect(resolveRecordedImageFile(root, [null, 'media/launches/img_1453.png'])).toEqual({
      status: 'found', abs: join(root, 'Media', 'Launches', 'IMG_1453.PNG'), relative: 'Media/Launches/IMG_1453.PNG', caseMismatch: true });
  });

  test('the exact recorded path wins over a case variant', () => {
    const root = dir(`r-${randomUUID()}`);
    writeFileSync(join(root, 'a.png'), PNG); writeFileSync(join(root, 'A.PNG'), PNG);
    expect(resolveRecordedImageFile(root, ['A.PNG', 'a.png'])).toMatchObject({ status: 'found', relative: 'A.PNG', caseMismatch: false });
  });

  test('two case-fold matches and no exact one refuse as ambiguous', () => {
    const root = dir(`r-${randomUUID()}`);
    writeFileSync(join(root, 'Shot.png'), PNG); writeFileSync(join(root, 'SHOT.png'), PNG);
    const resolved = resolveRecordedImageFile(root, ['shot.png']);
    expect(resolved.status).toBe('ambiguous');
    expect(resolved.status === 'ambiguous' ? [...resolved.matches].sort() : []).toEqual(['SHOT.png', 'Shot.png']);
  });

  test('a symlink out of the source root never resolves, exactly or case-insensitively', () => {
    const outside = dir(`outside-${randomUUID()}`);
    writeFileSync(join(outside, 'Secret.png'), PNG);
    const root = dir(`r-${randomUUID()}`);
    symlinkSync(outside, join(root, 'Linked'));
    expect(resolveRecordedImageFile(root, ['Linked/Secret.png']).status).toBe('outside_root');
    expect(resolveRecordedImageFile(root, ['linked/secret.png']).status).toBe('outside_root');
    expect(resolveRecordedImageFile(root, ['../' + outside.split('/').at(-1) + '/Secret.png']).status).toBe('missing');
  });

  test('one source root never resolves another source\'s file', () => {
    const a = dir(`a-${randomUUID()}`), b = dir(`b-${randomUUID()}`);
    writeFileSync(join(b, 'Only-B.png'), PNG);
    expect(resolveRecordedImageFile(a, ['only-b.png']).status).toBe('missing');
    expect(resolveRecordedImageFile(b, ['only-b.png'])).toMatchObject({ status: 'found', relative: 'Only-B.png' });
  });
});

async function managedSource(files: Record<string, Buffer>, legacyImages: string[]) {
  const sourceId = `d${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const root = dir(sourceId);
  execFileSync('git', ['-C', root, 'init', '-q']);
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); }
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'initial']);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [sourceId, root]);
  for (const path of legacyImages) expect((await importImageFile(engine, join(root, path), path, { sourceId, noEmbed: true })).status).toBe('imported');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { sourceId, root };
}

describe.skipIf(!caseSensitive)('#6543 D3 managed sweep and doctor share the resolver', () => {
  test('the sweep finds a case-mismatched image by slug, imports it under the real case and records that source_path; doctor counts it present', async () => withEnv(env, async () => {
    const { sourceId } = await managedSource({ 'Media/Launches/IMG_1453.PNG': PNG }, ['Media/Launches/IMG_1453.PNG']);
    await engine.executeRaw('UPDATE pages SET source_path=NULL WHERE source_id=$1', [sourceId]);
    await engine.executeRaw('UPDATE files SET storage_path=lower(storage_path) WHERE source_id=$1', [sourceId]);
    const swept = await embedStaleImages(engine, { sourceId, dryRun: false });
    expect(swept).toMatchObject({ candidates: 1, rebuilt: 1, missingFile: 0, failures: 0 });
    const [page] = await engine.executeRaw<{ slug: string; source_path: string | null }>('SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [sourceId]);
    expect(page).toEqual({ slug: 'media/launches/img_1453.png', source_path: 'Media/Launches/IMG_1453.PNG' });
    const check = (await buildChecks(engine, [])).find(c => c.name === 'image_assets')!;
    expect(check.message).not.toMatch(/missing from disk/);
    expect(check.message).not.toContain('--skip-failed');
  }), 120_000);

  test('two case-fold candidates refuse: nothing imported, source_path stays unrecorded, doctor names the ambiguity', async () => withEnv(env, async () => {
    const { sourceId } = await managedSource({ 'Media/Shot.png': PNG, 'Media/SHOT.png': Buffer.concat([PNG, Buffer.from([0])]) }, ['Media/Shot.png']);
    await engine.executeRaw('UPDATE pages SET source_path=NULL WHERE source_id=$1', [sourceId]);
    await engine.executeRaw('UPDATE files SET storage_path=lower(storage_path) WHERE source_id=$1', [sourceId]);
    const swept = await embedStaleImages(engine, { sourceId, dryRun: false });
    expect(swept).toMatchObject({ candidates: 1, rebuilt: 0, failures: 1 });
    expect(swept.failure_samples[0]).toContain('ambiguous');
    const [page] = await engine.executeRaw<{ source_path: string | null }>('SELECT source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [sourceId]);
    expect(page.source_path).toBeNull();
    const check = (await buildChecks(engine, [])).find(c => c.name === 'image_assets')!;
    expect(check.status).toBe('warn');
    expect(check.message).toContain('ambiguous');
    expect(check.message).not.toContain('--skip-failed');
  }), 120_000);
});
