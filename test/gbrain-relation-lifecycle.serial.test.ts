import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runMentionPass } from '../src/core/mentions/pass.ts';
import { readRelationSnapshot, replaceDerivedLinks } from '../src/core/pmbrain-adapters/relation-writer.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { requestImportedEntityCapture, ENTITY_CAPTURE_PENDING_PREFIX } from '../src/core/pmbrain-adapters/entity-capture-request.ts';
import { enqueueImportedEntityCapture } from '../src/product/tasks/imported-entity-capture.ts';
import { prepareLinkReconciliation } from '../src/core/link-reconciliation.ts';
import { reportLegacyPageTypes } from '../src/core/pmbrain-adapters/legacy-page-type-report.ts';

let engine: BrainEngine;
beforeAll(async () => {
  const url = process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
  if (url) assertSafeE2eDatabaseUrl(url);
  engine = url ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(url ? { database_url: url } : {});
  await engine.initSchema();
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw('DELETE FROM mention_gazetteer_entries');
  await engine.executeRaw('DELETE FROM mention_index_status');
  await engine.executeRaw("DELETE FROM minion_jobs");
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'dream.entity_capture.pending.%'");
  for (const key of ['auto_link', 'mentions.auto_link', 'mentions.entity_types', 'mentions.ignore', 'mentions.exclude_slugs']) await engine.unsetConfig(key);
});

test('import requests persist, coalesce, and wait for a configured model', async () => {
  const input={slug:'notes/input',type:'note',compiled_truth:'刘慈欣创作了三体，这是导入的资料。',frontmatter:{}};
  await requestImportedEntityCapture(engine,'default',input);
  await requestImportedEntityCapture(engine,'default',input);
  expect(await enqueueImportedEntityCapture(engine,async()=>false)).toEqual([]);
  expect(await engine.getConfig(ENTITY_CAPTURE_PENDING_PREFIX+'default')).not.toBeNull();
  const [job]=await enqueueImportedEntityCapture(engine,async()=>true);
  expect(job).toBeGreaterThan(0);
  expect(await enqueueImportedEntityCapture(engine,async()=>true)).toEqual([]);
  await requestImportedEntityCapture(engine,'default',input);
  expect(await enqueueImportedEntityCapture(engine,async()=>true)).toEqual([]);
  await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1",[job]);
  expect((await enqueueImportedEntityCapture(engine,async()=>true))).toHaveLength(1);
  const rows=await engine.executeRaw<{data:{task:{input:{phase:string;sourceId:string}}};max_attempts:number}>('SELECT data,max_attempts FROM minion_jobs');
  expect(rows.every(r=>r.data.task.input.phase==='capture_entities'&&r.data.task.input.sourceId==='default'&&r.max_attempts===1)).toBe(true);
});

test('indexed reconciliation resolves local titles and shared default, keeps explicit concept links, and removes stale derived edges', async () => {
  await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('team-a','A'),('team-b','B') ON CONFLICT (id) DO NOTHING");
  await page('people/local','person','刘慈欣','','team-a');
  await page('people/shared','person','刘慈欣','');
  await page('companies/other','company','无关公司','','team-b');
  await page('concepts/graph','concept','知识图谱','','team-a');
  await page('notes/input','note','资料','[[刘慈欣]]、[[concepts/graph]]、[[无关公司]]','team-a');
  await (await prepareLinkReconciliation(engine))('notes/input','team-a');
  const rows=await engine.executeRaw<{slug:string;source:string}>(`SELECT t.slug,t.source_id AS source FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug='notes/input'`);
  expect(rows).toContainEqual({slug:'people/local',source:'team-a'});
  expect(rows).toContainEqual({slug:'concepts/graph',source:'team-a'});
  expect(rows.some(r=>r.source==='team-b')).toBe(false);
  await page('notes/input','note','资料','引用删除了。','team-a');
  await (await prepareLinkReconciliation(engine))('notes/input','team-a');
  expect(await engine.executeRaw("SELECT * FROM links")).toHaveLength(0);
});

async function page(slug: string, type: string, title: string, body: string, sourceId = 'default') {
  await engine.putPage(slug, { type: type as never, title, compiled_truth: body, timeline: '', frontmatter: {} }, { sourceId });
}
async function targets(slug: string) {
  return (await engine.executeRaw<{ target: string }>(`SELECT t.source_id || ':' || t.slug AS target FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug=$1 AND l.link_source='mentions' ORDER BY target`, [slug])).map(r => r.target);
}

