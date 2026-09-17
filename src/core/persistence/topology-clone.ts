import { topologyTransaction } from './topology-transaction.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { parseRemoteUrl } from '../git-remote.ts';
import { isOwnedClone } from '../sources-ops.ts';
import { parseSourceConfig } from '../sources-load.ts';
import type { SourceLifecycleInput } from './source-lifecycle.ts';
import type { TopologyCloneRecovery } from './topology-clone-model.ts';
import { getWorktreeBinding, worktreeManifest } from './ownership.ts';
import { localHostId, persistenceHome } from './identity.ts';
import { acquireNativeLock, type NativeLockHandle } from './native-lock.ts';
import { canonicalFilesystemPath, recordManagedRoots } from './root-registry.ts';
import { withFilesystemPublication } from './filesystem-guard.ts';
import { lockTopologyRows, settleTopologyRequests, topologyCanonicalStamp, withTopologyLocks } from './topology-locks.ts';
import { priorTopologyChange, recordTopologyChange, topologyReceipt, type TopologyChange } from './topology-receipts.ts';
import { readJournalLimits } from './limits.ts';
import { cloneTopologyCheckout, flushTopologyDirectory, flushTopologyTree, topologyDirectoryBytes, topologyDirectoryIdentity } from './topology-filesystem.ts';
import { finishTopologyClone } from './topology-recovery.ts';
import { reservePhysicalRoot, preparePhysicalRootReplacement, readPhysicalRootReservation } from './physical-root.ts';

