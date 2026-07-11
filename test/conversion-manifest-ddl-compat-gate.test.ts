import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { readFileSync } from 'fs';
import { MIGRATIONS } from '../src/core/migrate.ts';

type Variant = 'postgres' | 'pglite';
type RawRow = Record<string, unknown>;
type Db = { exec(sql: string): Promise<unknown>; query(sql: string): Promise<{ rows: RawRow[] }> };

const selector = process.env.CONVERSION_MANIFEST_DDL_VARIANT
  ?? process.argv.find((arg) => arg.startsWith('--variant='))?.slice('--variant='.length);
if (selector && selector !== 'postgres' && selector !== 'pglite') throw new Error(`Unsupported variant: ${selector}`);
const variants: Variant[] = selector ? [selector as Variant] : ['pglite'];


const conversionEvidenceMigration = MIGRATIONS.find(
  (migration) => migration.version === 123 && migration.name === 'conversion_evidence_foundation',
);
if (!conversionEvidenceMigration) {
  throw new Error('Migration v123 conversion_evidence_foundation is missing from MIGRATIONS');
}
const ddl = conversionEvidenceMigration.sql;
if (!ddl || !ddl.includes('CREATE TABLE IF NOT EXISTS conversion_manifests')) {
  throw new Error('Migration v123 conversion_evidence_foundation does not contain canonical conversion DDL');
}

