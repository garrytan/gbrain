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
  producer: { kind: 'local_cli', id: null }, transport: 'local_cli', remote: false,
} satisfies ConversionManifestInput;

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
      const first = await createConversionManifest(engine, { ...BASE });
      expect(first.created).toBe(true);
      const receipt = await getConversionManifest(engine, first.receipt.receiptId);
      expect(receipt?.sourceId).toBe(BASE.sourceId);
      expect((await listConversionManifests(engine, BASE.sourceId, { fileId: 7 })).map((r) => r.receiptId)).toEqual([first.receipt.receiptId]);
      expect(await listConversionMappings(engine, first.receipt.receiptId)).toEqual([]);
      await expect(engine.executeRaw(`UPDATE conversion_manifests SET risk='warning' WHERE receipt_id='${first.receipt.receiptId}'`)).rejects.toThrow();
  });

  test('same-hash replay is idempotent; semantic or source snapshot changes conflict', async () => {
    await setup();
      const first = await createConversionManifest(engine, { ...BASE });
      const replay = await createConversionManifest(engine, { ...BASE });
      expect(replay).toEqual({ created: false, receipt: first.receipt });
      await expect(createConversionManifest(engine, { ...BASE, converterVersion: '2' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
      await expect(createConversionManifest(engine, { ...BASE, risk: 'warning', reasonCodes: ['CONVERTER_WARNING'] })).rejects.toMatchObject({ code: 'invalid_params' });
      await engine.executeRaw(`UPDATE files SET content_hash='${'b'.repeat(64)}' WHERE id=7 AND source_id='${BASE.sourceId}'`);
      await expect(createConversionManifest(engine, { ...BASE })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  test('source isolation, missing/unsupported inspection, and mapping guards are explicit', async () => {
    await setup();
      await expect(createConversionManifest(engine, { ...BASE, sourceId: 'other-source' })).rejects.toMatchObject({ code: expect.any(String) });
      expect(await inspectConversionFile(engine, { sourceId: BASE.sourceId, fileId: 999 })).toMatchObject({ state: 'file_missing' });
      await expect(createConversionManifest(engine, { ...BASE, mappings: [{ sourceRange: { kind: 'ordinal', unitKind: 'page', start: 0, end: 1 }, derivedPageId: 404, derivedSourceId: BASE.sourceId, derivedPageSlug: 'missing' }] })).rejects.toThrow();
  });

  test('DB linkage status and physical ByteCheck remain separate contracts', async () => {
    await setup();
      const result = await verifyConversionManifestLinkage(engine, { sourceId: BASE.sourceId, fileId: 999, physical: false });
      expect(result).toMatchObject({ status: 'file_missing', byteCheck: { reason: 'not_requested', reasons: [] } });
      expect(result.reasons).not.toContain('not_requested');
  });
  test('linkage precedence preserves baseline on physical unavailable/read errors and reports unsupported', async () => {
    await setup();
      await createConversionManifest(engine, { ...BASE });
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
