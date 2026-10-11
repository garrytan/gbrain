import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent, importFile } from '../src/core/import-file.ts';
import { syncFileContentFingerprint } from '../src/product/tasks/checkpoint.ts';
import { syncFileManifestKey } from '../src/product/tasks/sync-file-queue.ts';
import { importStructuredDocument } from '../src/core/document/document-import.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { SYNC_FILE_QUEUE, SyncFileQueue } from '../src/product/tasks/sync-file-queue.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const database = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const keys = ['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL'];
const saved = keys.map(key => process.env[key]);
let home: string;
let engine: BrainEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(),'pmbrain-sync-batches-'));
  keys.forEach(key => delete process.env[key]);
  process.env.PMBRAIN_HOME = home; process.env.GBRAIN_HOME = home;
  mkdirSync(join(home,'.pmbrain'));
  writeFileSync(join(home,'.pmbrain','config.json'),JSON.stringify({engine:database?'postgres':'pglite',model_usage:{embedding_enabled:false,generative_enabled:false}}));
  if (database) assertSafeE2eDatabaseUrl(database);
  engine = database ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(database ? {database_url:database} : {});
  await engine.initSchema();
},60000);
afterAll(async () => {
  await engine?.disconnect();
  keys.forEach((key,i) => { if(saved[i]===undefined) delete process.env[key]; else process.env[key]=saved[i]; });
  if(home) rmSync(home,{recursive:true,force:true});
},60000);

const body = Array.from({length:210},(_,i) => `## 段落 ${i}\n\n${'有意义的中文内容用于确认分批事务和停止续跑。'.repeat(15)}\n\n`).join('');

test('普通 Markdown 分批提交，中断保留第一批且不能认作已完成，继续后不重复',async () => {
  let writes = 0;
  const sizes: number[] = [];
  const observed = new Proxy(engine, {get(target,key) {
    if(key==='transaction') return (fn:(tx:BrainEngine)=>Promise<unknown>) => target.transaction(tx => fn(new Proxy(tx,{get(inner,method) {
      if(method==='upsertChunks') return async (slug:string,chunks:unknown[],opts:unknown) => {
        sizes.push(chunks.length);
        if(++writes===2) throw new Error('模拟第二批停止');
        return inner.upsertChunks(slug,chunks as never,opts as never);
      };
      const value=Reflect.get(inner,method);return typeof value==='function'?value.bind(inner):value;
    }})));
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }}) as BrainEngine;
  let failure: unknown;
  try { await importFromContent(observed,'batch-markdown','# 批次验收\n\n'+body,{noEmbed:true,sourcePath:'batch-markdown.md'}); } catch(error) {failure=error;}
  expect(String(failure)).toContain('模拟第二批停止');
  expect(sizes.every(size=>size<=100)).toBe(true);
  expect(await engine.getChunks('batch-markdown')).toHaveLength(100);
  expect((await engine.executeRaw<{chunker_version:number}>("SELECT chunker_version FROM pages WHERE slug='batch-markdown'"))[0].chunker_version).toBeLessThan(0);
  writes=1000;sizes.length=0;
  const resumed=await importFromContent(observed,'batch-markdown','# 批次验收\n\n'+body,{noEmbed:true,sourcePath:'batch-markdown.md'});
  expect(resumed.status).toBe('imported');
  expect(await engine.getChunks('batch-markdown')).toHaveLength(resumed.chunks);
  expect(sizes.reduce((total,size)=>total+size,0)).toBe(resumed.chunks-100);
  expect((await importFromContent(engine,'batch-markdown','# 批次验收\n\n'+body,{noEmbed:true})).status).toBe('skipped');
},60000);

