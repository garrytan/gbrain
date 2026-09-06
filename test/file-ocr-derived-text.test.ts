import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runFilesOcr, type FileOcrManifest } from '../src/commands/files-ocr.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let sourceRoot: string;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('bounded-ocr-fixture'),
]);

const digest = (value: Buffer | string): string =>
  createHash('sha256').update(value).digest('hex');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceRoot = mkdtempSync(join(tmpdir(), 'gbrain-files-ocr-'));
});

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await resetPgliteState(engine);
  mkdirSync(join(sourceRoot, 'assets'), { recursive: true });
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('notes-export', 'Third-party notes export', $1, '{}'::jsonb)`,
    [sourceRoot],
  );
});

async function seedFile(storagePath = 'assets/roster.png', bytes = PNG, manifestModel = 'test:ocr-model') {
  mkdirSync(dirname(join(sourceRoot, storagePath)), { recursive: true });
  writeFileSync(join(sourceRoot, storagePath), bytes);
  await engine.putPage('school/roster', {
    type: 'note',
    title: 'School roster',
    compiled_truth: 'The source note body remains authoritative.',
    frontmatter: { importer: 'third-party-notes' },
  }, { sourceId: 'notes-export' });
  const page = await engine.getPage('school/roster', { sourceId: 'notes-export' });
  const hash = digest(bytes);
  const file = await engine.upsertFile({
    source_id: 'notes-export', page_id: page!.id, page_slug: page!.slug,
    filename: 'roster.png', storage_path: storagePath, mime_type: 'image/png',
    size_bytes: bytes.length, content_hash: hash, metadata: { importer: 'third-party-notes' },
  });
  const manifest: FileOcrManifest = {
    version: 1,
    source_id: 'notes-export',
    model: manifestModel,
    prompt_version: 'visible-text-v1',
    rows: [{
      page_id: page!.id, page_slug: page!.slug, file_id: file.id,
      storage_path: storagePath, content_hash: `sha256:${hash}`, size_bytes: bytes.length,
    }],
  };
  const manifestPath = join(sourceRoot, `manifest-${file.id}.json`);
  const manifestJson = JSON.stringify(manifest);
  writeFileSync(manifestPath, manifestJson);
  return { manifestPath, manifestHash: digest(manifestJson), fileId: file.id, pageId: page!.id, hash };
}

const argsFor = (seeded: { manifestPath: string; manifestHash: string }, apply = false): string[] =>
  ['--manifest', seeded.manifestPath, '--manifest-sha256', seeded.manifestHash, ...(apply ? ['--apply'] : [])];

function deps(
  ocr: (bytes: Buffer, mime: string) => Promise<
    { status: 'succeeded'; text: string } | { status: 'empty' }
  >,
  model = 'test:ocr-model',
) {
  return {
    getImageOcrModel: () => model,
    runOcrGated: async (_engine: BrainEngine, bytes: Buffer, mime: string) => ocr(bytes, mime),
    now: () => new Date('2026-09-06T00:00:00.000Z'),
  };
}

describe('files ocr — attachment-derived searchable text', () => {
  test('dry-run validates bytes but performs no OCR or database write', async () => {
    const seeded = await seedFile();
    let calls = 0;
    const receipt = await runFilesOcr(engine, argsFor(seeded), deps(async () => {
      calls++;
      return { status: 'succeeded', text: 'should not run' };
    }));

    expect(receipt.status).toBe('planned');
    expect(calls).toBe(0);
    expect(await engine.getChunks('school/roster', { sourceId: 'notes-export' })).toHaveLength(0);
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr).toBeUndefined();
  });

  test('binds text to the owning note, makes it searchable, and reruns as a no-op', async () => {
    const seeded = await seedFile();
    let calls = 0;
    const injected = deps(async () => {
      calls++;
      return { status: 'succeeded', text: 'Alice Example School Class 2025-26' };
    });
    const first = await runFilesOcr(engine, argsFor(seeded, true), injected);
    const metadataAfterFirst = (await engine.getFile('notes-export', 'assets/roster.png'))!.metadata;
    const second = await runFilesOcr(engine, argsFor(seeded, true), injected);
    const dryRerun = await runFilesOcr(engine, argsFor(seeded), injected);

    expect(first.status).toBe('applied');
    expect(second.status).toBe('noop');
    expect(dryRerun.status).toBe('noop');
    expect(calls).toBe(1);
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata).toEqual(metadataAfterFirst);
    expect(metadataAfterFirst.ocr).toMatchObject({
      schema: 'gbrain.ocr-derived-text',
      version: 1,
      status: 'succeeded',
      source_content_hash: seeded.hash,
      source_byte_count: PNG.length,
      sniffed_mime: 'image/png',
      text_sha256: digest('Alice Example School Class 2025-26'),
      derived_chunk_index: -seeded.fileId,
      model: 'test:ocr-model',
      prompt_version: 'visible-text-v1',
      canonical_file_id: seeded.fileId,
      first_extracted_at: '2026-09-06T00:00:00.000Z',
    });
    const chunks = await engine.getChunks('school/roster', { sourceId: 'notes-export' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      chunk_index: -seeded.fileId,
      chunk_source: 'image_asset',
      modality: 'text',
    });
    const hits = await engine.searchKeyword('Alice Example', { sourceId: 'notes-export', limit: 10 });
    expect(hits.map(hit => hit.slug)).toContain('school/roster');
    expect(await engine.getPage('assets/roster.png', { sourceId: 'notes-export' })).toBeNull();
    expect((await engine.getPage('school/roster', { sourceId: 'notes-export' }))!.compiled_truth)
      .toBe('The source note body remains authoritative.');
    expect(JSON.stringify(first)).not.toContain('Alice Example');
    expect(JSON.stringify(first)).not.toContain('assets/roster.png');
  });

  test('sanitizes provider text before storing or hashing attachment-derived text', async () => {
    const seeded = await seedFile();
    const sanitized = 'Alice� Example';
    await runFilesOcr(engine, argsFor(seeded, true), deps(async () => ({
      status: 'succeeded', text: 'Alice\0\ud800 Example',
    })));
    const chunks = await engine.getChunks('school/roster', { sourceId: 'notes-export' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_text).toBe(sanitized);
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr)
      .toMatchObject({ text_sha256: digest(sanitized) });
  });

  test('repairs corrupt derived chunk shape from cached text without another provider call', async () => {
    const seeded = await seedFile();
    let calls = 0;
    const injected = deps(async () => {
      calls++;
      return { status: 'succeeded', text: 'Cached roster text' };
    });
    await runFilesOcr(engine, argsFor(seeded, true), injected);
    await engine.executeRaw(
      `UPDATE content_chunks SET chunk_source = 'compiled_truth', modality = 'image', model = 'wrong:model'
        WHERE page_id = $1 AND chunk_index = $2`,
      [seeded.pageId, -seeded.fileId],
    );
    await runFilesOcr(engine, argsFor(seeded, true), injected);
    expect(calls).toBe(1);
    expect((await engine.getChunks('school/roster', { sourceId: 'notes-export' }))[0]).toMatchObject({
      chunk_source: 'image_asset', modality: 'text', model: 'test:ocr-model',
    });
  });

  test('binds OCR provenance to the exact model admitted by the paid gate', async () => {
    const seeded = await seedFile('assets/roster.png', PNG, 'test:pinned-model');
    let admittedModel: string | undefined;
    await runFilesOcr(engine, argsFor(seeded, true), {
      getImageOcrModel: () => 'test:pinned-model',
      runOcrGated: async (_engine, _bytes, _mime, expectedModel) => {
        admittedModel = expectedModel;
        return { status: 'succeeded', text: 'Pinned model text' };
      },
    });
    expect(admittedModel).toBe('test:pinned-model');
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr)
      .toMatchObject({ model: 'test:pinned-model' });
  });

  test('rejects prompt-version drift before provider work', async () => {
    const seeded = await seedFile();
    const manifest = JSON.parse(await Bun.file(seeded.manifestPath).text()) as FileOcrManifest;
    manifest.prompt_version = 'future-prompt';
    const json = JSON.stringify(manifest);
    writeFileSync(seeded.manifestPath, json);
    let calls = 0;
    await expect(runFilesOcr(engine, [
      '--manifest', seeded.manifestPath, '--manifest-sha256', digest(json), '--apply',
    ], deps(async () => { calls++; return { status: 'empty' }; })))
      .rejects.toThrow(/prompt_version must be visible-text-v1/);
    expect(calls).toBe(0);
  });

  test('accepts safe bigint-shaped registered byte sizes and rejects unsafe values', async () => {
    const seeded = await seedFile();
    const withSize = (size: bigint): BrainEngine => new Proxy(engine, {
      get(target, property) {
        if (property === 'getFile') return async (sourceId: string, storagePath: string) => {
          const file = await target.getFile(sourceId, storagePath);
          return file ? { ...file, size_bytes: size } : null;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as BrainEngine;

    expect((await runFilesOcr(withSize(BigInt(PNG.length)), argsFor(seeded), deps(async () => ({
      status: 'empty',
    })))).status).toBe('planned');
    await expect(runFilesOcr(withSize(BigInt(Number.MAX_SAFE_INTEGER) + 1n), argsFor(seeded), deps(async () => ({
      status: 'empty',
    })))).rejects.toThrow(/stored file size_bytes must be a nonnegative safe integer/);
  });

  test('ordinary replacement preserves derived text; explicit purge removes it', async () => {
    const seeded = await seedFile();
    await runFilesOcr(engine, argsFor(seeded, true), deps(async () => ({
      status: 'succeeded', text: 'Visible attachment words',
    })));
    await engine.upsertChunks('school/roster', [{
      chunk_index: 0, chunk_text: 'Replacement body', chunk_source: 'compiled_truth',
    }], { sourceId: 'notes-export' });
    expect((await engine.getChunks('school/roster', { sourceId: 'notes-export' })).map(row => row.chunk_index))
      .toEqual([-seeded.fileId, 0]);
    await engine.deleteChunks('school/roster', { sourceId: 'notes-export', preserveDerivedFileText: true });
    expect((await engine.getChunks('school/roster', { sourceId: 'notes-export' })).map(row => row.chunk_index))
      .toEqual([-seeded.fileId]);
    await engine.deleteChunks('school/roster', { sourceId: 'notes-export' });
    expect(await engine.getChunks('school/roster', { sourceId: 'notes-export' })).toHaveLength(0);
  });

  test('ordinary empty re-import preserves attachment OCR but quarantine purges every chunk', async () => {
    const seeded = await seedFile();
    await runFilesOcr(engine, argsFor(seeded, true), deps(async () => ({
      status: 'succeeded', text: 'Attachment-only roster text',
    })));
    await importFromContent(engine, 'school/roster', `---