const seedPrerequisites = `INSERT INTO sources(id) VALUES ('synthetic-source'); INSERT INTO files(id,source_id) VALUES (7,'synthetic-source'); INSERT INTO pages(id,source_id,slug) VALUES (11,'synthetic-source','synthetic-page');`;
const seedManifest = `INSERT INTO conversion_manifests(receipt_id,source_id,file_id,source_sha256,source_mime_type,manifest_version,idempotency_key,request_hash,producer_kind,producer_id,adapter_kind,source_visual_kind,converter,converter_version,settings,started_at,completed_at,unit_kind,total_units,succeeded_units,failed_units,failed_ranges,candidates,ocr,unreadable_regions,adapter_warnings,risk,reason_codes) VALUES ('00000000-0000-4000-8000-000000000001','synthetic-source',7,repeat('a',64),'text/plain',1,'synthetic-key',repeat('b',64),'local_cli',NULL,'synthetic-adapter','text','synthetic-converter','1','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:01Z','document',1,1,0,'[]','{}','{}','[]','[]','pass',ARRAY[]::text[]);`;


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
    await db.exec(seedPrerequisites);
    await db.exec(seedManifest);
    const reject = async (sql: string) => { try { await db.exec(sql); return false; } catch { return true; } };
    expect(await reject("UPDATE conversion_manifests SET risk='warning' WHERE receipt_id='00000000-0000-4000-8000-000000000001'"), 'manifest UPDATE must be rejected').toBe(true);
    expect(await reject("DELETE FROM conversion_manifests WHERE receipt_id='00000000-0000-4000-8000-000000000001'"), 'manifest DELETE must be rejected').toBe(true);
    await db.exec("INSERT INTO conversion_manifest_mappings (receipt_id,mapping_ordinal,source_range,derived_page_id,derived_source_id,derived_page_slug,chunk_start,chunk_end) VALUES ('00000000-0000-4000-8000-000000000001',0,'{}',11,'synthetic-source','synthetic-page',NULL,NULL)");
    expect((await db.query("SELECT mapping_ordinal FROM conversion_manifest_mappings WHERE receipt_id='00000000-0000-4000-8000-000000000001'")).rows).toEqual([{ mapping_ordinal: 0 }]);
    expect(await reject("INSERT INTO conversion_manifest_mappings (receipt_id,mapping_ordinal,source_range,derived_page_id,derived_source_id,derived_page_slug,chunk_start,chunk_end) VALUES ('00000000-0000-4000-8000-000000000001',2,'{}',11,'synthetic-source','synthetic-page',NULL,1)"), 'half-null start must be rejected by chunk CHECK').toBe(true);
    expect(await reject("INSERT INTO conversion_manifest_mappings (receipt_id,mapping_ordinal,source_range,derived_page_id,derived_source_id,derived_page_slug,chunk_start,chunk_end) VALUES ('00000000-0000-4000-8000-000000000001',3,'{}',11,'synthetic-source','synthetic-page',0,NULL)"), 'half-null end must be rejected by chunk CHECK').toBe(true);
    expect(await reject("INSERT INTO conversion_manifest_mappings (receipt_id,mapping_ordinal,source_range,derived_page_id,derived_source_id,derived_page_slug,chunk_start,chunk_end) VALUES ('00000000-0000-4000-0000-000000000001',4,'{}',11,'synthetic-source','synthetic-page',0,1)"), 'invalid receipt must be rejected').toBe(true);
    expect(await reject("UPDATE conversion_manifest_mappings SET mapping_ordinal=1 WHERE receipt_id='00000000-0000-4000-8000-000000000001'"), 'mapping UPDATE must be rejected').toBe(true);
    expect(await reject("DELETE FROM conversion_manifest_mappings WHERE receipt_id='00000000-0000-4000-8000-000000000001'"), 'mapping DELETE must be rejected').toBe(true);
    expect(await reject("INSERT INTO conversion_manifest_mappings (receipt_id,mapping_ordinal,source_range,derived_page_id,derived_source_id,derived_page_slug,chunk_start,chunk_end) VALUES ('00000000-0000-4000-8000-000000000001',1,'{}',11,'wrong-source','synthetic-page',0,1)"), 'source mismatch must be rejected').toBe(true);
    if (variant === 'postgres') {
      const rows = await db.query("SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='conversion_manifest_probe' AND c.relname IN ('conversion_manifests','conversion_manifest_mappings') ORDER BY c.relname");
      expect(rows.rows.map((r) => r.relrowsecurity === true)).toEqual([true, true]);
    }
    expect(await reject("INSERT INTO conversion_manifest_mappings (receipt_id,mapping_ordinal,source_range,derived_page_id,derived_source_id,derived_page_slug,chunk_start,chunk_end) VALUES ('00000000-0000-4000-8000-000000000001',5,'{}',11,'synthetic-source','wrong-slug',0,1)"), 'slug mismatch must be rejected through guard').toBe(true);
    expect(await reject("DELETE FROM pages WHERE id=11 AND source_id='synthetic-source'"), 'referenced page deletion must be restricted').toBe(true);
    console.log(`[conversion-manifest-compat] variant=${variant} ddl_variant=native passed=true`);
  } finally {
    try { await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* cleanup is best effort after a failed connection */ }
    if (client) { if (variant === 'pglite') await (client as PGlite).close(); else await (client as ReturnType<typeof postgres>).end({ timeout: 2 }); }
  }
}

describe('conversion manifest Stage-0 DDL compatibility gate', () => {
  for (const variant of variants) test(`synthetic ${variant} posture`, () => probe(variant));
  test('shipping DDL surfaces retain the strengthened contract fragments', () => {
    const surfaces = [
      readFileSync('src/core/migrate.ts', 'utf8'),
      readFileSync('src/core/pglite-schema.ts', 'utf8'),
      readFileSync('src/schema.sql', 'utf8'),
      readFileSync('src/core/schema-embedded.ts', 'utf8'),
    ];
    for (const surface of surfaces) {
      expect(surface).toContain("producer_kind = 'oauth_client' AND producer_id IS NOT NULL");
      expect(surface).toContain('chunk_start IS NOT NULL AND chunk_end IS NOT NULL');
      expect(surface).toContain('conversion_mapping_page_source_fk');
      expect(surface).toContain('ON DELETE RESTRICT');
      expect(surface).toContain('array_positions(reason_codes');
    }
  });
});
