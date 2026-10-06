import { topologyTransaction } from './topology-transaction.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { catalogueError } from '../error-catalogue.ts';
import { isValidSourceId } from '../source-id.ts';
import { EXPIRED_ARCHIVE_SQL } from '../source-delete.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { redactSourceConfig } from '../source-config-redact.ts';
import { discoverGitRoot } from '../sync-git.ts';
import { isInsideGitRepo, hasTrackedContent } from '../git-remote.ts';
import { containsPath, getWorktreeBinding, humanManifestProgress, type WorktreeBinding, type WorktreeManifest, worktreeManifest } from './ownership.ts';
import { localHostId } from './identity.ts';
import { advanceTopology, lockTopologyPrincipal, lockTopologyRows, settleTopologyRequests, topologyCanonicalStamp, topologyPrincipal, withTopologyLocks } from './topology-locks.ts';
import { priorTopologyChange, recordTopologyChange, topologyReceipt } from './topology-receipts.ts';
import { isWriteRequestId } from './types.ts';
import { withCoordinatedWrite } from './context.ts';
import { principalAttribution } from './attribution.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { canonicalFilesystemPath, nativeFilesystemPath } from './root-registry.ts';
import { flushTopologyDirectory } from './topology-filesystem.ts';
import { claimPhysicalRoot } from './physical-root.ts';
import { assertWriterAdminState, WRITER_INSPECTION_HINT } from './admin-intent.ts';
import { assertWriterAdminUnlocked } from './admin-lock.ts';

export interface SourceLifecycleInput {
  operation:'add'|'claim'|'archive'|'restore'|'remove'|'purge'|'rebind'|'reclone';
  sourceId:string; requestId?:string; expectedIncarnation?:string; dryRun?:boolean;
  path?:string; name?:string; config?:Record<string,unknown>; refederate?:boolean; confirmDestructive?:boolean;
  remoteUrl?:string;
  createDirectory?:boolean;
  expiredOnly?:boolean;
  requireGitContent?:boolean;
  expectedAdminState?:string;
  automaticClaim?:boolean;
}
interface SourceState {id:string;incarnation:string;archived:boolean;local_path:string|null;config:Record<string,unknown>;name:string;last_commit:string|null;}

function sourcesListFix():Action{
  return readFix('Lists every registered source (archived ones included) with its ID and local path.',{argv:['gbrain','sources','list','--json']});
}
function ownerStatusFix(sourceId:string):Action{
  return readFix('Shows the canonical binding, owner host, incarnation and any pending recovery; read it before deciding on a topology change.',
    {argv:['gbrain','sources','writer','status','--source',sourceId,'--json']});
}

