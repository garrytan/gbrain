import {expect} from 'bun:test';
import {PGLiteEngine} from '../../src/core/pglite-engine.ts';
import {PostgresEngine} from '../../src/core/postgres-engine.ts';
import type {BrainEngine} from '../../src/core/engine.ts';
import {prepareLinkReconciliation} from '../../src/core/link-reconciliation.ts';
import {extractStaleFromDB} from '../../src/commands/extract-stale.ts';
import {listWantedPages} from '../../src/core/wanted-links-store.ts';
import {assertSafeE2eDatabaseUrl} from './db-guard.ts';

async function brain(run:(engine:BrainEngine)=>Promise<void>,url?:string){
  const selected=url??process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
  if(selected)assertSafeE2eDatabaseUrl(selected);
  const engine=selected?new PostgresEngine():new PGLiteEngine();
  await engine.connect(selected?{database_url:selected}:{});await engine.initSchema();
  await engine.executeRaw('DELETE FROM pages');
  try{await run(engine);}finally{await engine.disconnect();}
}
async function put(engine:BrainEngine,slug:string,body:string,type='note',frontmatter={}){
  await engine.putPage(slug,{type,title:slug,compiled_truth:body,timeline:'',frontmatter});
  await (await prepareLinkReconciliation(engine))(slug,'default');
}
const sweep=(engine:BrainEngine)=>extractStaleFromDB(engine,{dryRun:false,jsonMode:true,quiet:true,catchUp:true});
const wanted=(engine:BrainEngine)=>engine.executeRaw<{target_ref:string;ref_kind:string;producer:string}>('SELECT target_ref,ref_kind,producer FROM wanted_links ORDER BY target_ref');
const links=(engine:BrainEngine,slug:string)=>engine.executeRaw<{slug:string}>('SELECT f.slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE t.slug=$1 ORDER BY f.slug',[slug]);

export async function forwardReferenceHeals(url?:string){await brain(async engine=>{
  await put(engine,'notes/lunch','Lunch with [[people/carol-example]] about [[companies/acme-example]].');
  expect(await wanted(engine)).toHaveLength(2);await sweep(engine);
  await put(engine,'people/carol-example','Carol.','person');
  expect(await engine.countStalePagesForExtraction()).toBeGreaterThanOrEqual(1);await sweep(engine);
  expect(await links(engine,'people/carol-example')).toEqual([{slug:'notes/lunch'}]);
  expect((await wanted(engine)).map(r=>r.target_ref)).toEqual(['companies/acme-example']);
  expect(await engine.countStalePagesForExtraction()).toBe(0);
},url);}
export async function onlyUnresolvedAuthoredReferences(url?:string){await brain(async engine=>{
  await put(engine,'people/alice-example','Alice.','person');
  await put(engine,'notes/mixed','Met [[people/alice-example]].\nSee src/core/engine.ts and and/or docs/guides/missing.\nCode: `[[people/in-code]]`.');
  await sweep(engine);expect(await wanted(engine)).toEqual([]);
},url);}
export async function bareNameReferenceSettles(url?:string){await brain(async engine=>{
  await put(engine,'notes/call','Call with [[Dave Example]].');await sweep(engine);
  expect(await wanted(engine)).toEqual([{target_ref:'dave-example',ref_kind:'name',producer:'body'}]);
  await put(engine,'people/dave-example','Dave.','person');await sweep(engine);
  expect(await engine.countStalePagesForExtraction()).toBe(0);
  expect(await links(engine,'people/dave-example')).toContainEqual({slug:'notes/call'});
  expect(await wanted(engine)).toEqual([]);
},url);}
export async function privateOriginsStayPrivate(url?:string){await brain(async engine=>{
  await put(engine,'notes/open','Ask [[people/shared-target]].');
  await put(engine,'notes/secret','Ask [[people/shared-target]] and [[people/secret-target]].','note',{visibility:'private'});
  await sweep(engine);
  const local=await listWantedPages(engine,{limit:50,offset:0});
  expect(local.rows.map(r=>[r.target,r.referenced_by])).toEqual([['people/shared-target',2],['people/secret-target',1]]);
  const remote=await listWantedPages(engine,{limit:50,offset:0,excludePrivate:true,privateFilter:alias=>`COALESCE(${alias}.frontmatter->>'visibility','world')<>'private'`});
  expect(remote.total).toBe(1);expect(remote.rows.map(r=>[r.target,r.referenced_by])).toEqual([['people/shared-target',1]]);
  expect(JSON.stringify(remote)).not.toContain('secret');
},url);}
export async function disabledClearsRows(url?:string){await brain(async engine=>{
  await put(engine,'notes/lunch','Lunch with [[people/carol-example]].');expect(await wanted(engine)).toHaveLength(1);
  await engine.setConfig('wanted_pages.enabled','false');await put(engine,'notes/lunch','Lunch with [[people/carol-example]] again.');
  expect(await wanted(engine)).toEqual([]);await engine.unsetConfig('wanted_pages.enabled');
},url);}
export async function restoredTargetHeals(url?:string){await brain(async engine=>{
  await put(engine,'people/carol-example','Carol.','person');await engine.softDeletePage('people/carol-example');
  await put(engine,'notes/lunch','Lunch with [[people/carol-example]].');await sweep(engine);
  expect((await wanted(engine)).map(r=>r.target_ref)).toEqual(['people/carol-example']);
  await engine.restorePage('people/carol-example');await sweep(engine);
  expect(await links(engine,'people/carol-example')).toEqual([{slug:'notes/lunch'}]);
},url);}