title: School roster
type: note
---
`, { sourceId: 'notes-export', noEmbed: true, forceRechunk: true, allowEmptyOverwrite: true });
    expect((await engine.getChunks('school/roster', { sourceId: 'notes-export' })).map(row => row.chunk_index))
      .toEqual([-seeded.fileId]);

    const result = await importFromContent(engine, 'school/roster', `---
title: 'Attention Required! | Cloudflare'
type: note
---
Body.`, { sourceId: 'notes-export', noEmbed: true, forceRechunk: true });
    expect(result.quarantined).toBe(true);
    expect(await engine.getChunks('school/roster', { sourceId: 'notes-export' })).toHaveLength(0);
  });

  test('generic upsert rejects the reserved negative attachment namespace', async () => {
    await seedFile();
    await expect(engine.upsertChunks('school/roster', [{
      chunk_index: -1, chunk_text: 'not allowed', chunk_source: 'image_asset', modality: 'text',
    }], { sourceId: 'notes-export' })).rejects.toThrow(/reserves negative chunk indexes/);
  });

  test('deduplicates same-page identical bytes to one paid call and one text chunk', async () => {
    const first = await seedFile('assets/a.png');
    writeFileSync(join(sourceRoot, 'assets/b.png'), PNG);
    const second = await engine.upsertFile({
      source_id: 'notes-export', page_id: first.pageId, page_slug: 'school/roster',
      filename: 'b.png', storage_path: 'assets/b.png', mime_type: 'image/png',
      size_bytes: PNG.length, content_hash: first.hash, metadata: { importer: 'third-party-notes' },
    });
    const manifest: FileOcrManifest = {
      version: 1, source_id: 'notes-export', model: 'test:ocr-model', prompt_version: 'visible-text-v1',
      rows: [
        { page_id: first.pageId, page_slug: 'school/roster', file_id: first.fileId, storage_path: 'assets/a.png', content_hash: first.hash, size_bytes: PNG.length },
        { page_id: first.pageId, page_slug: 'school/roster', file_id: second.id, storage_path: 'assets/b.png', content_hash: first.hash, size_bytes: PNG.length },
      ],
    };
    const path = join(sourceRoot, 'duplicates.json');
    const manifestJson = JSON.stringify(manifest);
    writeFileSync(path, manifestJson);
    let calls = 0;
    const receipt = await runFilesOcr(engine, ['--manifest', path, '--manifest-sha256', digest(manifestJson), '--apply'], deps(async () => {
      calls++;
      return { status: 'succeeded', text: 'One roster text' };
    }));

    expect(calls).toBe(1);
    expect(new Set(receipt.rows.map(row => row.canonical_file_id)).size).toBe(1);
    const derived = (await engine.getChunks('school/roster', { sourceId: 'notes-export' }))
      .filter(row => row.chunk_index < 0);
    expect(derived).toHaveLength(1);
    expect(derived[0].chunk_text).toBe('One roster text');

    const canonical = first.fileId < second.id
      ? { path: 'assets/a.png', id: first.fileId }
      : { path: 'assets/b.png', id: second.id };
    await engine.upsertFile({
      source_id: 'notes-export', page_id: first.pageId, page_slug: 'school/roster',
      filename: canonical.path.split('/').at(-1)!, storage_path: canonical.path, mime_type: 'image/png',
      size_bytes: PNG.length + 1, content_hash: digest(Buffer.concat([PNG, Buffer.from('changed')])), metadata: {},
    });
    expect((await engine.getChunks('school/roster', { sourceId: 'notes-export' }))
      .filter(row => row.chunk_index < 0)).toHaveLength(0);
    expect((await engine.getFile('notes-export', 'assets/a.png'))!.metadata.ocr).toBeUndefined();
    expect((await engine.getFile('notes-export', 'assets/b.png'))!.metadata.ocr).toBeUndefined();
  });

  test('rejects an over-budget unique batch before the first provider call', async () => {
    const first = await seedFile('assets/a.png');
    const secondBytes = Buffer.concat([PNG, Buffer.from('second-image')]);
    writeFileSync(join(sourceRoot, 'assets/b.png'), secondBytes);
    const second = await engine.upsertFile({
      source_id: 'notes-export', page_id: first.pageId, page_slug: 'school/roster',
      filename: 'b.png', storage_path: 'assets/b.png', mime_type: 'image/png',
      size_bytes: secondBytes.length, content_hash: digest(secondBytes), metadata: {},
    });
    const manifest: FileOcrManifest = {
      version: 1, source_id: 'notes-export', model: 'test:ocr-model', prompt_version: 'visible-text-v1', rows: [
        { page_id: first.pageId, page_slug: 'school/roster', file_id: first.fileId, storage_path: 'assets/a.png', content_hash: first.hash, size_bytes: PNG.length },
        { page_id: first.pageId, page_slug: 'school/roster', file_id: second.id, storage_path: 'assets/b.png', content_hash: digest(secondBytes), size_bytes: secondBytes.length },
      ],
    };
    const json = JSON.stringify(manifest);
    const path = join(sourceRoot, 'over-budget.json');
    writeFileSync(path, json);
    await engine.setConfig('embedding_image_ocr_max_images', '1');
    let calls = 0;
    await expect(runFilesOcr(engine, [
      '--manifest', path, '--manifest-sha256', digest(json), '--apply',
    ], deps(async () => { calls++; return { status: 'empty' }; })))
      .rejects.toThrow(/batch rejected before provider work/);
    expect(calls).toBe(0);
    expect(await engine.getChunks('school/roster', { sourceId: 'notes-export' })).toHaveLength(0);
  });

  test('Readwise lineage and manifest mismatch both fail before OCR', async () => {
    const seeded = await seedFile();
    await engine.executeRaw(`UPDATE sources SET config = '{"upstream":"readwise"}'::jsonb WHERE id = 'notes-export'`);
    let calls = 0;
    const injected = deps(async () => {
      calls++;
      return { status: 'succeeded', text: 'forbidden' };
    });
    await expect(runFilesOcr(engine, argsFor(seeded, true), injected))
      .rejects.toThrow(/Readwise lineage/);
    expect(calls).toBe(0);

    await engine.executeRaw(`UPDATE sources SET config = '{}'::jsonb WHERE id = 'notes-export'`);
    const bad = JSON.parse(await Bun.file(seeded.manifestPath).text()) as FileOcrManifest;
    bad.rows[0].page_id += 1;
    const badPath = join(sourceRoot, 'mismatch.json');
    const badJson = JSON.stringify(bad);
    writeFileSync(badPath, badJson);
    await expect(runFilesOcr(engine, ['--manifest', badPath, '--manifest-sha256', digest(badJson), '--apply'], injected))
      .rejects.toThrow(/identity mismatch/);
    expect(calls).toBe(0);
  });

  test('Readwise body marker fails before bytes or provider work', async () => {
    const seeded = await seedFile();
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = 'Highlights first synced by Readwise' WHERE id = $1`,
      [seeded.pageId],
    );
    writeFileSync(join(sourceRoot, 'assets/roster.png'), Buffer.from('not an image'));
    let calls = 0;
    await expect(runFilesOcr(engine, argsFor(seeded, true), deps(async () => {
      calls++;
      return { status: 'succeeded', text: 'forbidden' };
    }))).rejects.toThrow(/Readwise lineage/);
    expect(calls).toBe(0);
  });

  test('Readwise lineage visible only in OCR text aborts without derived writes', async () => {
    const seeded = await seedFile();
    await expect(runFilesOcr(engine, argsFor(seeded, true), deps(async () => ({
      status: 'succeeded', text: 'Highlights first synced by Readwise',
    })))).rejects.toThrow(/Readwise lineage found in extracted text/);
    expect(await engine.getChunks('school/roster', { sourceId: 'notes-export' })).toHaveLength(0);
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr).toBeUndefined();
  });

  test('apply-time Readwise lineage drift rolls back after provider work', async () => {
    const seeded = await seedFile();
    let calls = 0;
    await expect(runFilesOcr(engine, argsFor(seeded, true), deps(async () => {
      calls++;
      await engine.executeRaw(`UPDATE sources SET local_path = '/tmp/Readwise/export' WHERE id = 'notes-export'`);
      return { status: 'succeeded', text: 'must not persist' };
    }))).rejects.toThrow(/Readwise lineage/);
    expect(calls).toBe(1);
    expect(await engine.getChunks('school/roster', { sourceId: 'notes-export' })).toHaveLength(0);
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr).toBeUndefined();
  });

  test('manifest hash mismatch fails before parsing or touching an engine', async () => {
    const seeded = await seedFile();
    await expect(runFilesOcr({} as BrainEngine, [
      '--manifest', seeded.manifestPath, '--manifest-sha256', '0'.repeat(64),
    ], deps(async () => ({ status: 'succeeded', text: 'forbidden' }))))
      .rejects.toThrow(/manifest SHA-256 mismatch/);
  });

  test('rejects unknown, duplicate, and unscoped flags', async () => {
    const seeded = await seedFile();
    await expect(runFilesOcr(engine, [...argsFor(seeded), '--wat']))
      .rejects.toThrow(/unknown argument/);
    await expect(runFilesOcr(engine, [...argsFor(seeded), '--apply', '--apply']))
      .rejects.toThrow(/duplicate flag/);
    await expect(runFilesOcr(engine, [...argsFor(seeded), '--all']))
      .rejects.toThrow(/does not support --all/);
  });

  test('byte hash mismatch and provider failure leave no OCR mutation', async () => {
    const seeded = await seedFile();
    let calls = 0;
    writeFileSync(join(sourceRoot, 'assets/roster.png'), Buffer.concat([PNG, Buffer.from('larger')]));
    await expect(runFilesOcr(engine, argsFor(seeded, true), deps(async () => {
      calls++;
      return { status: 'succeeded', text: 'forbidden' };
    }))).rejects.toThrow(/byte size mismatch/);
    expect(calls).toBe(0);

    const changedBytes = Buffer.from(PNG);
    changedBytes[changedBytes.length - 1] ^= 0xff;
    writeFileSync(join(sourceRoot, 'assets/roster.png'), changedBytes);
    await expect(runFilesOcr(engine, argsFor(seeded, true), deps(async () => {
      calls++;
      return { status: 'succeeded', text: 'forbidden' };
    }))).rejects.toThrow(/byte hash mismatch/);
    expect(calls).toBe(0);

    writeFileSync(join(sourceRoot, 'assets/roster.png'), PNG);
    await expect(runFilesOcr(engine, argsFor(seeded, true), {
      ...deps(async () => ({ status: 'empty' })),
      runOcrGated: async () => ({ status: 'provider-failure' as const }),
    })).rejects.toThrow(/aborted before apply: provider-failure/);
    expect(await engine.getChunks('school/roster', { sourceId: 'notes-export' })).toHaveLength(0);
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr).toBeUndefined();
  });

  test('empty OCR removes stale derived text and records an empty result', async () => {
    const seeded = await seedFile('assets/roster.png', PNG, 'test:ocr-v1');
    await runFilesOcr(engine, argsFor(seeded, true), deps(async () => ({
      status: 'succeeded', text: 'stale visible text',
    }), 'test:ocr-v1'));
    const nextManifest = JSON.parse(await Bun.file(seeded.manifestPath).text()) as FileOcrManifest;
    nextManifest.model = 'test:ocr-v2';
    const nextJson = JSON.stringify(nextManifest);
    writeFileSync(seeded.manifestPath, nextJson);
    const receipt = await runFilesOcr(engine, [
      '--manifest', seeded.manifestPath, '--manifest-sha256', digest(nextJson), '--apply',
    ], deps(async () => ({
      status: 'empty',
    }), 'test:ocr-v2'));
    expect(receipt.status).toBe('applied');
    expect(await engine.getChunks('school/roster', { sourceId: 'notes-export' })).toHaveLength(0);
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr)
      .toMatchObject({ status: 'empty', model: 'test:ocr-v2' });

    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, modality)
       VALUES ($1, $2, '', 'image_asset', 'text')`,
      [seeded.pageId, -seeded.fileId],
    );
    const repaired = await runFilesOcr(engine, [
      '--manifest', seeded.manifestPath, '--manifest-sha256', digest(nextJson), '--apply',
    ], deps(async () => ({ status: 'empty' }), 'test:ocr-v2'));
    expect(repaired.status).toBe('applied');
    expect(await engine.getChunks('school/roster', { sourceId: 'notes-export' })).toHaveLength(0);
  });

  test('metadata failure rolls back the derived chunk transaction', async () => {
    const seeded = await seedFile();
    const originalTransaction = engine.transaction.bind(engine);
    engine.transaction = async fn => originalTransaction(async tx => {
      const wrapped = new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== 'executeRaw') return Reflect.get(target, property, receiver);
          return async (sql: string, params?: unknown[]) => {
            if (/^UPDATE files/.test(sql.trim())) throw new Error('forced receipt failure');
            return target.executeRaw(sql, params);
          };
        },
      });
      return fn(wrapped);
    });
    try {
      await expect(runFilesOcr(engine, argsFor(seeded, true), deps(async () => ({
        status: 'succeeded', text: 'must roll back',
      })))).rejects.toThrow(/forced receipt failure/);
    } finally {
      engine.transaction = originalTransaction;
    }
    expect(await engine.getChunks('school/roster', { sourceId: 'notes-export' })).toHaveLength(0);
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr).toBeUndefined();
  });

  test('apply-time identity drift fails and rolls back without a successful receipt', async () => {
    const seeded = await seedFile();
    await expect(runFilesOcr(engine, argsFor(seeded, true), deps(async () => {
      await engine.executeRaw(`UPDATE files SET size_bytes = size_bytes + 1 WHERE id = $1`, [seeded.fileId]);
      return { status: 'succeeded', text: 'must never commit' };
    }))).rejects.toThrow(/apply identity mismatch/);
    expect(await engine.getChunks('school/roster', { sourceId: 'notes-export' })).toHaveLength(0);
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr).toBeUndefined();
  });

  test('preflight noop drift aborts instead of overwriting derived text as empty', async () => {
    const first = await seedFile('assets/a.png');
    await runFilesOcr(engine, argsFor(first, true), deps(async () => ({
      status: 'succeeded', text: 'existing attachment text',
    })));
    const secondBytes = Buffer.concat([PNG, Buffer.from('second')]);
    writeFileSync(join(sourceRoot, 'assets/b.png'), secondBytes);
    const second = await engine.upsertFile({
      source_id: 'notes-export', page_id: first.pageId, page_slug: 'school/roster',
      filename: 'b.png', storage_path: 'assets/b.png', mime_type: 'image/png',
      size_bytes: secondBytes.length, content_hash: digest(secondBytes), metadata: {},
    });
    const manifest: FileOcrManifest = {
      version: 1, source_id: 'notes-export', model: 'test:ocr-model', prompt_version: 'visible-text-v1', rows: [
        { page_id: first.pageId, page_slug: 'school/roster', file_id: first.fileId, storage_path: 'assets/a.png', content_hash: first.hash, size_bytes: PNG.length },
        { page_id: first.pageId, page_slug: 'school/roster', file_id: second.id, storage_path: 'assets/b.png', content_hash: digest(secondBytes), size_bytes: secondBytes.length },
      ],
    };
    const json = JSON.stringify(manifest);
    const path = join(sourceRoot, 'noop-drift.json');
    writeFileSync(path, json);
    await expect(runFilesOcr(engine, ['--manifest', path, '--manifest-sha256', digest(json), '--apply'], deps(async () => {
      await engine.executeRaw(`UPDATE content_chunks SET chunk_source = 'compiled_truth' WHERE page_id = $1 AND chunk_index = $2`, [first.pageId, -first.fileId]);
      return { status: 'succeeded', text: 'second attachment text' };
    }))).rejects.toThrow(/preflight-noop drift/);
    expect((await engine.getFile('notes-export', 'assets/a.png'))!.metadata.ocr).toBeDefined();
    expect((await engine.getFile('notes-export', 'assets/b.png'))!.metadata.ocr).toBeUndefined();
    expect((await engine.getChunks('school/roster', { sourceId: 'notes-export' }))
      .find(row => row.chunk_index === -first.fileId)?.chunk_text).toBe('existing attachment text');
  });

  test('duplicate membership drift aborts the manifest before OCR writes', async () => {
    const seeded = await seedFile();
    await expect(runFilesOcr(engine, argsFor(seeded, true), deps(async () => {
      writeFileSync(join(sourceRoot, 'assets/late-duplicate.png'), PNG);
      await engine.upsertFile({
        source_id: 'notes-export', page_id: seeded.pageId, page_slug: 'school/roster',
        filename: 'late-duplicate.png', storage_path: 'assets/late-duplicate.png', mime_type: 'image/png',
        size_bytes: PNG.length, content_hash: seeded.hash, metadata: {},
      });
      return { status: 'succeeded', text: 'must not persist' };
    }))).rejects.toThrow(/duplicate membership drift/);
    expect(await engine.getChunks('school/roster', { sourceId: 'notes-export' })).toHaveLength(0);
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr).toBeUndefined();
    expect((await engine.getFile('notes-export', 'assets/late-duplicate.png'))!.metadata.ocr).toBeUndefined();
  });

  test('rejects duplicate manifest identity rows before OCR', async () => {
    const seeded = await seedFile();
    const manifest = JSON.parse(await Bun.file(seeded.manifestPath).text()) as FileOcrManifest;
    manifest.rows.push({ ...manifest.rows[0] });
    const json = JSON.stringify(manifest);
    const path = join(sourceRoot, 'duplicate-identities.json');
    writeFileSync(path, json);
    let calls = 0;
    await expect(runFilesOcr(engine, [
      '--manifest', path, '--manifest-sha256', digest(json), '--apply',
    ], deps(async () => {
      calls++;
      return { status: 'succeeded', text: 'forbidden' };
    }))).rejects.toThrow(/duplicate file_id/);
    expect(calls).toBe(0);
  });

  test('rejects ancestor symlinks before reading image bytes', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-files-ocr-outside-'));
    writeFileSync(join(outside, 'escaped.png'), PNG);
    symlinkSync(outside, join(sourceRoot, 'assets/link'));
    const seeded = await seedFile('assets/link/escaped.png');
    await expect(runFilesOcr(engine, argsFor(seeded, true), deps(async () => ({
      status: 'succeeded', text: 'forbidden',
    })))).rejects.toThrow(/rejects symlinks/);
  });

  test('stored sha256 prefix reconciles and receipts omit text, path, URL, and provider details', async () => {
    const seeded = await seedFile();
    await engine.executeRaw(`UPDATE files SET content_hash = $1 WHERE id = $2`, [`sha256:${seeded.hash}`, seeded.fileId]);
    const receipt = await runFilesOcr(engine, argsFor(seeded, true), deps(async () => ({
      status: 'succeeded', text: 'Private Student Name',
    })));
    const serialized = JSON.stringify(receipt);
    expect(receipt.status).toBe('applied');
    expect(serialized).not.toContain('Private Student Name');
    expect(serialized).not.toContain('assets/roster.png');
    expect(serialized).not.toContain('http');
    expect(serialized).not.toContain('provider');
  });

  test('cross-source storage collisions fail without purging the original OCR chunk', async () => {
    const seeded = await seedFile();
    await runFilesOcr(engine, argsFor(seeded, true), deps(async () => ({
      status: 'succeeded', text: 'Keep original text',
    })));
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('other', 'Other', '{}'::jsonb)`);
    await engine.putPage('other/page', { type: 'note', title: 'Other', compiled_truth: 'Other body' }, { sourceId: 'other' });
    const otherPage = await engine.getPage('other/page', { sourceId: 'other' });
    await expect(engine.upsertFile({
      source_id: 'other', page_id: otherPage!.id, page_slug: otherPage!.slug,
      filename: 'collision.png', storage_path: 'assets/roster.png', mime_type: 'image/png',
      size_bytes: PNG.length, content_hash: digest(Buffer.from('other')), metadata: {},
    })).rejects.toThrow(/refused cross-source collision/);
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.source_id).toBe('notes-export');
    expect((await engine.getChunks('school/roster', { sourceId: 'notes-export' })).some(row => row.chunk_index === -seeded.fileId)).toBe(true);
  });

  test('upsertFile preserves OCR only while hash and page association stay unchanged', async () => {
    const seeded = await seedFile();
    await runFilesOcr(engine, argsFor(seeded, true), deps(async () => ({
      status: 'succeeded', text: 'Stale if bytes change',
    })));
    await engine.executeRaw(`UPDATE files SET content_hash = $1 WHERE id = $2`, [`sha256:${seeded.hash}`, seeded.fileId]);
    await engine.upsertFile({
      source_id: 'notes-export', page_id: seeded.pageId, page_slug: 'school/roster',
      filename: 'renamed.png', storage_path: 'assets/roster.png', mime_type: 'image/png',
      size_bytes: PNG.length, content_hash: seeded.hash, metadata: { refreshed: true },
    });
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr).toBeDefined();
    expect((await engine.getChunks('school/roster', { sourceId: 'notes-export' })).some(row => row.chunk_index < 0)).toBe(true);

    await engine.upsertFile({
      source_id: 'notes-export', page_id: seeded.pageId, page_slug: 'school/roster',
      filename: 'renamed.png', storage_path: 'assets/roster.png', mime_type: 'image/png',
      size_bytes: PNG.length + 1, content_hash: digest(Buffer.concat([PNG, Buffer.from('changed')])),
      metadata: { refreshed: true },
    });
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr).toBeUndefined();
    expect((await engine.getChunks('school/roster', { sourceId: 'notes-export' })).some(row => row.chunk_index < 0)).toBe(false);
  });

  test('ordinary file upserts cannot forge or replace reserved OCR provenance', async () => {
    const seeded = await seedFile();
    await engine.upsertFile({
      source_id: 'notes-export', page_id: seeded.pageId, page_slug: 'school/roster',
      filename: 'forged.png', storage_path: 'assets/forged.png', mime_type: 'image/png',
      size_bytes: PNG.length, content_hash: digest(Buffer.from('forged-file')), metadata: { safe: true, ocr: { status: 'forged' } },
    });
    expect((await engine.getFile('notes-export', 'assets/forged.png'))!.metadata)
      .toEqual({ safe: true });

    await runFilesOcr(engine, argsFor(seeded, true), deps(async () => ({
      status: 'succeeded', text: 'Legitimate OCR',
    })));
    const legitimate = (await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr;
    await engine.upsertFile({
      source_id: 'notes-export', page_id: seeded.pageId, page_slug: 'school/roster',
      filename: 'roster.png', storage_path: 'assets/roster.png', mime_type: 'image/png',
      size_bytes: PNG.length, content_hash: seeded.hash, metadata: { ocr: { status: 'forged' } },
    });
    expect((await engine.getFile('notes-export', 'assets/roster.png'))!.metadata.ocr).toEqual(legitimate);
  });
});
