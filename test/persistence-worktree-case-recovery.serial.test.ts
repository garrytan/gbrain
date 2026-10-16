/** Real owner/native-lock/fence/DB tests. Only local synthetic Git remotes and
 * in-memory PGLite; never a production checkout or provider. */
import {afterAll,beforeAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {chmodSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {withEnv} from './helpers/with-env.ts';
import {parseRefreshArgs} from '../src/commands/sources-refresh.ts';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
import {gitChildEnv} from '../src/core/git-env.ts';
import {digest,type CaseRecoveryPreview} from '../src/core/persistence/worktree-case-recovery.ts';
import {getWorktreeBinding} from '../src/core/persistence/ownership.ts';
import {disposePersistenceConsumer} from '../src/core/persistence/service.ts';
import {refreshWorktree,resumeWorktreeRefreshes} from '../src/core/persistence/worktree-refresh.ts';
import {withRefreshFixture,type RefreshFixture} from './helpers/worktree-refresh-fixture.ts';
const engine=new PGLiteEngine();
beforeAll(async()=>{await engine.connect({});await engine.initSchema();},120000);
afterAll(async()=>{await disposePersistenceConsumer(engine);await engine.disconnect();});
function g(root:string,args:string[],input?:Buffer,index?:string):Buffer {
 return execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-C',root,...args],{
  env:gitChildEnv({GIT_OPTIONAL_LOCKS:'0',...(index?{GIT_INDEX_FILE:index}:{})}),input,timeout:10000,maxBuffer:32*1024**2,stdio:['pipe','pipe','pipe']});
}
const keep='projects/CaseProject/learnings.jsonl',remove='projects/caseproject/learnings.jsonl';
const report='projects/caseproject/designs/history.md',moved='projects/CaseProject/designs/history.md';
const a=Buffer.from('{"id":1}\n{"id":2}\n{"id":3}\n');
const b=Buffer.concat([a,Buffer.from('{"id":4}\n{"id":5}\n')]);
const c=Buffer.from('# Historical report\nAll original bytes.\n');
async function setup(f:RefreshFixture,sameAliases=false):Promise<CaseRecoveryPreview> {
 const blobs=[sameAliases?b:a,b,c].map(data=>g(f.upstream,['hash-object','-w','--stdin'],data).toString().trim());
 for(const [i,path] of [keep,remove,report].entries())g(f.upstream,['update-index','--add','--cacheinfo',`100644,${blobs[i]},${path}`]);
 const executable=Buffer.from('#!/bin/sh\nexit 0\n');
 const executableOid=g(f.upstream,['hash-object','-w','--stdin'],executable).toString().trim();
 g(f.upstream,['update-index','--add','--cacheinfo',`100755,${executableOid},retained-tool.sh`]);
 g(f.upstream,['commit','-qm','old divergent aliases']);g(f.upstream,['push','-q','origin','main']);
 g(f.root,['fetch','-q','origin']);
 // Establish the synthetic original state without relying on clone checkout's
 // alias order. This is fixture setup, not the candidate recovery path.
 const old=g(f.upstream,['rev-parse','HEAD']).toString().trim();
 g(f.root,['read-tree',old]);g(f.root,['update-ref','HEAD',old]);
 writeFileSync(join(f.root,'retained-tool.sh'),executable);chmodSync(join(f.root,'retained-tool.sh'),0o755);
 mkdirSync(join(f.root,keep,'..'),{recursive:true});writeFileSync(join(f.root,keep),b);
 mkdirSync(join(f.root,report,'..'),{recursive:true});writeFileSync(join(f.root,report),c);
 // Native case-insensitive aliases already resolve. On a case-sensitive
 // filesystem, native hardlinks exercise the same inode-bound contract.
 if(!existsSync(join(f.root,remove))) {
  mkdirSync(join(f.root,remove,'..'),{recursive:true});linkSync(join(f.root,keep),join(f.root,remove));
 }
 expect(readFileSync(join(f.root,remove))).toEqual(b);
 const idx=join(f.dir,'target.index');writeFileSync(idx,readFileSync(join(f.upstream,'.git/index')));
 g(f.upstream,['update-index','--force-remove',remove,report],undefined,idx);
 for(const [path,oid] of [[keep,blobs[1]],[moved,blobs[2]]])g(f.upstream,['update-index','--add','--cacheinfo',`100644,${oid},${path}`],undefined,idx);
 const tree=g(f.upstream,['write-tree'],undefined,idx).toString().trim();
 const target=g(f.upstream,['commit-tree',tree,'-p',old,'-m','unify aliases preserving all records and report']).toString().trim();
 g(f.upstream,['update-ref','refs/heads/main',target]);g(f.upstream,['push','-q','origin','main']);g(f.root,['fetch','-q','origin']);
 const binding=(await getWorktreeBinding(f.engine,f.alpha))!;
 return {version:1,worktreeId:f.worktreeId,ownerEpoch:String(binding.owner_epoch),topologyGeneration:String(binding.topology_generation),oldHead:old,targetHead:target,indexSha256:digest(readFileSync(join(f.root,'.git/index'))),keep,remove,materializedSha256:digest(b)};
}
async function errorCode(p:Promise<unknown>,code:string) { const err=await p.then(()=>null,e=>e);expect(err).not.toBeNull();expect(err.code).toBe(code);return err; }
test('default refresh still refuses alias dirt; explicit bound recovery completes through real fence and sync',()=>withRefreshFixture(engine,async f=>{
 const preview=await setup(f),config=readFileSync(join(f.root,'.git/config'));
 await errorCode(refreshWorktree(engine,f.alpha),'refresh_dirty');expect(await f.refreshRows()).toEqual([]);
 const previewFile=join(f.dir,'preview.json');writeFileSync(previewFile,JSON.stringify(preview));
 const parsed=parseRefreshArgs([f.alpha,'--case-recovery-preview',previewFile,'--dry-run','--json']);
 expect((await refreshWorktree(engine,f.alpha,parsed.options)).status).toBe('dry_run');expect(await f.refreshRows()).toEqual([]);
 const result=await refreshWorktree(engine,f.alpha,{...parsed.options,dryRun:false,hooks:{boundary:async(point)=>{
  if(point==='case-index-replaced')await errorCode(f.put(f.beta,'notes/during-case','---\ntitle: No\ntype: note\n---\nheld\n'),'worktree_refreshing');
 }}});
 expect(result.status).toBe('completed');expect(f.head()).toBe(preview.targetHead);
 expect(result.synced.map(x=>x.last_commit)).toEqual([preview.targetHead,preview.targetHead]);
 expect(g(f.root,['status','--porcelain']).toString()).toBe('');
 expect(readFileSync(join(f.root,keep))).toEqual(b);expect(readFileSync(join(f.root,moved))).toEqual(c);
 expect(g(f.root,['show',`${preview.oldHead}:${keep}`])).toEqual(a);
 expect(g(f.root,['show',`${preview.oldHead}:${remove}`])).toEqual(b);
 expect(readFileSync(join(f.root,'.git/config'))).toEqual(config);
 expect((await f.refreshRows())[0].outcome.case_recovery).toBeDefined();
}),120000);
test('crash-window exception after index rename keeps fence; resume restores exact old index before abort',()=>withRefreshFixture(engine,async f=>{
 const p=await setup(f),before=readFileSync(join(f.root,'.git/index'));
 await expect(refreshWorktree(engine,f.alpha,{caseRecovery:p,hooks:{boundary(point){if(point==='case-index-replaced')throw new Error('synthetic crash window');}}})).rejects.toThrow('synthetic crash');
 await disposePersistenceConsumer(engine);
 expect(f.head()).toBe(p.oldHead);expect(readFileSync(join(f.root,'.git/index'))).not.toEqual(before);
 expect((await f.refreshRows())[0].state).toBe('fenced');
 await errorCode(refreshWorktree(engine,f.alpha,{abandon:true}),'refresh_in_progress');
 const resumed=await refreshWorktree(engine,f.alpha,{resume:true});expect(resumed.status).toBe('abandoned');
 expect(readFileSync(join(f.root,'.git/index'))).toEqual(before);expect(readFileSync(join(f.root,keep))).toEqual(b);
 expect((await f.refreshRows())[0].outcome.case_recovery_result).toBe('original_index_restored');
}),120000);
test('merge completed before crash is adopted with exact target; original index is never restored',()=>withRefreshFixture(engine,async f=>{
 const p=await setup(f);
 await expect(refreshWorktree(engine,f.alpha,{caseRecovery:p,hooks:{boundary(point){if(point==='merged')throw new Error('after merge');}}})).rejects.toThrow('after merge');
 await disposePersistenceConsumer(engine);expect(f.head()).toBe(p.targetHead);
 await resumeWorktreeRefreshes(engine);
 const result=await refreshWorktree(engine,f.alpha,{resume:true});expect(result.status).toBe('completed');
 expect(g(f.root,['status','--porcelain']).toString()).toBe('');expect(readFileSync(join(f.root,keep))).toEqual(b);
}),120000);
for(const field of ['indexSha256','materializedSha256','ownerEpoch','targetHead'] as const)test(`stale ${field} preview refuses before row/index changes`,()=>withRefreshFixture(engine,async f=>{
 const p=await setup(f),before=readFileSync(join(f.root,'.git/index'));
 await errorCode(refreshWorktree(engine,f.alpha,{caseRecovery:{...p,[field]:field==='ownerEpoch'?'999':'0'.repeat(field==='targetHead'?40:64)}}),'refresh_recovery_required');
 expect(await f.refreshRows()).toEqual([]);expect(readFileSync(join(f.root,'.git/index'))).toEqual(before);expect(f.head()).toBe(p.oldHead);
}),120000);
test('unknown post-transition index keeps recovery fenced rather than aborting on old HEAD',()=>withRefreshFixture(engine,async f=>{
 const p=await setup(f);
 await expect(refreshWorktree(engine,f.alpha,{caseRecovery:p,hooks:{boundary(point){if(point==='case-index-replaced')throw new Error('stop');}}})).rejects.toThrow('stop');
 await disposePersistenceConsumer(engine);
 const oid=g(f.root,['hash-object','-w','--stdin'],Buffer.from('unknown')).toString().trim();g(f.root,['update-index','--add','--cacheinfo',`100644,${oid},unknown.md`]);
 const unknown=readFileSync(join(f.root,'.git/index'));
 await errorCode(refreshWorktree(engine,f.alpha,{resume:true}),'refresh_recovery_required');
 expect(readFileSync(join(f.root,'.git/index'))).toEqual(unknown);expect((await f.refreshRows())[0].state).toBe('fenced');
}),120000);

