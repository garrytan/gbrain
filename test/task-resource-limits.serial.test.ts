import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { ProductTaskRuntime } from '../src/product/tasks/runtime.ts';
import { TaskEngineHost } from '../src/product/tasks/engine-host.ts';
import { TaskResourceGuard, streamFileHash, copyFileSnapshot, assertImportFileSize } from '../src/product/tasks/resource-guard.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { FileProjection } from '../src/product/tasks/file-projection.ts';
import { taskArtifactPath } from '../src/product/tasks/checkpoint.ts';
import { SyncFileQueue, SYNC_FILE_QUEUE, SYNC_FILE_TASK } from '../src/product/tasks/sync-file-queue.ts';
import { gbrainPath } from '../src/core/config.ts';
import { syncFileContentFingerprint, taskModelFingerprint } from '../src/product/tasks/checkpoint.ts';
import { TaskProgressAdapter } from '../src/product/tasks/progress-adapter.ts';

const database=process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL'];
const saved=keys.map(key=>process.env[key]);
let home:string;
let engine:BrainEngine;
beforeAll(async()=>{
  home=mkdtempSync(join(tmpdir(),'pmbrain-resources-'));
  keys.forEach(key=>delete process.env[key]);
  process.env.PMBRAIN_HOME=home;process.env.GBRAIN_HOME=home;
  mkdirSync(join(home,'.pmbrain'));
  writeFileSync(join(home,'.pmbrain','config.json'),JSON.stringify({engine:database?'postgres':'pglite',model_usage:{embedding_enabled:false,generative_enabled:false}}));
  if(database)assertSafeE2eDatabaseUrl(database);
  engine=database?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(database?{database_url:database}:{});await engine.initSchema();
},60000);
afterAll(async()=>{
  await engine?.disconnect();keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});
  if(home)rmSync(home,{recursive:true,force:true});
},60000);

test('队列硬上限原子拒绝并发新任务，延迟与暂停任务占用容量，幂等重试与终态不额外占位',async()=>{
  const queue=new MinionQueue(engine);
  const opts={queue:'resource-cap',maxQueueSize:2};
  const first=await queue.add('first',{}, {...opts,delay:86400000,idempotency_key:'resource-first'});
  await engine.executeRaw("UPDATE minion_jobs SET status='paused' WHERE id=$1",[first.id]);
  const submitted=await Promise.allSettled(Array.from({length:8},(_,i)=>queue.add('concurrent-'+i,{},opts)));
  expect(submitted.filter(row=>row.status==='fulfilled')).toHaveLength(1);
  expect(submitted.filter(row=>row.status==='rejected').every(row=>String(row.reason).includes('队列容量'))).toBe(true);
  expect((await queue.add('first',{}, {...opts,idempotency_key:'resource-first'})).id).toBe(first.id);
  await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1",[first.id]);
  expect((await queue.add('after-completion',{},opts)).queue).toBe(opts.queue);
},60000);

test('流式哈希和快照字节一致，空间不足或复制途中取消时不留下半份快照，原资料不变',async()=>{
  const input=join(home,'stream-source.bin');const output=join(home,'stream-snapshot.bin');
  const bytes=Buffer.alloc(3*1024*1024,42);writeFileSync(input,bytes);
  const hash=createHash('sha256').update(bytes).digest('hex');
  expect(await streamFileHash(input)).toBe(hash);
  await copyFileSnapshot(input,output,hash,async()=>{});
  expect(readFileSync(output)).toEqual(bytes);
  const failed=join(home,'stream-failed.bin');
  let checks=0;
  await expect(copyFileSnapshot(input,failed,hash,async()=>{if(++checks===3)throw new Error('模拟空间不足');})).rejects.toThrow('模拟空间不足');
  expect(existsSync(failed)).toBe(false);
  expect(readFileSync(input)).toEqual(bytes);
  const cancelled=join(home,'stream-cancelled.bin');const abort=new AbortController();checks=0;
  await expect(copyFileSnapshot(input,cancelled,hash,async()=>{if(++checks===3)abort.abort(new Error('模拟停止'));abort.signal.throwIfAborted();})).rejects.toThrow('模拟停止');
  expect(existsSync(cancelled)).toBe(false);
  expect(()=>assertImportFileSize('huge.md',6*1024**2)).toThrow('文件过大');
  expect(()=>assertImportFileSize('supported.docx',6*1024**2)).not.toThrow();
});

