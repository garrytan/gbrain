import {beforeAll,afterAll,expect,test} from 'bun:test';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
import {PostgresEngine} from '../src/core/postgres-engine.ts';
import type {BrainEngine} from '../src/core/engine.ts';
import {repairSearchWriteAmplification} from '../src/core/pmbrain-adapters/search-write-schema.ts';
import {resumePageRevisionBackfill} from '../src/core/page-state/revision-backfill-schema.ts';
import {PAGE_STATE_SCHEMA_SQL} from '../src/core/page-state/schema.ts';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard.ts';

let engine:BrainEngine;
beforeAll(async()=>{
  const url=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
  if(url)assertSafeE2eDatabaseUrl(url);
  engine=url?new PostgresEngine():new PGLiteEngine();
  await engine.connect(url?{database_url:url}:{});await engine.initSchema();
},60_000);
afterAll(async()=>{await engine.disconnect();});

test('metadata and identical content updates do not recompute full-text search, while actual content edits do',async()=>{
  await engine.putPage('notes/write-amplification',{type:'note',title:'中文检索性能',compiled_truth:'智慧水务与知识图谱。'.repeat(1000)});
  await repairSearchWriteAmplification(engine);
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger AS $fn$
    BEGIN RAISE EXCEPTION 'metadata must not invoke full-text computation';END;$fn$ LANGUAGE plpgsql;`);
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION bump_page_generation_fn() RETURNS trigger AS $fn$
    BEGIN RAISE EXCEPTION 'metadata must not inspect page content';END;$fn$ LANGUAGE plpgsql;`);
  await engine.executeRaw("UPDATE pages SET links_extracted_at=now() WHERE slug='notes/write-amplification'");
  await engine.initSchema();
  await repairSearchWriteAmplification(engine);
  const [before]=await engine.executeRaw<{v:string}>("SELECT search_vector::text AS v FROM pages WHERE slug='notes/write-amplification'");
  await engine.executeRaw("UPDATE pages SET compiled_truth=compiled_truth WHERE slug='notes/write-amplification'");
  expect((await engine.executeRaw<{v:string}>("SELECT search_vector::text AS v FROM pages WHERE slug='notes/write-amplification'"))[0].v).toBe(before.v);
  await engine.executeRaw("UPDATE pages SET compiled_truth='新增独立词语英文 lighthouse' WHERE slug='notes/write-amplification'");
  const [after]=await engine.executeRaw<{v:string}>("SELECT search_vector::text AS v FROM pages WHERE slug='notes/write-amplification'");
  expect(after.v).not.toBe(before.v);expect(after.v).toContain('lighthous');
  expect(await engine.executeRaw("SELECT indexname FROM pg_indexes WHERE indexname='idx_pages_compiled_truth_trgm'")).toHaveLength(0);
  await engine.initSchema();
  expect(await engine.executeRaw("SELECT indexname FROM pg_indexes WHERE indexname='idx_pages_compiled_truth_trgm'")).toHaveLength(0);
},60_000);

test('revision backfill commits 100 pages, cancels between batches and resumes without changing existing revisions',async()=>{
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("INSERT INTO pages(slug,type,title,compiled_truth,source_id) SELECT 'notes/backfill-'||n,'note','长中文资料',repeat('智慧水务与知识图谱。',2000),'default' FROM generate_series(1,231) n");
  await engine.executeRaw('ALTER TABLE pages DROP COLUMN knowledge_revision CASCADE');
  await engine.runMigration(131,PAGE_STATE_SCHEMA_SQL);
  const controller=new AbortController();
  const failure=await resumePageRevisionBackfill(engine,{signal:controller.signal,log:()=>{},onProgress:()=>controller.abort()}).catch(error=>error);
  expect(failure.name).toBe('AbortError');
  const revisions=await engine.executeRaw<{id:number;r:string}>('SELECT id,knowledge_revision::text AS r FROM pages WHERE knowledge_revision IS NOT NULL ORDER BY id');
  expect(revisions).toHaveLength(100);
  await resumePageRevisionBackfill(engine,{log:()=>{}});
  expect(await engine.executeRaw('SELECT id FROM pages WHERE knowledge_revision IS NULL')).toHaveLength(0);
  expect(await engine.executeRaw('SELECT id,knowledge_revision::text AS r FROM pages WHERE id=ANY($1::int[]) ORDER BY id',[revisions.map(row=>row.id)])).toEqual(revisions);
},60_000);
