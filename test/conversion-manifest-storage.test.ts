import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  createConversionManifest,
  getConversionManifest,
  listConversionManifests,
  listConversionMappings,
  getFileByIdForUpdate,
  getFileById,
  inspectConversionFile,
  verifyConversionManifestLinkage,
} from '../src/core/conversion-manifest.ts';
import type { ConversionManifestInput } from '../src/core/conversion-manifest.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const HASH = 'a'.repeat(64);
const BASE = {
  sourceId: 'synthetic-conversion-source', fileId: 7, idempotencyKey: 'synthetic-replay',
  adapterKind: 'synthetic-adapter', sourceVisualKind: 'text', converter: 'synthetic-converter',
  converterVersion: '1', settings: {}, unitKind: 'document', coverage: { total: 1, succeeded: 1, failed: 0, failedRanges: [] },
  candidates: {}, confidence: null, ocr: {}, imageDimensions: null, unreadableRegions: [], warnings: [], mappings: [],
} satisfies ConversionManifestInput;
const LOCAL_CONTEXT = { transport: 'local_cli', remote: false } as const;

async function setup(): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources(id,name) VALUES ('synthetic-conversion-source','synthetic-conversion-source') ON CONFLICT DO NOTHING`);
  await engine.executeRaw('INSERT INTO files(id,source_id,filename,content_hash,mime_type,storage_path) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [7, 'synthetic-conversion-source', 'synthetic-filename', HASH, 'text/plain', 'synthetic']);
}

describe('conversion manifest storage/service contract', () => {
  test('source reads expose the lock seam used by create', async () => {
    await setup();
      const file = await getFileById(engine, BASE.sourceId, BASE.fileId);
      const lockedFile = await getFileByIdForUpdate(engine, BASE.sourceId, BASE.fileId);
      expect(file).not.toBeNull();
      expect(lockedFile).not.toBeNull();
      if (file && lockedFile) {
        expect(file.id).toBe(BASE.fileId);
        expect(lockedFile.id).toBe(BASE.fileId);
      }
  });
  test('create/get/list/mappings persist one immutable receipt and its linkage', async () => {
    await setup();
      const first = await createConversionManifest(engine, { ...BASE }, LOCAL_CONTEXT);
      expect(first.created).toBe(true);
      const receipt = await getConversionManifest(engine, first.receipt.receiptId);
      expect(receipt?.sourceId).toBe(BASE.sourceId);
      expect((await listConversionManifests(engine, BASE.sourceId, { fileId: 7 })).map((r) => r.receiptId)).toEqual([first.receipt.receiptId]);
      expect(await listConversionMappings(engine, first.receipt.receiptId)).toEqual([]);
      await expect(engine.executeRaw(`UPDATE conversion_manifests SET risk='warning' WHERE receipt_id='${first.receipt.receiptId}'`)).rejects.toThrow();
  });
  test('producer attribution is trusted-context derived and fails closed', async () => {
    await setup();
    const spoofed = await createConversionManifest(engine, ({
      ...BASE,
      producer: { kind: 'oauth_client', id: 'spoofed.client' },
      transport: 'oauth_http',
      remote: true,
      auth: { clientId: 'spoofed.client', sourceId: BASE.sourceId },
    } as any), LOCAL_CONTEXT);
    expect(spoofed.receipt).toMatchObject({ producerKind: 'local_cli', producerId: null });
    await expect(createConversionManifest(engine, { ...BASE, idempotencyKey: 'missing-context' }, undefined as any)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(createConversionManifest(engine, { ...BASE, idempotencyKey: 'mismatched-source' }, {
      transport: 'stdio_mcp', remote: true, sourceId: 'other-source',
    })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(createConversionManifest(engine, { ...BASE, idempotencyKey: 'missing-client' }, {
      transport: 'oauth_http', remote: true, sourceId: BASE.sourceId, auth: { clientId: '' },
    })).rejects.toMatchObject({ code: 'permission_denied' });
    const oauth = await createConversionManifest(engine, { ...BASE, idempotencyKey: 'oauth-context' }, {
      transport: 'oauth_http', remote: true, sourceId: BASE.sourceId, auth: { clientId: 'validated.client' },
    });
    expect(oauth.receipt).toMatchObject({ producerKind: 'oauth_client', producerId: 'validated.client' });
    const stdio = await createConversionManifest(engine, { ...BASE, idempotencyKey: 'stdio-context' }, {
      transport: 'stdio_mcp', remote: true, sourceId: BASE.sourceId,
    });
    expect(stdio.receipt).toMatchObject({ producerKind: 'stdio_mcp', producerId: null });
  });

  test('same-hash replay is idempotent; semantic or source snapshot changes conflict', async () => {
    await setup();
      const first = await createConversionManifest(engine, { ...BASE }, LOCAL_CONTEXT);
      const replay = await createConversionManifest(engine, { ...BASE }, LOCAL_CONTEXT);
      expect(replay).toEqual({ created: false, receipt: first.receipt });
      await expect(createConversionManifest(engine, { ...BASE, converterVersion: '2' }, LOCAL_CONTEXT)).rejects.toMatchObject({ code: 'idempotency_conflict' });
      await expect(createConversionManifest(engine, { ...BASE, durationMs: 1000 }, LOCAL_CONTEXT)).rejects.toMatchObject({ code: 'idempotency_conflict' });
      await expect(createConversionManifest(engine, { ...BASE, risk: 'warning', reasonCodes: ['CONVERTER_WARNING'] }, LOCAL_CONTEXT)).rejects.toMatchObject({ code: 'invalid_params' });
      await engine.executeRaw(`UPDATE files SET content_hash='${'b'.repeat(64)}' WHERE id=7 AND source_id='${BASE.sourceId}'`);
      await expect(createConversionManifest(engine, { ...BASE }, LOCAL_CONTEXT)).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  test('unit kind is part of idempotency semantics', async () => {
    await setup();
    await createConversionManifest(engine, { ...BASE }, LOCAL_CONTEXT);
    await expect(createConversionManifest(engine, {
      ...BASE,
      unitKind: 'page',
      coverage: { total: 1, succeeded: 1, failed: 0, failedRanges: [] },
    }, LOCAL_CONTEXT)).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  test('persists only sanitized settings, warnings, and mapping section references', async () => {
    await setup();
    await engine.executeRaw("INSERT INTO pages(id,source_id,slug,type,title,compiled_truth) VALUES (70,$1,'synthetic-page','concept','Synthetic page','')", [BASE.sourceId]);
    const result = await createConversionManifest(engine, {
      ...BASE,
      adapterKind: 'image-import',
      settings: { format: 'path=/tmp/input.png https://example.test/x token=abc123' },
      warnings: [
        'warning /var/tmp/file https://warn.test token=secret',
        'Authorization: Bearer bearer-secret',
        'Authorization: Basic basic-secret',
        'Cookie: session=cookie-secret',
        'Windows C:\\Users\\synthetic\\private.txt POSIX /home/synthetic/private.txt',
        'https://example.test/callback?user=synthetic&password=url-secret',
      ],
      mappings: [{
        sourceRange: { kind: 'document' },
        derivedPageId: 70,
        derivedSourceId: BASE.sourceId,
        derivedPageSlug: 'synthetic-page',
        sectionRef: 'file:///private/x?password=secret',
      }],
    }, { transport: 'internal_adapter' });
    expect(result.receipt.settings).toEqual({ format: 'path=<redacted:path> <redacted:url> <redacted:credential>' });
    expect(result.receipt.warnings).toEqual([
      'warning <redacted:path> <redacted:url> <redacted:credential>',
      '<redacted:credential>',
      '<redacted:credential>',
      '<redacted:credential>',
      'Windows <redacted:path> POSIX <redacted:path>',
      '<redacted:url>',
    ]);
    expect(result.receipt.requestHash).not.toContain('/tmp/input.png');
    expect(result.receipt.requestHash).not.toContain('example.test');
    expect(await listConversionMappings(engine, result.receipt.receiptId)).toMatchObject([{ sectionRef: '<redacted:url>' }]);
    const replay = await createConversionManifest(engine, {
      ...BASE,
      adapterKind: 'image-import',
      settings: { format: 'path=/tmp/input.png https://example.test/x token=abc123' },
      warnings: [
        'warning /var/tmp/file https://warn.test token=secret',
        'Authorization: Bearer bearer-secret',
        'Authorization: Basic basic-secret',
        'Cookie: session=cookie-secret',
        'Windows C:\\Users\\synthetic\\private.txt POSIX /home/synthetic/private.txt',
        'https://example.test/callback?user=synthetic&password=url-secret',
      ],
      mappings: [{
        sourceRange: { kind: 'document' },
        derivedPageId: 70,
        derivedSourceId: BASE.sourceId,
        derivedPageSlug: 'synthetic-page',
        sectionRef: 'file:///private/x?password=secret',
        mappingOrdinal: 99,
        unitKind: 'document',
        durationMs: 999,
        chunkCount: 123,
      }],
    }, { transport: 'internal_adapter' });
    expect(replay.created).toBe(false);
  });
  test('malformed current file snapshots classify as corrupt without leaking normalization errors', async () => {
    await setup();
    await createConversionManifest(engine, { ...BASE }, LOCAL_CONTEXT);
    await engine.executeRaw("UPDATE files SET content_hash='malformed-hash', mime_type='malformed mime' WHERE id=7 AND source_id=$1", [BASE.sourceId]);
    const both = await verifyConversionManifestLinkage(engine, { sourceId: BASE.sourceId, fileId: BASE.fileId });
    expect(both).toMatchObject({ status: 'corrupt', matchesHash: false, matchesMime: false, reasons: ['DB_SOURCE_HASH_MISMATCH', 'DB_SOURCE_MIME_MISMATCH'] });
    await engine.executeRaw("UPDATE files SET content_hash=$1, mime_type='malformed mime' WHERE id=7 AND source_id=$2", [HASH, BASE.sourceId]);
    const badMime = await verifyConversionManifestLinkage(engine, { sourceId: BASE.sourceId, fileId: BASE.fileId });
    expect(badMime).toMatchObject({ status: 'corrupt', matchesHash: true, matchesMime: false, reasons: ['DB_SOURCE_MIME_MISMATCH'] });
    await engine.executeRaw("UPDATE files SET content_hash='malformed-hash', mime_type='text/plain' WHERE id=7 AND source_id=$1", [BASE.sourceId]);
    const badHash = await verifyConversionManifestLinkage(engine, { sourceId: BASE.sourceId, fileId: BASE.fileId });
    expect(badHash).toMatchObject({ status: 'corrupt', matchesHash: false, matchesMime: true, reasons: ['DB_SOURCE_HASH_MISMATCH'] });
  });

  test('source isolation, missing/unsupported inspection, and mapping guards are explicit', async () => {
    await setup();
    expect(await inspectConversionFile(engine, { sourceId: BASE.sourceId, fileId: BASE.fileId })).toMatchObject({ state: 'legacy_absent' });
    await expect(createConversionManifest(engine, { ...BASE, sourceId: 'other-source' }, LOCAL_CONTEXT)).rejects.toMatchObject({ code: expect.any(String) });
    expect(await inspectConversionFile(engine, { sourceId: BASE.sourceId, fileId: 999 })).toMatchObject({ state: 'file_missing' });
    await expect(createConversionManifest(engine, { ...BASE, mappings: [{ sourceRange: { kind: 'ordinal', unitKind: 'page', start: 0, end: 1 }, derivedPageId: 404, derivedSourceId: BASE.sourceId, derivedPageSlug: 'missing' }] }, LOCAL_CONTEXT)).rejects.toThrow();
  });

  test('DB linkage status and physical ByteCheck remain separate contracts', async () => {
    await setup();
    const legacy = await verifyConversionManifestLinkage(engine, { sourceId: BASE.sourceId, fileId: BASE.fileId });
    expect(legacy).toEqual({
      status: 'legacy_absent',
      matchesHash: null,
      matchesMime: null,
      reasons: [],
      byteCheck: { reason: 'not_requested', reasons: [] },
    });
    const result = await verifyConversionManifestLinkage(engine, { sourceId: BASE.sourceId, fileId: 999, physical: false });
    expect(result).toMatchObject({ status: 'file_missing', byteCheck: { reason: 'not_requested', reasons: [] } });
    expect(result.reasons).not.toContain('not_requested');
  });
  test('linkage precedence preserves baseline on physical unavailable/read errors and reports unsupported', async () => {
    await setup();
      await createConversionManifest(engine, { ...BASE }, LOCAL_CONTEXT);
      const unavailable = await verifyConversionManifestLinkage(engine, { sourceId: BASE.sourceId, fileId: BASE.fileId, physical: true });
      expect(unavailable).toMatchObject({ status: 'verified', reasons: ['PHYSICAL_SOURCE_UNAVAILABLE'], byteCheck: { reason: 'unavailable', reasons: [] } });
      const readError = await verifyConversionManifestLinkage(engine, { sourceId: BASE.sourceId, fileId: BASE.fileId, physical: true, byteReader: async () => { throw new Error('synthetic read error'); } });
      expect(readError).toMatchObject({ status: 'verified', reasons: ['PHYSICAL_SOURCE_UNAVAILABLE'], byteCheck: { reason: 'read_error', reasons: [] } });
      const unsupportedEngine = {
        executeRaw: async (sql: string) => sql.includes('FROM files')
          ? [{ id: BASE.fileId, source_id: BASE.sourceId, content_hash: HASH, mime_type: 'text/plain', created_at: new Date() }]
          : [{ manifest_version: 2, started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:00Z' }],
      } as unknown as BrainEngine;
      expect(await verifyConversionManifestLinkage(unsupportedEngine, { sourceId: BASE.sourceId, fileId: BASE.fileId })).toMatchObject({ status: 'unsupported', reasons: ['UNSUPPORTED_MANIFEST_VERSION'] });
  });
});
