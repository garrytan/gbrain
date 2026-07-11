import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';

type Variant = 'postgres' | 'pglite';
type RawRow = Record<string, unknown>;
type Db = { exec(sql: string): Promise<unknown>; query(sql: string): Promise<{ rows: RawRow[] }> };

const selector = process.env.CONVERSION_MANIFEST_DDL_VARIANT
  ?? process.argv.find((arg) => arg.startsWith('--variant='))?.slice('--variant='.length);
if (selector && selector !== 'postgres' && selector !== 'pglite') throw new Error(`Unsupported variant: ${selector}`);
const variants: Variant[] = selector ? [selector as Variant] : ['postgres', 'pglite'];

const ddl = `
CREATE UNIQUE INDEX IF NOT EXISTS files_id_source_unique ON files(id, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS pages_id_source_unique ON pages(id, source_id);
CREATE TABLE IF NOT EXISTS conversion_manifests (
  receipt_id TEXT PRIMARY KEY CHECK(receipt_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  file_id INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  source_mime_type TEXT NOT NULL CHECK(source_mime_type IS NOT NULL AND source_mime_type ~ '^[A-Za-z0-9!#$&^_+.-]+/[A-Za-z0-9!#$&^_+.-]+$' AND length(source_mime_type)<=255),
  manifest_version SMALLINT NOT NULL CHECK(manifest_version=1),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  producer_kind TEXT NOT NULL CHECK(producer_kind IN ('local_cli','stdio_mcp','oauth_client','internal_adapter')),
  producer_id TEXT NULL CHECK((producer_kind = 'oauth_client' AND producer_id ~ '^[A-Za-z0-9._:-]+$' AND length(producer_id) BETWEEN 1 AND 255) OR (producer_kind <> 'oauth_client' AND producer_id IS NULL)),
  adapter_kind TEXT NOT NULL CHECK(length(adapter_kind) BETWEEN 1 AND 64),
  source_visual_kind TEXT NOT NULL CHECK(source_visual_kind IN ('text','scan','image','mixed','unknown')),
  converter TEXT NOT NULL CHECK(length(converter) BETWEEN 1 AND 128),
  converter_version TEXT NOT NULL CHECK(length(converter_version) BETWEEN 1 AND 128),
  model TEXT NULL CHECK(model IS NULL OR length(model)<=128), model_version TEXT NULL CHECK(model_version IS NULL OR length(model_version)<=128),
  settings JSONB NOT NULL CHECK(jsonb_typeof(settings)='object' AND octet_length(settings::text)<=8192),
  started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ NOT NULL CHECK(completed_at>=started_at),
  unit_kind TEXT NOT NULL CHECK(unit_kind IN ('document','page','frame','segment')),
  total_units BIGINT NOT NULL CHECK(total_units BETWEEN 0 AND 9007199254740991), succeeded_units BIGINT NOT NULL CHECK(succeeded_units BETWEEN 0 AND 9007199254740991), failed_units BIGINT NOT NULL CHECK(failed_units BETWEEN 0 AND 9007199254740991),
  duration_ms BIGINT NULL CHECK(duration_ms IS NULL OR duration_ms BETWEEN 1 AND 9007199254740991),
  failed_ranges JSONB NOT NULL CHECK(jsonb_typeof(failed_ranges)='array' AND jsonb_array_length(failed_ranges)<=1000 AND octet_length(failed_ranges::text)<=16384),
  candidates JSONB NOT NULL CHECK(jsonb_typeof(candidates)='object' AND octet_length(candidates::text)<=512), confidence JSONB NULL CHECK(confidence IS NULL OR (jsonb_typeof(confidence)='object' AND octet_length(confidence::text)<=1024)),
  ocr JSONB NOT NULL CHECK(jsonb_typeof(ocr)='object' AND octet_length(ocr::text)<=512), image_dimensions JSONB NULL CHECK(image_dimensions IS NULL OR (jsonb_typeof(image_dimensions)='object' AND octet_length(image_dimensions::text)<=256)),
  unreadable_regions JSONB NOT NULL CHECK(jsonb_typeof(unreadable_regions)='array' AND jsonb_array_length(unreadable_regions)<=1000 AND octet_length(unreadable_regions::text)<=16384), adapter_warnings JSONB NOT NULL CHECK(jsonb_typeof(adapter_warnings)='array' AND jsonb_array_length(adapter_warnings)<=32 AND octet_length(adapter_warnings::text)<=8192),
  risk TEXT NOT NULL CHECK(risk IN ('pass','warning','visual_review_required','hard_failure')), reason_codes TEXT[] NOT NULL CHECK(cardinality(reason_codes)<=16), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversion_manifest_counts CHECK(total_units=succeeded_units+failed_units), CONSTRAINT conversion_manifest_file_source_fk FOREIGN KEY(file_id,source_id) REFERENCES files(id,source_id) ON DELETE RESTRICT, CONSTRAINT conversion_manifest_idempotency_unique UNIQUE(source_id,file_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS conversion_manifest_mappings (
  receipt_id TEXT NOT NULL REFERENCES conversion_manifests(receipt_id) ON DELETE RESTRICT, mapping_ordinal INTEGER NOT NULL CHECK(mapping_ordinal BETWEEN 0 AND 9999), source_range JSONB NOT NULL CHECK(jsonb_typeof(source_range)='object' AND octet_length(source_range::text)<=512), derived_page_id INTEGER NOT NULL, derived_source_id TEXT NOT NULL, derived_page_slug TEXT NOT NULL CHECK(length(derived_page_slug)<=512), section_ref TEXT NULL CHECK(section_ref IS NULL OR length(section_ref)<=256), chunk_start INTEGER NULL, chunk_end INTEGER NULL, PRIMARY KEY(receipt_id,mapping_ordinal), CONSTRAINT conversion_mapping_page_source_fk FOREIGN KEY(derived_page_id,derived_source_id) REFERENCES pages(id,source_id), CONSTRAINT conversion_mapping_chunk_bounds CHECK((chunk_start IS NULL AND chunk_end IS NULL) OR (chunk_start>=0 AND chunk_end>chunk_start))
);
CREATE OR REPLACE FUNCTION conversion_evidence_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='conversion evidence is append-only'; END $$;
DROP TRIGGER IF EXISTS conversion_manifest_immutable ON conversion_manifests;
CREATE TRIGGER conversion_manifest_immutable BEFORE UPDATE OR DELETE ON conversion_manifests FOR EACH ROW EXECUTE FUNCTION conversion_evidence_immutable();
DROP TRIGGER IF EXISTS conversion_mapping_immutable ON conversion_manifest_mappings;
CREATE TRIGGER conversion_mapping_immutable BEFORE UPDATE OR DELETE ON conversion_manifest_mappings FOR EACH ROW EXECUTE FUNCTION conversion_evidence_immutable();
CREATE OR REPLACE FUNCTION conversion_mapping_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ DECLARE parent_source TEXT; BEGIN SELECT source_id INTO parent_source FROM conversion_manifests WHERE receipt_id=NEW.receipt_id; IF parent_source IS NULL OR NEW.derived_source_id IS DISTINCT FROM parent_source THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='conversion mapping source mismatch'; END IF; IF NOT EXISTS (SELECT 1 FROM pages WHERE id=NEW.derived_page_id AND source_id=NEW.derived_source_id AND slug=NEW.derived_page_slug) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='conversion mapping page mismatch'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS conversion_mapping_source_guard ON conversion_manifest_mappings;
CREATE TRIGGER conversion_mapping_source_guard BEFORE INSERT ON conversion_manifest_mappings FOR EACH ROW EXECUTE FUNCTION conversion_mapping_guard();
CREATE INDEX IF NOT EXISTS idx_conversion_manifest_file_latest ON conversion_manifests(source_id,file_id,completed_at DESC,receipt_id DESC);
CREATE INDEX IF NOT EXISTS idx_conversion_manifest_risk ON conversion_manifests(source_id,risk,completed_at DESC,receipt_id DESC);
`;

