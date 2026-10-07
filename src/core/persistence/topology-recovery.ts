import { topologyTransaction } from './topology-transaction.ts';
import { existsSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots, withFilesystemPublication } from './filesystem-guard.ts';
import { localHostId } from './identity.ts';
import { compactStoredManifest, worktreeManifest } from './ownership.ts';
import { advanceTopology, lockTopologyPrincipal, settleTopologyRequests, topologyCanonicalStamp, withTopologyLocks } from './topology-locks.ts';
import { withCoordinatedWrite } from './context.ts';
import { principalAttribution } from './attribution.ts';
import { releaseTopologyReservation, type TopologyChange } from './topology-receipts.ts';
import type { TopologyCloneRecovery } from './topology-clone-model.ts';
import type { CloneLifecycleHooks } from './topology-clone.ts';
import { flushTopologyDirectory, topologyDirectoryIdentity } from './topology-filesystem.ts';
import { assertPhysicalRoot } from './physical-root.ts';
import { assertPhysicalRootStamp, readPhysicalRootReservation } from './physical-root-record.ts';
import { resumeWorktreeRefreshes } from './worktree-refresh.ts';

const cloneStatusFix=(sourceId:string):Action=>readFix(
  `Shows source ${sourceId}'s owner, worktree state (recovering while a clone is unresolved) and blocking effects, read-only.`,
  {argv:['gbrain','sources','writer','status','--source',sourceId,'--json']});