test('Office 和 PDF 共享的文档导入器每批不超过 100 片且各批独立提交',async () => {
  const file=join(home,'document.pdf');writeFileSync(file,'synthetic parsed source');
  let transactions=0;const batches:number[]=[];
  const observed=new Proxy(engine,{get(target,key){
    if(key==='transaction')return (fn:(tx:BrainEngine)=>Promise<unknown>)=>{transactions++;return target.transaction(tx=>fn(new Proxy(tx,{get(inner,method){
      if(method==='upsertChunks')return async (slug:string,chunks:unknown[],opts:unknown)=>{batches.push(chunks.length);return inner.upsertChunks(slug,chunks as never,opts as never);};
      const value=Reflect.get(inner,method);return typeof value==='function'?value.bind(inner):value;
    }})));};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }}) as BrainEngine;
  const result=await importStructuredDocument(observed,{title:'文档',format:'pdf',sections:Array.from({length:210},(_,i)=>({id:String(i),type:'paragraph',text:`第 ${i} 段 ${'正常中文资料内容用于独立文档分批写入。'.repeat(45)}`,locator:{page:i+1}})),metadata:{parser:'synthetic',structured:true,local:true,imageCount:0,tableCount:0,ocrUsed:false}} as never,file,'batch-document.pdf',{noEmbed:true});
  expect(result.status).toBe('imported');expect(batches.length).toBeGreaterThan(1);
  expect(batches.every(size=>size<=100)).toBe(true);expect(transactions).toBeGreaterThanOrEqual(batches.length+2);
  expect(await engine.getChunks(result.slug)).toHaveLength(result.chunks);
},60000);

test('文件统计只统计 parent_job_id，过期子任务被回收后父任务可完成',async () => {
  const queue=new MinionQueue(engine);
  const parent=await queue.add('test-parent',{}, {queue:'test-parent'});
  const child=await queue.add('test-child',{sessionId:parent.id},{queue:SYNC_FILE_QUEUE,parent_job_id:parent.id,max_stalled:1,on_child_fail:'continue'});
  await queue.add('unrelated',{sessionId:parent.id},{queue:SYNC_FILE_QUEUE});
  expect((await new SyncFileQueue(engine).counts(parent.id)).total).toBe(1);
  await engine.executeRaw("UPDATE minion_jobs SET status='active',lock_token='orphan',lock_until=now()-interval '1 hour' WHERE id=$1",[child.id]);
  const reclaimed=await queue.handleStalled();expect(reclaimed.dead.some(row=>row.id===child.id)).toBe(true);
  expect((await queue.getJob(child.id))?.stalled_counter).toBe(1);
  expect((await queue.getJob(parent.id))?.status).toBe('waiting');
},60000);

test('超过 5000 条历史也认领旧页面，源 SHA256 与页面 hash 分开保存，换模型不重复同步',async () => {
  const file=join(home,'legacy-source.md');const content='# 老页面\n\n已导入的资料应当认领，而不是重新生成任务。';writeFileSync(file,content);
  await importFile(engine,file,'legacy-source.md',{noEmbed:true});
  const queue=new MinionQueue(engine);
  const parent=await queue.add('legacy-parent',{}, {queue:'legacy-parent'});
  await queue.claim('legacy-token',3600000,'legacy-parent',['legacy-parent']);
  await engine.executeRaw(`INSERT INTO minion_jobs(name,queue,status,data,result)
    SELECT 'legacy-history',$1,'completed','{}'::jsonb,'{}'::jsonb FROM generate_series(1,5001)`,[SYNC_FILE_QUEUE]);
  const info=statSync(file);const options={sourceId:'default',noEmbed:true,documentOcr:true};
  const input={path:file,relativePath:'legacy-source.md',sourceRoot:home,originalPath:file,originalSize:info.size,originalMtime:info.mtimeMs,
    hash:createHash('sha256').update(content).digest('hex'),fingerprint:syncFileContentFingerprint(options),modelFingerprint:'old-model',options};
  const files=new SyncFileQueue(engine);
  expect(await files.sourceHash(input)).toBeNull();
  expect((await files.enqueue(parent.id,'legacy-token',input)).unchanged).toBe(true);
  const receipt=JSON.parse((await engine.getConfig(syncFileManifestKey(input)))!);
  expect(receipt.hash).toBe(input.hash);expect(receipt.pageHash).not.toBe(receipt.hash);
  expect(await files.sourceHash(input)).toBe(input.hash);
  expect(await files.sourceHash({...input,originalMtime:info.mtimeMs+1})).toBeNull();
  expect((await files.enqueue(parent.id,'legacy-token',{...input,modelFingerprint:'different-model-and-api-key'})).unchanged).toBe(true);
  expect((await files.counts(parent.id)).total).toBe(0);
  expect(await engine.getConfig(syncFileManifestKey({...input,options:{...options,sourceId:'another-source'}}))).toBeNull();
},60000);