test('target HEAD with only a mode change refuses recovery and retains the fence',()=>withRefreshFixture(engine,async f=>{
 const p=await setup(f);
 await expect(refreshWorktree(engine,f.alpha,{caseRecovery:p,hooks:{boundary(point){if(point==='merged')throw new Error('after merge');}}})).rejects.toThrow('after merge');
 await disposePersistenceConsumer(engine);chmodSync(join(f.root,keep),process.platform==='win32'?0o444:0o755);
 await errorCode(refreshWorktree(engine,f.alpha,{resume:true}),'refresh_recovery_required');
 expect((await f.refreshRows())[0].state).toBe('fenced');expect(f.head()).toBe(p.targetHead);
}),120000);
test('a remaining Git index lock is preserved and cannot silently lift recovery fence',()=>withRefreshFixture(engine,async f=>{
 const p=await setup(f);
 await expect(refreshWorktree(engine,f.alpha,{caseRecovery:p,hooks:{boundary(point){if(point==='case-index-replaced')throw new Error('stop');}}})).rejects.toThrow('stop');
 await disposePersistenceConsumer(engine);writeFileSync(join(f.root,'.git/index.lock'),'unknown owner');
 await errorCode(refreshWorktree(engine,f.alpha,{resume:true}),'refresh_recovery_required');
 expect(readFileSync(join(f.root,'.git/index.lock'),'utf8')).toBe('unknown owner');expect((await f.refreshRows())[0].state).toBe('fenced');
}),120000);