test('磁盘不足时不开始文件或写入事务，释放空间后同一任务正常写入',async()=>{
  let available=0;
  const guard=new TaskResourceGuard({diskReserveBytes:1024,freeDiskBytes:async()=>available});
  const queue=new MinionQueue(engine);
  const job=await queue.add('resource-disk',{}, {queue:'resource-disk'});
  await queue.claim('resource-disk-token',30000,'resource-disk',['resource-disk']);
  const host=new TaskEngineHost(engine,job.id,'resource-disk-token',async()=>{},false,undefined,guard);
  await expect(host.dispatch({type:'rpc',id:1,method:'task.inputFile',args:[{path:join(home,'source.md'),size:10,mtimeMs:0}]})).rejects.toThrow('磁盘空间不足');
  await expect(host.dispatch({type:'rpc',id:2,method:'transaction.open',args:[]})).rejects.toThrow('磁盘空间不足');
  expect(host.ownsLockedTransaction()).toBe(false);
  available=10*1024*1024;
  await host.dispatch({type:'rpc',id:3,method:'putPage',args:['resource-disk-page',{title:'资源验收',type:'note',compiled_truth:'保留原文',frontmatter:{}}]});
  expect((await engine.getPage('resource-disk-page'))?.title).toBe('资源验收');
  const scope=await host.dispatch({type:'rpc',id:4,method:'transaction.open',args:[]}) as number;
  await host.dispatch({type:'rpc',id:5,scope,method:'putPage',args:['resource-disk-rollback',{title:'应回滚',type:'note',compiled_truth:'未提交内容',frontmatter:{}}]});
  available=0;
  await expect(host.dispatch({type:'rpc',id:6,scope,method:'putPage',args:['resource-disk-next',{title:'不写入',type:'note',compiled_truth:'不写入',frontmatter:{}}]})).rejects.toThrow('磁盘空间不足');
  await host.dispatch({type:'rpc',id:7,scope,method:'scope.close',args:[false]}).catch(()=>{});
  expect(await engine.getPage('resource-disk-rollback')).toBeNull();
  expect((await engine.getPage('resource-disk-page'))?.title).toBe('资源验收');
  await host.close();
},60000);

test('快照容量拒绝超限并在释放后恢复，不会删除原资料来腾空间',async()=>{
  const guard=new TaskResourceGuard({snapshotQuotaBytes:100});
  const release=await guard.reserveSnapshot(70);
  await expect(guard.reserveSnapshot(31)).rejects.toThrow('快照容量');
  release();release();
  await expect(guard.reserveSnapshot(100)).resolves.toBeFunction();
});

test('软件重启回收已完成任务的遗留快照，暂停任务的快照与原资料保留',async()=>{
  const directory=gbrainPath('task-artifacts','sync-files','77001');mkdirSync(directory,{recursive:true});
  const completed=join(directory,'a'.repeat(64)+'-completed.md'),paused=join(directory,'b'.repeat(64)+'-paused.md');
  const original=join(home,'snapshot-original.md');writeFileSync(original,'原始资料必须保留');
  writeFileSync(completed,Buffer.alloc(60));writeFileSync(paused,Buffer.alloc(30));
  const queue=new MinionQueue(engine);
  for(const [path,status] of [[completed,'completed'],[paused,'paused']]){
    const job=await queue.add(SYNC_FILE_TASK,{sessionId:77001,task:{input:{path}}},{queue:SYNC_FILE_QUEUE});
    await engine.executeRaw("UPDATE minion_jobs SET status=$2,result=$3::jsonb WHERE id=$1",[job.id,status,{status:'imported'}]);
  }
  const resources=new TaskResourceGuard({snapshotQuotaBytes:100});
  await resources.reserveSnapshot(0);
  const denied=await resources.reserveSnapshot(40).catch(error=>error);expect(String(denied)).toContain('快照容量');
  const files=new SyncFileQueue(engine,undefined,()=>true,resources);
  await files.cleanupCompletedSnapshots();await files.cleanupCompletedSnapshots();
  expect(existsSync(completed)).toBe(false);expect(existsSync(paused)).toBe(true);
  expect(readFileSync(original,'utf8')).toBe('原始资料必须保留');
  expect(await resources.reserveSnapshot(40)).toBeFunction();
  writeFileSync(completed,Buffer.alloc(60));
  const runtime=new ProductTaskRuntime(engine,{snapshotQuotaBytes:100});
  try{
    await runtime.start();
    expect(existsSync(completed)).toBe(false);expect(existsSync(paused)).toBe(true);
    expect(readFileSync(original,'utf8')).toBe('原始资料必须保留');
  }finally{await runtime.close();}
  unlinkSync(paused);
},60000);

