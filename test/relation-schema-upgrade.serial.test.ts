import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

let engine:BrainEngine;
beforeAll(async()=>{
  const url=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
  if(url)assertSafeE2eDatabaseUrl(url);
  engine=url?new PostgresEngine():new PGLiteEngine();
  await engine.connect(url?{database_url:url}:{}); await engine.initSchema();
},60_000);
afterAll(async()=>{await engine.disconnect();});
test('schema 130 upgrades metadata while preserving legacy content, types, versions, tags and vectors',async()=>{
  await engine.putPage('notes/legacy-upgrade',{type:'concept',title:'旧页面',compiled_truth:'旧内容必须原样保留。',timeline:'旧时间线',frontmatter:{aliases:['旧别名']}});
  await engine.executeRaw("INSERT INTO tags(page_id,tag) SELECT id,'原标签' FROM pages WHERE slug='notes/legacy-upgrade'");
  await engine.createVersion('notes/legacy-upgrade');
  const [dimension]=await engine.executeRaw<{n:number}>("SELECT atttypmod AS n FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
  await engine.executeRaw("INSERT INTO content_chunks(page_id,chunk_index,chunk_text,embedding) SELECT id,0,'旧向量原文',$2::vector FROM pages WHERE slug=$1",['notes/legacy-upgrade',JSON.stringify(Array.from({length:dimension.n},(_,i)=>i===0?1:0))]);
  const chunks=await engine.executeRaw('SELECT chunk_text,embedding::text FROM content_chunks');
  const before=await engine.executeRaw('SELECT p.compiled_truth,p.timeline,p.frontmatter,p.type,p.title,p.content_hash,p.updated_at,(SELECT jsonb_agg(tag ORDER BY tag) FROM tags WHERE page_id=p.id) AS tags FROM pages p WHERE slug=$1',['notes/legacy-upgrade']);
  for(const sql of ['DROP TRIGGER IF EXISTS pages_knowledge_revision ON pages','DROP TRIGGER IF EXISTS tags_knowledge_revision ON tags','ALTER TABLE pages DROP COLUMN knowledge_revision CASCADE','ALTER TABLE pages DROP COLUMN text_projection_revision','ALTER TABLE sources DROP COLUMN incarnation CASCADE',
    'DROP TABLE IF EXISTS page_write_guards','DROP TABLE IF EXISTS page_mention_state','DROP TABLE IF EXISTS mention_gazetteer_entries','DROP TABLE IF EXISTS mention_index_status','DROP TABLE IF EXISTS wanted_links',
    'ALTER TABLE page_aliases DROP CONSTRAINT page_aliases_origin_uniq','ALTER TABLE page_aliases DROP COLUMN origin','ALTER TABLE page_aliases DROP COLUMN case_sensitive','ALTER TABLE page_aliases DROP COLUMN alias_text','ALTER TABLE page_aliases ADD CONSTRAINT page_aliases_uniq UNIQUE(source_id,alias_norm,slug)'])await engine.executeRaw(sql);
  await engine.setConfig('version','130');
  await engine.unsetConfig('pmbrain.schema.version');
  await engine.executeRaw('DROP TABLE pmbrain_schema_migrations');
  expect(await runMigrations(engine)).toEqual({applied:4,current:134});
  const after=await engine.executeRaw('SELECT p.compiled_truth,p.timeline,p.frontmatter,p.type,p.title,p.content_hash,p.updated_at,(SELECT jsonb_agg(tag ORDER BY tag) FROM tags WHERE page_id=p.id) AS tags FROM pages p WHERE slug=$1',['notes/legacy-upgrade']);
  expect(after).toEqual(before);
  expect(await engine.executeRaw('SELECT chunk_text,embedding::text FROM content_chunks')).toEqual(chunks);
  expect(await engine.getVersions('notes/legacy-upgrade')).toHaveLength(1);
  const [revision]=await engine.executeRaw<{revision:string}>('SELECT knowledge_revision::text AS revision FROM pages WHERE slug=$1',['notes/legacy-upgrade']);
  expect(revision.revision).toMatch(/^[0-9a-f-]{36}$/);
  expect((await runMigrations(engine)).applied).toBe(0);
  expect((await engine.executeRaw<{revision:string}>('SELECT knowledge_revision::text AS revision FROM pages WHERE slug=$1',['notes/legacy-upgrade']))[0].revision).toBe(revision.revision);
},60_000);

test('legacy 133 adopts the PMBrain migration namespace and resumes an unfinished revision backfill',async()=>{
 await engine.executeRaw('ALTER TABLE pages ALTER COLUMN knowledge_revision DROP NOT NULL');
 await engine.executeRaw("UPDATE pages SET knowledge_revision=NULL WHERE slug='notes/legacy-upgrade'");
 await engine.unsetConfig('pmbrain.schema.version');await engine.unsetConfig('page_state.revision_backfill');await engine.setConfig('version','133');
 await runMigrations(engine);
 expect(await engine.getConfig('pmbrain.schema.version')).toBe('134');
 expect(await engine.executeRaw('SELECT id FROM pages WHERE knowledge_revision IS NULL')).toHaveLength(0);
 expect(await engine.executeRaw<{version:number;upstream_version:number}>("SELECT version,upstream_version FROM pmbrain_schema_migrations WHERE namespace='pmbrain' AND upstream_version IS NOT NULL ORDER BY version")).toEqual([{version:131,upstream_version:150},{version:132,upstream_version:206},{version:133,upstream_version:214}]);
},60_000);
