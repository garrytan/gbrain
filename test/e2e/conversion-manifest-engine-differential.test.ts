import { describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ConversionManifestInput } from '../../src/core/conversion-manifest.ts';
import {
  createConversionManifest, getConversionManifest, inspectConversionFile,
  listConversionMappings, listConversionManifests, verifyConversionManifestLinkage,
} from '../../src/core/conversion-manifest.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const HASH = 'c'.repeat(64);
type Seed = { sourceId: string; fileId: number; pageId: number };
const seeds: Seed[] = [
  { sourceId: 'synthetic-differential-source-a', fileId: 1901, pageId: 2901 },
  { sourceId: 'synthetic-differential-source-b', fileId: 1902, pageId: 2902 },
];
const input = (seed: Seed, key: string): ConversionManifestInput => ({
  sourceId: seed.sourceId, fileId: seed.fileId, idempotencyKey: key,
  adapterKind: 'synthetic-adapter', sourceVisualKind: 'text', converter: 'synthetic-converter', converterVersion: '1',
  settings: {}, unitKind: 'document', coverage: { total: 1, succeeded: 1, failed: 0, failedRanges: [] },
  candidates: {}, confidence: null, ocr: {}, imageDimensions: null, unreadableRegions: [], warnings: [], mappings: [],
});
const context = { transport: 'local_cli', remote: false } as const;
type Normalized = { ok: boolean; value?: unknown; error?: string };
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (['receiptId', 'startedAt', 'completedAt', 'requestHash'].includes(key)) continue;
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
};
async function call(fn: () => Promise<unknown>): Promise<Normalized> {
  try { return { ok: true, value: normalize(await fn()) }; }
  catch (error: unknown) {
    const record = typeof error === 'object' && error !== null ? error as { code?: unknown } : {};
    return { ok: false, error: typeof record.code === 'string' ? record.code : error instanceof Error ? error.name : 'unknown_error' };
  }
}
async function prepare(engine: BrainEngine, seed: Seed): Promise<void> {
  await engine.connect(engine.kind === 'postgres' ? { database_url: DATABASE_URL as string } : {});
  await engine.initSchema();
  await engine.executeRaw('TRUNCATE conversion_manifest_mappings, conversion_manifests');
  await engine.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [seed.sourceId]);
  await engine.executeRaw('INSERT INTO files(id,source_id,filename,content_hash,mime_type,storage_path) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [seed.fileId, seed.sourceId, `synthetic-${seed.fileId}.txt`, HASH, 'text/plain', `synthetic-${seed.fileId}`]);
  await engine.executeRaw("INSERT INTO pages(id,source_id,slug,type,title,compiled_truth) VALUES ($1,$2,$3,'concept','Synthetic page','') ON CONFLICT DO NOTHING", [seed.pageId, seed.sourceId, `synthetic-page-${seed.fileId}`]);
  await engine.executeRaw('INSERT INTO content_chunks(page_id,chunk_index,chunk_text) VALUES ($1,0,$2),($1,1,$3) ON CONFLICT DO NOTHING', [seed.pageId, 'synthetic chunk zero', 'synthetic chunk one']);
}
async function withUnsupportedManifestSnapshot<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  const constraint = 'conversion_manifests_manifest_version_check';
  let dropped = false;
  let disabled = false;
  try {
    await engine.executeRaw(`ALTER TABLE conversion_manifests DROP CONSTRAINT IF EXISTS ${constraint}`);
    dropped = true;
    await engine.executeRaw('ALTER TABLE conversion_manifests DISABLE TRIGGER conversion_manifest_immutable');
    disabled = true;
    await engine.executeRaw('UPDATE conversion_manifests SET manifest_version=2');
    return await fn();
  } finally {
    try {
      if (disabled) await engine.executeRaw('UPDATE conversion_manifests SET manifest_version=1');
    } finally {
      try {
        if (dropped) await engine.executeRaw(`ALTER TABLE conversion_manifests ADD CONSTRAINT ${constraint} CHECK (manifest_version=1)`);
      } finally {
        if (disabled) await engine.executeRaw('ALTER TABLE conversion_manifests ENABLE TRIGGER conversion_manifest_immutable');
      }
    }
  }
}
type Snapshot = { manifests: Record<string, unknown>[]; mappings: Record<string, unknown>[] };
async function snapshot(engine: BrainEngine, seed: Seed): Promise<Snapshot> {
  const manifests = await engine.executeRaw<Record<string, unknown>>(
    'SELECT * FROM conversion_manifests WHERE source_id=$1 AND file_id=$2 ORDER BY idempotency_key',
    [seed.sourceId, seed.fileId],
  );
  const mappings = await engine.executeRaw<Record<string, unknown>>(
    'SELECT m.idempotency_key, x.mapping_ordinal, x.source_range, x.derived_page_id, x.derived_source_id, x.derived_page_slug, x.section_ref, x.chunk_start, x.chunk_end FROM conversion_manifest_mappings x JOIN conversion_manifests m ON m.receipt_id=x.receipt_id WHERE m.source_id=$1 AND m.file_id=$2 ORDER BY m.idempotency_key, x.mapping_ordinal',
    [seed.sourceId, seed.fileId],
  );
  const manifestFields = ['source_id', 'file_id', 'source_sha256', 'source_mime_type', 'manifest_version', 'idempotency_key', 'producer_kind', 'producer_id', 'adapter_kind', 'source_visual_kind', 'converter', 'converter_version', 'model', 'model_version', 'settings', 'unit_kind', 'total_units', 'succeeded_units', 'failed_units', 'duration_ms', 'failed_ranges', 'candidates', 'confidence', 'ocr', 'image_dimensions', 'unreadable_regions', 'adapter_warnings', 'risk', 'reason_codes'];
  const manifest = (row: Record<string, unknown>) => Object.fromEntries(manifestFields.map((key) => [
    key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    ['file_id', 'manifest_version', 'total_units', 'succeeded_units', 'failed_units'].includes(key) ? Number(row[key]) : row[key],
  ]));
  return {
    manifests: manifests.map(manifest),
    mappings: mappings.map((row) => ({
      idempotencyKey: row.idempotency_key, mappingOrdinal: Number(row.mapping_ordinal), sourceRange: row.source_range,
      derivedPageId: Number(row.derived_page_id), derivedSourceId: row.derived_source_id, derivedPageSlug: row.derived_page_slug,
      sectionRef: row.section_ref, chunkStart: row.chunk_start == null ? null : Number(row.chunk_start), chunkEnd: row.chunk_end == null ? null : Number(row.chunk_end),
    })),
  };
}
type OperationExpected = { value: unknown; delta: [number, number]; keys?: string[]; mappings?: Record<string, unknown>[] } | { error: string; delta: [number, number] };
async function operation(
  pglite: BrainEngine, postgres: BrainEngine, seed: Seed, fn: (engine: BrainEngine) => Promise<unknown>, expected: OperationExpected,
): Promise<void> {
  const beforeP = await snapshot(pglite, seed);
  const beforeG = await snapshot(postgres, seed);
  const left = await call(() => fn(pglite));
  const right = await call(() => fn(postgres));
  const check = async (result: Normalized, before: Snapshot, engine: BrainEngine) => {
    const target = 'error' in expected ? { ok: false, error: expected.error } : { ok: true, value: normalize(expected.value) };
    expect(result).toEqual(target);
    const after = await snapshot(engine, seed);
    if (expected.delta[0] === 0 && expected.delta[1] === 0) {
      expect(after).toEqual(before);
      return;
    }
    const keys = 'keys' in expected ? expected.keys ?? [] : [];
    const added = after.manifests.filter((row) => !before.manifests.some((old) => old.idempotencyKey === row.idempotencyKey));
    expect(added.map((row) => row.idempotencyKey)).toEqual(keys);
    expect(added).toEqual(keys.map((key) => snapshotManifestExpected(seed, key)));
    const addedMappings = after.mappings.filter((row) => !before.mappings.some((old) => old.idempotencyKey === row.idempotencyKey && old.mappingOrdinal === row.mappingOrdinal));
    expect(addedMappings).toEqual('mappings' in expected ? expected.mappings ?? [] : []);
    expect(after.manifests.filter((row) => before.manifests.some((old) => old.idempotencyKey === row.idempotencyKey))).toEqual(before.manifests);
    const removed = before.manifests.filter((row) => !after.manifests.some((old) => old.idempotencyKey === row.idempotencyKey));
    expect(removed).toEqual([]);
    const changed = before.manifests.filter((row) => after.manifests.some((old) => old.idempotencyKey === row.idempotencyKey && JSON.stringify(old) !== JSON.stringify(row)));
    expect(changed).toEqual([]);
    const removedMappings = before.mappings.filter((row) => !after.mappings.some((old) => old.idempotencyKey === row.idempotencyKey && old.mappingOrdinal === row.mappingOrdinal));
    expect(removedMappings).toEqual([]);
    expect(after.mappings.filter((row) => before.mappings.some((old) => old.idempotencyKey === row.idempotencyKey && old.mappingOrdinal === row.mappingOrdinal))).toEqual(before.mappings);
  };
  await check(left, beforeP, pglite);
  await check(right, beforeG, postgres);
  expect(right).toEqual(left);
  expect(await snapshot(pglite, seed)).toEqual(await snapshot(postgres, seed));
}
const value = (result: unknown, delta: [number, number], keys: string[] = [], mappings: Record<string, unknown>[] = []): OperationExpected => ({ value: result, delta, keys, mappings });
const failure = (code: string, delta: [number, number]): OperationExpected => ({ error: code, delta });
const manifestExpected = (seed: Seed, key: string) => ({
  sourceId: seed.sourceId, fileId: seed.fileId, sourceSha256: HASH, sourceMimeType: 'text/plain', manifestVersion: 1,
  idempotencyKey: key, producerKind: 'local_cli', producerId: null, adapterKind: 'synthetic-adapter',
  sourceVisualKind: 'text', converter: 'synthetic-converter', converterVersion: '1', model: null, modelVersion: null,
  settings: {}, unitKind: 'document', totalUnits: 1, succeededUnits: 1, failedUnits: 0, durationMs: null,
  failedRanges: [], candidates: {}, confidence: null, ocr: {}, imageDimensions: null, unreadableRegions: [], warnings: [],
  risk: 'pass', reasonCodes: [],
});
const snapshotManifestExpected = (seed: Seed, key: string) => {
  const { warnings, ...manifest } = manifestExpected(seed, key);
  return { ...manifest, adapterWarnings: warnings };
};

