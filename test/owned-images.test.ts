/**
 * Native page-image contract: official files-backend persistence, source/page
 * isolation, native MCP pixels, and a narrowly bounded legacy read fallback.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent, importImageFile } from '../src/core/import-file.ts';
import { operations } from '../src/core/operations.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import { hasScope } from '../src/core/scope.ts';
import { STARTER_OPS } from '../src/mcp/surface.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { DispatchOpts } from '../src/mcp/dispatch.ts';
import { _resetImageWriteLimiterForTests } from '../src/core/ops/image.ts';
import {
  commitPageImage,
  drainPageImageGcItem,
  listPageImageGcQueue,
  queuePageImageGc,
  queuePageImageUploadIntent,
} from '../src/core/page-image-storage.ts';
import { LocalStorage } from '../src/core/storage/local.ts';
import { pageImageStorageIdentity } from '../src/core/storage.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const PAGE = 'produit/espace-client/references-visuelles';
const PAGE_PATH = `${PAGE}.md`;
const LEGACY_REF = '../../media/legacy.png';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2xQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');
const PNG_2_BYTES = Buffer.from(PNG_BYTES);
PNG_2_BYTES[PNG_2_BYTES.length - 1] = PNG_2_BYTES[PNG_2_BYTES.length - 1]! ^ 1;
const GIF_BYTES = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

let engine: PGLiteEngine;
let root: string;
let sourceRoot: string;
let otherRoot: string;
let storageRoot: string;
let configHome: string;
let noStorageHome: string;

const AUTH: AuthInfo = {
  token: 'redacted-test-token',
  clientId: 'katezo-agent',
  scopes: ['read', 'write'],
  sourceId: 'katezo',
  allowedSources: ['katezo'],
};
const DISPATCH: DispatchOpts = {
  remote: true,
  transport: 'stdio' as const,
  sourceId: 'katezo',
  auth: AUTH,
};
const TRUSTED_LOCAL: DispatchOpts = {
  remote: false,
  transport: 'stdio' as const,
  sourceId: 'katezo',
};

function textJson(result: Awaited<ReturnType<typeof dispatchToolCall>>): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected metadata text block first');
  return JSON.parse(first.text) as Record<string, unknown>;
}

function call(
  name: string,
  args: Record<string, unknown>,
  opts = DISPATCH,
  home = configHome,
) {
  return withEnv({ GBRAIN_HOME: home }, () => dispatchToolCall(engine, name, args, opts));
}

async function seedSource(id: string, localPath: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ($1, $1, $2, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [id, localPath],
  );
}

async function seedPage(
  sourceId: string,
  localPath: string,
  slug = PAGE,
  body = `# Références visuelles\n\n![Legacy](${LEGACY_REF})\n`,
  visibility: 'world' | 'private' = 'world',
): Promise<void> {
  const sourcePath = `${slug}.md`;
  const content = `---\ntitle: Références visuelles\ntype: note\nvisibility: ${visibility}\n---\n\n${body}`;
  await importFromContent(engine, slug, content, { noEmbed: true, sourceId, sourcePath });
  const pageFile = join(localPath, sourcePath);
  mkdirSync(dirname(pageFile), { recursive: true });
  writeFileSync(pageFile, content);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  root = mkdtempSync(join(tmpdir(), 'gbrain-owned-images-'));
  sourceRoot = join(root, 'katezo');
  otherRoot = join(root, 'other');
  storageRoot = join(root, 'storage');
  configHome = join(root, 'home');
  noStorageHome = join(root, 'home-no-storage');
  for (const dir of [sourceRoot, otherRoot, storageRoot, join(configHome, '.gbrain'), join(noStorageHome, '.gbrain')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(configHome, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    mcp: { publish_images: true },
    storage: { backend: 'local', bucket: 'test', namespace: 'owned-images-test', localPath: storageRoot },
  }));
  writeFileSync(join(noStorageHome, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    mcp: { publish_images: true },
  }));
  await seedSource('katezo', sourceRoot);
  await seedSource('other', otherRoot);
  await seedPage('katezo', sourceRoot);
  await seedPage('other', otherRoot);
  _resetImageWriteLimiterForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('put_image through the official files backend', () => {
  test('stores immutable bytes + a files row and retries idempotently without writing into the source repo', async () => {
    const args = {
      page_slug: PAGE,
      filename: 'desktop.png',
      content_base64: PNG_BASE64,
      mime_type: 'image/png',
      alt_text: 'Fiche de traitement',
    };
    const first = await call('put_image', args);
    expect(first.isError).toBeUndefined();
    expect(first.content).toHaveLength(1);
    const meta = textJson(first);
    expect(meta.status).toBe('created');
    expect(meta.storage_path).toMatch(/^images\/v1\/owned-images-test\/katezo\/\d+\/produit\/espace-client\/references-visuelles\/[a-f0-9]{64}\/desktop\.png$/);
    expect(meta.image_ref).toBe(meta.storage_path);
    expect(meta.alt_text).toBe('Fiche de traitement');
    expect(meta.mime_type).toBe('image/png');
    expect(meta.size_bytes).toBe(PNG_BYTES.length);
    expect((first.content[0] as { text: string }).text).not.toContain(PNG_BASE64);

    const storagePath = meta.storage_path as string;
    expect(existsSync(join(storageRoot, storagePath))).toBe(true);
    expect(existsSync(join(sourceRoot, 'media'))).toBe(false);
    const row = await engine.getFile('katezo', storagePath);
    expect(row).toEqual(expect.objectContaining({
      source_id: 'katezo', page_slug: PAGE, filename: 'desktop.png', mime_type: 'image/png',
    }));
    expect(row?.page_id).toBe((await engine.getPage(PAGE, { sourceId: 'katezo' }))?.id);
    expect(row?.metadata).toEqual(expect.objectContaining({ storage: 'backend', kind: 'page_image' }));

    const second = await call('put_image', args);
    expect(textJson(second).status).toBe('unchanged');
    expect(textJson(second).storage_path).toBe(storagePath);
  });

  test('updates by creating a new content-addressed object without deleting the previous version', async () => {
    const base = { page_slug: PAGE, filename: 'diagram.png', mime_type: 'image/png' };
    const first = await call('put_image', { ...base, content_base64: PNG_BASE64 });
    const firstPath = textJson(first).storage_path as string;
    const second = await call('put_image', { ...base, content_base64: PNG_2_BYTES.toString('base64') });
    const secondMeta = textJson(second);
    const secondPath = secondMeta.storage_path as string;
    expect(secondMeta.status).toBe('updated');
    expect(secondPath).not.toBe(firstPath);
    expect(existsSync(join(storageRoot, firstPath))).toBe(true);
    expect(existsSync(join(storageRoot, secondPath))).toBe(true);
    const page = await engine.getPage(PAGE, { sourceId: 'katezo' });
    expect(await engine.listFilesForPage(page!.id)).toHaveLength(2);

    const getPage = await call('get_page', { slug: PAGE });
    const images = textJson(getPage).images as Array<Record<string, unknown>>;
    expect(images).toEqual([expect.objectContaining({
      filename: 'diagram.png',
      image_ref: secondPath,
      version_count: 2,
    })]);
  });

  test('moves the explicit head correctly across A -> B -> A without duplicating A', async () => {
    const base = { page_slug: PAGE, filename: 'head.png', mime_type: 'image/png' };
    const first = await call('put_image', { ...base, content_base64: PNG_BASE64 });
    const firstPath = textJson(first).storage_path as string;
    const second = await call('put_image', { ...base, content_base64: PNG_2_BYTES.toString('base64') });
    const secondPath = textJson(second).storage_path as string;
    const third = await call('put_image', { ...base, content_base64: PNG_BASE64 });
    expect(textJson(third)).toEqual(expect.objectContaining({
      status: 'updated',
      storage_path: firstPath,
      previous_image_ref: secondPath,
      version: 2,
    }));

    const page = await engine.getPage(PAGE, { sourceId: 'katezo' });
    expect(await engine.listFilesForPage(page!.id)).toHaveLength(2);
    const getPage = await call('get_page', { slug: PAGE });
    expect(textJson(getPage).images).toEqual([expect.objectContaining({
      filename: 'head.png', image_ref: firstPath, version_count: 2,
    })]);
  });

  test('repairs a missing or corrupt exact object instead of reporting a false unchanged result', async () => {
    const args = {
      page_slug: PAGE, filename: 'repair.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    };
    const first = await call('put_image', args);
    const imageRef = textJson(first).storage_path as string;
    writeFileSync(join(storageRoot, imageRef), PNG_2_BYTES);

    const repaired = await call('put_image', args);
    expect(textJson(repaired).status).toBe('updated');
    const read = await call('get_image', { page_slug: PAGE, image_ref: imageRef });
    expect(read.content[1] as unknown).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
  });

  test('serializes concurrent quota decisions so only one new image is retained', async () => {
    await engine.setConfig('mcp.image_max_page_files', '1');
    const [a, b] = await Promise.all([
      call('put_image', {
        page_slug: PAGE, filename: 'concurrent-a.png', content_base64: PNG_BASE64, mime_type: 'image/png',
      }),
      call('put_image', {
        page_slug: PAGE, filename: 'concurrent-b.png', content_base64: PNG_BASE64, mime_type: 'image/png',
      }),
    ]);
    const results = [textJson(a), textJson(b)];
    expect(results.filter(result => result.status === 'created')).toHaveLength(1);
    expect(results.filter(result => result.error === 'storage_error')).toHaveLength(1);
    const rows = await engine.executeRaw<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM files WHERE source_id = 'katezo' AND metadata->>'kind' = 'page_image'`,
    );
    expect(Number(rows[0]?.count)).toBe(1);
    const storedObjects = readdirSync(join(storageRoot, 'images'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile());
    expect(storedObjects).toHaveLength(1);
  });

  test('collapses simultaneous identical writes onto one version and reports one no-op', async () => {
    const args = {
      page_slug: PAGE, filename: 'concurrent-same.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    };
    const [a, b] = await Promise.all([call('put_image', args), call('put_image', args)]);
    const statuses = [textJson(a).status, textJson(b).status].sort();
    expect(statuses).toEqual(['created', 'unchanged']);
    const page = await engine.getPage(PAGE, { sourceId: 'katezo' });
    expect(await engine.listFilesForPage(page!.id)).toHaveLength(1);
  });

  test('enforces owner opt-in, finite quotas, and per-client write rate without charging idempotent retries', async () => {
    await engine.setConfig('mcp.publish_images', 'false');
    const gated = await call('put_image', {
      page_slug: PAGE, filename: 'gate.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    expect(textJson(gated).error).toBe('permission_denied');

    await engine.setConfig('mcp.publish_images', 'true');
    await engine.setConfig('mcp.image_max_versions_per_filename', '1');
    const first = await call('put_image', {
      page_slug: PAGE, filename: 'quota.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    expect(textJson(first).status).toBe('created');
    const versionQuota = await call('put_image', {
      page_slug: PAGE, filename: 'quota.png', content_base64: PNG_2_BYTES.toString('base64'), mime_type: 'image/png',
    });
    expect(textJson(versionQuota).error).toBe('storage_error');

    _resetImageWriteLimiterForTests(1);
    const idempotent = await call('put_image', {
      page_slug: PAGE, filename: 'quota.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    expect(textJson(idempotent).status).toBe('unchanged');
    const allowed = await call('put_image', {
      page_slug: PAGE, filename: 'rate-one.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    expect(textJson(allowed).status).toBe('created');
    const limited = await call('put_image', {
      page_slug: PAGE, filename: 'rate-two.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    expect(textJson(limited).error).toBe('rate_limited');
  });

  test('fails closed without a configured storage backend and never inserts a phantom row', async () => {
    const result = await call('put_image', {
      page_slug: PAGE, filename: 'no-store.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    }, DISPATCH, noStorageHome);
    expect(textJson(result).error).toBe('storage_error');
    expect(await engine.executeRaw(`SELECT id FROM files WHERE filename = 'no-store.png'`)).toHaveLength(0);
  });

  test('validates bytes, MIME, page ownership, source grants, and slug fences before mutation', async () => {
    const malformed = await call('put_image', {
      page_slug: PAGE, filename: 'x.png', content_base64: '%%%=', mime_type: 'image/png',
    });
    expect(textJson(malformed).error).toBe('invalid_params');

    const mismatch = await call('put_image', {
      page_slug: PAGE, filename: 'x.jpg', content_base64: PNG_BASE64, mime_type: 'image/jpeg',
    });
    expect(textJson(mismatch).error).toBe('invalid_params');

    const missing = await call('put_image', {
      page_slug: 'produit/inexistant', filename: 'x.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    expect(textJson(missing).error).toBe('page_not_found');

    const crossSource = await call('put_image', {
      source_id: 'other', page_slug: PAGE, filename: 'x.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    expect(textJson(crossSource).error).toBe('permission_denied');

    const fenced = await call('put_image', {
      page_slug: PAGE, filename: 'x.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    }, { ...DISPATCH, auth: { ...AUTH, boundSlugPrefixes: ['wiki/agents/alice/'] } });
    expect(textJson(fenced).error).toBe('permission_denied');

    const operation = operations.find(candidate => candidate.name === 'put_image');
    expect(operation?.scope).toBe('write');
    expect(hasScope(['read'], operation?.scope ?? 'read')).toBe(false);
    expect(STARTER_OPS.has('put_image')).toBe(false);
    expect(STARTER_OPS.has('get_image')).toBe(false);
  });

  test('dry_run reports the immutable target without touching storage or files metadata', async () => {
    const result = await call('put_image', {
      page_slug: PAGE,
      filename: 'dry.png',
      content_base64: PNG_BASE64,
      mime_type: 'image/png',
      dry_run: true,
    }, DISPATCH, configHome);
    expect(textJson(result).status).toBe('dry_run');
    expect(await engine.executeRaw(`SELECT id FROM files WHERE filename = 'dry.png'`)).toHaveLength(0);
    expect(existsSync(join(storageRoot, 'images'))).toBe(false);
  });

  test('releases live quota after page deletion and prunes the detached object through the durable queue', async () => {
    await engine.setConfig('mcp.image_max_source_files', '1');
    const old = await call('put_image', {
      page_slug: PAGE, filename: 'detached.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const oldRef = textJson(old).storage_path as string;
    await engine.executeRaw(`UPDATE files SET created_at = now() - interval '60 days' WHERE storage_path = $1`, [oldRef]);
    await engine.deletePage(PAGE, { sourceId: 'katezo' });
    await seedPage('katezo', sourceRoot);

    const replacement = await call('put_image', {
      page_slug: PAGE, filename: 'replacement.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    expect(textJson(replacement).status).toBe('created');

    const preview = await call('prune_page_images', { retention_days: 30, dry_run: true }, TRUSTED_LOCAL);
    expect(textJson(preview)).toEqual(expect.objectContaining({ status: 'dry_run', candidate_count: 1 }));
    expect(existsSync(join(storageRoot, oldRef))).toBe(true);

    const pruned = await call('prune_page_images', { retention_days: 30 }, TRUSTED_LOCAL);
    expect(textJson(pruned)).toEqual(expect.objectContaining({
      status: 'complete', scheduled_count: 1, deleted_count: 1, failed_count: 0,
    }));
    expect(existsSync(join(storageRoot, oldRef))).toBe(false);
    expect(await engine.getFile('katezo', oldRef)).toBeNull();
    expect(await engine.executeRaw(`SELECT storage_path FROM page_image_gc_queue`)).toHaveLength(0);
  });

  test('preserves backend object references in the GC queue across a source cascade', async () => {
    const put = await call('put_image', {
      page_slug: PAGE, filename: 'source-cascade.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const imageRef = textJson(put).storage_path as string;
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'katezo'`);

    expect(await engine.getFile('katezo', imageRef)).toBeNull();
    expect(await engine.executeRaw(`SELECT storage_path, source_id, reason FROM page_image_gc_queue`)).toEqual([{
      storage_path: imageRef, source_id: 'katezo', reason: 'files_row_deleted',
    }]);
    expect(existsSync(join(storageRoot, imageRef))).toBe(true);
  });

  test('GC revalidates a queued path and never deletes bytes referenced by a live file', async () => {
    const put = await call('put_image', {
      page_slug: PAGE, filename: 'gc-race.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const imageRef = textJson(put).storage_path as string;
    const [file] = await engine.executeRaw<{ storage_identity: string }>(
      `SELECT metadata->>'storage_identity' AS storage_identity FROM files WHERE storage_path = $1`,
      [imageRef],
    );
    await engine.executeRaw(
      `INSERT INTO page_image_gc_queue
         (storage_path, storage_identity, source_id, reason)
       VALUES ($1, $2, 'katezo', 'upload_pending')`,
      [imageRef, file!.storage_identity],
    );

    const result = await call('prune_page_images', { retention_days: 30 }, TRUSTED_LOCAL);
    expect(textJson(result)).toEqual(expect.objectContaining({
      status: 'complete', deleted_count: 0, retained_count: 1, failed_count: 0,
    }));
    expect(existsSync(join(storageRoot, imageRef))).toBe(true);
    expect(await engine.executeRaw(`SELECT storage_path FROM page_image_gc_queue`)).toHaveLength(0);
  });

  test('a retry consumes a durable upload intent before GC can remove the committed object', async () => {
    const first = await call('put_image', {
      page_slug: PAGE, filename: 'retry-intent.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const imageRef = textJson(first).storage_path as string;
    const [file] = await engine.executeRaw<{ storage_identity: string }>(
      `SELECT metadata->>'storage_identity' AS storage_identity FROM files WHERE storage_path = $1`,
      [imageRef],
    );
    await engine.executeRaw(
      `INSERT INTO page_image_gc_queue
         (storage_path, storage_identity, source_id, reason)
       VALUES ($1, $2, 'katezo', 'upload_pending')`,
      [imageRef, file!.storage_identity],
    );

    const [pending] = await listPageImageGcQueue(engine, 10, 'katezo');
    expect(pending).toBeDefined();
    expect(await drainPageImageGcItem(
      engine, new LocalStorage(storageRoot), pending!, file!.storage_identity,
    )).toBe('retained');
    expect(await engine.executeRaw(
      `SELECT storage_path FROM page_image_gc_queue WHERE storage_path = $1`, [imageRef],
    )).toHaveLength(0);

    const retry = await call('put_image', {
      page_slug: PAGE, filename: 'retry-intent.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    expect(textJson(retry).status).toBe('unchanged');
    expect(await engine.executeRaw(`SELECT storage_path FROM page_image_gc_queue`)).toHaveLength(0);
    expect(existsSync(join(storageRoot, imageRef))).toBe(true);
  });

  test('keeps a failed upload discoverable until explicit aged-intent recovery', async () => {
    const page = await engine.getPage(PAGE, { sourceId: 'katezo' });
    const storage = new LocalStorage(storageRoot);
    const storageIdentity = pageImageStorageIdentity({
      backend: 'local', bucket: 'test', namespace: 'owned-images-test', localPath: storageRoot,
    }, 'owned-images-test', storage);
    const storagePath = 'images/v1/owned-images-test/katezo/abandoned.png';
    const spec = {
      source_id: 'katezo', page_slug: PAGE, page_id: page!.id,
      filename: 'abandoned.png', storage_path: storagePath,
      mime_type: 'image/png', size_bytes: PNG_BYTES.length, content_hash: 'abandoned',
      metadata: { storage: 'backend', kind: 'page_image', storage_identity: storageIdentity },
    };
    const quotas = {
      sourceBytes: 1_000_000, sourceFiles: 100, pageBytes: 1_000_000,
      pageFiles: 100, versionsPerFilename: 20,
    };

    await queuePageImageGc(engine, storagePath, storageIdentity, 'katezo', 'upload_pending');
    const [fresh] = await listPageImageGcQueue(engine, 10, 'katezo');
    expect(await drainPageImageGcItem(engine, storage, fresh!, storageIdentity)).toBe('deferred');

    await expect(commitPageImage(engine, spec, quotas, async () => {
      await storage.upload(storagePath, PNG_BYTES, 'image/png');
      throw new Error('simulated failure after backend I/O');
    })).rejects.toThrow('simulated failure');
    expect(await storage.exists(storagePath)).toBe(true);
    expect(await engine.getFile('katezo', storagePath)).toBeNull();
    expect(await engine.executeRaw(
      `SELECT storage_path FROM page_image_gc_queue WHERE storage_path = $1`, [storagePath],
    )).toHaveLength(1);

    await engine.executeRaw(
      `UPDATE page_image_gc_queue SET queued_at = now() - interval '60 minutes'
       WHERE storage_path = $1`,
      [storagePath],
    );
    const [abandoned] = await listPageImageGcQueue(engine, 10, 'katezo');
    const recoveryCutoff = new Date(Date.now() - 15 * 60 * 1000);
    expect(await drainPageImageGcItem(
      engine, storage, abandoned!, storageIdentity, recoveryCutoff,
    )).toBe('deleted');
    expect(await storage.exists(storagePath)).toBe(false);
    expect(await engine.executeRaw(
      `SELECT storage_path FROM page_image_gc_queue WHERE storage_path = $1`, [storagePath],
    )).toHaveLength(0);
    expect(await engine.executeRaw(`SELECT 1 AS ok`)).toEqual([{ ok: 1 }]);
  });

  test('atomically anchors the first upload intent and rejects a competing backend without poisoning retries', async () => {
    const pathA = 'images/v1/owned-images-test/katezo/first-a.png';
    const pathB = 'images/v1/owned-images-test/katezo/first-b.png';
    const identityA = 'v3:first-storage-a';
    const identityB = 'v3:first-storage-b';

    const attempts = await Promise.allSettled([
      queuePageImageUploadIntent(engine, pathA, identityA, 'katezo'),
      queuePageImageUploadIntent(engine, pathB, identityB, 'katezo'),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);

    const anchored = await engine.getConfig('page_images.storage_identity');
    if (!anchored) throw new Error('storage identity was not anchored');
    expect([identityA, identityB]).toContain(anchored);
    const queue = await listPageImageGcQueue(engine, 10, 'katezo');
    expect(queue).toHaveLength(1);
    expect(queue[0]?.storage_identity).toBe(anchored);

    const winnerPath = anchored === identityA ? pathA : pathB;
    await queuePageImageUploadIntent(engine, winnerPath, anchored, 'katezo');
    expect(await listPageImageGcQueue(engine, 10, 'katezo')).toHaveLength(1);
  });

  test('a global path collision preserves foreign bytes and a clean retry consumes the intent', async () => {
    const page = await engine.getPage(PAGE, { sourceId: 'katezo' });
    const otherPage = await engine.getPage(PAGE, { sourceId: 'other' });
    const storagePath = 'images/v1/owned-images-test/katezo/failure-after-upload.png';
    const storageIdentity = 'test-storage-identity';
    const storage = new LocalStorage(storageRoot);
    await storage.upload(storagePath, PNG_2_BYTES, 'image/png');
    await engine.upsertFile({
      source_id: 'other', page_slug: PAGE, page_id: otherPage!.id,
      filename: 'collision.png', storage_path: storagePath,
      mime_type: 'image/png', size_bytes: PNG_BYTES.length,
      content_hash: 'foreign', metadata: { storage: 'git' },
    });
    await queuePageImageGc(engine, storagePath, storageIdentity, 'katezo', 'upload_pending');
    const spec = {
      source_id: 'katezo', page_slug: PAGE, page_id: page!.id,
      filename: 'failure-after-upload.png', storage_path: storagePath,
      mime_type: 'image/png', size_bytes: PNG_BYTES.length,
      content_hash: 'owned',
      metadata: { storage: 'backend', kind: 'page_image', storage_identity: storageIdentity },
    };
    const quotas = {
      sourceBytes: 1_000_000, sourceFiles: 100, pageBytes: 1_000_000,
      pageFiles: 100, versionsPerFilename: 20,
    };

    await expect(commitPageImage(
      engine, spec, quotas, () => storage.upload(storagePath, PNG_BYTES, 'image/png'),
    )).rejects.toThrow('storage_path collision');
    expect(existsSync(join(storageRoot, storagePath))).toBe(true);
    expect(readFileSync(join(storageRoot, storagePath))).toEqual(PNG_2_BYTES);
    expect(await engine.executeRaw(`SELECT storage_path FROM page_image_gc_queue WHERE storage_path = $1`, [storagePath])).toHaveLength(1);

    await engine.executeRaw(`DELETE FROM files WHERE source_id = 'other' AND storage_path = $1`, [storagePath]);
    await commitPageImage(
      engine, spec, quotas, () => storage.upload(storagePath, PNG_BYTES, 'image/png'),
    );
    expect(await engine.executeRaw(`SELECT storage_path FROM page_image_gc_queue WHERE storage_path = $1`, [storagePath])).toHaveLength(0);
    expect(await engine.getFile('katezo', storagePath)).not.toBeNull();
    expect(readFileSync(join(storageRoot, storagePath))).toEqual(PNG_BYTES);
  });

  test('anchors the complete storage identity and rejects locator drift before writing bytes', async () => {
    const storageAlias = join(root, 'active-storage');
    symlinkSync(storageRoot, storageAlias);
    writeFileSync(join(configHome, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite',
      mcp: { publish_images: true },
      storage: {
        backend: 'local', bucket: 'test', namespace: 'owned-images-test', localPath: storageAlias,
      },
    }));
    const args = {
      page_slug: PAGE, filename: 'identity.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    };
    const first = await call('put_image', args);
    const imageRef = textJson(first).image_ref as string;
    const original = readFileSync(join(storageRoot, imageRef));
    const otherStorageRoot = join(root, 'different-storage');
    mkdirSync(otherStorageRoot, { recursive: true });
    unlinkSync(storageAlias);
    symlinkSync(otherStorageRoot, storageAlias);
    const foreignPath = join(otherStorageRoot, imageRef);
    mkdirSync(dirname(foreignPath), { recursive: true });
    writeFileSync(foreignPath, PNG_2_BYTES);

    const retry = await call('put_image', args);
    expect(retry.isError).toBe(true);
    expect(textJson(retry)).toEqual(expect.objectContaining({
      error: 'storage_error',
      message: expect.stringContaining('immutable storage identity'),
    }));
    const read = await call('get_image', { page_slug: PAGE, image_ref: imageRef });
    expect(read.isError).toBe(true);
    expect(textJson(read).error).toBe('storage_error');
    const gc = await call('prune_page_images', { retention_days: 30 }, TRUSTED_LOCAL);
    expect(gc.isError).toBe(true);
    expect(textJson(gc).error).toBe('storage_error');
    expect(readFileSync(foreignPath)).toEqual(PNG_2_BYTES);
    expect(readFileSync(join(storageRoot, imageRef))).toEqual(original);
    expect(await engine.executeRaw(
      `SELECT storage_path FROM page_image_gc_queue WHERE storage_path = $1`, [imageRef],
    )).toHaveLength(0);
  });

  test('does not expose backend error details in the MCP response', async () => {
    const outside = join(root, 'outside-storage');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(storageRoot, 'images'));

    const result = await call('put_image', {
      page_slug: PAGE, filename: 'redacted.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const envelope = textJson(result);
    expect(result.isError).toBe(true);
    expect(envelope).toEqual({ error: 'storage_error', message: 'Image storage upload failed.' });
    expect(JSON.stringify(envelope)).not.toContain('ancestor symlink');
    expect(JSON.stringify(envelope)).not.toContain(storageRoot);
  });
});

describe('get_image native MCP response', () => {
  test('downloads an owned files row and returns metadata first plus native pixels', async () => {
    const put = await call('put_image', {
      page_slug: PAGE, filename: 'native.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const imageRef = textJson(put).image_ref as string;
    const result = await call('get_image', { page_slug: PAGE, image_ref: imageRef });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[1] as unknown).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
    const meta = textJson(result);
    expect(meta.storage).toBe('backend');
    expect(meta.storage_path).toBe(imageRef);
    expect((result.content[0] as { text: string }).text).not.toContain(PNG_BASE64);
  });

  test('refuses a file row owned by another page, a private page, missing bytes, and hash drift', async () => {
    await seedPage('katezo', sourceRoot, 'produit/autre-page', '# Autre page\n');
    const otherPut = await call('put_image', {
      page_slug: 'produit/autre-page', filename: 'other.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const otherRef = textJson(otherPut).image_ref as string;
    const crossPage = await call('get_image', { page_slug: PAGE, image_ref: otherRef });
    expect(textJson(crossPage).error).toBe('not_found');

    await seedPage('katezo', sourceRoot, 'produit/private', '# Private\n', 'private');
    const privatePut = await call('put_image', {
      page_slug: 'produit/private', filename: 'private.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const privateRead = await call('get_image', {
      page_slug: 'produit/private', image_ref: textJson(privatePut).image_ref,
    });
    expect(textJson(privateRead).error).toBe('page_not_found');

    const put = await call('put_image', {
      page_slug: PAGE, filename: 'integrity.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const ref = textJson(put).image_ref as string;
    unlinkSync(join(storageRoot, ref));
    const missing = await call('get_image', { page_slug: PAGE, image_ref: ref });
    expect(textJson(missing).error).toBe('not_found');

    writeFileSync(join(storageRoot, ref), PNG_2_BYTES);
    const drift = await call('get_image', { page_slug: PAGE, image_ref: ref });
    expect(textJson(drift).error).toBe('storage_error');
  });

  test('does not resurrect an attachment when a deleted page slug is recreated', async () => {
    const put = await call('put_image', {
      page_slug: PAGE, filename: 'old.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const oldRef = textJson(put).image_ref as string;
    await engine.deletePage(PAGE, { sourceId: 'katezo' });
    await seedPage('katezo', sourceRoot);

    const result = await call('get_image', { page_slug: PAGE, image_ref: oldRef });
    expect(textJson(result).error).toBe('not_found');
  });

  test('reads a genuinely imported git-backed image without requiring the binary backend', async () => {
    const gitPath = 'assets/git-image.png';
    mkdirSync(join(sourceRoot, 'assets'), { recursive: true });
    writeFileSync(join(sourceRoot, gitPath), PNG_BYTES);
    const imported = await importImageFile(engine, join(sourceRoot, gitPath), gitPath, {
      noEmbed: true, sourceId: 'katezo',
    });
    expect(imported.status).toBe('imported');
    const [file] = await engine.executeRaw<{ storage_path: string }>(
      `SELECT storage_path FROM files WHERE source_id = 'katezo' AND metadata->>'git_path' = $1`,
      [gitPath],
    );
    expect(file?.storage_path).toBe(`git/katezo/${gitPath}`);
    const result = await call(
      'get_image', { page_slug: gitPath, image_ref: file!.storage_path }, DISPATCH, noStorageHome,
    );
    expect(result.content[1] as unknown).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
    expect(textJson(result).storage).toBe('git');
  });

  test('resolves imported image bytes from a managed .sources/<id> source root', async () => {
    const managedRepo = join(root, 'managed-repo');
    const managedSource = join(managedRepo, '.sources', 'managed');
    const relativePath = 'assets/managed.png';
    mkdirSync(join(managedSource, 'assets'), { recursive: true });
    writeFileSync(join(managedSource, relativePath), PNG_BYTES);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('managed', 'managed', NULL, '{}'::jsonb)`,
    );
    await engine.setConfig('sync.repo_path', managedRepo);
    const imported = await importImageFile(engine, join(managedSource, relativePath), relativePath, {
      noEmbed: true, sourceId: 'managed',
    });
    expect(imported.status).toBe('imported');

    const managedAuth: AuthInfo = {
      ...AUTH, sourceId: 'managed', allowedSources: ['managed'],
    };
    const [file] = await engine.executeRaw<{ storage_path: string }>(
      `SELECT storage_path FROM files WHERE source_id = 'managed' AND metadata->>'git_path' = $1`,
      [relativePath],
    );
    const result = await call('get_image', {
      source_id: 'managed', page_slug: relativePath, image_ref: file!.storage_path,
    }, { ...DISPATCH, sourceId: 'managed', auth: managedAuth }, noStorageHome);
    expect(result.content[1] as unknown).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
  });

  test('isolates identical Git paths across sources and repairs unchanged metadata', async () => {
    const gitPath = 'assets/logo.png';
    mkdirSync(join(sourceRoot, 'assets'), { recursive: true });
    mkdirSync(join(otherRoot, 'assets'), { recursive: true });
    writeFileSync(join(sourceRoot, gitPath), PNG_BYTES);
    writeFileSync(join(otherRoot, gitPath), PNG_BYTES);

    expect((await importImageFile(engine, join(sourceRoot, gitPath), gitPath, {
      noEmbed: true, sourceId: 'katezo',
    })).status).toBe('imported');
    expect((await importImageFile(engine, join(otherRoot, gitPath), gitPath, {
      noEmbed: true, sourceId: 'other',
    })).status).toBe('imported');

    const rows = await engine.executeRaw<{ source_id: string; storage_path: string; page_id: number }>(
      `SELECT source_id, storage_path, page_id FROM files
       WHERE metadata->>'git_path' = $1 ORDER BY source_id`,
      [gitPath],
    );
    expect(rows).toEqual([
      expect.objectContaining({ source_id: 'katezo', storage_path: `git/katezo/${gitPath}` }),
      expect.objectContaining({ source_id: 'other', storage_path: `git/other/${gitPath}` }),
    ]);

    await engine.executeRaw(
      `DELETE FROM page_image_heads WHERE source_id = 'katezo' AND filename = 'logo.png'`,
    );
    expect((await importImageFile(engine, join(sourceRoot, gitPath), gitPath, {
      noEmbed: true, sourceId: 'katezo',
    })).status).toBe('skipped');
    const repaired = await engine.executeRaw(
      `SELECT h.file_id FROM page_image_heads h JOIN files f ON f.id = h.file_id
       WHERE h.source_id = 'katezo' AND f.storage_path = $1`,
      [`git/katezo/${gitPath}`],
    );
    expect(repaired).toHaveLength(1);
  });

  test('imports GIF, HEIC, AVIF, and >8 MiB images for search without advertising an unreadable MCP head', async () => {
    const cases: Array<{ name: string; bytes: Buffer }> = [
      { name: 'search-only.gif', bytes: GIF_BYTES },
      { name: 'search-only.heic', bytes: readFileSync('test/fixtures/images/tiny.heic') },
      { name: 'search-only.avif', bytes: readFileSync('test/fixtures/images/tiny.avif') },
      { name: 'search-only-large.png', bytes: Buffer.concat([PNG_BYTES, Buffer.alloc(8 * 1024 * 1024)]) },
    ];
    mkdirSync(join(sourceRoot, 'assets'), { recursive: true });
    for (const item of cases) {
      const relativePath = `assets/${item.name}`;
      const absolutePath = join(sourceRoot, relativePath);
      writeFileSync(absolutePath, item.bytes);
      const result = await importImageFile(engine, absolutePath, relativePath, {
        noEmbed: true, sourceId: 'katezo',
      });
      expect(result.status).toBe('imported');
    }

    const heads = await engine.executeRaw(
      `SELECT h.filename FROM page_image_heads h WHERE h.source_id = 'katezo'
       AND h.filename LIKE 'search-only%'`,
    );
    expect(heads).toHaveLength(0);
    const files = await engine.executeRaw(
      `SELECT f.filename FROM files f WHERE f.source_id = 'katezo'
       AND f.filename LIKE 'search-only%'`,
    );
    expect(files).toHaveLength(0);
  }, 30000);
});

describe('legacy repository fallback', () => {
  test('is disabled remotely and serves only an exact Markdown reference to a trusted local caller', async () => {
    const legacyPath = join(sourceRoot, 'media', 'legacy.png');
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, PNG_BYTES);
    const remote = await call('get_image', { page_slug: PAGE, image_ref: LEGACY_REF }, DISPATCH, noStorageHome);
    expect(textJson(remote).error).toBe('not_found');

    const result = await call('get_image', { page_slug: PAGE, image_ref: LEGACY_REF }, TRUSTED_LOCAL, noStorageHome);
    expect(result.isError).toBeUndefined();
    expect(result.content[1] as unknown).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
    expect(textJson(result).storage).toBe('legacy_git');

    writeFileSync(join(sourceRoot, 'media', 'secret.png'), PNG_BYTES);
    const unreferenced = await call('get_image', {
      page_slug: PAGE, image_ref: '../../media/secret.png',
    }, TRUSTED_LOCAL, noStorageHome);
    expect(textJson(unreferenced).error).toBe('not_found');
  });

  test('rejects a page-referenced symlink escape and wrong-source reads', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.png'), PNG_BYTES);
    symlinkSync(outside, join(sourceRoot, 'escape'));
    await seedPage('katezo', sourceRoot, PAGE, '# References\n\n![Escape](../../escape/secret.png)\n');
    const escaped = await call('get_image', {
      page_slug: PAGE, image_ref: '../../escape/secret.png',
    }, TRUSTED_LOCAL, noStorageHome);
    expect(textJson(escaped).error).toBe('permission_denied');

    const wrongSource = await call('get_image', {
      source_id: 'other', page_slug: PAGE, image_ref: LEGACY_REF,
    }, DISPATCH, noStorageHome);
    expect(textJson(wrongSource).error).toBe('permission_denied');
  });
});