test('整批资料超过快照窗口时自动分批完成，同一任务不报失败且完成副本释放',async()=>{
  const dir=join(home,'bounded-scan');mkdirSync(dir);
  const content='# 有界队列\n\n容量不足时保留原文，先完成已经入队的资料。';
  for(const name of ['first.md','second.md','third.md'])writeFileSync(join(dir,name),content+'\n'+name);
  const originals=['first.md','second.md','third.md'].map(name=>readFileSync(join(dir,name)));
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('bounded-scan','容量验收',$1,'{}'::jsonb)",[dir]);
  const runtime=new ProductTaskRuntime(engine,{snapshotQuotaBytes:Buffer.byteLength(content+'\nsecond.md')*2});
  await runtime.start();
  async function ended(id:string){
    const deadline=Date.now()+90_000;
    while(Date.now()<deadline){const run=await runtime.getRun(id);if(run&&!['running','queued'].includes(run.status))return run;await Bun.sleep(30);}
    throw new Error(`容量限制任务未收尾：${JSON.stringify(await runtime.getRun(id))}`);
  }
  try{
    const run=await runtime.submitDream({preset:'quick',sourceId:'bounded-scan'});
    const resumed=await ended(run.id);
    expect(resumed.status,JSON.stringify(resumed)).toBe('completed');
    expect((await engine.executeRaw<{stopped:boolean}>("SELECT data ? 'resourceStopReason' AS stopped FROM minion_jobs WHERE id=$1",[Number(run.id.slice(5))]))[0].stopped).toBe(false);
    const resumedFiles=await runtime.files(run.id);
    const savedPages=await engine.executeRaw<{slug:string}>("SELECT slug FROM pages WHERE source_id='bounded-scan' ORDER BY slug");
    expect(savedPages.map(page=>page.slug)).toEqual(['first','second','third']);
    expect(resumedFiles?.rows,JSON.stringify({run:await runtime.getRun(run.id),files:resumedFiles})).toHaveLength(3);
    expect(resumedFiles?.rows.every(row=>row.status==='completed')).toBe(true);
    const snapshots=await engine.executeRaw<{path:string}>("SELECT data->'task'->'input'->>'path' AS path FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2",[SYNC_FILE_QUEUE,Number(run.id.slice(5))]);
    expect(snapshots.every(row=>!existsSync(row.path))).toBe(true);
    originals.forEach((bytes,index)=>expect(readFileSync(join(dir,['first.md','second.md','third.md'][index]))).toEqual(bytes));
  }finally{
    await runtime.close();
    await engine.executeRaw("UPDATE minion_jobs SET status='cancelled' WHERE id=(SELECT parent_job_id FROM minion_jobs WHERE queue=$1 AND data->'task'->'input'->'options'->>'sourceId'='bounded-scan' LIMIT 1)",[SYNC_FILE_QUEUE]);
    const snapshots=await engine.executeRaw<{path:string}>("SELECT data->'task'->'input'->>'path' AS path FROM minion_jobs WHERE queue=$1 AND data->'task'->'input'->'options'->>'sourceId'='bounded-scan'",[SYNC_FILE_QUEUE]);
    for(const row of snapshots){if(!row.path.startsWith(home))throw new Error('隔离快照路径越界');if(existsSync(row.path))unlinkSync(row.path);}
  }
},120000);