test('sibling nested transactions preserve the successful write when another savepoint rolls back',async()=>{
  await page('notes/one','note','一','原文一'); await page('notes/two','note','二','原文二');
  const result=await engine.transaction(async tx=>Promise.allSettled([
    tx.transaction(async child=>{await child.putPage('notes/one',{type:'note',title:'一',compiled_truth:'应回滚'});await Bun.sleep(10);throw new Error('rollback');}),
    tx.transaction(async child=>{await child.putPage('notes/two',{type:'note',title:'二',compiled_truth:'应保存'});}),
  ]));
  expect(result.map(r=>r.status)).toEqual(['rejected','fulfilled']);
  expect((await engine.getPage('notes/one'))?.compiled_truth).toBe('原文一');
  expect((await engine.getPage('notes/two'))?.compiled_truth).toBe('应保存');
});

test('default entity policy excludes concept, project and aliased ordinary notes', async () => {
  await page('concepts/graph', 'concept', '知识图谱', '');
  await page('projects/river', 'project', '智慧水务', '');
  await page('notes/alias', 'note', '知识点：系统架构', '');
  await engine.setPageAliases('notes/alias', 'default', ['系统架构']);
  await page('notes/input', 'note', '资料', '知识图谱、智慧水务、系统架构。');
  await runMentionPass(engine);
  expect(await targets('notes/input')).toEqual([]);
});

test('legacy type report records suspects without changing page types or text', async () => {
  await page('notes/legacy','concept','旧资料','保存原文。');
  await page('concepts/real','concept','真概念','保留概念。');
  const report=await reportLegacyPageTypes(engine);
  expect(report.candidates.map(p=>p.slug)).toEqual(['notes/legacy']);
  expect((await engine.getPage('notes/legacy'))?.type).toBe('concept');
  expect((await engine.getPage('notes/legacy'))?.compiled_truth).toBe('保存原文。');
});

test('a wanted explicit concept reference becomes due when its page appears', async () => {
  await page('notes/history','note','资料','[[concepts/graph]]');
  const { extractStaleFromDB }=await import('../src/commands/extract-stale.ts');
  const opts={dryRun:false,jsonMode:false,includeFrontmatter:true,catchUp:true,quiet:true,catalogAware:true};
  await extractStaleFromDB(engine,opts);
  expect(await engine.executeRaw('SELECT * FROM wanted_links')).toHaveLength(1);
  await page('concepts/graph','concept','知识图谱','');
  expect(await engine.countStalePagesForExtraction()).toBeGreaterThan(0);
  await extractStaleFromDB(engine,opts);
  const links=await engine.getLinks('notes/history');
  expect(links.some(l=>l.to_slug==='concepts/graph'&&l.link_source==='markdown')).toBe(true);
  expect(await engine.executeRaw('SELECT * FROM wanted_links')).toHaveLength(0);
});

test('a later entity links old pages and the next unchanged pass scans zero pages', async () => {
  await page('notes/history', 'note', '旧资料', '刘慈欣创作了三体。');
  await page('notes/unrelated', 'note', '无关资料', '这一页没有人物。');
  await runMentionPass(engine);
  await page('people/liu', 'person', '刘慈欣', '');
  await runMentionPass(engine);
  expect(await targets('notes/history')).toEqual(['default:people/liu']);
  expect(await targets('notes/unrelated')).toEqual([]);
  const repeat = await runMentionPass(engine);
  expect(repeat.pages).toBe(0);
  expect(repeat.created).toBe(0);
  expect(repeat.remaining).toBe(0);
});

test('a missing qualified reference retains its Source and does not bind to the shared default',async()=>{
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('team-a','A'),('team-b','B') ON CONFLICT(id) DO NOTHING");
  await page('concepts/graph','concept','同名共享概念','');
  await page('notes/input','note','资料','[[team-b:concepts/graph]]','team-a');
  await (await prepareLinkReconciliation(engine))('notes/input','team-a');
  expect(await engine.executeRaw('SELECT * FROM links')).toHaveLength(0);
  expect(await engine.executeRaw<{target_source_id:string;target_ref:string}>('SELECT target_source_id,target_ref FROM wanted_links')).toEqual([{target_source_id:'team-b',target_ref:'concepts/graph'}]);
  await page('concepts/graph','concept','明确引用的概念','','team-b');
  await (await prepareLinkReconciliation(engine))('notes/input','team-a');
  expect(await engine.executeRaw<{source_id:string}>('SELECT t.source_id FROM links l JOIN pages t ON t.id=l.to_page_id')).toEqual([{source_id:'team-b'}]);
  expect(await engine.executeRaw('SELECT * FROM wanted_links')).toHaveLength(0);
});

