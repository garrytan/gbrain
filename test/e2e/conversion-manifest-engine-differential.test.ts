import { describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ConversionManifestInput } from '../../src/core/conversion-manifest.ts';
import { createConversionManifest, listConversionManifests } from '../../src/core/conversion-manifest.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const HASH = 'c'.repeat(64);
type Seed = { sourceId: string; fileId: number };
const seeds: Seed[] = [
  { sourceId: 'synthetic-differential-source-a', fileId: 1901 },
  { sourceId: 'synthetic-differential-source-b', fileId: 1902 },
];
const input = (seed: Seed, key: string) => ({
  sourceId: seed.sourceId, fileId: seed.fileId, idempotencyKey: key, adapterKind: 'synthetic-adapter', sourceVisualKind: 'text', converter: 'synthetic-converter', converterVersion: '1', settings: {}, unitKind: 'document', coverage: { total: 1, succeeded: 1, failed: 0, failedRanges: [] }, candidates: {}, confidence: null, ocr: {}, imageDimensions: null, unreadableRegions: [], warnings: [], mappings: [], producer: { kind: 'local_cli', id: null }, transport: 'local_cli', remote: false,
} satisfies ConversionManifestInput);

async function prepare(engine: BrainEngine, seed: Seed): Promise<void> {
  await engine.connect(engine.kind === 'postgres' ? { database_url: DATABASE_URL as string } : {});
  await engine.initSchema();
  await engine.executeRaw('TRUNCATE conversion_manifest_mappings, conversion_manifests');
  await engine.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [seed.sourceId]);
  await engine.executeRaw('INSERT INTO files(id,source_id,filename,content_hash,mime_type,storage_path) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [seed.fileId, seed.sourceId, `synthetic-${seed.fileId}.txt`, HASH, 'text/plain', `synthetic-${seed.fileId}`]);
}

type Outcome = { ok: boolean; created: boolean | null; order: string[]; error: string | null };
async function outcome(engine: BrainEngine, seed: Seed, key: string): Promise<Outcome> {
  try {
    const created = await createConversionManifest(engine, input(seed, key));
    const listed = await listConversionManifests(engine, seed.sourceId, { fileId: seed.fileId });
    return { ok: true, created: created.created, order: listed.map((row: unknown) => { if (typeof row !== 'object' || row === null || !('idempotencyKey' in row) || typeof row.idempotencyKey !== 'string') throw new Error('invalid manifest row'); return row.idempotencyKey; }), error: null };
  } catch (error: unknown) {
    const record = typeof error === 'object' && error !== null ? error as { code?: unknown } : {};
    return { ok: false, created: null, order: [], error: typeof record.code === 'string' ? record.code : error instanceof Error ? error.name : 'unknown_error' };
  }
}

describe.skipIf(!DATABASE_URL)('conversion manifest PGLite/Postgres differential', () => {
  for (const seed of seeds) {
    test(`create/replay/order/validation are engine-independent for ${seed.sourceId}`, async () => {
      const pglite = new PGLiteEngine();
      const postgres = new PostgresEngine();
      try {
        await prepare(pglite, seed); await prepare(postgres, seed);
        const pgliteResults = [await outcome(pglite, seed, 'synthetic-b'), await outcome(pglite, seed, 'synthetic-a'), await outcome(pglite, seed, 'synthetic-a')];
        const postgresResults = [await outcome(postgres, seed, 'synthetic-b'), await outcome(postgres, seed, 'synthetic-a'), await outcome(postgres, seed, 'synthetic-a')];
        expect(postgresResults.map(({ order: _order, ...result }) => result)).toEqual(pgliteResults.map(({ order: _order, ...result }) => result));
        expect(postgresResults.map((result) => result.order)).toEqual(pgliteResults.map((result) => result.order));
        const invalidPglite = await outcome(pglite, seed, 'bad key with spaces');
        const invalidPostgres = await outcome(postgres, seed, 'bad key with spaces');
        expect(invalidPostgres).toMatchObject({ ok: invalidPglite.ok, error: invalidPglite.error });
      } finally { await pglite.disconnect(); await postgres.disconnect(); }
    });
  }
});
