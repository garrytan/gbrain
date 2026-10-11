import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runByMentionCore } from '../src/commands/extract.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine=new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
},60_000);
afterAll(async()=>{await engine.disconnect();});
beforeEach(async()=>{
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw('DELETE FROM mention_index_status');
  await engine.executeRaw('DELETE FROM mention_gazetteer_entries');
  await engine.executeRaw('DELETE FROM op_checkpoints');
});
async function page(slug:string,body:string,type='note'){
  await engine.putPage(slug,{type,title:type==='company'?'Acme Corp':slug,compiled_truth:body,timeline:'',frontmatter:{}});
}
test('completed revisions survive the run and an unchanged run scans zero pages',async()=>{
  await page('companies/acme','company body','company'); await page('notes/one','Acme Corp.');
  expect((await runByMentionCore(engine,{quiet:true})).created).toBe(1);
  expect((await runByMentionCore(engine,{quiet:true})).pages).toBe(0);
  expect(await engine.executeRaw('SELECT * FROM page_mention_state WHERE mention_revision IS NOT NULL')).toHaveLength(2);
});
test('dry run previews edges without saving revisions, gazetteer or links',async()=>{
  await page('companies/acme','company body','company'); await page('notes/one','Acme Corp.');
  expect((await runByMentionCore(engine,{quiet:true,dryRun:true})).created).toBe(1);
  for(const table of ['links','page_mention_state','mention_gazetteer_entries'])expect(await engine.executeRaw(`SELECT * FROM ${table}`)).toHaveLength(0);
});
test('a legacy slug checkpoint cannot suppress a revision that was never indexed',async()=>{
  await page('companies/acme','company body','company'); await page('notes/one','Acme Corp.');
  await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('extract-by-mention','old','[\"default::notes/one\"]')");
  expect((await runByMentionCore(engine,{quiet:true})).created).toBe(1);
});
test('a bounded pass resumes only the remaining revisions',async()=>{
  await page('companies/acme','company body','company');
  for(let i=0;i<5;i++)await page(`notes/${i}`,'Acme Corp.');
  const first=await runByMentionCore(engine,{quiet:true,maxHistoricalPages:2});
  expect(first.pages).toBe(2); expect(first.historicalRemaining).toBe(4);
  const second=await runByMentionCore(engine,{quiet:true});
  expect(second.pages).toBe(4); expect(second.historicalRemaining).toBe(0);
  expect((await runByMentionCore(engine,{quiet:true})).pages).toBe(0);
  expect(await engine.executeRaw('SELECT * FROM links')).toHaveLength(5);
});
test('a new entity invalidates matching historical pages and leaves unrelated revisions complete',async()=>{
  await page('notes/one','Charlie Example.'); await page('notes/unrelated','Nothing here.');
  await runByMentionCore(engine,{quiet:true});
  await engine.putPage('people/charlie',{type:'person',title:'Charlie Example',compiled_truth:'',timeline:'',frontmatter:{}});
  const result=await runByMentionCore(engine,{quiet:true});
  expect(result.processedSlugs.map(p=>p.slug).sort()).toEqual(['notes/one','people/charlie']);
  expect(result.created).toBe(1);
});
test('type filters leave excluded pages due for a subsequent unrestricted pass',async()=>{
  await page('companies/acme','company body','company'); await page('meetings/one','Acme Corp.','meeting'); await page('notes/one','Acme Corp.');
  const filtered=await runByMentionCore(engine,{quiet:true,typeFilter:'meeting'});
  expect(filtered.pages).toBe(1); expect(filtered.created).toBe(1);
  expect((await runByMentionCore(engine,{quiet:true})).created).toBe(1);
});