test('停止任务释放可重建的快照，新任务不被旧副本阻塞，旧任务仍按原子任务续跑',async()=>{
  const queue=new MinionQueue(engine);
  const resources=new TaskResourceGuard({snapshotQuotaBytes:80});
  let files=new SyncFileQueue(engine,undefined,()=>true,resources);
  const dir=join(home,'stopped-cache');mkdirSync(dir);
  const path=join(dir,'original.md');writeFileSync(path,'# 原资料\n\n'+'甲'.repeat(20));
  const bytes=readFileSync(path),info=statSync(path);
  const options={sourceId:'stopped-cache',noEmbed:true};
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('stopped-cache','停止续跑验收',$1,'{}'::jsonb)",[dir]);
  const input={path,originalPath:path,originalSize:info.size,originalMtime:info.mtimeMs,sourceRoot:dir,relativePath:'original.md',options,hash:createHash('sha256').update(bytes).digest('hex'),fingerprint:syncFileContentFingerprint(options),modelFingerprint:taskModelFingerprint()};
  const old=await queue.add('pmbrain-product-task',{kind:'dream_quick',task:{type:'dream',input:{preset:'quick',sourceId:'stopped-cache'}}},{queue:'pmbrain-product',delay:86400000});
  await engine.executeRaw("UPDATE minion_jobs SET status='active',lock_token='stopped-cache-token' WHERE id=$1",[old.id]);
  await files.enqueue(old.id,'stopped-cache-token',input);
  await files.pause(old.id);
  await engine.executeRaw("UPDATE minion_jobs SET status='cancelled',lock_token=NULL,error_text='任务已停止' WHERE id=$1",[old.id]);
  const [child]=await engine.executeRaw<{id:number;path:string}>("SELECT id,data->'task'->'input'->>'path' AS path FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2",[SYNC_FILE_QUEUE,old.id]);
  const runtime=new ProductTaskRuntime(engine,{snapshotQuotaBytes:80});
  try{
    await runtime.start();
    expect(existsSync(child.path)).toBe(false);
    expect((await queue.getJob(child.id))?.status).toBe('paused');
    expect(readFileSync(path)).toEqual(bytes);
    await runtime.close();
    files=new SyncFileQueue(engine,undefined,()=>true,new TaskResourceGuard({snapshotQuotaBytes:80}));
    await files.resume(old.id);
    await engine.executeRaw("UPDATE minion_jobs SET status='active',lock_token='stopped-cache-token' WHERE id=$1",[old.id]);
    expect((await files.enqueue(old.id,'stopped-cache-token',input)).deferred).toBe(true);
    const rows=await engine.executeRaw<{id:number;path:string}>("SELECT id,data->'task'->'input'->>'path' AS path FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2",[SYNC_FILE_QUEUE,old.id]);
    expect(rows).toHaveLength(1);expect(rows[0].id).toBe(child.id);expect(rows[0].path).toBe(child.path);
    expect(readFileSync(child.path)).toEqual(bytes);
  }finally{
    await engine.executeRaw("UPDATE minion_jobs SET status='cancelled' WHERE id=$1",[old.id]);
    await runtime.close();
    if(existsSync(child.path))unlinkSync(child.path);
  }
},60000);

test('原资料丢失或内容改变时停止缓存仍保留，清理不会删除仅存副本',async()=>{
  const queue=new MinionQueue(engine);
  const files=new SyncFileQueue(engine);
  const parent=await queue.add('pmbrain-product-task',{kind:'dream_quick',task:{type:'dream',input:{preset:'quick'}}},{queue:'pmbrain-product',delay:86400000});
  await engine.executeRaw("UPDATE minion_jobs SET status='cancelled' WHERE id=$1",[parent.id]);
  const directory=gbrainPath('task-artifacts','sync-files','retained',String(parent.id));mkdirSync(directory,{recursive:true});
  const bytes=Buffer.from('原资料的旧版正文');
  const paths:string[]=[];
  for(const [index,reason] of ['missing','changed'].entries()){
    const original=join(home,reason+'-original.md');writeFileSync(original,bytes);
    const path=join(directory,String(index).repeat(64)+'-'+reason+'.md');writeFileSync(path,bytes);paths.push(path);
    if(reason==='changed')writeFileSync(original,Buffer.alloc(bytes.length,46));
    const info=statSync(original);
    if(reason==='missing')unlinkSync(original);
    const child=await queue.add(SYNC_FILE_TASK,{sessionId:parent.id,task:{type:'sync-file',input:{path,originalPath:original,originalSize:info.size,originalMtime:info.mtimeMs,hash:createHash('sha256').update(bytes).digest('hex')}}},{queue:SYNC_FILE_QUEUE,delay:86400000});
    await engine.executeRaw("UPDATE minion_jobs SET parent_job_id=$2,status='paused' WHERE id=$1",[child.id,parent.id]);
  }
  try{
    await files.cleanupStoppedSnapshots(parent.id);
    for(const path of paths)expect(readFileSync(path)).toEqual(bytes);
  }finally{for(const path of paths)unlinkSync(path);}
},60000);

