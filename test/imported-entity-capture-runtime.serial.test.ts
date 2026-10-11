import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { ProductTaskRuntime } from '../src/product/tasks/runtime.ts';
import { importFile } from '../src/core/import-file.ts';
import { configPath } from '../src/core/config.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

let engine:BrainEngine, runtime:ProductTaskRuntime, root:string, server:ReturnType<typeof Bun.serve>;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL'];
const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
let calls=0;
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-imported-entities-'));
  for(const key of keys)delete process.env[key];
  process.env.PMBRAIN_HOME=root; process.env.GBRAIN_HOME=root; mkdirSync(join(root,'.pmbrain'));
  const dimensions=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL?1536:1024;
  const steps=[
    ['brain_search',{query:'刘慈欣'}],
    ['brain_put_page',{slug:'people/liu',content:'---\ntitle: 刘慈欣\ntype: person\n---\n刘慈欣创作了三体。[Source: notes/input] [[auto-capture:notes/input]]'}],
  ] as const;
  server=Bun.serve({port:0,async fetch(req){
    const body=await req.json() as {input?:string|string[];tools?:Array<{function:{name:string}}>};
    if(new URL(req.url).pathname.endsWith('/embeddings'))return Response.json({object:'list',data:(Array.isArray(body.input)?body.input:[body.input]).map((_,index)=>({object:'embedding',index,embedding:Array.from({length:dimensions},(_,i)=>i===0?1:0)})),model:'relation-embedding',usage:{prompt_tokens:2,total_tokens:2}});
    const step=steps[calls++];
    const name=step&&body.tools?.find(tool=>tool.function.name===step[0])?.function.name;
    return Response.json({id:`chat-${calls}`,object:'chat.completion',created:1,model:'relation-test',choices:[{
      index:0,finish_reason:step?'tool_calls':'stop',message:step?{role:'assistant',content:null,tool_calls:[{id:`call-${calls}`,type:'function',function:{name:name??step[0],arguments:JSON.stringify(step[1])}}]}:{role:'assistant',content:JSON.stringify({entities:['people/liu'],relations:[]})},
    }],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});
  }});
  const url=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
  if(url)assertSafeE2eDatabaseUrl(url);
  writeFileSync(configPath(),JSON.stringify({engine:url?'postgres':'pglite',custom_openai_api_key:'isolated-test-only',embedding_model:'custom-openai:relation-embedding',embedding_dimensions:dimensions,
    provider_base_urls:{'custom-openai':server.url.origin+'/v1'},models:{default:'custom-openai:relation-test'},
    model_usage:{generative_enabled:true,embedding_enabled:true},desktop:{knowledge_directory:root}}));
  engine=url?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(url?{database_url:url}:{}); await engine.initSchema();
  await engine.executeRaw("DELETE FROM pages WHERE source_id='auto-capture'");
  await engine.executeRaw("DELETE FROM minion_jobs WHERE data->'task'->'input'->>'sourceId'='auto-capture' OR data->>'source_id'='auto-capture'");
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('auto-capture','Auto', $1) ON CONFLICT(id) DO UPDATE SET local_path=EXCLUDED.local_path",[root]);
},60_000);
afterAll(async()=>{
  await runtime?.close(); await engine?.disconnect(); server?.stop(true);
  for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
  if(root&&resolve(root).startsWith(resolve(tmpdir())+sep)&&root.includes('pmbrain-imported-entities-'))rmSync(root,{recursive:true,force:true});
},60_000);
test('an import survives runtime restart, automatically creates an entity and exposes persisted graph results',async()=>{
  const file=join(root,'input.md');
  writeFileSync(file,'---\ntitle: 导入资料\ntype: note\n---\n刘慈欣创作了三体，这是导入的中文资料。');
  expect((await importFile(engine,file,'notes/input.md',{sourceId:'auto-capture',noEmbed:true})).status).toBe('imported');
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE queue='pmbrain-product' AND data->'task'->'input'->>'sourceId'='auto-capture'")).toHaveLength(1);
  runtime=new ProductTaskRuntime(engine); await runtime.start();
  let job:{id:number;status:string;error_text:string|null}|undefined;
  const deadline=Date.now()+45_000;
  while(Date.now()<deadline){
    [job]=await engine.executeRaw<typeof job & {}>("SELECT id,status,error_text FROM minion_jobs WHERE queue='pmbrain-product' AND data->'task'->'input'->>'sourceId'='auto-capture' ORDER BY id DESC LIMIT 1");
    if(job&&['completed','dead','failed','paused'].includes(job.status))break;
    await Bun.sleep(50);
  }
  expect(job?.status,job?.error_text??JSON.stringify(await runtime.listRuns())).toBe('completed');
  expect((await engine.getPage('people/liu',{sourceId:'auto-capture'}))?.title).toBe('刘慈欣');
  const links=await engine.executeRaw<{from_slug:string;to_slug:string}>('SELECT f.slug AS from_slug,t.slug AS to_slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id=$1',['auto-capture']);
  expect(links).toContainEqual({from_slug:'notes/input',to_slug:'people/liu'});
  const count=calls;
  await runtime.close(); runtime=new ProductTaskRuntime(engine); await runtime.start();
  await Bun.sleep(300);
  expect(calls).toBe(count);
  expect((await runtime.listRuns()).some(run=>run.kind==='dream_capture_entities'&&run.trigger==='scheduled'&&run.status==='completed')).toBe(true);
  expect(await engine.getConfig('dream.entity_capture.pending.auto-capture')).toBeNull();
},60_000);
