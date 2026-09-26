import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isPhysicalRootMetadata } from '../src/core/persistence/physical-root.ts';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { registerLocalWriter, revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree, getWorktreeBinding, worktreeManifest } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runManagedSourceClone } from '../src/core/persistence/topology-clone.ts';
import { addSource, removeSource } from '../src/core/sources-ops.ts';
import { softDeleteSource, restoreSource } from '../src/core/destructive-guard.ts';
import { topologyDirectoryBytes } from '../src/core/persistence/topology-filesystem.ts';
import { topologyPrincipal } from '../src/core/persistence/topology-locks.ts';

import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
const databaseUrl=process.env.DATABASE_URL;
for(const flavor of ['pglite',...(databaseUrl?['postgres']:[])] as const)describe(`managed source lifecycle (${flavor})`,()=>{
let engine:BrainEngine;
let closePostgres:(()=>Promise<void>)|undefined;
beforeAll(async()=>{
  if(flavor==='postgres'){
    const fixture=await isolatedPersistencePostgres(databaseUrl!);engine=fixture.engine;closePostgres=fixture.close;
  }else{
    engine=new PGLiteEngine();await engine.connect({});await engine.initSchema();
  }
},120_000);
afterAll(async()=>{if(!engine)return;await disposePersistenceConsumer(engine);if(closePostgres)await closePostgres();else await engine.disconnect();});
async function fixture(run:(home:string,source:string,root:string)=>Promise<void>){
  const home=mkdtempSync(join(tmpdir(),'gbrain-topology-'));
  try{await withEnv({GBRAIN_HOME:home,DATABASE_URL:undefined,GBRAIN_DATABASE_URL:undefined},async()=>{
    await resetPgliteState(engine as PGLiteEngine);await registerLocalWriter(engine,'cli');
    const source='lifecycle-source',root=join(home,'canonical');mkdirSync(root);
    writeFileSync(join(root,'example.md'),'---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)',[source,root]);
    await claimWorktree(engine,source,root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await run(home,source,root);
  });}finally{rmSync(home,{recursive:true,force:true});}
}
async function queued(source:string,requestId=randomUUID()){
  const binding=(await getWorktreeBinding(engine,source))!;
  const authority=await submissionAuthority({engine,config:{engine:'pglite'},remote:false,sourceId:source,dryRun:false,logger:{info(){},warn(){},error(){}}},'put_page',source,binding.source_incarnation,'queued');
  return admitWrite(engine,{principal:authority.principal,operation:'put_page',sourceId:source,sourceIncarnation:binding.source_incarnation,
    slug:'queued',requestId,callerIntent:{content:'queued'},intent:{content:'queued'},authority,
    worktreeId:binding.worktree_id,topologyGeneration:binding.topology_generation});
}

test('archive/restore advance topology and permanently invalidate accepted old bindings',()=>fixture(async(_home,source)=>{
  const old=(await getWorktreeBinding(engine,source))!;const accepted=await queued(source);
  const requestId=randomUUID();
  const result=await runManagedSourceLifecycle(engine,{operation:'archive',sourceId:source,requestId});
  expect(result).toMatchObject({state:'committed',invalidated_requests:1});
  expect((await engine.executeRaw<{state:string;error_code:string}>('SELECT state,error_code FROM persistence_requests WHERE id=$1::uuid',[accepted.id]))[0]).toEqual({state:'conflict',error_code:'source_changed'});
  const next=(await getWorktreeBinding(engine,source))!;expect(Number(next.topology_generation)).toBe(Number(old.topology_generation)+1);
  expect(await runManagedSourceLifecycle(engine,{operation:'archive',sourceId:source,requestId})).toEqual(result);
  await expect(runManagedSourceLifecycle(engine,{operation:'restore',sourceId:source,requestId})).rejects.toMatchObject({code:'idempotency_conflict'});
  await runManagedSourceLifecycle(engine,{operation:'restore',sourceId:source});
  expect((await engine.executeRaw<{archived:boolean}>('SELECT archived FROM sources WHERE id=$1',[source]))[0].archived).toBe(false);
}),60_000);

test('remove/recreate retains old request IDs and creates a new source incarnation',()=>fixture(async(_home,source,root)=>{
  const original=(await getWorktreeBinding(engine,source))!;const accepted=await queued(source);const requestId=randomUUID();
  const result=await runManagedSourceLifecycle(engine,{operation:'remove',sourceId:source,confirmDestructive:true,requestId});
  await runManagedSourceLifecycle(engine,{operation:'add',sourceId:source,path:root});
  const replacement=(await getWorktreeBinding(engine,source))!;
  expect(replacement.source_incarnation).not.toBe(original.source_incarnation);
  expect(await runManagedSourceLifecycle(engine,{operation:'remove',sourceId:source,confirmDestructive:true,requestId})).toEqual(result);
  expect((await engine.executeRaw('SELECT id FROM sources WHERE id=$1',[source]))).toHaveLength(1);
  expect((await engine.executeRaw<{state:string}>('SELECT state FROM persistence_requests WHERE id=$1::uuid',[accepted.id]))[0].state).toBe('conflict');
  expect((await engine.executeRaw<{outstanding_count:string}>("SELECT outstanding_count::text FROM persistence_counters WHERE key='brain'"))[0].outstanding_count).toBe('0');
}),60_000);

test('running publication refuses lifecycle before metadata or generation changes',()=>fixture(async(_home,source)=>{
  const binding=(await getWorktreeBinding(engine,source))!;await queued(source);
  const row=await claimNextWrite(engine,binding.owner_host_id!);expect(row).not.toBeNull();
  await expect(runManagedSourceLifecycle(engine,{operation:'archive',sourceId:source})).rejects.toMatchObject({code:'write_pending'});
  expect((await getWorktreeBinding(engine,source))!.topology_generation).toBe(binding.topology_generation);
  expect((await engine.executeRaw<{archived:boolean}>('SELECT archived FROM sources WHERE id=$1',[source]))[0].archived).toBe(false);
}),60_000);

test('rebind requires exact manifest including deletion and old path remains fenced',()=>fixture(async(home,source,root)=>{
  const candidate=join(home,'candidate');cpSync(root,candidate,{recursive:true,filter:path=>!isPhysicalRootMetadata(basename(path))});
  writeFileSync(join(candidate,'extra.md'),'Unexpected');
  await expect(runManagedSourceLifecycle(engine,{operation:'rebind',sourceId:source,path:candidate})).rejects.toMatchObject({code:'writer_manifest_mismatch'});
  rmSync(join(candidate,'extra.md'));
  await runManagedSourceLifecycle(engine,{operation:'rebind',sourceId:source,path:candidate});
  expect((await getWorktreeBinding(engine,source))!.local_path).toBe(candidate);
  const {assertManagedFilesystemWrite}=await import('../src/core/persistence/filesystem-guard.ts');
  expect(()=>assertManagedFilesystemWrite(join(root,'example.md'))).toThrow('managed canonical worktree');
}),60_000);

test('clone publication rolls forward after the directory rename and retains exact reservations until cleanup',()=>fixture(async(home,source,root)=>{
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify({managed_clone:true,remote_url:'https://example.invalid/brain.git'})]);
  const principal=await topologyPrincipal(engine),requestId=randomUUID();
  const input={operation:'reclone' as const,sourceId:source,requestId};
  let providerCalls=0,renamed=0;
  const result=await runManagedSourceClone(engine,input,principal,requestId,{...input,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage)=>{providerCalls++;cpSync(root,stage,{recursive:true,filter:path=>!isPhysicalRootMetadata(basename(path))});},
    boundary:async(name)=>{if(name==='new_moved'&&renamed++===0)throw new Error('injected lost transaction');},
  });
  expect(result).toMatchObject({state:'committed',cloned:true});expect(providerCalls).toBe(1);
  expect(await runManagedSourceLifecycle(engine,input)).toEqual(result);
  expect(readFileSync(join(root,'example.md'),'utf8')).toContain('Canonical');
  expect(readdirSync(home).some(name=>name.includes('gbrain-old')||name.startsWith('.gbrain-clone'))).toBe(false);
  expect((await engine.executeRaw<{recovery_bytes:string}>("SELECT recovery_bytes::text FROM persistence_counters WHERE key='brain'"))[0].recovery_bytes).toBe('0');
}),60_000);

