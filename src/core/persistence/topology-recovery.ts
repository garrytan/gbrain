import { topologyTransaction } from './topology-transaction.ts';
import { existsSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots, withFilesystemPublication } from './filesystem-guard.ts';
import { localHostId } from './identity.ts';
import { worktreeManifest } from './ownership.ts';
import { advanceTopology, lockTopologyPrincipal, settleTopologyRequests, topologyCanonicalStamp, withTopologyLocks } from './topology-locks.ts';
import { withCoordinatedWrite } from './context.ts';
import { releaseTopologyReservation, type TopologyChange } from './topology-receipts.ts';
import type { TopologyCloneRecovery } from './topology-clone-model.ts';
import type { CloneLifecycleHooks } from './topology-clone.ts';
import { flushTopologyDirectory, topologyDirectoryIdentity } from './topology-filesystem.ts';
import { assertPhysicalRoot } from './physical-root.ts';
import { assertPhysicalRootStamp, readPhysicalRootReservation } from './physical-root-record.ts';

async function readChange(engine:BrainEngine,id:string):Promise<TopologyChange>{
  const [row]=await engine.executeRaw<TopologyChange>('SELECT * FROM persistence_topology_changes WHERE id=$1::uuid',[id]);
  if(!row)throw new OperationError('not_found','Source lifecycle request not found.');
  return row;
}
function matchesCloneStage(target:string,stage:string):boolean{
  const name=basename(stage),prefix=`.gbrain-clone-${basename(target)}-`;
  return name.startsWith(prefix)&&/^[a-f0-9-]{36}$/.test(name.slice(prefix.length));
}
function validateRecord(record:TopologyCloneRecovery):void{
  if(record.version!==1||record.kind!=='clone'||record.ownerHostId!==localHostId()
    ||dirname(record.stage)!==dirname(record.target)||dirname(record.aside)!==dirname(record.target)
    ||!matchesCloneStage(record.target,record.stage)
    ||!record.aside.startsWith(`${record.target}.gbrain-old-`)||!/[a-f0-9-]{36}$/.test(record.aside)
    ||canonicalFilesystemPath(record.target)!==record.target||canonicalFilesystemPath(record.stage)!==record.stage||canonicalFilesystemPath(record.aside)!==record.aside)
    throw new OperationError('recovery_required','The recorded clone paths no longer belong to this owner.');
}
function treeHash(path:string):string|null{
  if(!existsSync(path))return null;
  if(lstatSync(path).isSymbolicLink())throw new OperationError('recovery_required','Recovery refuses a substituted symbolic link.');
  return worktreeManifest(path).digest;
}
function assertRetainedRoot(record:TopologyCloneRecovery,path:string):void{
  const reservation=readPhysicalRootReservation(record.target);
  if(!reservation||reservation.worktreeId!==record.worktreeId)throw new OperationError('recovery_required','The retained checkout identity cannot be verified.');
  assertPhysicalRootStamp(path,reservation);
}
function assertStagingOwned(record:TopologyCloneRecovery):void{
  if(!existsSync(record.stage))return;
  const current=topologyDirectoryIdentity(record.stage),expected=record.stageIdentity;
  if(!expected||current.device!==expected.device||current.inode!==expected.inode||current.birthNs!==expected.birthNs)
    throw new OperationError('recovery_required','Unexpected staging directory identity; recovery retained its bytes.');
  if(record.afterHash!==null){
    if(treeHash(record.stage)!==record.afterHash)throw new OperationError('recovery_required','Unexpected staged clone bytes; recovery retained them.');
    assertRetainedRoot(record,record.stage);
  }
}
function removeOwnedStage(record:TopologyCloneRecovery):void{
  assertStagingOwned(record);
  if(existsSync(record.stage))rmSync(record.stage,{recursive:true,force:true});
}
async function guard(tx:BrainEngine,row:TopologyChange,record:TopologyCloneRecovery):Promise<string[]>{
  await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
  const [owner]=await tx.executeRaw<{owner_host_id:string;owner_epoch:string;state:string}>('SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE',[record.worktreeId]);
  const [host]=await tx.executeRaw<{local_path:string}>('SELECT local_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid',[record.worktreeId,localHostId()]);
  if(!owner||owner.owner_host_id!==record.ownerHostId||String(owner.owner_epoch)!==record.ownerEpoch||owner.state!=='recovering'||host?.local_path!==record.target)
    throw new OperationError('recovery_required','Ownership changed while the clone needed recovery.');
  const members=await tx.executeRaw<{source_id:string}>('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid ORDER BY source_id',[record.worktreeId]);
  const sources=[...new Set([record.sourceId,...members.map(value=>value.source_id)])].sort();
  await tx.executeRaw('SELECT id FROM sources WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[sources]);
  return sources;
}
async function releaseReservation(tx:BrainEngine,row:TopologyChange,record:TopologyCloneRecovery,state:'committed'|'failed'):Promise<void>{
  if(!await releaseTopologyReservation(tx,row))return;
  await tx.executeRaw(`UPDATE persistence_topology_changes SET state=$2,recovery=NULL,recovery_bytes=0,updated_at=now(),
    outcome=COALESCE(outcome,'{}'::jsonb)||$3::text::jsonb WHERE id=$1::uuid`,[row.id,state,JSON.stringify(state==='failed'?{write_error:record.failureCode??'clone_interrupted'}:{})]);
  if(state==='failed'&&record.operation==='add')await tx.executeRaw('DELETE FROM persistence_source_bindings WHERE source_id=$1 AND source_incarnation=$2::uuid',[record.sourceId,record.incarnation]);
  await tx.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid",[record.worktreeId]);
}
async function abortClone(engine:BrainEngine,row:TopologyChange,record:TopologyCloneRecovery,code:string):Promise<TopologyChange>{
  if(record.phase!=='aborting'){
    record={...record,phase:'aborting',failureCode:/^[a-z0-9_]{1,64}$/.test(code)?code:'storage_error'};
    await topologyTransaction(engine,async tx=>{
      await guard(tx,row,record);
      await tx.executeRaw("UPDATE persistence_topology_changes SET recovery=$2::text::jsonb,updated_at=now() WHERE id=$1::uuid AND state='recovering'",[row.id,JSON.stringify(record)]);
    });
  }
  await topologyTransaction(engine,async tx=>{
    await guard(tx,row,record);
    // Restore only this attempt's exact bytes. A newer withdrawal remains in
    // the database; its mirror resumes after the root becomes available.
    assertStagingOwned(record);
    const aside=treeHash(record.aside),target=treeHash(record.target);
    if(target!==null)assertPhysicalRoot(record.target,{worktreeId:record.worktreeId});
    if(aside!==null){
      assertRetainedRoot(record,record.aside);
      if(aside!==record.beforeHash||target!==null&&target!==record.afterHash)throw new OperationError('recovery_required','Unexpected clone recovery bytes; nothing was overwritten.');
      removeOwnedStage(record);
      if(target!==null){renameSync(record.target,record.stage);flushTopologyDirectory(dirname(record.target));}
      renameSync(record.aside,record.target);flushTopologyDirectory(dirname(record.target));
    }else if(record.beforeHash===null){
      if(target!==null&&target!==record.afterHash)throw new OperationError('recovery_required','Unexpected bytes occupy the interrupted clone destination.');
      if(target!==null){removeOwnedStage(record);renameSync(record.target,record.stage);flushTopologyDirectory(dirname(record.target));}
    }else if(target!==record.beforeHash)throw new OperationError('recovery_required','The original checkout cannot be proven intact.');
    removeOwnedStage(record);
    if(record.beforeHash!==null)assertPhysicalRoot(record.target,{worktreeId:record.worktreeId});
    if(existsSync(dirname(record.target)))flushTopologyDirectory(dirname(record.target));
    await releaseReservation(tx,row,record,'failed');
  });
  return readChange(engine,row.id);
}

/** Caller owns the recorded native lock; commit uncertainty always reads this row first. */
export async function finishTopologyClone(engine:BrainEngine,id:string,hooks:CloneLifecycleHooks={},failure?:unknown):Promise<TopologyChange>{
  let row=await readChange(engine,id);if(!row.recovery)return row;
  const record=row.recovery as unknown as TopologyCloneRecovery;validateRecord(record);
  return withFilesystemPublication([record.target,record.stage,record.aside],async()=>{
    if(row.state!=='committed'&&(record.phase==='reserved'||record.phase==='aborting'))
      return abortClone(engine,row,record,(failure as {code?:string}|undefined)?.code??record.failureCode??'clone_interrupted');
    if(row.state!=='committed'){
      try{
        await topologyTransaction(engine,async tx=>{
          const sources=await guard(tx,row,record);
          const [source]=await tx.executeRaw<{incarnation:string;last_commit:string|null;config:unknown}>('SELECT incarnation,last_commit,config FROM sources WHERE id=$1',[record.sourceId]);
          if(record.operation==='add'?!!source:!source||source.incarnation!==record.incarnation||source.last_commit!==record.checkpoint
            ||record.operation==='reclone'&&(parseSourceConfig(source?.config).remote_url??null)!==record.sourceRemoteUrl)
            throw new OperationError('source_changed','The source identity/checkpoint changed while cloning.');
          if(record.operation==='reclone'&&await topologyCanonicalStamp(tx,record.worktreeId)!==record.canonicalStamp)
            throw new OperationError('source_changed','The logical source changed while cloning; retry after its mirrors finish.');
          await settleTopologyRequests(tx,sources,[record.worktreeId],row.principal_id);
          assertStagingOwned(record);
          const stage=treeHash(record.stage),target=treeHash(record.target),aside=treeHash(record.aside);
          if(stage!==null){
            assertRetainedRoot(record,record.stage);
            if(aside!==null)assertRetainedRoot(record,record.aside);
            if(target!==null)assertPhysicalRoot(record.target,{worktreeId:record.worktreeId});
            if(stage!==record.afterHash||aside!==null&&aside!==record.beforeHash)throw new OperationError('recovery_required','Staged clone bytes changed.');
            if(target!==null){
              if(target!==record.beforeHash||aside!==null)throw new OperationError('recovery_required','The active checkout changed during clone preparation.');
              renameSync(record.target,record.aside);flushTopologyDirectory(dirname(record.target));await hooks.boundary?.('old_moved');
            }else if(record.beforeHash!==null&&aside!==record.beforeHash)throw new OperationError('recovery_required','The old checkout is missing from both recorded paths.');
            renameSync(record.stage,record.target);flushTopologyDirectory(dirname(record.target));await hooks.boundary?.('new_moved');
          }else if(target!==record.afterHash)throw new OperationError('recovery_required','Neither a verified stage nor the published clone is present.');
          assertPhysicalRoot(record.target,{worktreeId:record.worktreeId});
          await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
          await withCoordinatedWrite(tx,sources,async()=>{
            if(record.operation==='add')await tx.executeRaw('INSERT INTO sources(id,name,local_path,config,incarnation) VALUES($1,$2,$3,$4::text::jsonb,$5::uuid)',
              [record.sourceId,record.input.name??record.sourceId,record.target,JSON.stringify({...record.input.config,remote_url:record.input.remoteUrl,managed_clone:true}),record.incarnation]);
            else await tx.executeRaw('UPDATE sources SET last_commit=NULL,last_sync_at=NULL WHERE id=$1 AND incarnation=$2::uuid',[record.sourceId,record.incarnation]);
          });
          await advanceTopology(tx,[record.worktreeId]);
          await tx.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid',[record.worktreeId,JSON.stringify({...record.manifest,canonical_stamp:await topologyCanonicalStamp(tx,record.worktreeId)})]);
          await refreshManagedFilesystemRoots(tx,managedFilesystemDatastorePath(engine));
          await tx.executeRaw("UPDATE persistence_topology_changes SET state='committed',outcome=outcome||$2::text::jsonb,updated_at=now() WHERE id=$1::uuid",
            [row.id,JSON.stringify({cloned:true,local_path:record.target})]);
        });
        row=await readChange(engine,id);await hooks.boundary?.('committed');
      }catch(error){
        // No speculation on an unknown database commit. Its durable state
        // decides whether to finish cleanup or preserve the original checkout.
        row=await readChange(engine,id);
        if(row.state!=='committed'){
          const code=(error as {code?:string}).code;
          if(['permission_denied','source_changed','recovery_required'].includes(code??''))return abortClone(engine,row,record,code!);
          throw error;
        }
      }
    }
    assertPhysicalRoot(record.target,{worktreeId:record.worktreeId});
    if(treeHash(record.target)!==record.afterHash)throw new OperationError('recovery_required','The committed clone changed before recovery cleanup.');
    const aside=treeHash(record.aside);
    if(aside!==null&&aside!==record.beforeHash)throw new OperationError('recovery_required','The retained old checkout changed; cleanup requires inspection.');
    if(existsSync(record.stage))throw new OperationError('recovery_required','Unexpected staging bytes remain after clone commitment.');
    if(aside!==null){assertRetainedRoot(record,record.aside);rmSync(record.aside,{recursive:true,force:true});}
    flushTopologyDirectory(dirname(record.target));
    await topologyTransaction(engine,async tx=>{await guard(tx,row,record);await releaseReservation(tx,row,record,'committed');});
    return readChange(engine,id);
  });
}

const recoveryCursors=new WeakMap<BrainEngine,string>();
/** A bounded rotating scan keeps persistent conflicts from starving other roots. */
export async function recoverSourceTopologies(engine:BrainEngine,opts:{hostId?:string;limit?:number}={}):Promise<number>{
  const host=opts.hostId??localHostId(),limit=Math.max(1,Math.min(16,opts.limit??2));
  const scan=async(after:string|null)=>engine.executeRaw<TopologyChange>(`SELECT c.* FROM persistence_topology_changes c
    JOIN persistence_worktrees w ON w.id=(c.recovery->>'worktreeId')::uuid
    WHERE c.recovery IS NOT NULL AND w.owner_host_id=$1::uuid AND ($2::uuid IS NULL OR c.id>$2::uuid)
    ORDER BY c.id LIMIT $3`,[host,after,limit]);
  let rows=await scan(recoveryCursors.get(engine)??null);
  if(!rows.length){recoveryCursors.delete(engine);rows=await scan(null);}
  if(rows.length)recoveryCursors.set(engine,rows[rows.length-1].id);
  let recovered=0;
  for(const row of rows){
    try{await withTopologyLocks(engine,row.source_id,async()=>{const done=await finishTopologyClone(engine,row.id);if(!done.recovery)recovered++;},undefined,0);}
    catch(error){if(!(error instanceof OperationError&&['write_pending','recovery_required'].includes(error.code)))throw error;}
  }
  return recovered;
}
