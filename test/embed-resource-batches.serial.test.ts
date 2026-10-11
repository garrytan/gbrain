import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
import {PostgresEngine} from '../src/core/postgres-engine.ts';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard.ts';
import {runEmbedCore} from '../src/commands/embed.ts';
import {configureGateway,resetGateway,__setEmbedTransportForTests} from '../src/core/ai/gateway.ts';

test('向量分页随资源压力缩小再恢复，游标不跳过切片且写入保留兄弟切片',async()=>{
  const database=process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
  if(database)assertSafeE2eDatabaseUrl(database);
  const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_EMBEDDING_MODEL','GBRAIN_EMBEDDING_MODEL','PMBRAIN_EMBEDDING_DIMENSIONS','GBRAIN_EMBEDDING_DIMENSIONS'];
  const saved=keys.map(key=>process.env[key]);
  const home=mkdtempSync(join(tmpdir(),'pmbrain-embed-pressure-'));
  keys.forEach(key=>delete process.env[key]);
  process.env.PMBRAIN_HOME=home;process.env.GBRAIN_HOME=home;
  mkdirSync(join(home,'.pmbrain'));
  writeFileSync(join(home,'.pmbrain','config.json'),JSON.stringify({engine:database?'postgres':'pglite',embedding_model:'openai:text-embedding-3-large',embedding_dimensions:1536,model_usage:{embedding_enabled:true,generative_enabled:false}}));
  const engine=database?new PostgresEngine():new PGLiteEngine();
  try{
    configureGateway({embedding_model:'openai:text-embedding-3-large',embedding_dimensions:1536,env:{OPENAI_API_KEY:'sk-test'}});
    __setEmbedTransportForTests(async({values})=>({embeddings:values.map(()=>Array.from({length:1536},(_,i)=>i===0?1:0))}) as any);
    await engine.connect(database?{database_url:database}:{});await engine.initSchema();
    for(let page=0;page<3;page++){
      await engine.putPage(`resource-${page}`,{title:`分页 ${page}`,type:'note',compiled_truth:'合成测试资料'});
      await engine.upsertChunks(`resource-${page}`,Array.from({length:5},(_,i)=>({chunk_index:i,chunk_text:`合成切片 ${page}/${i}`,chunk_source:'compiled_truth' as const,token_count:5})));
    }
    let size=4;
    const batches:number[]=[];
    const list=engine.listStaleChunks.bind(engine);
    engine.listStaleChunks=async opts=>{
      batches.push(opts!.batchSize!);
      const rows=await list(opts);
      size=batches.length===1?2:3;
      return rows;
    };
    const result=await runEmbedCore(engine,{stale:true,quiet:true,getBatchSize:()=>size});
    expect(batches.slice(0,3)).toEqual([4,2,3]);
    expect(result.embedded).toBe(15);
    expect(result.failedPages).toBe(0);
    expect(await engine.countStaleChunks()).toBe(0);
    for(let page=0;page<3;page++)expect(await engine.getChunks(`resource-${page}`)).toHaveLength(5);
  }finally{
    await engine.disconnect();__setEmbedTransportForTests(null);resetGateway();
    keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});
    rmSync(home,{recursive:true,force:true});
  }
},60000);