test('stale cloned bytes fail before touching the active worktree and preserve a permanent failure receipt',()=>fixture(async(_home,source,root)=>{
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify({managed_clone:true,remote_url:'https://example.invalid/brain.git'})]);
  const input={operation:'reclone' as const,sourceId:source,requestId:randomUUID()};
  const result=await runManagedSourceClone(engine,input,await topologyPrincipal(engine),input.requestId,{...input,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage)=>{cpSync(root,stage,{recursive:true,filter:path=>!isPhysicalRootMetadata(basename(path))});writeFileSync(join(stage,'stale.md'),'Remote-only stale bytes');},
  });
  expect(result).toMatchObject({state:'failed',write_error:'writer_manifest_mismatch'});
  expect(readFileSync(join(root,'example.md'),'utf8')).toContain('Canonical');
  expect((await getWorktreeBinding(engine,source))!.state).toBe('active');
  expect(await runManagedSourceLifecycle(engine,input)).toEqual(result);
}),60_000);

test('revocation while cloning prevents publication and releases the root without replacing credentials',()=>fixture(async(_home,source,root)=>{
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify({managed_clone:true,remote_url:'https://example.invalid/brain.git'})]);
  const principal=await topologyPrincipal(engine),input={operation:'reclone' as const,sourceId:source,requestId:randomUUID()};
  const result=await runManagedSourceClone(engine,input,principal,input.requestId,{...input,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage)=>{cpSync(root,stage,{recursive:true,filter:path=>!isPhysicalRootMetadata(basename(path))});await revokeLocalWriter(engine,principal);},
  });
  expect(result).toMatchObject({state:'failed',write_error:'permission_denied'});
  expect((await getWorktreeBinding(engine,source))!.state).toBe('active');
  await expect(topologyPrincipal(engine)).rejects.toMatchObject({code:'permission_denied'});
}),60_000);


