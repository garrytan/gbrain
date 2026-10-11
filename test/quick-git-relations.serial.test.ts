import { beforeAll, afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { ProductTaskRuntime } from '../src/product/tasks/runtime.ts';
import { readTaskRelations } from '../src/product/tasks/relations.ts';
import { configPath } from '../src/core/config.ts';
import { initializeSourceGit, commitSourceGit } from '../src/core/source-git.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const keys=['GBRAIN_HOME','PMBRAIN_HOME','DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_DATABASE_URL'];
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const database=process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const sourceId=`quick-git-${randomUUID().slice(0,8)}`;
let root:string,repo:string,db:BrainEngine,runtime:ProductTaskRuntime;
const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
async function finish(id:string){
  const deadline=Date.now()+240000;
  while(Date.now()<deadline){const run=await runtime.getRun(id);if(run&&!['running','queued'].includes(run.status))return run;await Bun.sleep(100);}
  throw new Error(JSON.stringify(await runtime.getRun(id)));
}
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-quick-git-test-'));repo=join(root,'source');mkdirSync(repo);
  keys.forEach(key=>delete process.env[key]);process.env.GBRAIN_HOME=root;process.env.PMBRAIN_HOME=root;
  mkdirSync(join(root,'.pmbrain'));
  writeFileSync(configPath(),JSON.stringify({engine:database?'postgres':'pglite',model_usage:{embedding_enabled:false,generative_enabled:false}}));
  if(database)assertSafeE2eDatabaseUrl(database);
  db=database?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;
  await db.connect(database?{database_url:database}:{database_path:join(root,'brain.pglite')});await db.initSchema();
  initializeSourceGit(repo);writeFileSync(join(repo,'other.txt'),'old');commitSourceGit(repo,'initial');
  await db.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{\"syncEnabled\":true}')",[sourceId,repo]);
  runtime=new ProductTaskRuntime(db);await runtime.start();
},60000);
afterAll(async()=>{
  await runtime?.close();await db?.disconnect();
  keys.forEach(key=>{if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];});
  if(root)rmSync(root,{recursive:true,force:true});
},60000);

test('uncommitted changes sync, commit locally, show real relations, repeat without new edges, and survive runtime reload',async()=>{
  writeFileSync(join(repo,'a.md'),'---\ntitle: 示例项目\ntype: project\n---\n# 示例项目\n\n项目由[示例组织](b)支持。');
  writeFileSync(join(repo,'b.md'),'---\ntitle: 示例组织\ntype: organization\n---\n# 示例组织\n\n支持示例项目项目。');
  writeFileSync(join(repo,'other.txt'),'user staged');git('add','other.txt');
  const submitted=await runtime.submitDream({preset:'quick',sourceId});
  const run=await finish(submitted.id);
  expect(run.status).toBe('completed');
  expect(run.stdout).not.toContain('cycle_already_running');
  expect(await db.getPage('a',{sourceId})).not.toBeNull();
  expect(git('show','HEAD:a.md')).toContain('示例项目');
  expect(git('diff','--cached','--name-only')).toBe('other.txt');
  expect(run.product?.gitResults?.some(row=>row.committed)).toBe(true);
  const details=await readTaskRelations(db,Number(run.id.slice(5)));
  expect(details.total).toBeGreaterThan(0);
  expect(details.rows.every(row=>row.fromSourceId===sourceId&&row.toSourceId===sourceId)).toBe(true);
  expect(run.product?.relations?.total).toBe(details.total);
  const head=git('rev-parse','HEAD');
  const repeated=await finish((await runtime.submitDream({preset:'quick',sourceId})).id);
  expect(repeated.status).toBe('completed');expect(git('rev-parse','HEAD')).toBe(head);
  expect(repeated.product?.relations?.total).toBe(0);
  writeFileSync(join(repo,'a.md'),'---\ntitle: 示例项目\ntype: project\n---\n# 示例项目\n\n项目更新后由[示例组织](b)支持。');
  const changed=await finish((await runtime.submitDream({preset:'quick',sourceId})).id);
  expect(changed.status).toBe('completed');
  expect(git('show','HEAD:a.md')).toContain('项目更新后');
  expect((await db.getPage('a',{sourceId}))?.compiled_truth).toContain('项目更新后');
  await runtime.close();runtime=new ProductTaskRuntime(db);await runtime.start();
  expect((await runtime.getRun(run.id))?.product?.relations?.total).toBe(details.total);
  rmSync(join(repo,'a.md'));
  const removed=await finish((await runtime.submitDream({preset:'quick',sourceId})).id);
  expect(removed.status).toBe('completed');
  expect(git('ls-tree','--name-only','HEAD')).not.toContain('a.md');
  expect(await db.getPage('a',{sourceId})).toBeNull();
  expect((await readTaskRelations(db,Number(run.id.slice(5)))).rows.every(row=>!row.present)).toBe(true);
},300000);

