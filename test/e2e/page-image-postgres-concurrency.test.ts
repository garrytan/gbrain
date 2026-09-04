/**
 * Real-Postgres proof for the page-image writer/GC critical section.
 *
 * PGLite serializes one embedded connection and cannot prove that the shared
 * advisory lock excludes a concurrent garbage collector while object storage
 * I/O is in flight. This suite also proves that a rolled-back upload keeps its
 * durable upload intent until an explicit aged recovery deletes the orphan.
 *
 * Run:
 *   DATABASE_URL=postgresql://... bun test test/e2e/page-image-postgres-concurrency.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { FileSpec } from '../../src/core/engine.ts';
import {
  commitPageImage,
  drainPageImageGcItem,
  listPageImageGcQueue,
  queuePageImageUploadIntent,
  type PageImageQuotas,
} from '../../src/core/page-image-storage.ts';
import type { StorageBackend } from '../../src/core/storage.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

class MemoryStorage implements StorageBackend {
  readonly objects = new Map<string, Buffer>();

  async upload(path: string, data: Buffer): Promise<void> {
    this.objects.set(path, Buffer.from(data));
  }

  async download(path: string): Promise<Buffer> {
    const data = this.objects.get(path);
    if (!data) throw new Error(`missing object: ${path}`);
    return Buffer.from(data);
  }

  async delete(path: string): Promise<void> {
    this.objects.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.objects.has(path);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter(path => path.startsWith(prefix));
  }

  async getUrl(path: string): Promise<string> {
    return `memory://${path}`;
  }
}

const QUOTAS: PageImageQuotas = {
  sourceBytes: 1024 * 1024,
  sourceFiles: 100,
  pageBytes: 1024 * 1024,
  pageFiles: 100,
  versionsPerFilename: 20,
};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describePostgres('page images — Postgres writer/GC concurrency', () => {
  let engine: PostgresEngine;
  let sourceId = '';
  let pageId = 0;
  let storageIdentity = '';
  let storagePath = '';
  let storage: MemoryStorage;

  async function cleanupFixtureRows(): Promise<void> {
    await engine.executeRaw(
      `DELETE FROM sources WHERE id LIKE 'page-image-postgres-test-%'`,
    );
    // Deleting a source cascades files and intentionally queues their objects,
    // so drain those rows after the cascade rather than before it.
    await engine.executeRaw(
      `DELETE FROM page_image_gc_queue WHERE source_id LIKE 'page-image-postgres-test-%'`,
    );
    await engine.executeRaw(`DELETE FROM config WHERE key = 'page_images.storage_identity'`);
  }

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl!, poolSize: 8 });
    await engine.initSchema();
    await cleanupFixtureRows();
  }, 90_000);

  beforeEach(async () => {
    await cleanupFixtureRows();
    const suffix = randomUUIDv7();
    sourceId = `page-image-postgres-test-${suffix}`;
    storageIdentity = `v3:postgres-test-${suffix}`;
    storagePath = `page-images/${sourceId}/asset-${suffix}.png`;
    storage = new MemoryStorage();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`,
      [sourceId],
    );
    const [page] = await engine.executeRaw<{ id: number | string }>(
      `INSERT INTO pages (source_id, slug, type, title)
       VALUES ($1, 'images/postgres-concurrency', 'note', 'Postgres image concurrency')
       RETURNING id`,
      [sourceId],
    );
    pageId = Number(page!.id);
  });

  afterEach(async () => {
    await cleanupFixtureRows();
  });

  afterAll(async () => {
    await engine?.disconnect();
  });

  function spec(): FileSpec & {
    source_id: string;
    page_id: number;
    page_slug: string;
    size_bytes: number;
  } {
    return {
      source_id: sourceId,
      page_id: pageId,
      page_slug: 'images/postgres-concurrency',
      filename: 'asset.png',
      storage_path: storagePath,
      mime_type: 'image/png',
      size_bytes: 3,
      content_hash: `sha256:${'a'.repeat(64)}`,
      metadata: {
        kind: 'page_image',
        storage: 'backend',
        storage_identity: storageIdentity,
        alt_text: 'Postgres concurrency canary',
      },
    };
  }

  test('GC waits for the writer lock and cannot delete an in-flight successful upload', async () => {
    await queuePageImageUploadIntent(engine, storagePath, storageIdentity, sourceId);
    const [item] = await listPageImageGcQueue(engine, 10, sourceId);
    expect(item).toBeDefined();

    let releaseWriter!: () => void;
    let markWriterStarted!: () => void;
    const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
    const writerStarted = new Promise<void>(resolve => { markWriterStarted = resolve; });

    const writer = commitPageImage(engine, spec(), QUOTAS, async () => {
      await storage.upload(storagePath, Buffer.from([1, 2, 3]));
      markWriterStarted();
      await writerGate;
    });
    await writerStarted;

    let gcSettled = false;
    const gc = drainPageImageGcItem(engine, storage, item!, storageIdentity)
      .then(result => {
        gcSettled = true;
        return result;
      });

    try {
      await delay(150);
      expect(gcSettled).toBe(false);
      expect(await storage.exists(storagePath)).toBe(true);
    } finally {
      releaseWriter();
    }

    await writer;
    expect(await gc).toBe('missing');
    expect(await storage.exists(storagePath)).toBe(true);
    expect(await listPageImageGcQueue(engine, 10, sourceId)).toHaveLength(0);
    const rows = await engine.executeRaw<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM files WHERE source_id = $1 AND storage_path = $2`,
      [sourceId, storagePath],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  }, 30_000);

  test('rolled-back upload remains deferred until explicit aged recovery', async () => {
    await queuePageImageUploadIntent(engine, storagePath, storageIdentity, sourceId);

    await expect(commitPageImage(engine, spec(), QUOTAS, async () => {
      await storage.upload(storagePath, Buffer.from([1, 2, 3]));
      throw new Error('simulated transaction failure after upload');
    })).rejects.toThrow('simulated transaction failure after upload');

    let [item] = await listPageImageGcQueue(engine, 10, sourceId);
    expect(item).toBeDefined();
    expect(await drainPageImageGcItem(engine, storage, item!, storageIdentity)).toBe('deferred');
    expect(await storage.exists(storagePath)).toBe(true);

    await engine.executeRaw(
      `UPDATE page_image_gc_queue SET queued_at = now() - interval '2 hours'
       WHERE storage_identity = $1 AND storage_path = $2`,
      [storageIdentity, storagePath],
    );
    [item] = await listPageImageGcQueue(engine, 10, sourceId);
    expect(await drainPageImageGcItem(
      engine,
      storage,
      item!,
      storageIdentity,
      new Date(Date.now() - 60 * 60 * 1000),
    )).toBe('deleted');
    expect(await storage.exists(storagePath)).toBe(false);
    expect(await listPageImageGcQueue(engine, 10, sourceId)).toHaveLength(0);
  }, 30_000);

  test('only one backend can claim the first upload intent', async () => {
    const otherIdentity = `${storageIdentity}-other`;
    const otherPath = `${storagePath}.other`;
    const attempts = await Promise.allSettled([
      queuePageImageUploadIntent(engine, storagePath, storageIdentity, sourceId),
      queuePageImageUploadIntent(engine, otherPath, otherIdentity, sourceId),
    ]);

    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    const anchor = await engine.getConfig('page_images.storage_identity');
    if (!anchor) throw new Error('storage identity was not anchored');
    expect([storageIdentity, otherIdentity]).toContain(anchor);
    const queue = await listPageImageGcQueue(engine, 10, sourceId);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.storage_identity).toBe(anchor);

    const winnerPath = anchor === storageIdentity ? storagePath : otherPath;
    await queuePageImageUploadIntent(engine, winnerPath, anchor, sourceId);
    expect(await listPageImageGcQueue(engine, 10, sourceId)).toHaveLength(1);
  }, 30_000);
});