test('深度整理 Git 临时目录已移除后，仅释放当前原资料仍能重建的停止快照',async()=>{
  const queue=new MinionQueue(engine);const files=new SyncFileQueue(engine);
  const repo=join(home,'git-stopped');mkdirSync(repo);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('git-stopped','Git停止缓存验收',$1,'{}'::jsonb)",[repo]);
  const parent=await queue.add('pmbrain-product-task',{kind:'dream_full',fileSession:true,task:{type:'dream',input:{preset:'full',sourceId:'git-stopped'}}},{queue:'pmbrain-product',delay:86400000});
  await engine.executeRaw("UPDATE minion_jobs SET status='cancelled' WHERE id=$1",[parent.id]);
  const directory=gbrainPath('task-artifacts','sync-files','git-stopped',String(parent.id));mkdirSync(directory,{recursive:true});
  const bytes=Buffer.from('Git已提交资料的原始正文');const paths:string[]=[];
  const names=['safe.md','changed.md','missing.md','../outside.md'];
  for(const [index,name] of names.entries()){
    if(name!=='missing.md')writeFileSync(join(repo,name),index===1?Buffer.alloc(bytes.length,46):bytes);
    const path=join(directory,String(index+1).repeat(64)+'-snapshot.md');writeFileSync(path,bytes);paths.push(path);
    const child=await queue.add(SYNC_FILE_TASK,{sessionId:parent.id,task:{type:'sync-file',input:{path,sourceRoot:repo,relativePath:name,options:{sourceId:'git-stopped',noEmbed:true},originalSize:bytes.length,originalMtime:1,hash:createHash('sha256').update(bytes).digest('hex')}}},{queue:SYNC_FILE_QUEUE,delay:86400000});
    await engine.executeRaw("UPDATE minion_jobs SET parent_job_id=$2,status='paused' WHERE id=$1",[child.id,parent.id]);
  }
  try{
    await files.cleanupStoppedSnapshots(parent.id);
    expect(existsSync(paths[0])).toBe(false);
    for(const path of paths.slice(1))expect(readFileSync(path)).toEqual(bytes);
    expect(readFileSync(join(repo,'safe.md'))).toEqual(bytes);
    expect(readFileSync(join(repo,'../outside.md'))).toEqual(bytes);
  }finally{for(const path of paths)if(existsSync(path))unlinkSync(path);}
},60000);

