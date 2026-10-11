import {afterAll,afterEach,beforeAll,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
import {PostgresEngine} from '../src/core/postgres-engine.ts';
import type {BrainEngine} from '../src/core/engine.ts';
import {configureGateway,resetGateway,__setChatTransportForTests,type ChatResult} from '../src/core/ai/gateway.ts';
import {runPhaseExtractAtoms} from '../src/core/cycle/extract-atoms.ts';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard.ts';
import {resetPgliteState} from './helpers/reset-pglite.ts';

const previous=process.env.PMBRAIN_HOME;
process.env.PMBRAIN_HOME=mkdtempSync(join(tmpdir(),'pmbrain-extraction-compat-'));
const url=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine:BrainEngine;
beforeAll(async()=>{if(url)assertSafeE2eDatabaseUrl(url);engine=url?new PostgresEngine():new PGLiteEngine();await engine.connect(url?{database_url:url}:{});await engine.initSchema();},60_000);
beforeEach(async()=>{await resetPgliteState(engine as PGLiteEngine);configureGateway({chat_model:'ollama:Qwen3.6-35B-A3B',chat_output_limits:{'ollama:Qwen3.6-35B-A3B':64000},generative_enabled:true,env:{}});await engine.setConfig('models.dream.extract_atoms','ollama:Qwen3.6-35B-A3B');});
afterEach(()=>{__setChatTransportForTests(null);resetGateway();});
afterAll(async()=>{await engine.disconnect();if(previous===undefined)delete process.env.PMBRAIN_HOME;else process.env.PMBRAIN_HOME=previous;},60_000);

function reply(stopReason:ChatResult['stopReason'],text='[]'):ChatResult{return {text,blocks:[{type:'text',text}],stopReason,model:'ollama:Qwen3.6-35B-A3B',providerId:'ollama',usage:{input_tokens:10,output_tokens:5,cache_read_tokens:0,cache_creation_tokens:0}};}

for(const mode of ['length','parse'] as const)test(`Atom ${mode} 失败不写完成标记，下一页继续并保留再次处理入口`,async()=>{
  const pages=[{slug:'notes/bad',content:'待抽取正文',contentHash:'bad-hash-12345678'},{slug:'notes/good',content:'正常正文',contentHash:'good-hash-1234567'}];
  for(const page of pages)await engine.putPage(page.slug,{type:'note',title:page.slug,compiled_truth:page.content,frontmatter:{}});
  const requests:number[]=[];
  __setChatTransportForTests(async opts=>{requests.push(opts.maxTokens!);return opts.messages.some(message=>JSON.stringify(message.content).includes('notes/bad'))?reply(mode==='length'?'length':'end',mode==='length'?'[]':'invalid JSON'):reply('end');});
  const result=await runPhaseExtractAtoms(engine,{sourceId:'default',_pages:pages,_transcripts:[]});
  expect(result.details?.pages_processed).toBe(1);expect((result.details?.failures as unknown[])).toHaveLength(1);
  expect((await engine.getPage('notes/bad'))?.frontmatter.atoms_scan_hash).toBeUndefined();
  expect((await engine.getPage('notes/good'))?.frontmatter.atoms_scan_hash).toBe(pages[1]!.contentHash.slice(0,16));
  expect(requests).toEqual(mode==='length'?[32000,64000,32000]:[32000,32000]);
});