test('停止发生在领任务请求途中时，退回任务且不开始处理',async () => {
  const queue=new MinionQueue(engine);const job=await queue.add('claim-stop',{}, {queue:'claim-stop'});
  let entered!:()=>void;let release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
  let handled=0;
  const observed=new Proxy(engine,{get(target,key){
    if(key==='executeRaw')return async (sql:string,args:unknown[])=>{
      const result=await target.executeRaw(sql,args);
      if(sql.includes('attempts_started = attempts_started + 1') && result.length){entered();await gate;}
      return result;
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }}) as BrainEngine;
  const worker=new MinionWorker(observed,{queue:'claim-stop',pollInterval:10,healthCheckInterval:0});
  worker.register('claim-stop',async()=>{handled++;return {};});
  const running=worker.start();await started;worker.stop();release();await running;
  expect(handled).toBe(0);expect((await queue.getJob(job.id))?.status).toBe('waiting');
  expect((await queue.getJob(job.id))?.attempts_started).toBe(0);
},60000);

test('旧 Office 内容去重回执不因原页面路径不同重复入队，跳过的零新增分块不能覆盖已有分块数',async()=>{
  const file=join(home,'office-copy.docx');writeFileSync(file,'isolated original Office bytes');
  const info=statSync(file);
  await importFromContent(engine,'office-original','# 旧 Office\n\n保持原页面与来源路径。',{noEmbed:true,sourcePath:'backups\\office-original-v1.docx'});
  const page=(await engine.getPage('office-original'))!;
  const chunks=await engine.getChunks('office-original');
  expect(chunks.length).toBeGreaterThan(0);
  const options={sourceId:'default',noEmbed:true,includeOffice:true,documentOcr:true};
  const input={path:file,relativePath:'backups/office-copy.docx',sourceRoot:home,originalPath:file,originalSize:info.size,originalMtime:info.mtimeMs,
    hash:createHash('sha256').update(readFileSync(file)).digest('hex'),fingerprint:syncFileContentFingerprint(options),modelFingerprint:'isolated-model',options};
  const queue=new MinionQueue(engine);
  const parent=await queue.add('office-mapping-parent',{}, {queue:'office-mapping-parent'});
  await queue.claim('office-mapping-token',3600000,'office-mapping-parent',['office-mapping-parent']);
  const child=await queue.add('pmbrain-sync-file',{sessionId:parent.id,kind:'sync_file',task:{type:'sync-file',input}},{queue:SYNC_FILE_QUEUE,delay:86400000});
  await engine.executeRaw(`UPDATE minion_jobs SET parent_job_id=$1,status='completed',result=$3::jsonb WHERE id=$2`,[parent.id,child.id,{slug:page.slug,status:'skipped',chunks:0,pageHash:page.content_hash}]);
  const files=new SyncFileQueue(engine);
  expect((await files.enqueue(parent.id,'office-mapping-token',input)).status).toBe('skipped');
  expect((await files.counts(parent.id)).total).toBe(1);
  const manifest=JSON.parse((await engine.getConfig(syncFileManifestKey(input)))!);
  expect(manifest.chunks).toBe(chunks.length);
  expect(manifest.contentMatched).toBe(true);
  const next=await queue.add('office-mapping-next',{}, {queue:'office-mapping-next'});
  await queue.claim('office-mapping-next-token',3600000,'office-mapping-next',['office-mapping-next']);
  expect((await files.enqueue(next.id,'office-mapping-next-token',input)).unchanged).toBe(true);
  expect((await files.counts(next.id)).total).toBe(0);
  expect(await engine.getPage('office-original')).toEqual(page);
  expect(await engine.getChunks('office-original')).toEqual(chunks);
},60000);

test('升级后复用旧指纹的未完成任务，已导入的旧排队文件退出队列',async () => {
  const file=join(home,'upgrade-source.md');writeFileSync(file,'# 升级资料\n\n保留旧文件任务，不再重复入队。');
  const info=statSync(file);const options={sourceId:'default',noEmbed:true,activePack:{page_types:[{path_prefixes:[],name:'note'}]}};
  const input={path:file,relativePath:'upgrade-source.md',sourceRoot:home,originalPath:file,originalSize:info.size,originalMtime:info.mtimeMs,
    hash:createHash('sha256').update(readFileSync(file)).digest('hex'),fingerprint:syncFileContentFingerprint(options),modelFingerprint:'new-model',options};
  const queue=new MinionQueue(engine);const parent=await queue.add('upgrade-parent',{}, {queue:'upgrade-parent'});
  await queue.claim('upgrade-token',3600000,'upgrade-parent',['upgrade-parent']);
  const old=await queue.add('pmbrain-sync-file',{sessionId:parent.id,kind:'sync_file',task:{type:'sync-file',input:{...input,fingerprint:'old-fingerprint',modelFingerprint:'old-model'}}},
    {queue:SYNC_FILE_QUEUE,delay:86400000,idempotency_key:'old-upgrade-key'});
  await engine.executeRaw('UPDATE minion_jobs SET parent_job_id=$1 WHERE id=$2',[parent.id,old.id]);
  const files=new SyncFileQueue(engine);
  expect((await files.enqueue(parent.id,'upgrade-token',input)).deferred).toBe(true);
  expect((await files.counts(parent.id)).total).toBe(1);
  expect((((await queue.getJob(old.id))!.data.task as {input:typeof input}).input).fingerprint).toBe(input.fingerprint);
  await importFile(engine,file,input.relativePath,options);
  expect((await files.enqueue(parent.id,'upgrade-token',input)).unchanged).toBe(true);
  expect((await files.counts(parent.id)).total).toBe(0);
  expect((await queue.getJob(old.id))?.status).toBe('cancelled');
},60000);

test('批次之间页面被用户编辑时停止写入，保留用户的新内容',async () => {
  let wrote=false;let edited=false;
  const observed=new Proxy(engine,{get(target,key){
    if(key==='transaction')return async(fn:(tx:BrainEngine)=>Promise<unknown>)=>{
      const result=await target.transaction(tx=>fn(new Proxy(tx,{get(inner,method){
        if(method==='upsertChunks')return async(...args:Parameters<BrainEngine['upsertChunks']>)=>{await inner.upsertChunks(...args);wrote=true;};
        const value=Reflect.get(inner,method);return typeof value==='function'?value.bind(inner):value;
      }})));
      if(wrote&&!edited){edited=true;await target.putPage('batch-edited',{type:'note',title:'用户修改',compiled_truth:'批次之间保存的用户内容',content_hash:'manual-edit'});}
      return result;
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }}) as BrainEngine;
  let failure:unknown;
  try{await importFromContent(observed,'batch-edited','# 批次编辑\n\n'+body,{noEmbed:true});}catch(error){failure=error;}
  expect(String(failure)).toContain('分批写入期间已改变');
  expect((await engine.getPage('batch-edited'))?.compiled_truth).toBe('批次之间保存的用户内容');
  expect(await engine.getChunks('batch-edited')).toHaveLength(100);
},60000);