test('旧版本因快照容量失败的最新任务启动后自动恢复，主动停止和不确定模型请求仍不重启',async()=>{
  const queue=new MinionQueue(engine);
  const dir=join(home,'legacy-capacity');mkdirSync(dir);
  const path=join(dir,'legacy.md');writeFileSync(path,'# 旧容量中断\n\n旧版因缓存达到上限而停止的任务，应恢复正常处理。');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('legacy-capacity','旧任务容量恢复',$1,'{}'::jsonb)",[dir]);
  const reason='资源保护：同步快照容量已达到 1024 MB，已拒绝入队。请先完成已有任务后手动继续。';
  const parent=await queue.add('pmbrain-product-task',{kind:'dream_quick',resourceStopReason:reason,task:{type:'dream',input:{preset:'quick',sourceId:'legacy-capacity'}}},{queue:'pmbrain-product',delay:86400000});
  const progress=new TaskProgressAdapter('dream_quick').view;progress.errorReason=reason;
  await engine.executeRaw("UPDATE minion_jobs SET status='paused',error_text=$2,progress=$3::jsonb WHERE id=$1",[parent.id,reason,{product:progress,result:{status:'partial'}}]);
  const unsafe=await queue.add('pmbrain-product-task',{kind:'dream_quick',resourceStopReason:reason,task:{type:'dream',input:{preset:'quick',sourceId:'legacy-uncertain'}}},{queue:'pmbrain-product',delay:86400000});
  await engine.executeRaw("UPDATE minion_jobs SET status='paused',error_text=$2 WHERE id=$1",[unsafe.id,reason]);
  const child=await queue.add(SYNC_FILE_TASK,{sessionId:unsafe.id,task:{type:'sync-file',input:{modelMayRun:true}}},{queue:SYNC_FILE_QUEUE,delay:86400000});
  await engine.executeRaw("UPDATE minion_jobs SET parent_job_id=$2,status='paused',attempts_started=1 WHERE id=$1",[child.id,unsafe.id]);
  const unsafeInline=await queue.add('pmbrain-product-task',{kind:'dream_quick',resourceStopReason:reason,task:{type:'dream',input:{preset:'quick',sourceId:'legacy-inline-uncertain'}}},{queue:'pmbrain-product',delay:86400000});
  await engine.executeRaw("UPDATE minion_jobs SET status='paused',error_text=$2 WHERE id=$1",[unsafeInline.id,reason]);
  const inline=await queue.add('model-capture',{}, {queue:'dream-inline-snapshot-uncertain',delay:86400000});
  await engine.executeRaw("UPDATE minion_jobs SET private_queue_owner_job_id=$2,status='paused',attempts_started=1 WHERE id=$1",[inline.id,unsafeInline.id]);
  const stopped=await queue.add('pmbrain-product-task',{kind:'dream_quick',resourceStopReason:reason,task:{type:'dream',input:{preset:'quick',sourceId:'legacy-stopped'}}},{queue:'pmbrain-product',delay:86400000});
  await engine.executeRaw("UPDATE minion_jobs SET status='cancelled',error_text=$2 WHERE id=$1",[stopped.id,reason]);
  const runtime=new ProductTaskRuntime(engine);
  try{
    await runtime.start();
    const deadline=Date.now()+90_000;
    let status='queued';
    while(Date.now()<deadline){const run=await runtime.getRun(`task-${parent.id}`);status=run!.status;if(!['running','queued'].includes(status))break;await Bun.sleep(50);}
    expect(status,JSON.stringify(await runtime.getRun(`task-${parent.id}`))).toBe('completed');
    expect((await queue.getJob(parent.id))?.data.resourceStopReason).toBeUndefined();
    expect((await runtime.getRun(`task-${parent.id}`))?.product?.errorReason).toBeNull();
    expect((await engine.getPage('legacy',{sourceId:'legacy-capacity'}))?.title).toBe('旧容量中断');
    expect((await queue.getJob(unsafe.id))?.status).toBe('paused');
    expect((await queue.getJob(child.id))?.attempts_started).toBe(1);
    expect((await queue.getJob(unsafeInline.id))?.status).toBe('paused');
    expect((await queue.getJob(inline.id))?.attempts_started).toBe(1);
    expect((await queue.getJob(stopped.id))?.status).toBe('cancelled');
  }finally{await runtime.close();}
},120000);

test('分批同步中主动停止后保持停止，重启后继续原任务完成且文件记录不重复',async()=>{
  const dir=join(home,'live-stop');mkdirSync(dir);
  const names=['first.md','second.md','third.md'];
  const bytes=Buffer.from('# 实际停止续跑\n\n停止后按原任务接着处理，原资料不改变。');
  for(const name of names)writeFileSync(join(dir,name),bytes);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('live-stop','真实停止续跑',$1,'{}'::jsonb)",[dir]);
  let runtime=new ProductTaskRuntime(engine,{snapshotQuotaBytes:bytes.length*2});
  const queue=new MinionQueue(engine);
  let runId:string|undefined;
  try{
    await runtime.start();
    const run=await runtime.submitDream({preset:'quick',sourceId:'live-stop'});runId=run.id;
    const id=Number(run.id.slice(5)),deadline=Date.now()+90_000;
    let waiting=false;
    while(Date.now()<deadline){if((await queue.getJob(id))?.status==='waiting-children'){waiting=true;break;}await Bun.sleep(20);}
    expect(waiting,JSON.stringify(await runtime.getRun(run.id))).toBe(true);
    expect((await runtime.cancel(run.id))?.status).toBe('cancelled');
    const old=await engine.executeRaw<{id:number}>("SELECT id FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2",[SYNC_FILE_QUEUE,id]);
    await runtime.close();
    runtime=new ProductTaskRuntime(engine,{snapshotQuotaBytes:bytes.length*2});await runtime.start();
    expect((await runtime.getRun(run.id))?.status).toBe('cancelled');
    expect((await runtime.retry(run.id))?.id).toBe(run.id);
    const finishDeadline=Date.now()+90_000;
    let status='queued';
    while(Date.now()<finishDeadline){status=(await runtime.getRun(run.id))!.status;if(!['running','queued'].includes(status))break;await Bun.sleep(40);}
    expect(status,JSON.stringify(await runtime.getRun(run.id))).toBe('completed');
    const final=await engine.executeRaw<{id:number;path:string}>("SELECT id,data->'task'->'input'->>'path' AS path FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2",[SYNC_FILE_QUEUE,id]);
    expect(final).toHaveLength(3);expect(old.every(row=>final.some(saved=>saved.id===row.id))).toBe(true);
    expect(final.every(row=>!existsSync(row.path))).toBe(true);
    for(const name of names)expect(readFileSync(join(dir,name))).toEqual(bytes);
  }finally{
    if(runId)await runtime.cancel(runId);
    await runtime.close();
  }
},240000);