test('a page edited during a scan is not published from the old revision', async () => {
  await page('people/liu', 'person', '刘慈欣', '');
  await page('notes/history', 'note', '资料', '刘慈欣。');
  let edited = false;
  const result = await runMentionPass(engine, { beforePublish: async () => {
    if (!edited) { edited = true; await page('notes/history', 'note', '资料', '人物提及已经删除。'); }
  } });
  expect(result.skipped).toBeGreaterThan(0);
  expect(await targets('notes/history')).toEqual([]);
  await runMentionPass(engine);
  expect((await runMentionPass(engine)).pages).toBe(0);
});

test('1001 historical pages, including a long page 770, resume by revision and do not re-scan unchanged text',async()=>{
  await engine.executeRaw(`INSERT INTO pages(slug,type,title,compiled_truth,timeline,frontmatter,source_id)
    SELECT 'notes/bulk-'||n,'note','资料 '||n,
      CASE WHEN n=770 THEN repeat('长资料。',40000)||'刘慈欣。' WHEN n%2=0 THEN '刘慈欣创作三体。' ELSE '没有这个人物。' END,
      '', '{}'::jsonb,'default' FROM generate_series(1,1001) n`);
  expect((await runMentionPass(engine)).pages).toBe(1001);
  await page('people/liu','person','刘慈欣','');
  let changed=false;
  const first=await runMentionPass(engine,{beforePublish:async()=>{
    if(!changed){changed=true;await page('notes/bulk-770','note','资料 770','刘慈欣，保留并发编辑的内容。');}
  }});
  expect(first.pages).toBeLessThanOrEqual(501);
  expect(first.processedSlugs.some(p=>p.slug==='notes/bulk-1')).toBe(false);
  await runMentionPass(engine);
  expect(await targets('notes/bulk-770')).toEqual(['default:people/liu']);
  expect((await runMentionPass(engine)).pages).toBe(0);
  expect((await engine.getPage('notes/bulk-770'))?.compiled_truth).toBe('刘慈欣，保留并发编辑的内容。');
},120_000);

test('derived replacement checks revision and keeps manual and typed NER edges', async () => {
  await page('people/liu', 'person', '刘慈欣', '');
  await page('notes/history', 'note', '资料', '[[people/liu]]');
  await engine.addLinksBatch([
    { from_slug: 'notes/history', to_slug: 'people/liu', link_type: 'references', link_source: 'markdown' },
    { from_slug: 'notes/history', to_slug: 'people/liu', link_type: 'knows', link_source: 'manual' },
    { from_slug: 'notes/history', to_slug: 'people/liu', link_type: 'advises', link_source: 'mentions', link_kind: 'typed_ner' },
  ]);
  const snapshot = await readRelationSnapshot(engine, 'notes/history', 'default');
  expect(snapshot).not.toBeNull();
  await page('notes/history', 'note', '资料', '引用已经删除。');
  await expect(replaceDerivedLinks(engine, { slug: 'notes/history', sourceId: 'default', expectedRevision: snapshot!.revision, sourceIncarnation: snapshot!.sourceIncarnation }, [])).rejects.toMatchObject({ code: 'revision_conflict' });
  const fresh = await readRelationSnapshot(engine, 'notes/history', 'default');
  await replaceDerivedLinks(engine, { slug: 'notes/history', sourceId: 'default', expectedRevision: fresh!.revision, sourceIncarnation: fresh!.sourceIncarnation }, []);
  const rows = await engine.executeRaw<{ link_source: string; link_kind: string | null }>('SELECT link_source, link_kind FROM links ORDER BY link_source');
  expect(rows).toHaveLength(2);
  expect(rows.some(r => r.link_source === 'manual')).toBe(true);
  expect(rows.some(r => r.link_kind === 'typed_ner')).toBe(true);
});
