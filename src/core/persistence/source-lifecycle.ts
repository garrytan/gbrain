import { topologyTransaction } from './topology-transaction.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { isValidSourceId } from '../source-id.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { discoverGitRoot } from '../sync-git.ts';
import { isInsideGitRepo, hasTrackedContent } from '../git-remote.ts';
import { containsPath, getWorktreeBinding, type WorktreeBinding, worktreeManifest } from './ownership.ts';
import { localHostId } from './identity.ts';
import { advanceTopology, lockTopologyPrincipal, lockTopologyRows, settleTopologyRequests, topologyCanonicalStamp, topologyPrincipal, withTopologyLocks } from './topology-locks.ts';
import { priorTopologyChange, recordTopologyChange, topologyReceipt } from './topology-receipts.ts';
import { isWriteRequestId } from './types.ts';
import { withCoordinatedWrite } from './context.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { canonicalFilesystemPath, nativeFilesystemPath } from './root-registry.ts';
import { flushTopologyDirectory } from './topology-filesystem.ts';
import { claimPhysicalRoot } from './physical-root.ts';
import { assertWriterAdminState, WRITER_INSPECTION_HINT } from './admin-intent.ts';

export interface SourceLifecycleInput {
  operation:'add'|'claim'|'archive'|'restore'|'remove'|'purge'|'rebind'|'reclone';
  sourceId:string; requestId?:string; expectedIncarnation?:string; dryRun?:boolean;
  path?:string; name?:string; config?:Record<string,unknown>; refederate?:boolean; confirmDestructive?:boolean;
  remoteUrl?:string;
  createDirectory?:boolean;
  expiredOnly?:boolean;
  requireGitContent?:boolean;
  expectedAdminState?:string;
}
interface SourceState {id:string;incarnation:string;archived:boolean;local_path:string|null;config:Record<string,unknown>;name:string;last_commit:string|null;}

function localRoot(path:string,create=false):{source:string;worktree:string}{
  if(!isAbsolute(path)||path.includes('\0')) throw new OperationError('invalid_params','Source path must be an absolute directory on this host.');
  const source=create?canonicalFilesystemPath(resolve(path)):realpathSync(resolve(path));
  if(existsSync(source)&&!statSync(source).isDirectory()) throw new OperationError('invalid_params','Source path must be a directory.');
  let worktree=source;
  let ancestor=source;while(!existsSync(ancestor))ancestor=dirname(ancestor);
  try{worktree=realpathSync(discoverGitRoot(ancestor));}catch{/* directory source */}
  return {source,worktree};
}

export async function installTopologyBinding(tx:BrainEngine,sourceId:string,incarnation:string,root:{source:string;worktree:string},bindings:WorktreeBinding[]):Promise<string>{
  const others=await tx.executeRaw<{source_id:string;relative_path:string;local_path:string}>(`SELECT b.source_id,b.relative_path,h.local_path
    FROM persistence_source_bindings b JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid
    WHERE b.source_id<>$2`,[localHostId(),sourceId]);
  const sourcePath=nativeFilesystemPath(root.source);
  if(others.some(other=>{const path=nativeFilesystemPath(join(other.local_path,other.relative_path));return containsPath(path,sourcePath)||containsPath(sourcePath,path);}))
    throw new OperationError('overlapping_path','Sources cannot claim overlapping canonical directories.');
  const compatible=bindings.find(binding=>binding.local_path && containsPath(binding.local_path,root.worktree));
  const overlapping=bindings.find(binding=>binding.local_path && containsPath(root.worktree,binding.local_path));
  if(overlapping&&!compatible) throw new OperationError('topology_change_required','The proposed root encloses another registered worktree. Rebind those sources explicitly first.');
  const worktree=compatible?.local_path??root.worktree;
  const physical=await claimPhysicalRoot(tx,worktree,{hostId:localHostId(),
    ...(compatible?{worktreeId:compatible.worktree_id,coordinationPath:compatible.coordination_path!}:{})});
  const id=physical.worktreeId;
  const [existing]=await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid',[id]);
  if(!existing)await tx.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch) VALUES($1::uuid,$2::uuid,1)',[id,localHostId()]);
  await tx.executeRaw(`INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) VALUES($1::uuid,$2::uuid,$3,$4)
    ON CONFLICT(worktree_id,host_id) DO NOTHING`,[id,localHostId(),worktree,physical.coordinationPath]);
  const rel=relative(nativeFilesystemPath(worktree),nativeFilesystemPath(root.source)).split(sep).join('/');
  await tx.executeRaw(`INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id,relative_path,topology_generation)
    SELECT $1,$2::uuid,$3::uuid,$4,topology_generation FROM persistence_worktrees WHERE id=$3::uuid
    ON CONFLICT(source_id) DO UPDATE SET source_incarnation=EXCLUDED.source_incarnation,worktree_id=EXCLUDED.worktree_id,
      relative_path=EXCLUDED.relative_path,topology_generation=EXCLUDED.topology_generation`,[sourceId,incarnation,id,rel]);
  return id;
}