test('正常 2GB 工作集可以继续，软压力回收闲置线程并降并发，恢复后继续领取任务',async()=>{
  let memory=0;
  const runtime=new ProductTaskRuntime(engine,{memoryBytes:()=>memory,totalMemoryBytes:()=>32*1024**3,availableMemoryBytes:()=>14*1024**3,rssCheckIntervalMs:10});
  await runtime.start();
  try{
    memory=3*1024*1024*1024;
    await Bun.sleep(50);
    expect((runtime as any).failure).toBeNull();expect((runtime as any).paused).toBe(false);
    expect((runtime as any).worker.opts.concurrency).toBe(2);
    memory=9*1024**3;await Bun.sleep(50);
    expect((runtime as any).worker.opts.concurrency).toBe(1);
    expect((runtime as any).fileWorker.opts.concurrency).toBe(1);
    const run=await runtime.submitDream({preset:'quick',dryRun:true});
    const deadline=Date.now()+15000;let status='queued';
    while(Date.now()<deadline){status=(await runtime.getRun(run.id))!.status;if(!['running','queued'].includes(status))break;await Bun.sleep(30);}
    expect(status).toBe('completed');expect((runtime as any).idleMaintenanceThreads).toHaveLength(0);
    memory=0;await Bun.sleep(50);
    expect((runtime as any).worker.opts.concurrency).toBe(2);
    await runtime.adjustResourcePressure(true);expect((runtime as any).worker.opts.concurrency).toBe(1);
    await runtime.adjustResourcePressure(false);expect((runtime as any).worker.opts.concurrency).toBe(2);
  }finally{await runtime.close();}
},60000);

test('明细日志合并重复活动并压缩，流式重载保留最新状态和旧日志截断行',async()=>{
  const projection=new FileProjection({maxBytes:2048});
  projection.seed(900001,[{id:1,sourceId:'default',path:'source.md',status:'running',error:null}]);
  for(let index=0;index<100;index++){
    projection.activity(900001,1,{id:1,sourceId:'default',path:'source.md',bytes:100,stage:'写入第 '+index+' 批',updatedAt:new Date().toISOString()});
    await projection.flush();
  }
  const path=taskArtifactPath(900001,'files.jsonl');
  expect(readFileSync(path).length).toBeLessThanOrEqual(2048);
  const legacy=readFileSync(path,'utf8')+'{"unfinished":';writeFileSync(path,legacy);
  const reloaded=new FileProjection({maxBytes:2048});await reloaded.load(900001);
  expect(reloaded.details(900001)?.rows[0].activity?.stage).toBe('写入第 99 批');
  for(let id=900002;id<900022;id++){
    reloaded.seed(id,[{id:1,sourceId:'default',path:'old-running.md',status:'running',error:null}]);await reloaded.flush();
  }
  expect((reloaded as any).sessions.size).toBeLessThanOrEqual(16);
  await reloaded.load(900001);
  expect(reloaded.details(900001)?.rows[0].activity?.stage).toBe('写入第 99 批');
  let free=0;
  const low=new FileProjection({resources:new TaskResourceGuard({diskReserveBytes:10,freeDiskBytes:async()=>free})});
  low.seed(900023,[{id:1,sourceId:'default',path:'recover.md',status:'failed',error:'原错误保留'}]);
  await expect(low.flush()).rejects.toThrow('磁盘空间不足');
  free=100*1024**2;await low.recover();await low.flush();
  const restored=new FileProjection();await restored.load(900023);
  expect(restored.details(900023)?.rows[0].error).toBe('原错误保留');
});