const seed = `INSERT INTO sources(id) VALUES ('synthetic-source'); INSERT INTO files(id,source_id) VALUES (7,'synthetic-source'); INSERT INTO pages(id,source_id,slug) VALUES (11,'synthetic-source','synthetic-page');
INSERT INTO conversion_manifests(receipt_id,source_id,file_id,source_sha256,source_mime_type,manifest_version,idempotency_key,request_hash,producer_kind,producer_id,adapter_kind,source_visual_kind,converter,converter_version,settings,started_at,completed_at,unit_kind,total_units,succeeded_units,failed_units,failed_ranges,candidates,ocr,unreadable_regions,adapter_warnings,risk,reason_codes) VALUES ('00000000-0000-4000-8000-000000000001','synthetic-source',7,repeat('a',64),'text/plain',1,'synthetic-key',repeat('b',64),'local_cli',NULL,'synthetic-adapter','text','synthetic-converter','1','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:01Z','document',1,1,0,'[]','{}','{}','[]','[]','pass',ARRAY[]::text[]);`;

async function probe(variant: Variant): Promise<void> {
  let client: PGlite | ReturnType<typeof postgres> | null = null;
  const schema = 'conversion_manifest_probe';
  const db: Db = variant === 'pglite'
    ? (() => { const p = new PGlite(); client = p; return { exec: (sql: string) => p.exec(sql), query: async (sql: string) => ({ rows: (await p.query<RawRow>(sql)).rows }) }; })()
    : (() => { const url = process.env.GBRAIN_DATABASE_URL ?? process.env.DATABASE_URL; if (!url) throw new Error('DATABASE_URL is required for the postgres probe'); const p = postgres(url, { max: 1, prepare: false }); client = p; return { exec: async (sql: string) => { await p.unsafe(sql); }, query: async (sql: string) => ({ rows: await p.unsafe(sql) as unknown as RawRow[] }) }; })();
  try {
    await db.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public; CREATE TABLE sources(id TEXT PRIMARY KEY); CREATE TABLE files(id INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id), UNIQUE(id,source_id)); CREATE TABLE pages(id INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id), slug TEXT NOT NULL, UNIQUE(id,source_id));`);
    expect(ddl).toContain('SET search_path = pg_catalog, public');
    await db.exec(ddl.replaceAll('SET search_path = pg_catalog, public', `SET search_path = ${schema}, public`));
    if (variant === 'postgres') await db.exec('ALTER TABLE conversion_manifests ENABLE ROW LEVEL SECURITY; ALTER TABLE conversion_manifest_mappings ENABLE ROW LEVEL SECURITY;');
    await db.exec(seed);
    const reject = async (sql: string) => { try { await db.exec(sql); return false; } catch { return true; } };
    expect(await reject("UPDATE conversion_manifests SET risk='warning' WHERE receipt_id='00000000-0000-4000-8000-000000000001'"), 'manifest UPDATE must be rejected').toBe(true);
    expect(await reject("DELETE FROM conversion_manifests WHERE receipt_id='00000000-0000-4000-8000-000000000001'"), 'manifest DELETE must be rejected').toBe(true);
    await db.exec("INSERT INTO conversion_manifest_mappings VALUES ('00000000-0000-4000-8000-000000000001',0,'{}',11,'synthetic-source','synthetic-page',NULL,NULL)");
    expect(await reject("UPDATE conversion_manifest_mappings SET mapping_ordinal=1 WHERE receipt_id='00000000-0000-4000-8000-000000000001'"), 'mapping UPDATE must be rejected').toBe(true);
    expect(await reject("DELETE FROM conversion_manifest_mappings WHERE receipt_id='00000000-0000-4000-8000-000000000001'"), 'mapping DELETE must be rejected').toBe(true);
    expect(await reject("INSERT INTO conversion_manifest_mappings VALUES ('00000000-0000-4000-8000-000000000001',1,'{}',11,'wrong-source','synthetic-page',NULL,NULL)"), 'source mismatch must be rejected').toBe(true);
    if (variant === 'postgres') {
      const rows = await db.query("SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='conversion_manifest_probe' AND c.relname IN ('conversion_manifests','conversion_manifest_mappings') ORDER BY c.relname");
      expect(rows.rows.map((r) => r.relrowsecurity === true)).toEqual([true, true]);
    }
    console.log(`[conversion-manifest-compat] variant=${variant} ddl_variant=${variant === 'postgres' ? 'native' : 'native'} passed=true`);
  } finally {
    try { await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* cleanup is best effort after a failed connection */ }
    if (client) { if (variant === 'pglite') await (client as PGlite).close(); else await (client as ReturnType<typeof postgres>).end({ timeout: 2 }); }
  }
}

describe('conversion manifest Stage-0 DDL compatibility gate', () => {
  for (const variant of variants) test(`synthetic ${variant} posture`, () => probe(variant));
});