for(const stage of ['case-index-locked','case-prepared','case-index-replaced','merged']) test(`real SIGKILL at ${stage} reconciles or retains the fence`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'case-recovery-restart-')),disk=new PGLiteEngine(),database={engine:'pglite' as const,database_path:join(dir,'brain.pglite')};
 await disk.connect(database);await disk.initSchema();
 try{await withRefreshFixture(disk,async f=>{
  const p=await setup(f),before=readFileSync(join(f.root,'.git/index'));
  await disposePersistenceConsumer(disk);await disk.disconnect();
  const child=spawnSync(process.execPath,['--no-env-file',join(import.meta.dir,'helpers/worktree-case-child.ts')],{
    env:{...process.env,GBRAIN_HOME:f.home,GBRAIN_TEST_CASE_CHILD:JSON.stringify({database,source:f.alpha,preview:p,stage})},encoding:'utf8',timeout:60000,
  });
  await disk.connect(database);
  expect(child.stdout,child.stderr).toContain(`CASE_CHILD_KILL ${stage}`);expect(child.signal).toBe('SIGKILL');
  if(stage==='case-index-locked'||stage==='case-prepared'){
    const err=await refreshWorktree(disk,f.alpha,{resume:true}).then(()=>null,e=>e);
    expect(err?.code).toBe('refresh_recovery_required');expect((await f.refreshRows())[0].state).toBe('fenced');
    expect(readFileSync(join(f.root,'.git/index'))).toEqual(before);expect(readFileSync(join(f.root,keep))).toEqual(b);
  }else{
    const result=await refreshWorktree(disk,f.alpha,{resume:true});
    expect(result.status).toBe(stage==='merged'?'completed':'abandoned');
    if(stage==='case-index-replaced')expect(readFileSync(join(f.root,'.git/index'))).toEqual(before);
    else expect(f.head()).toBe(p.targetHead);
    expect(readFileSync(join(f.root,keep))).toEqual(b);
  }
 });}finally{await disposePersistenceConsumer(disk);await disk.disconnect();rmSync(dir,{recursive:true,force:true});}
},120000);

