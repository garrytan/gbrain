import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
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

const TABLES = ['conversion_manifest_mappings', 'conversion_manifests'] as const;
const INDEXES = [
  'files_id_source_unique',
  'pages_id_source_unique',
  'idx_conversion_manifest_file_latest',
  'idx_conversion_manifest_risk',
] as const;
const TRIGGERS: Array<[string, string]> = [
  ['conversion_manifest_immutable', 'conversion_manifests'],
  ['conversion_mapping_immutable', 'conversion_manifest_mappings'],
  ['conversion_mapping_source_guard', 'conversion_manifest_mappings'],
];
const PLATFORM_REASONS = [
  'DB_SOURCE_FILE_MISSING', 'DB_SOURCE_HASH_MISMATCH', 'DB_SOURCE_MIME_MISMATCH',
  'PHYSICAL_SOURCE_HASH_MISMATCH', 'PHYSICAL_SOURCE_UNAVAILABLE', 'COVERAGE_INVALID',
  'COVERAGE_LOSS', 'MAPPING_MISSING', 'UNREADABLE_REGION', 'VISUAL_CANDIDATE',
  'CONFIDENCE_BELOW_POLICY', 'CONVERTER_WARNING', 'OBSERVATION_INCOMPLETE',
  'UNSUPPORTED_MANIFEST_VERSION',
] as const;