function localRoot(path:string,create=false):{source:string;worktree:string}{
  if(!isAbsolute(path)||path.includes('\0')) throw opError('invalid_params','Source path must be an absolute directory on this host.',
    'Pass the source directory as an absolute path on the brain host, then rerun the command; nothing was changed.');
  const source=create?canonicalFilesystemPath(resolve(path)):realpathSync(resolve(path));
  if(existsSync(source)&&!statSync(source).isDirectory()) throw opError('invalid_params','Source path must be a directory.',
    'The path names a file. Pass the directory that holds the source content, then rerun the command; nothing was changed.');
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
  const overlap=others.find(other=>{const path=nativeFilesystemPath(join(other.local_path,other.relative_path));return containsPath(path,sourcePath)||containsPath(sourcePath,path);});
  if(overlap) throw opError('overlapping_path','Sources cannot claim overlapping canonical directories.',
    `Source '${sourceId}' would nest inside or around source '${overlap.source_id}'. Choose a directory outside that source's checkout; nothing was changed.`,
    {fix:ownerStatusFix(overlap.source_id)});
  const compatible=bindings.find(binding=>binding.local_path && containsPath(binding.local_path,root.worktree));
  const overlapping=bindings.find(binding=>binding.local_path && containsPath(root.worktree,binding.local_path));
  if(overlapping&&!compatible) throw opError('topology_change_required','The proposed root encloses another registered worktree. Rebind those sources explicitly first.',
    `The directory for '${sourceId}' contains the checkout of source '${overlapping.source_id}'. Move that source first with gbrain sources set-path ${overlapping.source_id} and its verified new directory (a topology change the user decides), or choose a directory that does not enclose it.`,
    {fix:ownerStatusFix(overlapping.source_id)});
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

/** #5219: the refusal for a vanished canonical checkout, with its exits. */
function missingCheckoutError(sourceId:string,path:string,state?:{pages:number;members:number}):OperationError{
  return catalogueError('source_checkout_missing',
    `The canonical checkout ${path} of source '${sourceId}' is missing; restore its verified manifest first.`+(state
      ?` Only a source with no pages that is its checkout's sole member can be retired without it (pages: ${state.pages}, other sources on the checkout: ${state.members}).`:''),
    `Restore the checkout at ${path} and retry, or switch the brain to classic mode with gbrain sources writer deactivate --dry-run (then the printed apply_command) and retire the source there with gbrain sources archive ${sourceId}.`);
}
async function assertRetirableWithoutCheckout(tx:BrainEngine,sourceId:string,path:string):Promise<void>{
  const [state]=await tx.executeRaw<{pages:number;members:number}>(`SELECT (SELECT count(*)::int FROM pages WHERE source_id=$1) AS pages,
    (SELECT count(*)::int FROM persistence_source_bindings b JOIN persistence_source_bindings o ON o.worktree_id=b.worktree_id AND o.source_id<>b.source_id WHERE b.source_id=$1) AS members`,[sourceId]);
  if(Number(state.pages)>0||Number(state.members)>0) throw missingCheckoutError(sourceId,path,{pages:Number(state.pages),members:Number(state.members)});
}

/** One source transition; shared-root members are fenced and invalidated together. */
export async function runManagedSourceLifecycle(engine:BrainEngine,input:SourceLifecycleInput, admission?: {
  before(tx: BrainEngine): Promise<void>;
  after(tx: BrainEngine, incarnation: string): Promise<void>;
}):Promise<Record<string,unknown>>{
  if(!['add','claim','archive','restore','remove','purge','rebind','reclone'].includes(input.operation)) throw opError('invalid_params','Unknown source lifecycle operation.',
    'Use one of: add, claim, archive, restore, remove, purge, rebind, reclone.');
  for(const key of ['dryRun','refederate','confirmDestructive','createDirectory','expiredOnly','requireGitContent'] as const) if(input[key]!==undefined&&typeof input[key]!=='boolean') throw opError('invalid_params',`${key} must be a boolean.`,`Pass ${key} as true or false, or omit it.`);
  for(const key of ['path','name','expectedIncarnation','requestId','remoteUrl'] as const) if(input[key]!==undefined&&(typeof input[key]!=='string'||input[key]!.length>8192)) throw opError('invalid_params',`${key} must be a bounded string.`,`Pass ${key} as a string of at most 8192 characters, or omit it.`);
  if(input.config!==undefined&&(!input.config||Array.isArray(input.config)||typeof input.config!=='object'||Buffer.byteLength(JSON.stringify(input.config))>8192)) throw opError('invalid_params','Source configuration must be a bounded object.',
    'Pass the source configuration as one JSON object whose serialized form is at most 8192 bytes.');
  if(!isValidSourceId(input.sourceId)) throw opError('invalid_params','A valid explicit source ID is required.',
    'Name the source by its ID: lowercase letters, digits and inner hyphens, at most 32 characters. The command in fix lists registered IDs.',{fix:sourcesListFix()});
  const requestId=input.requestId??randomUUID();
  if(!isWriteRequestId(requestId) || input.expectedIncarnation!==undefined&&!isWriteRequestId(input.expectedIncarnation))
    throw opError('invalid_params','request_id and expected_incarnation must be UUIDs.',
      `Omit request_id to get a generated one or pass a UUID; expected_incarnation is the source_incarnation the command in fix reports for '${input.sourceId}'.`,
      {fix:ownerStatusFix(input.sourceId)});
  if(['remove','purge','archive'].includes(input.operation)&&input.sourceId==='default') throw opError('invalid_params','The default source cannot be removed or archived.',
    `The default source holds the brain's primary pages and always stays registered. ${input.operation} a named source instead; the command in fix lists them.`,{fix:sourcesListFix()});
  const principal=await topologyPrincipal(engine);
  const intent={...input,requestId:undefined,dryRun:undefined,automaticClaim:undefined};
  const prior=await priorTopologyChange(engine,principal,requestId,intent);
  if(prior) return topologyReceipt(prior);
  if(input.requireGitContent&&input.path&&(!isInsideGitRepo(input.path)||!hasTrackedContent(input.path)))
    throw opError('not_a_git_repo','The source path must contain committed Git content. Use --force to register an ordinary directory.',
      `Commit the content in that directory with git first, or, if '${input.sourceId}' is meant to be a plain directory, rerun the add with --force; nothing was registered.`);
  if(input.operation==='reclone'||input.operation==='add'&&input.remoteUrl){
    const {runManagedSourceClone}=await import('./topology-clone.ts');
    return runManagedSourceClone(engine,input,principal,requestId,intent);
  }
  const root=input.path?localRoot(input.path,input.operation==='add'&&input.createDirectory):undefined;
  if(['rebind','claim'].includes(input.operation)&&!root) throw opError('invalid_params','The source operation requires its canonical path.',
    `Pass the canonical directory for '${input.sourceId}' (the one the command in fix reports, or its verified successor), then rerun the ${input.operation}.`,
    {fix:ownerStatusFix(input.sourceId)});
  const [before]=await engine.executeRaw<SourceState>('SELECT id,incarnation,archived,local_path,config,name,last_commit FROM sources WHERE id=$1',[input.sourceId]);
  if(input.operation!=='add'&&!before) throw opError('not_found','Source not found.',
    `No source '${input.sourceId}' is registered on this brain. Check the ID against the command in fix, which lists archived sources too.`,{fix:sourcesListFix()});
  if(input.expectedIncarnation&&input.expectedIncarnation!==before?.incarnation) throw opError('source_changed','The source was replaced.',
    `Source '${input.sourceId}' was removed and re-added after expected_incarnation was read, so nothing was changed. Read its current incarnation with the command in fix and confirm the ${input.operation} still applies before running it again.`,
    {fix:ownerStatusFix(input.sourceId)});
  if(input.dryRun) return {dry_run:true,operation:input.operation,source_id:input.sourceId,source_incarnation:before?.incarnation??null,path:root?.source??before?.local_path??null};
  return withTopologyLocks(engine,input.sourceId,async bindings=>{
    // Hash canonical bytes while holding native exclusion, without a database
    // connection checked out. The final transaction rejects new pending mirrors.
    const manifests=new Map<string,WorktreeManifest>();
    let missingCheckout:string|undefined;
    for(const path of new Set([...bindings.map(binding=>binding.local_path!).filter(Boolean),...(root?[root.worktree]:[])])) {
      if(!existsSync(path)) {
        if(input.operation==='add'&&input.createDirectory&&path===root?.worktree)continue;
        // #5219: retiring may skip a vanished checkout; the transaction proves the source is empty and its sole member.
        if(['archive','remove','purge'].includes(input.operation)&&!root){missingCheckout=path;continue;}
        throw missingCheckoutError(input.sourceId,path);
      }
      const manifest=worktreeManifest(path,{progress:humanManifestProgress()});
      manifests.set(path,manifest);
    }
    return topologyTransaction(engine,async tx=>{
    await assertWriterAdminState(tx,input.expectedAdminState);
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    const sources=await lockTopologyRows(tx,input.sourceId,bindings);
    if(input.operation==='claim'&&!input.automaticClaim) await assertWriterAdminUnlocked(tx);
    const [source]=await tx.executeRaw<SourceState>('SELECT id,incarnation,archived,local_path,config,name,last_commit FROM sources WHERE id=$1',[input.sourceId]);
    if(source)source.config=parseSourceConfig(source.config);
    const repeated=await priorTopologyChange(tx,principal,requestId,intent);
    if(repeated){await lockTopologyPrincipal(tx,principal);return topologyReceipt(repeated);}
    if((source?.incarnation??null)!==(before?.incarnation??null)) throw opError('source_changed','The source changed during lifecycle preparation.',
      `Source '${input.sourceId}' was replaced while this ${input.operation} was being prepared; the transaction rolled back and nothing changed. Check its current state with the command in fix before running the ${input.operation} again.`,
      {fix:ownerStatusFix(input.sourceId)});
    if(admission) await admission.before(tx);
    if(input.operation==='add'&&source&&(!root||source.local_path!==null)) throw opError('source_id_taken','Source ID is already registered.',
      `A source named '${input.sourceId}' already exists; nothing was added. Pick a different ID, or inspect the existing source with the command in fix.`,{fix:sourcesListFix()});
    if(input.operation==='purge'&&!input.expiredOnly&&!source?.archived) throw opError('invalid_params','Only an archived source can be purged.',
      `Source '${input.sourceId}' is active. Purge only follows an archive: gbrain sources archive ${input.sourceId} first, and confirm the purge with the user because it deletes the source's pages.`,{fix:sourcesListFix()});
    if(['remove','purge'].includes(input.operation)&&!input.confirmDestructive) throw opError('invalid_params','Source removal requires explicit destructive confirmation.',
      `Nothing was changed. ${input.operation} deletes the pages of source '${input.sourceId}' from the brain (its files stay on disk); ask the user, and only with their agreement run the command in fix.`,
      {fix:{argv:['gbrain','sources',input.operation,input.sourceId,'--confirm-destructive'],preview_argv:['gbrain','sources',input.operation,input.sourceId,'--dry-run'],
        consent:['destructive'],actor:'agent',requires_exclusive:false,
        why:`Deletes every page of source '${input.sourceId}' from the brain database; local storage is retained.`,
        user_message:`Removing source '${input.sourceId}' deletes its pages from the brain. Its files on disk stay. Do you want to go ahead?`}});
    if(missingCheckout) await assertRetirableWithoutCheckout(tx,input.sourceId,missingCheckout);
    const worktrees=bindings.map(binding=>binding.worktree_id);
    const currentBinding=bindings.find(binding=>binding.source_id===input.sourceId);
    const sameBinding=!!root&&!!currentBinding?.local_path&&currentBinding.local_path===root.worktree
      &&nativeFilesystemPath(join(currentBinding.local_path,currentBinding.relative_path))===nativeFilesystemPath(root.source);
    if(input.operation==='claim'&&currentBinding&&!sameBinding)
      throw opError('writer_transfer_required','The source already has a different canonical binding. Use rebind or verified ownership transfer.',
        `Source '${input.sourceId}' is already bound to another directory or host; nothing was claimed. Inspect the binding with the command in fix. Moving it (gbrain sources set-path on this host, or a writer transfer between hosts) is a topology change for the user to decide.`,
        {fix:ownerStatusFix(input.sourceId)});
    if(input.operation==='claim'&&!currentBinding&&source?.local_path&&realpathSync(source.local_path)!==root!.source)
      throw opError('source_changed','The requested claim path differs from the configured source root.',
        `Claim '${input.sourceId}' at the local_path the command in fix reports, or move it to the new directory with gbrain sources set-path ${input.sourceId}; nothing was claimed.`,{fix:sourcesListFix()});
    const expired=input.expiredOnly?await tx.executeRaw(`SELECT id FROM sources WHERE id=$1 AND ${EXPIRED_ARCHIVE_SQL}`,[input.sourceId]):null;
    const noop=expired?.length===0 || input.operation==='archive'&&source?.archived || input.operation==='restore'&&!source?.archived
      || ['claim','rebind'].includes(input.operation)&&sameBinding&&!!source?.local_path&&nativeFilesystemPath(source.local_path)===nativeFilesystemPath(root!.source);
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
      if(!binding?.local_path || !existsSync(binding.local_path)) throw opError('recovery_required','The original checkout is unavailable; recover its last verified manifest before rebinding.',
        `Nothing was rebound. Restore the original checkout of '${input.sourceId}' at the path the command in fix reports, with its last verified contents, then rerun set-path.`,
        {fix:ownerStatusFix(input.sourceId)});
      if(manifests.get(binding.local_path)!.digest!==manifests.get(root!.worktree)!.digest) throw opError('writer_manifest_mismatch','The new checkout differs from the current canonical manifest, including deletions.',
        `Nothing was rebound. Make the new directory an exact copy of the current checkout of '${input.sourceId}' (same files, nothing extra or missing), then rerun set-path.`,
        {fix:ownerStatusFix(input.sourceId)});
    }
    const ownedSourcePath=currentBinding?.local_path?join(currentBinding.local_path,currentBinding.relative_path):source?.local_path;
    if(input.operation==='restore'&&ownedSourcePath&&!existsSync(ownedSourcePath)) throw opError('recovery_required','Restore requires the verified canonical checkout. Reclone it before restoring the source.',
      `Nothing was restored. Recreate the checkout of '${input.sourceId}' with gbrain sources reclone ${input.sourceId}, then run gbrain sources restore ${input.sourceId} again.`,
      {fix:ownerStatusFix(input.sourceId)});
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
        const refs=await tx.executeRaw<{client_id:string}>('SELECT client_id FROM oauth_clients WHERE source_id=$1 LIMIT 1',[input.sourceId]);
        if(refs.length) throw opError('source_referenced','OAuth clients still reference this source. Revoke and remove those registrations first.',
          `Nothing was removed. OAuth client ${refs[0].client_id} (and possibly others) is bound to '${input.sourceId}'; list them with the command in fix and ask the user before revoking any, since revoking disconnects that client.`,
          {fix:readFix('Lists OAuth clients with the source each is bound to.',{argv:['gbrain','auth','clients','--json']})});
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
        ...(missingCheckout?{retired_without_checkout:missingCheckout}:{}),
        ...(root?{local_path:root.source}:{}),...(['remove','purge'].includes(input.operation)?{storage_retained:true,local_path:ownedSourcePath??null,pages_deleted:pagesDeleted}:{}),
        ...(input.operation==='add'?{name:input.name??source?.name??input.sourceId,config:redactSourceConfig({...source?.config,...input.config}),id:input.sourceId}: {})};
    },principalAttribution({kind:'local_cli',id:principal}));
    if(admission) await admission.after(tx,String(result.source_incarnation));
    const row=await recordTopologyChange(tx,{principal,requestId,intent,operation:input.operation,sourceId:input.sourceId,incarnation:source?.incarnation??String(result.source_incarnation),worktrees},result);
    return topologyReceipt(row);
    });
  },root?.worktree);
}