/** One source transition; shared-root members are fenced and invalidated together. */
export async function runManagedSourceLifecycle(engine:BrainEngine,input:SourceLifecycleInput, admission?: {
  before(tx: BrainEngine): Promise<void>;
  after(tx: BrainEngine, incarnation: string): Promise<void>;
}):Promise<Record<string,unknown>>{
  if(!['add','claim','archive','restore','remove','purge','rebind','reclone'].includes(input.operation)) throw new OperationError('invalid_params','Unknown source lifecycle operation.');
  for(const key of ['dryRun','refederate','confirmDestructive','createDirectory','expiredOnly','requireGitContent'] as const) if(input[key]!==undefined&&typeof input[key]!=='boolean') throw new OperationError('invalid_params',`${key} must be a boolean.`);
  for(const key of ['path','name','expectedIncarnation','requestId','remoteUrl'] as const) if(input[key]!==undefined&&(typeof input[key]!=='string'||input[key]!.length>8192)) throw new OperationError('invalid_params',`${key} must be a bounded string.`);
  if(input.config!==undefined&&(!input.config||Array.isArray(input.config)||typeof input.config!=='object'||Buffer.byteLength(JSON.stringify(input.config))>8192)) throw new OperationError('invalid_params','Source configuration must be a bounded object.');
  if(!isValidSourceId(input.sourceId)) throw new OperationError('invalid_params','A valid explicit source ID is required.');
  const requestId=input.requestId??randomUUID();
  if(!isWriteRequestId(requestId) || input.expectedIncarnation!==undefined&&!isWriteRequestId(input.expectedIncarnation))
    throw new OperationError('invalid_params','request_id and expected_incarnation must be UUIDs.');
  if(['remove','purge','archive'].includes(input.operation)&&input.sourceId==='default') throw new OperationError('invalid_params','The default source cannot be removed or archived.');
  const principal=await topologyPrincipal(engine);
  const intent={...input,requestId:undefined,dryRun:undefined};
  const prior=await priorTopologyChange(engine,principal,requestId,intent);
  if(prior) return topologyReceipt(prior);
  if(input.requireGitContent&&input.path&&(!isInsideGitRepo(input.path)||!hasTrackedContent(input.path)))
    throw new OperationError('not_a_git_repo','The source path must contain committed Git content. Use --force to register an ordinary directory.');
  if(input.operation==='reclone'||input.operation==='add'&&input.remoteUrl){
    const {runManagedSourceClone}=await import('./topology-clone.ts');
    return runManagedSourceClone(engine,input,principal,requestId,intent);
  }
  const root=input.path?localRoot(input.path,input.operation==='add'&&input.createDirectory):undefined;
  if(['rebind','claim'].includes(input.operation)&&!root) throw new OperationError('invalid_params','The source operation requires its canonical path.');
  const [before]=await engine.executeRaw<SourceState>('SELECT id,incarnation,archived,local_path,config,name,last_commit FROM sources WHERE id=$1',[input.sourceId]);
  if(input.operation!=='add'&&!before) throw new OperationError('not_found','Source not found.');
  if(input.expectedIncarnation&&input.expectedIncarnation!==before?.incarnation) throw new OperationError('source_changed','The source was replaced.');
  if(input.dryRun) return {dry_run:true,operation:input.operation,source_id:input.sourceId,source_incarnation:before?.incarnation??null,path:root?.source??before?.local_path??null};
  return withTopologyLocks(engine,input.sourceId,async bindings=>{
    // Hash canonical bytes while holding native exclusion, without a database
    // connection checked out. The final transaction rejects new pending mirrors.
    const manifests=new Map<string,ReturnType<typeof worktreeManifest>>();
    for(const path of new Set([...bindings.map(binding=>binding.local_path!).filter(Boolean),...(root?[root.worktree]:[])])) {
      if(!existsSync(path)) {if(input.operation==='add'&&input.createDirectory&&path===root?.worktree)continue;throw new OperationError('recovery_required','The canonical checkout is missing; restore its verified manifest first.');}
      const manifest=worktreeManifest(path);
      if(Buffer.byteLength(JSON.stringify(manifest))>1_048_576) throw new OperationError('request_too_large','The verified source manifest exceeds the 1 MiB administration metadata bound.');
      manifests.set(path,manifest);
    }
    return topologyTransaction(engine,async tx=>{
    await assertWriterAdminState(tx,input.expectedAdminState);
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    const sources=await lockTopologyRows(tx,input.sourceId,bindings);
    const [source]=await tx.executeRaw<SourceState>('SELECT id,incarnation,archived,local_path,config,name,last_commit FROM sources WHERE id=$1',[input.sourceId]);
    if(source)source.config=parseSourceConfig(source.config);
    const repeated=await priorTopologyChange(tx,principal,requestId,intent);
    if(repeated){await lockTopologyPrincipal(tx,principal);return topologyReceipt(repeated);}
    if((source?.incarnation??null)!==(before?.incarnation??null)) throw new OperationError('source_changed','The source changed during lifecycle preparation.');
    if(admission) await admission.before(tx);
    if(input.operation==='add'&&source&&(!root||source.local_path!==null)) throw new OperationError('source_id_taken','Source ID is already registered.');
    if(input.operation==='purge'&&!input.expiredOnly&&!source?.archived) throw new OperationError('invalid_params','Only an archived source can be purged.');
    if(['remove','purge'].includes(input.operation)&&!input.confirmDestructive) throw new OperationError('invalid_params','Source removal requires explicit destructive confirmation.');
    const worktrees=bindings.map(binding=>binding.worktree_id);
    const currentBinding=bindings.find(binding=>binding.source_id===input.sourceId);
    const sameBinding=!!root&&!!currentBinding?.local_path&&currentBinding.local_path===root.worktree
      &&nativeFilesystemPath(join(currentBinding.local_path,currentBinding.relative_path))===nativeFilesystemPath(root.source);
    if(input.operation==='claim'&&currentBinding&&!sameBinding)
      throw new OperationError('writer_transfer_required','The source already has a different canonical binding. Use rebind or verified ownership transfer.');
    if(input.operation==='claim'&&!currentBinding&&source?.local_path&&realpathSync(source.local_path)!==root!.source)
      throw new OperationError('source_changed','The requested claim path differs from the configured source root.');
    const expired=input.expiredOnly?await tx.executeRaw('SELECT id FROM sources WHERE id=$1 AND archived=true AND archive_expires_at<=now()',[input.sourceId]):null;
    const noop=expired?.length===0 || input.operation==='archive'&&source?.archived || input.operation==='restore'&&!source?.archived
      || input.operation==='claim'&&!!currentBinding || input.operation==='rebind'&&sameBinding;
    if(noop){
      await lockTopologyPrincipal(tx,principal);
      return topologyReceipt(await recordTopologyChange(tx,{principal,requestId,intent,operation:input.operation,sourceId:input.sourceId,incarnation:source!.incarnation,worktrees},
        {operation:input.operation,source_id:input.sourceId,source_incarnation:source!.incarnation,noop:true,invalidated_requests:0}));
    }
    const invalidated=await settleTopologyRequests(tx,sources,worktrees,principal);
    // All pending mirrors must settle before these manifests are read. A pure
    // path rebind may never substitute stale or incomplete canonical bytes.
    if(input.operation==='rebind'){
      const binding=bindings.find(value=>value.source_id===input.sourceId);
      if(!binding&&source?.local_path===null)throw new OperationError('writer_registration_required','This source has no canonical filesystem binding.',
        WRITER_INSPECTION_HINT);
      if(!binding?.local_path || !existsSync(binding.local_path)) throw new OperationError('recovery_required','The original checkout is unavailable; recover its last verified manifest before rebinding.');
      if(manifests.get(binding.local_path)!.digest!==manifests.get(root!.worktree)!.digest) throw new OperationError('writer_manifest_mismatch','The new checkout differs from the current canonical manifest, including deletions.');
    }
    const ownedSourcePath=currentBinding?.local_path?join(currentBinding.local_path,currentBinding.relative_path):source?.local_path;
    if(input.operation==='restore'&&ownedSourcePath&&!existsSync(ownedSourcePath)) throw new OperationError('recovery_required','Restore requires the verified canonical checkout. Reclone it before restoring the source.');
    await refreshManagedFilesystemRoots(tx,managedFilesystemDatastorePath(engine));
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    const result=await withCoordinatedWrite(tx,sources,async()=>{
      let incarnation=source?.incarnation??randomUUID();
      let pagesDeleted=0;
      if(input.operation==='add'||input.operation==='claim'){
        if(root&&input.createDirectory&&!existsSync(root.source)){mkdirSync(root.source,{recursive:true});flushTopologyDirectory(dirname(root.source));}
        if(source) await tx.executeRaw("UPDATE sources SET local_path=$2,name=COALESCE($3,name),config=$4::text::jsonb WHERE id=$1",
          [input.sourceId,root!.source,input.name??null,JSON.stringify({...source.config,...input.config})]);
        else await tx.executeRaw('INSERT INTO sources(id,name,local_path,config,incarnation) VALUES($1,$2,$3,$4::text::jsonb,$5::uuid)',
          [input.sourceId,input.name??input.sourceId,root?.source??null,JSON.stringify(input.config??{}),incarnation]);
        if(root){const id=await installTopologyBinding(tx,input.sourceId,incarnation,root,bindings);if(!worktrees.includes(id))worktrees.push(id);}
      }else if(input.operation==='archive') await tx.executeRaw(`UPDATE sources SET archived=true,archived_at=COALESCE(archived_at,now()),
        archive_expires_at=COALESCE(archive_expires_at,now()+interval '72 hours'),config=$2::text::jsonb WHERE id=$1`,[input.sourceId,JSON.stringify({...source?.config,federated:false})]);
      else if(input.operation==='restore') await tx.executeRaw(`UPDATE sources SET archived=false,archived_at=NULL,archive_expires_at=NULL,
        config=$2::text::jsonb WHERE id=$1`,[input.sourceId,JSON.stringify({...source?.config,federated:input.refederate!==false})]);
      else if(input.operation==='rebind'){
        await tx.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1',[input.sourceId,root!.source]);
        const id=await installTopologyBinding(tx,input.sourceId,incarnation,root!,bindings);if(!worktrees.includes(id))worktrees.push(id);
      }else{
        const refs=await tx.executeRaw('SELECT client_id FROM oauth_clients WHERE source_id=$1 LIMIT 1',[input.sourceId]);
        if(refs.length) throw new OperationError('source_referenced','OAuth clients still reference this source. Revoke and remove those registrations first.');
        const [impact]=await tx.executeRaw<{count:string}>('SELECT count(*)::text AS count FROM pages WHERE source_id=$1',[input.sourceId]);
        pagesDeleted=Number(impact.count);
        await tx.executeRaw('DELETE FROM sources WHERE id=$1 AND incarnation=$2::uuid',[input.sourceId,incarnation]);
        await tx.executeRaw('DELETE FROM persistence_source_bindings WHERE source_id=$1 AND source_incarnation=$2::uuid',[input.sourceId,incarnation]);
      }
      await advanceTopology(tx,worktrees);
      for(const id of worktrees){
        const [host]=await tx.executeRaw<{local_path:string}>('SELECT local_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid',[id,localHostId()]);
        if(host&&manifests.has(host.local_path)) await tx.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid',[id,JSON.stringify({...manifests.get(host.local_path),canonical_stamp:await topologyCanonicalStamp(tx,id)})]);
      }
      // This durable registry intentionally retains old checkout paths, so
      // stale installations cannot write after a source moved or disappeared.
      await refreshManagedFilesystemRoots(tx,managedFilesystemDatastorePath(engine));
      return {operation:input.operation,source_id:input.sourceId,source_incarnation:incarnation,invalidated_requests:invalidated,
        ...(root?{local_path:root.source}:{}),...(['remove','purge'].includes(input.operation)?{storage_retained:true,local_path:ownedSourcePath??null,pages_deleted:pagesDeleted}:{}),
        ...(input.operation==='add'?{name:input.name??source?.name??input.sourceId,config:{...source?.config,...input.config},id:input.sourceId}: {})};
    });
    if(admission) await admission.after(tx,String(result.source_incarnation));
    const row=await recordTopologyChange(tx,{principal,requestId,intent,operation:input.operation,sourceId:input.sourceId,incarnation:source?.incarnation??String(result.source_incarnation),worktrees},result);
    return topologyReceipt(row);
    });
  },root?.worktree);
}