test('case preview CLI rejects malformed, oversized and resume-combined documents before admission',()=>withRefreshFixture(engine,async f=>{
 const p=await setup(f),path=join(f.dir,'preview.json'),before=readFileSync(join(f.root,'.git/index'));
 writeFileSync(path,JSON.stringify({...p,remove:42}));expect(()=>parseRefreshArgs([f.alpha,'--case-recovery-preview',path])).toThrow('invalid preview fields');
 writeFileSync(path,' '.repeat(65537));expect(()=>parseRefreshArgs([f.alpha,'--case-recovery-preview',path])).toThrow('64 KiB');
 writeFileSync(path,JSON.stringify(p));expect(()=>parseRefreshArgs([f.alpha,'--case-recovery-preview',path,'--resume'])).toThrow('cannot be combined');
 expect(await f.refreshRows()).toEqual([]);expect(readFileSync(join(f.root,'.git/index'))).toEqual(before);
}),120000);

test('unrelated tracked dirt refuses case recovery before any admission or merge',()=>withRefreshFixture(engine,async f=>{
 const p=await setup(f),before=readFileSync(join(f.root,'.git/index')),path=join(f.root,'beta/one.md');
 const dirty=Buffer.concat([readFileSync(path),Buffer.from('Unrelated local change.\n')]);writeFileSync(path,dirty);
 await errorCode(refreshWorktree(engine,f.alpha,{caseRecovery:p}),'refresh_dirty');
 expect(await f.refreshRows()).toEqual([]);expect(f.head()).toBe(p.oldHead);expect(readFileSync(path)).toEqual(dirty);expect(readFileSync(join(f.root,'.git/index'))).toEqual(before);
}),120000);


test('clean identical aliases still require and complete an explicit byte-preserving transition',()=>withRefreshFixture(engine,async f=>{
 const p=await setup(f,true),before=readFileSync(join(f.root,'.git/index'));
 expect(g(f.root,['status','--porcelain']).toString()).toBe('');
 expect((await refreshWorktree(engine,f.alpha,{caseRecovery:p,dryRun:true})).status).toBe('dry_run');
 expect(await f.refreshRows()).toEqual([]);expect(readFileSync(join(f.root,'.git/index'))).toEqual(before);
 const result=await refreshWorktree(engine,f.alpha,{caseRecovery:p});
 expect(result.status).toBe('completed');expect(f.head()).toBe(p.targetHead);
 expect(readFileSync(join(f.root,keep))).toEqual(b);expect(readFileSync(join(f.root,moved))).toEqual(c);
 expect(g(f.root,['status','--porcelain']).toString()).toBe('');
 expect(g(f.root,['show',`${p.oldHead}:${keep}`])).toEqual(b);
 expect(g(f.root,['show',`${p.oldHead}:${remove}`])).toEqual(b);
 expect((await f.refreshRows())[0].outcome.case_recovery).toBeDefined();
}),120000);