// This suite deliberately stays sequential: each case mutates a synthetic source snapshot.
describe.skipIf(!DATABASE_URL)('conversion manifest PGLite/Postgres differential', () => {
  for (const seed of seeds) {
    test(`complete foundation contract is engine-independent for ${seed.sourceId}`, async () => {
      const pglite = new PGLiteEngine();
      const postgres = new PostgresEngine();
      try {
        await prepare(pglite, seed); await prepare(postgres, seed);
        await operation(pglite, postgres, seed, (engine) => createConversionManifest(engine, input(seed, 'synthetic-b'), context), value({ created: true, receipt: manifestExpected(seed, 'synthetic-b') }, [1, 0], ['synthetic-b']));
        const receiptIds = {
          pglite: (await listConversionManifests(pglite, seed.sourceId, { fileId: seed.fileId }))[0]?.receiptId,
          postgres: (await listConversionManifests(postgres, seed.sourceId, { fileId: seed.fileId }))[0]?.receiptId,
        };
        expect(receiptIds.pglite).toBeTruthy(); expect(receiptIds.postgres).toBeTruthy();
        await operation(pglite, postgres, seed, (engine) => getConversionManifest(engine, engine === pglite ? receiptIds.pglite as string : receiptIds.postgres as string), value(manifestExpected(seed, 'synthetic-b'), [0, 0]));
        await operation(pglite, postgres, seed, (engine) => listConversionManifests(engine, seed.sourceId, { fileId: seed.fileId }), value([manifestExpected(seed, 'synthetic-b')], [0, 0]));
        await operation(pglite, postgres, seed, (engine) => listConversionMappings(engine, engine === pglite ? receiptIds.pglite as string : receiptIds.postgres as string), value([], [0, 0]));
        await operation(pglite, postgres, seed, (engine) => inspectConversionFile(engine, { sourceId: seed.sourceId, fileId: seed.fileId }), value({ state: 'receipt_found' }, [0, 0]));
        await operation(pglite, postgres, seed, (engine) => verifyConversionManifestLinkage(engine, { sourceId: seed.sourceId, fileId: seed.fileId }), value({ status: 'verified', matchesHash: true, matchesMime: true, reasons: [], byteCheck: { reason: 'not_requested', reasons: [] } }, [0, 0]));

        await operation(pglite, postgres, seed, (engine) => withUnsupportedManifestSnapshot(engine, async () => ({
          inspect: await inspectConversionFile(engine, { sourceId: seed.sourceId, fileId: seed.fileId }),
          linkage: await verifyConversionManifestLinkage(engine, { sourceId: seed.sourceId, fileId: seed.fileId }),
        })), value({
          inspect: { state: 'unsupported_manifest_version' },
          linkage: { status: 'unsupported', matchesHash: null, matchesMime: null, reasons: ['UNSUPPORTED_MANIFEST_VERSION'], byteCheck: { reason: 'not_requested', reasons: [] } },
        }, [0, 0]));

        await operation(pglite, postgres, seed, (engine) => createConversionManifest(engine, input(seed, 'synthetic-b'), context), value({ created: false, receipt: manifestExpected(seed, 'synthetic-b') }, [0, 0]));
        await operation(pglite, postgres, seed, (engine) => createConversionManifest(engine, input(seed, 'synthetic-a'), context), value({ created: true, receipt: manifestExpected(seed, 'synthetic-a') }, [1, 0], ['synthetic-a']));
        await operation(pglite, postgres, seed, (engine) => createConversionManifest(engine, input(seed, 'bad key with spaces'), context), failure('invalid_params', [0, 0]));
        await operation(pglite, postgres, seed, (engine) => createConversionManifest(engine, { ...input(seed, 'missing-source'), sourceId: 'synthetic-missing-source' }, context), failure('invalid_source_file', [0, 0]));

        const mapped = { ...input(seed, 'mapped'), mappings: [{ sourceRange: { kind: 'document' as const }, derivedPageId: seed.pageId, derivedSourceId: seed.sourceId, derivedPageSlug: `synthetic-page-${seed.fileId}`, sectionRef: 'synthetic-section', chunkStart: 0, chunkEnd: 2 }] };
        await operation(pglite, postgres, seed, (engine) => createConversionManifest(engine, mapped, context), value({ created: true, receipt: manifestExpected(seed, 'mapped') }, [1, 1], ['mapped'], [{ idempotencyKey: 'mapped', mappingOrdinal: 0, sourceRange: { kind: 'document' }, derivedPageId: seed.pageId, derivedSourceId: seed.sourceId, derivedPageSlug: `synthetic-page-${seed.fileId}`, sectionRef: 'synthetic-section', chunkStart: 0, chunkEnd: 2 }]));
        const mappedReceipts = { pglite: (await listConversionManifests(pglite, seed.sourceId, { fileId: seed.fileId })).find((row) => row.idempotencyKey === 'mapped')?.receiptId, postgres: (await listConversionManifests(postgres, seed.sourceId, { fileId: seed.fileId })).find((row) => row.idempotencyKey === 'mapped')?.receiptId };
        expect(mappedReceipts.pglite).toBeTruthy(); expect(mappedReceipts.postgres).toBeTruthy();
        await operation(pglite, postgres, seed, (engine) => listConversionMappings(engine, engine === pglite ? mappedReceipts.pglite as string : mappedReceipts.postgres as string), value([{ mappingOrdinal: 0, sourceRange: { kind: 'document' }, derivedPageId: seed.pageId, derivedSourceId: seed.sourceId, derivedPageSlug: `synthetic-page-${seed.fileId}`, sectionRef: 'synthetic-section', chunkStart: 0, chunkEnd: 2 }], [0, 0]));

        for (const badMapping of [
          { sourceRange: { kind: 'document' as const }, derivedPageId: seed.pageId + 99, derivedSourceId: seed.sourceId, derivedPageSlug: 'missing-page' },
          { sourceRange: { kind: 'document' as const }, derivedPageId: seed.pageId, derivedSourceId: seed.sourceId, derivedPageSlug: `synthetic-page-${seed.fileId}`, chunkStart: 1, chunkEnd: 4 },
        ]) {
          const key = badMapping.derivedPageId === seed.pageId ? 'bad-chunk' : 'bad-target';
          await operation(pglite, postgres, seed, (engine) => createConversionManifest(engine, { ...input(seed, key), mappings: [badMapping] }, context), failure('invalid_params', [0, 0]));
        }

        await operation(pglite, postgres, seed, (engine) => engine.executeRaw("UPDATE files SET content_hash='malformed-hash', mime_type='malformed mime' WHERE id=$1", [seed.fileId]), value([], [0, 0]));
        await operation(pglite, postgres, seed, (engine) => verifyConversionManifestLinkage(engine, { sourceId: seed.sourceId, fileId: seed.fileId }), value({ status: 'corrupt', matchesHash: false, matchesMime: false, reasons: ['DB_SOURCE_HASH_MISMATCH', 'DB_SOURCE_MIME_MISMATCH'], byteCheck: { reason: 'not_requested', reasons: [] } }, [0, 0]));
        await operation(pglite, postgres, seed, (engine) => verifyConversionManifestLinkage(engine, { sourceId: seed.sourceId, fileId: seed.fileId, physical: true, bytes: new TextEncoder().encode('not-the-source') }), value({ status: 'corrupt', matchesHash: false, matchesMime: false, reasons: ['DB_SOURCE_HASH_MISMATCH', 'DB_SOURCE_MIME_MISMATCH', 'PHYSICAL_SOURCE_HASH_MISMATCH'], byteCheck: { reason: 'checked_mismatch', reasons: [] } }, [0, 0]));
        await operation(pglite, postgres, seed, (engine) => verifyConversionManifestLinkage(engine, { sourceId: seed.sourceId, fileId: seed.fileId, physical: true }), value({ status: 'corrupt', matchesHash: false, matchesMime: false, reasons: ['DB_SOURCE_HASH_MISMATCH', 'DB_SOURCE_MIME_MISMATCH', 'PHYSICAL_SOURCE_UNAVAILABLE'], byteCheck: { reason: 'unavailable', reasons: [] } }, [0, 0]));
        await operation(pglite, postgres, seed, (engine) => verifyConversionManifestLinkage(engine, { sourceId: seed.sourceId, fileId: seed.fileId, physical: true, byteReader: async () => { throw new Error('read failed'); } }), value({ status: 'corrupt', matchesHash: false, matchesMime: false, reasons: ['DB_SOURCE_HASH_MISMATCH', 'DB_SOURCE_MIME_MISMATCH', 'PHYSICAL_SOURCE_UNAVAILABLE'], byteCheck: { reason: 'read_error', reasons: [] } }, [0, 0]));
        await operation(pglite, postgres, seed, (engine) => engine.executeRaw('UPDATE files SET content_hash=$1,mime_type=$2 WHERE id=$3', [HASH, 'text/plain', seed.fileId]), value([], [0, 0]));
        await operation(pglite, postgres, seed, (engine) => verifyConversionManifestLinkage(engine, { sourceId: seed.sourceId, fileId: seed.fileId, physical: true }), value({ status: 'verified', matchesHash: true, matchesMime: true, reasons: ['PHYSICAL_SOURCE_UNAVAILABLE'], byteCheck: { reason: 'unavailable', reasons: [] } }, [0, 0]));
        await operation(pglite, postgres, seed, (engine) => verifyConversionManifestLinkage(engine, { sourceId: seed.sourceId, fileId: seed.fileId, physical: true, byteReader: async () => { throw new Error('read failed'); } }), value({ status: 'verified', matchesHash: true, matchesMime: true, reasons: ['PHYSICAL_SOURCE_UNAVAILABLE'], byteCheck: { reason: 'read_error', reasons: [] } }, [0, 0]));
        await operation(pglite, postgres, seed, (engine) => verifyConversionManifestLinkage(engine, { sourceId: seed.sourceId, fileId: seed.fileId, physical: true, transport: 'oauth_http', bytes: new TextEncoder().encode('not-the-source') }), value({ status: 'verified', matchesHash: true, matchesMime: true, reasons: [], byteCheck: { reason: 'remote_caller', reasons: [] } }, [0, 0]));

        const race = async (engine: BrainEngine) => (await Promise.all([createConversionManifest(engine, input(seed, 'synthetic-race'), context), createConversionManifest(engine, input(seed, 'synthetic-race'), context)])).map((result) => result.created).sort();
        await operation(pglite, postgres, seed, race, value([false, true], [1, 0], ['synthetic-race']));
      } finally { await pglite.disconnect(); await postgres.disconnect(); }
    }, 30_000);
  }
});