/** A clone recovery that found bytes it cannot account for: it stops, keeps everything, and the owner re-checks on each pass. */
function retainedClone(message:string,record:TopologyCloneRecovery,detail:string):OperationError{
  return opError('recovery_required',message,
    `${detail} Recovery of source ${record.sourceId}'s ${record.operation} stopped without moving or deleting anything, and the owner re-checks it on every recovery pass. Show the user the writer status and these paths; never delete them to force progress (docs/architecture/topologies.md, "Supported managed work and explicit repair").`,
    {why:`Checkout ${record.target}, staging ${record.stage}, retained original ${record.aside}.`,fix:cloneStatusFix(record.sourceId)});
}
async function readChange(engine:BrainEngine,id:string):Promise<TopologyChange>{
  const [row]=await engine.executeRaw<TopologyChange>('SELECT * FROM persistence_topology_changes WHERE id=$1::uuid',[id]);
  if(!row)throw opError('not_found','Source lifecycle request not found.',
    `No source lifecycle request ${id} is recorded on this brain, so there is nothing to recover. Check writer status for the source's current state instead.`,
    {fix:readFix('Shows every source binding, worktree state and blocking effect on this brain, read-only.',{argv:['gbrain','sources','writer','status','--json']})});
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
    throw retainedClone('The recorded clone paths no longer belong to this owner.',record,
      `The recovery record names paths or an owner host that this host (${localHostId()}) cannot vouch for.`);
}
function treeHash(path:string,scope:'git'|'tree'):string|null{
  if(!existsSync(path))return null;
  if(lstatSync(path).isSymbolicLink())throw opError('recovery_required','Recovery refuses a substituted symbolic link.',
    `${path} was replaced by a symbolic link, so clone recovery stopped without following or removing it. Show the user the path; the owner re-checks it on every recovery pass and stays blocked until the link is replaced by the recorded directory (docs/architecture/topologies.md).`);
  return worktreeManifest(path,{scope}).digest;
}
function assertRetainedRoot(record:TopologyCloneRecovery,path:string):void{
  const reservation=readPhysicalRootReservation(record.target);
  if(!reservation||reservation.worktreeId!==record.worktreeId)throw retainedClone('The retained checkout identity cannot be verified.',record,
    `${path} carries no physical-root reservation for worktree ${record.worktreeId}.`);
  assertPhysicalRootStamp(path,reservation);
}
function assertStagingOwned(record:TopologyCloneRecovery):void{
  if(!existsSync(record.stage))return;
  const current=topologyDirectoryIdentity(record.stage),expected=record.stageIdentity;
  if(!expected||current.device!==expected.device||current.inode!==expected.inode||current.birthNs!==expected.birthNs)
    throw retainedClone('Unexpected staging directory identity; recovery retained its bytes.',record,
      `The staging directory ${record.stage} is not the one this clone created (device/inode differ).`);
  if(record.afterHash!==null){
    if(treeHash(record.stage,record.hashScope??'tree')!==record.afterHash)throw retainedClone('Unexpected staged clone bytes; recovery retained them.',record,
      `The staged clone at ${record.stage} no longer matches the bytes this clone wrote.`);
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
    throw retainedClone('Ownership changed while the clone needed recovery.',record,
      `Worktree ${record.worktreeId} no longer has owner epoch ${record.ownerEpoch} on this host in the recovering state.`);
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
    const aside=treeHash(record.aside,record.hashScope??'tree'),target=treeHash(record.target,record.hashScope??'tree');
    if(target!==null)assertPhysicalRoot(record.target,{worktreeId:record.worktreeId});
    if(aside!==null){
      assertRetainedRoot(record,record.aside);
      if(aside!==record.beforeHash||target!==null&&target!==record.afterHash)throw retainedClone('Unexpected clone recovery bytes; nothing was overwritten.',record,
        'The retained original or the checkout holds bytes this clone did not record, so restoring the original was not attempted.');
      removeOwnedStage(record);
      if(target!==null){renameSync(record.target,record.stage);flushTopologyDirectory(dirname(record.target));}
      renameSync(record.aside,record.target);flushTopologyDirectory(dirname(record.target));
    }else if(record.beforeHash===null){
      if(target!==null&&target!==record.afterHash)throw retainedClone('Unexpected bytes occupy the interrupted clone destination.',record,
        `${record.target} holds content this clone did not write.`);
      if(target!==null){removeOwnedStage(record);renameSync(record.target,record.stage);flushTopologyDirectory(dirname(record.target));}
    }else if(target!==record.beforeHash)throw retainedClone('The original checkout cannot be proven intact.',record,
      `${record.target} no longer matches the original checkout recorded before the clone.`);
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
            throw opError('source_changed','The source identity/checkpoint changed while cloning.',
              `Source ${record.sourceId} was added, replaced, synced or repointed while its ${record.operation} cloned, so the clone is rolled back and the original checkout kept. Check writer status, then run the ${record.operation} again under a new request id if it is still wanted.`,
              {fix:cloneStatusFix(record.sourceId)});
          if(record.operation==='reclone'&&await topologyCanonicalStamp(tx,record.worktreeId)!==record.canonicalStamp)
            throw opError('source_changed','The logical source changed while cloning; retry after its mirrors finish.',
              `Pages in source ${record.sourceId} changed while it recloned, so the clone is rolled back and the original checkout kept. Wait until writer status shows no blocking effects for ${record.sourceId}, then run gbrain sources reclone ${record.sourceId} again under a new request id.`,
              {fix:cloneStatusFix(record.sourceId)});
          await settleTopologyRequests(tx,sources,[record.worktreeId],row.principal_id);
          assertStagingOwned(record);
          const stage=treeHash(record.stage,record.hashScope??'tree'),target=treeHash(record.target,record.hashScope??'tree'),aside=treeHash(record.aside,record.hashScope??'tree');
          if(stage!==null){
            assertRetainedRoot(record,record.stage);
            if(aside!==null)assertRetainedRoot(record,record.aside);
            if(target!==null)assertPhysicalRoot(record.target,{worktreeId:record.worktreeId});
            if(stage!==record.afterHash||aside!==null&&aside!==record.beforeHash)throw retainedClone('Staged clone bytes changed.',record,
              'The staged clone or the retained original changed after the clone verified them.');
            if(target!==null){
              if(target!==record.beforeHash||aside!==null)throw retainedClone('The active checkout changed during clone preparation.',record,
                `${record.target} was edited after the clone recorded it, so it was not swapped out.`);
              renameSync(record.target,record.aside);flushTopologyDirectory(dirname(record.target));await hooks.boundary?.('old_moved');
            }else if(record.beforeHash!==null&&aside!==record.beforeHash)throw retainedClone('The old checkout is missing from both recorded paths.',record,
              'The original checkout is at neither the checkout path nor the retained path.');
            renameSync(record.stage,record.target);flushTopologyDirectory(dirname(record.target));await hooks.boundary?.('new_moved');
          }else if(target!==record.afterHash)throw retainedClone('Neither a verified stage nor the published clone is present.',record,
            'Neither the staging directory nor the checkout holds the verified clone.');
          assertPhysicalRoot(record.target,{worktreeId:record.worktreeId});
          await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
          await withCoordinatedWrite(tx,sources,async()=>{
            if(record.operation==='add')await tx.executeRaw('INSERT INTO sources(id,name,local_path,config,incarnation) VALUES($1,$2,$3,$4::text::jsonb,$5::uuid)',
              [record.sourceId,record.input.name??record.sourceId,record.target,JSON.stringify({...record.input.config,remote_url:record.input.remoteUrl,managed_clone:true}),record.incarnation]);
            else await tx.executeRaw('UPDATE sources SET last_commit=NULL,last_sync_at=NULL WHERE id=$1 AND incarnation=$2::uuid',[record.sourceId,record.incarnation]);
          },principalAttribution({kind:'local_cli',id:row.principal_id}));
          await advanceTopology(tx,[record.worktreeId]);
          await tx.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid',[record.worktreeId,JSON.stringify({...(record.manifest?compactStoredManifest(record.manifest):null),canonical_stamp:await topologyCanonicalStamp(tx,record.worktreeId)})]);
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
    if(treeHash(record.target,record.hashScope??'tree')!==record.afterHash)throw retainedClone('The committed clone changed before recovery cleanup.',record,
      `The clone is committed, but ${record.target} changed before its cleanup ran.`);
    const aside=treeHash(record.aside,record.hashScope??'tree');
    if(aside!==null&&aside!==record.beforeHash)throw retainedClone('The retained old checkout changed; cleanup requires inspection.',record,
      `The clone is committed, but the retained original at ${record.aside} changed, so it was not removed.`);
    if(existsSync(record.stage))throw retainedClone('Unexpected staging bytes remain after clone commitment.',record,
      `The clone is committed, but ${record.stage} still exists.`);
    if(aside!==null){assertRetainedRoot(record,record.aside);rmSync(record.aside,{recursive:true,force:true});}
    flushTopologyDirectory(dirname(record.target));
    await topologyTransaction(engine,async tx=>{await guard(tx,row,record);await releaseReservation(tx,row,record,'committed');});
    return readChange(engine,id);
  });
}