test('a shared Git root advances every membership and terminates all old-topology queues',()=>fixture(async(home)=>{
  const shared=join(home,'shared');mkdirSync(shared);execFileSync('git',['init','--quiet',shared]);
  const first=join(shared,'first'),second=join(shared,'second');mkdirSync(first);mkdirSync(second);
  writeFileSync(join(first,'example.md'),'First');writeFileSync(join(second,'example.md'),'Second');
  await runManagedSourceLifecycle(engine,{operation:'add',sourceId:'shared-first',path:first});
  await runManagedSourceLifecycle(engine,{operation:'add',sourceId:'shared-second',path:second});
  const one=(await getWorktreeBinding(engine,'shared-first'))!,two=(await getWorktreeBinding(engine,'shared-second'))!;
  expect(one.worktree_id).toBe(two.worktree_id);
  const a=await queued('shared-first'),b=await queued('shared-second');
  const result=await runManagedSourceLifecycle(engine,{operation:'archive',sourceId:'shared-first'});
  expect(result.invalidated_requests).toBe(2);
  const updated=(await getWorktreeBinding(engine,'shared-second'))!;
  expect(Number(updated.topology_generation)).toBe(Number(two.topology_generation)+1);
  expect((await engine.executeRaw<{state:string}>('SELECT state FROM persistence_requests WHERE id=ANY($1::uuid[])',[ [a.id,b.id] ])).map(row=>row.state)).toEqual(['conflict','conflict']);
}),60_000);

test('page and lifecycle requests share one permanent UUID domain in both directions',()=>fixture(async(_home,source)=>{
  const pageId=randomUUID();await queued(source,pageId);
  await expect(runManagedSourceLifecycle(engine,{operation:'archive',sourceId:source,requestId:pageId})).rejects.toMatchObject({code:'idempotency_conflict'});
  const lifecycleId=randomUUID();await runManagedSourceLifecycle(engine,{operation:'restore',sourceId:source,requestId:lifecycleId});
  await expect(queued(source,lifecycleId)).rejects.toMatchObject({code:'idempotency_conflict'});
  expect((await engine.executeRaw('SELECT id FROM persistence_requests'))).toHaveLength(1);
}),60_000);