/** Provider seam only for deterministic storage-boundary tests. */
export interface CloneLifecycleHooks {
  clone?:(url:string,stage:string,budget:number)=>Promise<void>;
  boundary?:(name:'reserved'|'prepared'|'old_moved'|'new_moved'|'committed')=>Promise<void>;
}
export async function runManagedSourceClone(engine:BrainEngine,input:SourceLifecycleInput,principal:string,requestId:string,intent:unknown,
  hooks:CloneLifecycleHooks={}):Promise<Record<string,unknown>>{
  const [source]=await engine.executeRaw<{incarnation:string;config:Record<string,unknown>;last_commit:string|null;local_path:string|null}>(
    'SELECT incarnation,config,last_commit,local_path FROM sources WHERE id=$1',[input.sourceId]);
  if(source)source.config=parseSourceConfig(source.config);
  if(input.operation==='add'&&source)throw new OperationError('source_id_taken','Source ID is already registered.');
  if(input.operation==='reclone'&&!source)throw new OperationError('not_found','Source not found.');
  if(input.expectedIncarnation&&input.expectedIncarnation!==source?.incarnation)throw new OperationError('source_changed','The source was replaced.');
  const binding=input.operation==='reclone'?await getWorktreeBinding(engine,input.sourceId):null;
  if(input.operation==='reclone'&&(!binding?.local_path||binding.owner_host_id!==localHostId()||binding.relative_path!==''))
    throw new OperationError('owner_unavailable','Reclone must run on the owner of the complete canonical worktree.');
  if(input.operation==='reclone'&&(!source||!isOwnedClone({id:input.sourceId,local_path:source.local_path,config:source.config})))throw new OperationError('unmanaged_path','Reclone only replaces a checkout created and managed by GBrain.');
  const url=input.remoteUrl??source?.config.remote_url;
  if(typeof url!=='string')throw new OperationError('invalid_params','A configured HTTPS clone URL is required.');
  parseRemoteUrl(url);
  if(input.operation==='reclone'&&input.remoteUrl!==undefined&&input.remoteUrl!==source?.config.remote_url)
    throw new OperationError('source_changed',"Reclone must use the source's configured remote URL.");
  const requested=binding?.local_path??input.path;
  if(typeof requested!=='string'||!isAbsolute(requested)||requested.includes('\0'))throw new OperationError('invalid_params','Clone destination must be an absolute path on the owner.');
  const target=canonicalFilesystemPath(resolve(requested));
  if(input.operation==='add'&&existsSync(target))throw new OperationError('source_changed','Clone destination already exists. Register its existing path explicitly.');
  if(input.dryRun)return {dry_run:true,operation:input.operation,source_id:input.sourceId,path:target,source_incarnation:source?.incarnation??null};
  return withTopologyLocks(engine,input.sourceId,async bindings=>{
    if(input.operation==='add'&&bindings.some(binding=>!binding.unbound||binding.local_path!==target))throw new OperationError('overlapping_path','A new clone cannot replace or nest inside an existing canonical worktree.');
    const currentBinding=bindings.find(value=>value.source_id===input.sourceId);
    if(input.operation==='reclone'&&(!currentBinding||currentBinding.worktree_id!==binding!.worktree_id))throw new OperationError('source_changed','The canonical clone binding changed.');
    const reservedIdentity=readPhysicalRootReservation(target);
    const worktreeId=currentBinding?.worktree_id??reservedIdentity?.worktreeId??randomUUID();
    const coordination=currentBinding?.coordination_path??reservedIdentity?.coordinationPath??join(persistenceHome(),'locks',`${worktreeId}.lock`);
    let newLock:NativeLockHandle|null=null;
    if(!bindings.some(binding=>binding.worktree_id===worktreeId)){newLock=await acquireNativeLock(coordination!,{timeoutMs:5000});if(!newLock)throw new OperationError('writer_lock_unavailable','The new clone coordination lock is busy.');}
    let accepted:TopologyChange|undefined;
    try{
      const before=existsSync(target)?worktreeManifest(target):null;
      const limits=await readJournalLimits(engine);
      const reserved=Math.min(limits.worktreeRecoveryBytes,limits.brainRecoveryBytes);
      const oldBytes=existsSync(target)?await topologyDirectoryBytes(target,reserved):0;
      const token=randomUUID(),stage=join(dirname(target),`.gbrain-clone-${basename(target)}-${token}`),aside=`${target}.gbrain-old-${token}`;
      accepted=await topologyTransaction(engine,async tx=>{
        await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
        await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
        const [preparedOwner]=currentBinding?[]:await tx.executeRaw<{owner_host_id:string;owner_epoch:string;state:string}>(
          'SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE',[worktreeId]);
        if(preparedOwner){
          const members=await tx.executeRaw('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid LIMIT 1',[worktreeId]);
          const [host]=await tx.executeRaw<{local_path:string;coordination_path:string}>(
            'SELECT local_path,coordination_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid',[worktreeId,localHostId()]);
          if(preparedOwner.owner_host_id!==localHostId()||preparedOwner.state!=='active'||members.length
            ||host?.local_path!==target||host.coordination_path!==coordination)
            throw new OperationError('recovery_required','The reserved checkout is still bound, recovering, or has a different physical identity.');
        }
        const sources=await lockTopologyRows(tx,input.sourceId,bindings);
        const [current]=await tx.executeRaw<{incarnation:string;last_commit:string|null;config:unknown}>('SELECT incarnation,last_commit,config FROM sources WHERE id=$1',[input.sourceId]);
        const replay=await priorTopologyChange(tx,principal,requestId,intent);if(replay)return replay;
        if((current?.incarnation??null)!==(source?.incarnation??null)||current?.last_commit!==source?.last_commit
          ||current&&parseSourceConfig(current.config).remote_url!==source?.config.remote_url)throw new OperationError('source_changed','The source changed before clone admission.');
        const invalidated=await settleTopologyRequests(tx,sources,bindings.map(row=>row.worktree_id),principal);
        const incarnation=source?.incarnation??randomUUID();
        let canonicalStamp=currentBinding?await topologyCanonicalStamp(tx,worktreeId):'';
        const [owner]=currentBinding?await tx.executeRaw<{manifest:TopologyCloneRecovery['manifest']}>('SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid',[worktreeId]):[];
        const manifest=before?{...before,canonical_stamp:canonicalStamp}:owner?.manifest??null;
        if(input.operation==='reclone'&&(!manifest||manifest.canonical_stamp!==canonicalStamp))
          throw new OperationError('recovery_required','The missing checkout has no current verified canonical manifest. Recover it from a verified checkpoint before recloning.');
        if(manifest&&Buffer.byteLength(JSON.stringify(manifest))>1_048_576)throw new OperationError('request_too_large','The canonical manifest exceeds the 1 MiB recovery metadata bound.');
        const recovery:TopologyCloneRecovery={version:1,kind:'clone',phase:'reserved',operation:input.operation as 'add'|'reclone',sourceId:input.sourceId,
          incarnation,worktreeId,ownerHostId:localHostId(),ownerEpoch:String(currentBinding?.owner_epoch??preparedOwner?.owner_epoch??1),target,stage,aside,
          beforeHash:before?.digest??null,afterHash:null,manifest,canonicalStamp,checkpoint:source?.last_commit??null,sourceRemoteUrl:source?.config.remote_url as string??null,input,cloneBudget:0};
        recovery.cloneBudget=reserved-oldBytes-Buffer.byteLength(JSON.stringify(recovery))-65_536;
        if(recovery.cloneBudget<65_536)throw new OperationError('request_too_large','The old checkout leaves insufficient configured recovery space for a staged clone.');
        if(!currentBinding){
          if(preparedOwner)await tx.executeRaw("UPDATE persistence_worktrees SET state='recovering' WHERE id=$1::uuid",[worktreeId]);
          else await tx.executeRaw("INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch,state) VALUES($1::uuid,$2::uuid,1,'recovering')",[worktreeId,localHostId()]);
          await tx.executeRaw('INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) VALUES($1::uuid,$2::uuid,$3,$4) ON CONFLICT(worktree_id,host_id) DO NOTHING',[worktreeId,localHostId(),target,coordination]);
          await tx.executeRaw('INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id) VALUES($1,$2::uuid,$3::uuid)',[input.sourceId,incarnation,worktreeId]);
        }else await tx.executeRaw("UPDATE persistence_worktrees SET state='recovering',manifest=$2::text::jsonb WHERE id=$1::uuid",[worktreeId,JSON.stringify(manifest)]);
        const [brain]=await tx.executeRaw<{brain_id:string}>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
        recordManagedRoots(brain.brain_id,[{local_path:target,source_id:input.sourceId,source_incarnation:incarnation,worktree_id:worktreeId}]);
        return recordTopologyChange(tx,{principal,requestId,intent,operation:input.operation,sourceId:input.sourceId,incarnation,worktrees:[worktreeId]},
          {operation:input.operation,source_id:input.sourceId,source_incarnation:incarnation,invalidated_requests:invalidated},recovery as unknown as Record<string,unknown>,reserved);
      });
      if(accepted.state!=='recovering')return topologyReceipt(accepted);
      const admission=accepted;
      const recovery=admission.recovery as unknown as TopologyCloneRecovery;
      await hooks.boundary?.('reserved');
      await withFilesystemPublication([target,recovery.stage,recovery.aside],async()=>{
        mkdirSync(dirname(target),{recursive:true});flushTopologyDirectory(dirname(target));
        await topologyTransaction(engine,async tx=>{
          await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
          await reservePhysicalRoot(tx,target,{hostId:localHostId(),worktreeId,coordinationPath:coordination!});
        });
        if(existsSync(recovery.stage))throw new OperationError('recovery_required','The recorded staging path is already occupied.');
        mkdirSync(recovery.stage,{mode:0o700});flushTopologyDirectory(dirname(recovery.stage));
        recovery.stageIdentity=topologyDirectoryIdentity(recovery.stage);
        await topologyTransaction(engine,async tx=>{
          await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
          await tx.executeRaw("UPDATE persistence_topology_changes SET recovery=$2::text::jsonb,updated_at=now() WHERE id=$1::uuid AND state='recovering'",[accepted!.id,JSON.stringify(recovery)]);
        });
        await (hooks.clone??cloneTopologyCheckout)(url,recovery.stage,recovery.cloneBudget);
        const stageBytes=await topologyDirectoryBytes(recovery.stage,recovery.cloneBudget);
        const candidate=worktreeManifest(recovery.stage);
        if(Buffer.byteLength(JSON.stringify(candidate))>1_048_576)throw new OperationError('request_too_large','The cloned canonical manifest exceeds its 1 MiB recovery metadata bound.');
        if(recovery.manifest&&candidate.digest!==recovery.manifest.digest)throw new OperationError('writer_manifest_mismatch','The cloned checkout differs from the verified canonical manifest, including deletions.');
        flushTopologyTree(recovery.stage);flushTopologyDirectory(dirname(recovery.stage));
        recovery.afterHash=candidate.digest;recovery.phase='prepared';recovery.manifest={...candidate,canonical_stamp:recovery.canonicalStamp};
        if(oldBytes+stageBytes+Buffer.byteLength(JSON.stringify(recovery))+65_536>Number(admission.recovery_bytes))
          throw new OperationError('request_too_large','The complete staged clone and recovery metadata exceed the reserved capacity.');
        await topologyTransaction(engine,async tx=>{
          await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
          await preparePhysicalRootReplacement(tx,recovery.stage,target,{hostId:localHostId(),worktreeId,coordinationPath:coordination!});
          await tx.executeRaw("UPDATE persistence_topology_changes SET recovery=$2::text::jsonb,updated_at=now() WHERE id=$1::uuid AND state='recovering'",[accepted!.id,JSON.stringify(recovery)]);
        });
        await hooks.boundary?.('prepared');
        accepted=await finishTopologyClone(engine,accepted!.id,hooks);
      });
      return topologyReceipt(accepted);
    }catch(error){
      if(!accepted)throw error;
      // A commit may have succeeded even when its acknowledgment was lost.
      // Read the durable record before considering cleanup or retry.
      try{accepted=await finishTopologyClone(engine,accepted.id,{},error);}catch{/* recovery remains durable and blocks this root */}
      if(accepted.state==='committed')return topologyReceipt(accepted);
      if(accepted.state==='failed')return topologyReceipt(accepted);
      throw new OperationError('recovery_required','The clone requires recovery before this worktree can publish.',
        `Inspect writer status and repeat lifecycle request_id ${requestId}.`);
    }finally{await newLock?.release();}
  },target);
}
