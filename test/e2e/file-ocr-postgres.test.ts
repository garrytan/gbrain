/**
 * files ocr mutation parity on live Postgres + pgvector.
 *
 * Run: DATABASE_URL=postgresql://... bun test test/e2e/file-ocr-postgres.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runFilesOcr, type FileOcrManifest } from '../../src/commands/files-ocr.ts';
import { _resetOcrRunBudgetForTests } from '../../src/core/import-file.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('postgres-ocr-fixture'),
]);
const digest = (value: Buffer | string): string =>
  createHash('sha256').update(value).digest('hex');

let engine: PostgresEngine;
let sourceRoot: string;

async function seedManifest(storagePaths: string[]): Promise<{
  args: string[];
  fileIds: number[];
  pageId: number;
}> {
  const page = await engine.putPage('postgres/ocr', {
    type: 'note',
    title: 'Postgres OCR',
    compiled_truth: 'Original source body.',
  }, { sourceId: 'ocr-postgres' });
  const fileIds: number[] = [];
  const rows: FileOcrManifest['rows'] = [];
  for (const storagePath of storagePaths) {
    const absolute = join(sourceRoot, storagePath);
    writeFileSync(absolute, PNG);
    const file = await engine.upsertFile({
      source_id: 'ocr-postgres',
      page_id: page.id,
      page_slug: 'postgres/ocr',
      filename: storagePath.split('/').at(-1)!,
      storage_path: storagePath,
      mime_type: 'image/png',
      size_bytes: PNG.length,
      content_hash: digest(PNG),
      metadata: {},
    });
    fileIds.push(file.id);
    rows.push({
      page_id: page.id,
      page_slug: 'postgres/ocr',
      file_id: file.id,
      storage_path: storagePath,
      content_hash: digest(PNG),
      size_bytes: PNG.length,
    });
  }
  const manifest: FileOcrManifest = {
    version: 1,
    source_id: 'ocr-postgres',
    model: 'test:ocr-model',
    prompt_version: 'visible-text-v1',
    rows,
  };
  const json = JSON.stringify(manifest);
  const path = join(sourceRoot, 'manifest.json');
  writeFileSync(path, json);
  return {
    args: ['--manifest', path, '--manifest-sha256', digest(json), '--apply'],
    fileIds,
    pageId: page.id,
  };
}

const deps = (ocr: () => Promise<{ status: 'succeeded'; text: string }>) => ({
  getImageOcrModel: () => 'test:ocr-model',
  runOcrGated: async () => ocr(),
  now: () => new Date('2026-09-06T00:00:00.000Z'),
});

d('files ocr mutation parity (live Postgres)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    sourceRoot = mkdtempSync(join(tmpdir(), 'gbrain-files-ocr-postgres-'));
    mkdirSync(join(sourceRoot, 'assets'), { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await teardownDB();
    rmSync(sourceRoot, { recursive: true, force: true });
  }, 30_000);

  beforeEach(async () => {
    _resetOcrRunBudgetForTests();
    await engine.executeRaw('DELETE FROM content_chunks');
    await engine.executeRaw('DELETE FROM files');
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('ocr-postgres', 'OCR Postgres', $1, '{}'::jsonb)`,
      [sourceRoot],
    );
  });

  test('canonicalizes duplicates, stores JSONB, and replays idempotently', async () => {
    const seeded = await seedManifest(['assets/a.png', 'assets/b.png']);
    let calls = 0;
    const injected = deps(async () => {
      calls++;
      return { status: 'succeeded', text: 'Postgres attachment text' };
    });

    const first = await runFilesOcr(engine, seeded.args, injected);
    const second = await runFilesOcr(engine, seeded.args, injected);
    expect(first.counts).toEqual({ planned: 0, applied: 2, noop: 0 });
    expect(second.counts).toEqual({ planned: 0, applied: 0, noop: 2 });
    expect(calls).toBe(1);

    const canonicalId = Math.min(...seeded.fileIds);
    const chunks = await engine.executeRaw<{ chunk_index: number; chunk_text: string }>(
      `SELECT chunk_index, chunk_text FROM content_chunks WHERE page_id = $1 ORDER BY chunk_index`,
      [seeded.pageId],
    );
    expect(chunks).toEqual([{ chunk_index: -canonicalId, chunk_text: 'Postgres attachment text' }]);
    const metadata = await engine.executeRaw<{ kind: string; n: number }>(
      `SELECT jsonb_typeof(metadata->'ocr') AS kind, count(*)::int AS n
       FROM files WHERE id = ANY($1::int[]) GROUP BY 1`,
      [seeded.fileIds],
    );
    expect(metadata).toEqual([{ kind: 'object', n: 2 }]);
  });

  test('rolls back chunk and JSONB receipt together on a receipt write failure', async () => {
    const seeded = await seedManifest(['assets/rollback.png']);
    const originalTransaction = engine.transaction.bind(engine);
    engine.transaction = async fn => originalTransaction(async tx => {
      const wrapped = new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== 'executeRaw') return Reflect.get(target, property, receiver);
          return async (sql: string, params?: unknown[]) => {
            if (/^UPDATE files/.test(sql.trim())) throw new Error('forced Postgres receipt failure');
            return target.executeRaw(sql, params);
          };
        },
      });
      return fn(wrapped);
    });
    try {
      await expect(runFilesOcr(engine, seeded.args, deps(async () => ({
        status: 'succeeded', text: 'must roll back',
      })))).rejects.toThrow(/forced Postgres receipt failure/);
    } finally {
      engine.transaction = originalTransaction;
    }

    expect(await engine.executeRaw(`SELECT 1 FROM content_chunks WHERE page_id = $1`, [seeded.pageId]))
      .toHaveLength(0);
    const files = await engine.executeRaw<{ has_ocr: boolean }>(
      `SELECT metadata ? 'ocr' AS has_ocr FROM files WHERE id = $1`,
      [seeded.fileIds[0]],
    );
    expect(files).toEqual([{ has_ocr: false }]);
  });
});