test('dry-run and no-op lifecycle leave accepted work and topology unchanged',()=>fixture(async(_home,source)=>{
  const before=(await getWorktreeBinding(engine,source))!,request=await queued(source);
  const dry=await runManagedSourceLifecycle(engine,{operation:'archive',sourceId:source,dryRun:true});
  expect(dry.dry_run).toBe(true);
  expect(await engine.executeRaw('SELECT id FROM persistence_topology_changes')).toHaveLength(0);
  const noop=await runManagedSourceLifecycle(engine,{operation:'restore',sourceId:source});expect(noop.noop).toBe(true);
  expect((await getWorktreeBinding(engine,source))!.topology_generation).toBe(before.topology_generation);
  expect((await engine.executeRaw<{state:string}>('SELECT state FROM persistence_requests WHERE id=$1::uuid',[request.id]))[0].state).toBe('queued');
}),60_000);

test('oversized staging fails before active checkout mutation and releases its exact reservation',()=>fixture(async(_home,source,root)=>{
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify({managed_clone:true,remote_url:'https://example.invalid/brain.git'})]);
  await engine.setConfig('persistence.limits.worktree_recovery_bytes','262144');
  const input={operation:'reclone' as const,sourceId:source,requestId:randomUUID()};
  const result=await runManagedSourceClone(engine,input,await topologyPrincipal(engine),input.requestId,{...input,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage,budget)=>{mkdirSync(stage,{recursive:true});writeFileSync(join(stage,'large.md'),Buffer.alloc(budget+1));},
  });
  expect(result).toMatchObject({state:'failed',write_error:'request_too_large'});
  expect(readFileSync(join(root,'example.md'),'utf8')).toContain('Canonical');
  expect((await engine.executeRaw<{recovery_bytes:string}>("SELECT recovery_bytes::text FROM persistence_counters WHERE key='brain'"))[0].recovery_bytes).toBe('0');
}),60_000);

test('expiry sweep rechecks restored sources under the topology guard',()=>fixture(async(_home,source)=>{
  const result=await runManagedSourceLifecycle(engine,{operation:'purge',sourceId:source,confirmDestructive:true,expiredOnly:true});
  expect(result).toMatchObject({state:'committed',noop:true});
  expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1',[source])).toHaveLength(1);
}),60_000);


test('a failed new clone retries under the retained physical identity and a new explicit request',()=>fixture(async(home)=>{
  const target=join(home,'new-clone');
  const first={operation:'add' as const,sourceId:'new-clone-source',path:target,remoteUrl:'https://example.invalid/brain.git',requestId:randomUUID()};
  const principal=await topologyPrincipal(engine);
  const failed=await runManagedSourceClone(engine,first,principal,first.requestId,{...first,requestId:undefined,dryRun:undefined},{clone:async()=>{throw new Error('provider unavailable');}});
  expect(failed.state).toBe('failed');
  const [old]=await engine.executeRaw<{worktree_ids:string[]}>('SELECT worktree_ids FROM persistence_topology_changes WHERE request_id=$1::uuid',[first.requestId]);
  const second={...first,requestId:randomUUID()};
  const result=await runManagedSourceClone(engine,second,principal,second.requestId,{...second,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage)=>{mkdirSync(stage,{recursive:true});writeFileSync(join(stage,'example.md'),'Canonical new clone');},
  });
  expect(result).toMatchObject({state:'committed',cloned:true});
  expect((await getWorktreeBinding(engine,first.sourceId))!.worktree_id).toBe(old.worktree_ids[0]);
  expect(await runManagedSourceLifecycle(engine,first)).toEqual(failed);
}),60_000);

test('a missing owned checkout needs a current verified manifest before clone recovery',()=>fixture(async(_home,source,root)=>{
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify({managed_clone:true,remote_url:'https://example.invalid/brain.git'})]);
  const body=readFileSync(join(root,'example.md'),'utf8');
  await runManagedSourceLifecycle(engine,{operation:'archive',sourceId:source});
  rmSync(root,{recursive:true});
  const input={operation:'reclone' as const,sourceId:source,requestId:randomUUID()};
  const result=await runManagedSourceClone(engine,input,await topologyPrincipal(engine),input.requestId,{...input,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage)=>{mkdirSync(stage,{recursive:true});writeFileSync(join(stage,'example.md'),body);},
  });
  expect(result.state).toBe('committed');expect(readFileSync(join(root,'example.md'),'utf8')).toBe(body);
  await runManagedSourceLifecycle(engine,{operation:'restore',sourceId:source});
}),60_000);