const recoveryCursors=new WeakMap<BrainEngine,string>();
/**
 * A bounded rotating scan keeps persistent conflicts from starving other roots.
 * It first converges interrupted worktree refreshes (F0, section 1.5) whose
 * refreshing process has exited; a live refresh holds its lock and is skipped.
 */
export async function recoverSourceTopologies(engine:BrainEngine,opts:{hostId?:string;limit?:number;onAttempt?:(id:string,recovered:boolean)=>void}={}):Promise<number>{
  const host=opts.hostId??localHostId(),limit=Math.max(1,Math.min(16,opts.limit??2));
  await resumeWorktreeRefreshes(engine,{hostId:host});
  const scan=async(after:string|null)=>engine.executeRaw<TopologyChange>(`SELECT c.* FROM persistence_topology_changes c
    JOIN persistence_worktrees w ON w.id=(c.recovery->>'worktreeId')::uuid
    WHERE c.recovery IS NOT NULL AND w.owner_host_id=$1::uuid AND ($2::uuid IS NULL OR c.id>$2::uuid)
    ORDER BY c.id LIMIT $3`,[host,after,limit]);
  let rows=await scan(recoveryCursors.get(engine)??null);
  if(!rows.length){recoveryCursors.delete(engine);rows=await scan(null);}
  if(rows.length)recoveryCursors.set(engine,rows[rows.length-1].id);
  let recovered=0;
  for(const row of rows){
    let finished=false;
    try{await withTopologyLocks(engine,row.source_id,async()=>{const done=await finishTopologyClone(engine,row.id);if(!done.recovery){recovered++;finished=true;}},undefined,0);}
    catch(error){if(!(error instanceof OperationError&&['write_pending','recovery_required'].includes(error.code)))throw error;}
    finally{opts.onAttempt?.(row.id,finished);}
  }
  return recovered;
}