describe('conversion evidence v123 schema foundation', () => {
  test('migration and bootstrap create exactly the additive receipt tables', async () => {
      expect(LATEST_VERSION).toBeGreaterThanOrEqual(123);
      const rows = await engine.executeRaw<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema='public' AND table_name LIKE 'conversion_manifest%'
         ORDER BY table_name`,
      );
      expect(rows.map((row) => row.table_name)).toEqual([...TABLES]);
      const indexes = await engine.executeRaw<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname='public' AND indexname = ANY($1::text[])
         ORDER BY indexname`,
        [[...INDEXES]],
      );
      expect(indexes.map((row) => row.indexname)).toEqual([...INDEXES].sort());
  });
  test('reason_codes enforce the closed PlatformReason vocabulary', async () => {
      const file = await engine.executeRaw<{ id: number }>(
        `INSERT INTO files(source_id,filename,storage_path,content_hash)
         VALUES ('default','synthetic-reasons.txt','/synthetic/reasons.txt',repeat('a',64))
         RETURNING id`,
      );
      const insert = (reasonSql: string, key: string) => engine.executeRaw(`
        INSERT INTO conversion_manifests (
          receipt_id,source_id,file_id,source_sha256,source_mime_type,manifest_version,
          idempotency_key,request_hash,producer_kind,producer_id,adapter_kind,
          source_visual_kind,converter,converter_version,settings,started_at,completed_at,
          unit_kind,total_units,succeeded_units,failed_units,duration_ms,failed_ranges,
          candidates,ocr,unreadable_regions,adapter_warnings,risk,reason_codes
        ) VALUES (
          gen_random_uuid(),'default',${file[0].id},repeat('b',64),'text/plain',1,
          '${key}',repeat('c',64),'internal_adapter',NULL,'synthetic','text',
          'synthetic-converter','1','{}'::jsonb,'2026-01-01T00:00:00Z',
          '2026-01-01T00:00:00Z','document',1,1,0,NULL,'[]'::jsonb,'{}'::jsonb,
          '{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'pass',${reasonSql}
        )
      `);
      await insert(`ARRAY['DB_SOURCE_FILE_MISSING','COVERAGE_LOSS']::text[]`, 'synthetic-valid-reasons');
      await expect(insert(`ARRAY['BYTE_CHECK']::text[]`, 'synthetic-byte-check')).rejects.toBeDefined();
      await expect(insert(`ARRAY['COVERAGE_LOSS','COVERAGE_LOSS']::text[]`, 'synthetic-duplicate')).rejects.toBeDefined();
      await expect(insert(`ARRAY['NOT_A_PLATFORM_REASON']::text[]`, 'synthetic-unknown')).rejects.toBeDefined();
  });

  test('catalog exposes UUID/hash/MIME/idempotency/producer and coverage constraints', async () => {
      const columns = await engine.executeRaw<{ column_name: string; is_nullable: string }>(
        `SELECT column_name,is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name='conversion_manifests'`,
      );
      const required = ['receipt_id','source_id','file_id','source_sha256','source_mime_type','idempotency_key','request_hash','producer_kind','producer_id','settings','failed_ranges','candidates','confidence','ocr','unreadable_regions','adapter_warnings','total_units','succeeded_units','failed_units'];
      expect(required.every((name) => columns.some((column) => column.column_name === name))).toBe(true);
      const constraints = await engine.executeRaw<{ constraint_name: string; constraint_type: string }>(
        `SELECT constraint_name,constraint_type FROM information_schema.table_constraints
         WHERE table_schema='public' AND table_name IN ('conversion_manifests','conversion_manifest_mappings')
           AND constraint_type IN ('CHECK','FOREIGN KEY','UNIQUE')
         ORDER BY constraint_type, constraint_name`,
      );
      const namedConstraints = new Set([
        'conversion_manifest_counts',
        'conversion_mapping_chunk_bounds',
        'conversion_manifest_file_source_fk',
        'conversion_mapping_page_source_fk',
        'conversion_manifest_idempotency_unique',
      ]);
      const byType = (type: string) => constraints
        .filter((row) => row.constraint_type === type && namedConstraints.has(row.constraint_name))
        .map((row) => row.constraint_name);
      expect(byType('CHECK')).toEqual(['conversion_manifest_counts', 'conversion_mapping_chunk_bounds']);
      expect(byType('FOREIGN KEY')).toEqual(['conversion_manifest_file_source_fk', 'conversion_mapping_page_source_fk']);
      expect(byType('UNIQUE')).toEqual(['conversion_manifest_idempotency_unique']);
  });

  test('composite file/page foreign keys and append-only guards are installed', async () => {
      const fks = await engine.executeRaw<{ constraint_name: string; table_name: string }>(
        `SELECT constraint_name,table_name FROM information_schema.table_constraints
         WHERE table_schema='public' AND constraint_type='FOREIGN KEY'
           AND table_name IN ('conversion_manifests','conversion_manifest_mappings')
           AND constraint_name IN ('conversion_manifest_file_source_fk','conversion_mapping_page_source_fk')
         ORDER BY table_name,constraint_name`,
      );
      expect(fks.map((row) => row.constraint_name)).toEqual([
        'conversion_mapping_page_source_fk',
        'conversion_manifest_file_source_fk',
      ]);
      const triggers = await engine.executeRaw<{ trigger_name: string; event_object_table: string }>(
        `SELECT trigger_name,event_object_table FROM information_schema.triggers
         WHERE trigger_schema='public' AND event_object_table IN ('conversion_manifests','conversion_manifest_mappings')
         ORDER BY event_object_table,trigger_name`,
      );
      expect([...new Set(triggers.map((row) => `${row.trigger_name}\0${row.event_object_table}`))]
        .map((value) => value.split('\0'))).toEqual(
        [...TRIGGERS].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])),
      );
      const functions = await engine.executeRaw<{ proname: string; proconfig: string[] | null }>(
        `SELECT p.proname,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname IN ('conversion_evidence_immutable','conversion_mapping_guard') ORDER BY p.proname`,
      );
      expect(functions).toHaveLength(2);
      expect(functions.every((row) => row.proconfig?.includes('search_path=pg_catalog, public'))).toBe(true);
  });

  test('migration replay is idempotent and preserves both table/index names', async () => {
      await engine.initSchema();
      const tables = await engine.executeRaw<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'conversion_manifest%' ORDER BY table_name`,
      );
      expect(tables.map((row) => row.table_name)).toEqual([...TABLES]);
      const indexes = await engine.executeRaw<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1::text[]) ORDER BY indexname`,
        [[...INDEXES]],
      );
      expect(indexes.map((row) => row.indexname)).toEqual([...INDEXES].sort());
  });
});