test('changed prepared staging is retained with its recovery reservation',()=>fixture(async(_home,source,root)=>{
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify({managed_clone:true,remote_url:'https://example.invalid/brain.git'})]);
  const input={operation:'reclone' as const,sourceId:source,requestId:randomUUID()};let stagePath='';
  await expect(runManagedSourceClone(engine,input,await topologyPrincipal(engine),input.requestId,{...input,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage)=>{stagePath=stage;cpSync(root,stage,{recursive:true,filter:path=>!isPhysicalRootMetadata(basename(path))});},
    boundary:async(boundary)=>{if(boundary==='prepared'){writeFileSync(join(stagePath,'example.md'),'Unexpected staging bytes');throw new Error('interrupted preparation');}},
  })).rejects.toMatchObject({code:'recovery_required'});
  expect(readFileSync(join(stagePath,'example.md'),'utf8')).toBe('Unexpected staging bytes');
  expect(readFileSync(join(root,'example.md'),'utf8')).toContain('Canonical');
  const [row]=await engine.executeRaw<{state:string;recovery_bytes:string}>('SELECT state,recovery_bytes::text FROM persistence_topology_changes WHERE request_id=$1::uuid',[input.requestId]);
  expect(row.state).toBe('recovering');expect(Number(row.recovery_bytes)).toBeGreaterThan(0);
}),60_000);

test('a substituted partial staging directory is retained instead of being cleaned up',()=>fixture(async(_home,source,root)=>{
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify({managed_clone:true,remote_url:'https://example.invalid/brain.git'})]);
  const input={operation:'reclone' as const,sourceId:source,requestId:randomUUID()};let stagePath='';
  await expect(runManagedSourceClone(engine,input,await topologyPrincipal(engine),input.requestId,{...input,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage)=>{stagePath=stage;renameSync(stage,stage+'-retained');mkdirSync(stage);writeFileSync(join(stage,'foreign.md'),'Retain me');throw new Error('provider interrupted');},
  })).rejects.toMatchObject({code:'recovery_required'});
  expect(readFileSync(join(stagePath,'foreign.md'),'utf8')).toBe('Retain me');
  expect(readFileSync(join(root,'example.md'),'utf8')).toContain('Canonical');
  expect((await getWorktreeBinding(engine,source))!.state).toBe('recovering');
}),60_000);


test('trusted source constructors and archive/remove facades use managed topology and replay IDs',()=>fixture(async(home)=>{
  const id='core-source',path=join(home,id);mkdirSync(path);writeFileSync(join(path,'note.md'),'Core source');
  const created=await addSource(engine,{id,localPath:path,force:true,requestId:randomUUID()});
  expect(created.local_path).toBe(path);expect(await getWorktreeBinding(engine,id)).not.toBeNull();
  expect(await softDeleteSource(engine,id)).not.toBeNull();expect(await restoreSource(engine,id)).toBe(true);
  const opts={id,confirmDestructive:true,requestId:randomUUID()};const removed=await removeSource(engine,opts);
  expect(removed).toMatchObject({id,clone_removed:false,clone_path:path});
  expect(await removeSource(engine,opts)).toEqual(removed);
  const databaseOnly=await addSource(engine,{id:'db-only-source',requestId:randomUUID()});
  expect(databaseOnly.local_path).toBeNull();expect(await getWorktreeBinding(engine,'db-only-source')).toBeNull();
}),60_000);