test('disabling auto commit still syncs; a failed file never prevents committing successful files',async()=>{
  const before=git('rev-parse','HEAD');
  await db.setConfig('sync.auto_git_commit','false');
  writeFileSync(join(repo,'disabled.md'),'# 示例资料\n\n关闭自动提交后仍同步本地修改。');
  expect((await finish((await runtime.submitDream({preset:'quick',sourceId})).id)).status).toBe('completed');
  expect(await db.getPage('disabled',{sourceId})).not.toBeNull();
  expect(git('rev-parse','HEAD')).toBe(before);
  await db.setConfig('sync.auto_git_commit','true');
  writeFileSync(join(repo,'bad.md'),'# Bad\n\n'+'x'.repeat(5_000_001));
  const partial=await finish((await runtime.submitDream({preset:'quick',sourceId})).id);
  expect((partial.result as Record<string, unknown>)?.status).toBe('partial');
  expect(git('show','HEAD:disabled.md')).toContain('仍同步');
  expect(git('ls-tree','--name-only','HEAD')).not.toContain('bad.md');
  expect(git('diff','--cached','--name-only')).toBe('other.txt');
  writeFileSync(join(repo,'bad.md'),'# 修复后资料\n\n失败后继续同步。');
  expect((await finish((await runtime.submitDream({preset:'quick',sourceId})).id)).status).toBe('completed');
  expect(git('show','HEAD:bad.md')).toContain('失败后继续');
},300000);

test('interruption and restart reuse successful receipts before committing the completed round',async()=>{
  for(let i=0;i<12;i++)writeFileSync(join(repo,`resume-${i}.md`),`# 续跑资料 ${i}\n\n隔离资料用于验证中断后的本地提交。`);
  const accepted=await runtime.submitDream({preset:'quick',sourceId});
  const deadline=Date.now()+120000;
  let observed=false;
  while(Date.now()<deadline){
    const counts=(await runtime.getRun(accepted.id))?.product?.syncFiles;
    if(counts&&counts.completed>0&&counts.remaining>0){observed=true;break;}
    await Bun.sleep(50);
  }
  expect(observed).toBe(true);
  await runtime.cancel(accepted.id); await finish(accepted.id);
  const completedBefore=(await runtime.files(accepted.id))!.rows.filter(row=>row.status==='completed').length;
  expect(completedBefore).toBeGreaterThan(0);
  const pagesBefore=await db.executeRaw<{id:number;knowledge_revision:number}>("SELECT id,knowledge_revision FROM pages WHERE source_id=$1 AND slug LIKE 'resume-%'",[sourceId]);
  await runtime.close();runtime=new ProductTaskRuntime(db);await runtime.start();
  expect((await runtime.getRun(accepted.id))?.status).toBe('cancelled');
  await runtime.retry(accepted.id);
  expect((await finish(accepted.id)).status).toBe('completed');
  for(let i=0;i<12;i++)expect(git('show',`HEAD:resume-${i}.md`)).toContain('隔离资料');
  for(const page of pagesBefore){
    const rows=await db.executeRaw<{knowledge_revision:number}>("SELECT knowledge_revision FROM pages WHERE id=$1",[page.id]);
    expect(rows[0].knowledge_revision).toBe(page.knowledge_revision);
  }
  expect(git('diff','--cached','--name-only')).toBe('other.txt');
},300000);