test('new clone metadata is counted alongside staging before canonical installation',()=>fixture(async(home)=>{
  await engine.setConfig('persistence.limits.worktree_recovery_bytes',String(4*1024*1024));
  const input={operation:'add' as const,sourceId:'metadata-clone',path:join(home,'metadata-clone'),remoteUrl:'https://example.invalid/brain.git',requestId:randomUUID()};
  let cloneBudget=0,stagedBytes=0,manifestBytes=0;
  const result=await runManagedSourceClone(engine,input,await topologyPrincipal(engine),input.requestId,{...input,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage,budget)=>{
      // Directory stat.size varies by filesystem. Fill the measured remaining
      // space so raw staging fits and only its new manifest exceeds capacity.
      for(let i=0;i<128;i++)writeFileSync(join(stage,`${String(i).padStart(4,'0')}-${'x'.repeat(175)}.md`),'');
      const payload=join(stage,'payload.md');writeFileSync(payload,'');
      const remaining=budget-await topologyDirectoryBytes(stage)-8192;
      writeFileSync(payload,'x'.repeat(Math.max(0,remaining)));
      cloneBudget=budget;stagedBytes=await topologyDirectoryBytes(stage);
      manifestBytes=Buffer.byteLength(JSON.stringify(worktreeManifest(stage)));
    },
  });
  expect(stagedBytes).toBe(cloneBudget-8192);
  expect(manifestBytes).toBeGreaterThan(8192);expect(manifestBytes).toBeLessThan(1_048_576);
  expect(result).toMatchObject({state:'failed',write_error:'request_too_large'});
  expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1',[input.sourceId])).toHaveLength(0);
  expect((await engine.executeRaw<{recovery_bytes:string}>("SELECT recovery_bytes::text FROM persistence_counters WHERE key='brain'"))[0].recovery_bytes).toBe('0');
}),60_000);

test('pending withdrawal mirrors block topology without cancelling accepted work',()=>fixture(async(_home,source)=>{
  const request=await queued(source),binding=(await getWorktreeBinding(engine,source))!;
  await engine.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
    VALUES($1::uuid,'withdrawal-mirror','{}'::jsonb,$2,$3::uuid,$4::uuid)`,[request.id,source,binding.source_incarnation,binding.worktree_id]);
  await expect(runManagedSourceLifecycle(engine,{operation:'archive',sourceId:source})).rejects.toMatchObject({code:'recovery_required'});
  expect((await engine.executeRaw<{state:string}>('SELECT state FROM persistence_requests WHERE id=$1::uuid',[request.id]))[0].state).toBe('queued');
  expect((await getWorktreeBinding(engine,source))!.topology_generation).toBe(binding.topology_generation);
}),60_000);


test('archive and restore preserve historical source configuration fields',()=>fixture(async(_home,source)=>{
  const original={federated:true,remote_url:'https://example.invalid/brain.git',custom_key:'retained'};
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify(JSON.stringify(original))]);
  await runManagedSourceLifecycle(engine,{operation:'archive',sourceId:source});
  await runManagedSourceLifecycle(engine,{operation:'restore',sourceId:source,refederate:false});
  const [row]=await engine.executeRaw<{config:Record<string,unknown>}>('SELECT config FROM sources WHERE id=$1',[source]);
  expect(row.config).toEqual({...original,federated:false});
}),60_000);

test('remote URL changes during clone preparation refuse publication',()=>fixture(async(_home,source,root)=>{
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify({managed_clone:true,remote_url:'https://example.invalid/brain.git'})]);
  const input={operation:'reclone' as const,sourceId:source,requestId:randomUUID()};
  const result=await runManagedSourceClone(engine,input,await topologyPrincipal(engine),input.requestId,{...input,requestId:undefined,dryRun:undefined},{
    clone:async(_url,stage)=>{
      cpSync(root,stage,{recursive:true,filter:path=>!isPhysicalRootMetadata(basename(path))});
      await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',[source,JSON.stringify({managed_clone:true,remote_url:'https://example.invalid/changed.git'})]);
    },
  });
  expect(result).toMatchObject({state:'failed',write_error:'source_changed'});
  expect(readFileSync(join(root,'example.md'),'utf8')).toContain('Canonical');
  const counters=await engine.executeRaw<{key:string;outstanding_count:string;intent_bytes:string;recovery_bytes:string}>('SELECT key,outstanding_count::text,intent_bytes::text,recovery_bytes::text FROM persistence_counters');
  for(const counter of counters){expect(counter.outstanding_count).toBe('0');expect(counter.intent_bytes).toBe('0');expect(counter.recovery_bytes).toBe('0');}
}),60_000);

});
