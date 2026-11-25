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
import { parseSourceConfig } from '../sources-load.ts';
import { redactSourceConfig } from '../source-config-redact.ts';
import { discoverGitRoot } from '../sync-git.ts';
import { inGitCheckout, hasTrackedContent } from '../git-remote.ts';
import { containsPath, getWorktreeBinding, humanManifestProgress, type WorktreeBinding, type WorktreeManifest, worktreeManifest } from './ownership.ts';
import { manifestDifferences, storedManifestScope, type WorktreeManifestScope } from './worktree-manifest.ts';
import { hostIdFor } from './identity.ts';
import { advanceTopology, assertTopologyRequestsSettled, inspectTopologyPhysicalRoot, lockTopologyPrincipal, lockTopologyRows, settleTopologyRequests, topologyCanonicalStamp, topologyPrincipal, withTopologyLocks } from './topology-locks.ts';
import { admitTopologyRetire, isRetireAdmission, isSupersededRetire, priorTopologyChange, RETIRE_SUPERSEDED, recordTopologyChange, settleTopologyRetire, supersedeTopologyRetires, topologyReceipt, type TopologyChange } from './topology-receipts.ts';
import { isWriteRequestId } from './types.ts';
import { withCoordinatedWrite } from './context.ts';
import { principalAttribution } from './attribution.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { canonicalFilesystemPath, nativeFilesystemPath } from './root-registry.ts';
import { flushTopologyDirectory } from './topology-filesystem.ts';
import { claimPhysicalRoot, movedPhysicalRootRefusal } from './physical-root.ts';
import { inspectRelocatedPhysicalRoot, physicalRootMovedError, relocatePhysicalRoot } from './physical-root-record.ts';
import { sourceCheckoutMissingRefusal } from './verb-errors.ts';
import { assertWriterAdminState, WRITER_INSPECTION_HINT } from './admin-intent.ts';
import { assertWriterAdminUnlocked } from './admin-lock.ts';
import { rebindContentReceipts } from '../shared-skills/receipt-root.ts';
import { assertLinkedWorktreeIntact } from './worktree-link.ts';
import { requireTopologyRawSql } from './topology-stop.ts';

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
/** #7702/#8905: pages one retire batch deletes; each batch (with its cascaded chunks, links and versions) stays far under the 5 s topology statement bound. */
export const SOURCE_RETIRE_BATCH_PAGES=500;
interface SourceState {id:string;incarnation:string;archived:boolean;local_path:string|null;config:Record<string,unknown>;name:string;last_commit:string|null;}

function sourcesListFix():Action{
  return readFix('Lists every registered source (archived ones included) with its ID and local path.',{argv:['gbrain','sources','list','--json']});
}
function ownerStatusFix(sourceId:string):Action{
  return readFix('Shows the canonical binding, owner host, incarnation and any pending recovery; read it before deciding on a topology change.',
    {argv:['gbrain','sources','writer','status','--source',sourceId,'--json']});
}

/** #8984: the source this request_id was admitted against has since been removed, replaced or changed by another lifecycle operation. */
function retireSuperseded(row:TopologyChange):OperationError{
  return opError(RETIRE_SUPERSEDED,`This ${row.operation} request was superseded: source '${row.source_id}' has since been removed, replaced or changed by another lifecycle operation.`,
    `Nothing was changed: request ${row.request_id} can only act on incarnation ${row.source_incarnation} of '${row.source_id}' as it stood when the request was admitted, so retrying it can never delete pages the source holds now. Do not retry it. Read the source's current state with the command in fix; removing the current source is a new decision for the user, made with a new request id.`,
    {fix:ownerStatusFix(row.source_id)});
}
/** A prior receipt of this request_id, replayed; a retire admission (#8984) returns null so the run resumes. */
/** The arguments a lifecycle request id is bound to (its receipt digest). */
export function topologyIntent(input:SourceLifecycleInput):Record<string,unknown>{
  return {...input,requestId:undefined,dryRun:undefined,automaticClaim:undefined};
}

function replayTopologyChange(row:TopologyChange|null):Record<string,unknown>|null{
  if(!row||isRetireAdmission(row))return null;
  if(isSupersededRetire(row))throw retireSuperseded(row);
  return topologyReceipt(row);
}

function localRoot(path:string,create=false):{source:string;worktree:string}{
  if(!isAbsolute(path)||path.includes('\0')) throw opError('invalid_params','Source path must be an absolute directory on this host.',
    'Pass the source directory as an absolute path on the brain host, then rerun the command; nothing was changed.');
  const source=create?canonicalFilesystemPath(resolve(path)):realpathSync(resolve(path));
  if(existsSync(source)&&!statSync(source).isDirectory()) throw opError('invalid_params','Source path must be a directory.',
    'The path names a file. Pass the directory that holds the source content, then rerun the command; nothing was changed.');
  let worktree=source;
  let ancestor=source;while(!existsSync(ancestor))ancestor=dirname(ancestor);
  assertLinkedWorktreeIntact(ancestor);
  try{worktree=realpathSync(discoverGitRoot(ancestor));}catch{/* directory source */}
  return {source,worktree};
}

export async function installTopologyBinding(tx:BrainEngine,sourceId:string,incarnation:string,root:{source:string;worktree:string},bindings:WorktreeBinding[]):Promise<string>{
  const store=await tx.topologyStore();
  const others=await store.otherHostBindings(hostIdFor(tx),sourceId);
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
  const physical=await claimPhysicalRoot(tx,worktree,{hostId:hostIdFor(tx),
    ...(compatible?{worktreeId:compatible.worktree_id,coordinationPath:compatible.coordination_path!}:{})});
  const id=physical.worktreeId;
  if(!await store.worktreeExists(id))await store.insertWorktree(id,hostIdFor(tx));
  await store.insertHostBinding(id,hostIdFor(tx),worktree,physical.coordinationPath);
  const rel=relative(nativeFilesystemPath(worktree),nativeFilesystemPath(root.source)).split(sep).join('/');
  await store.upsertSourceBinding(sourceId,incarnation,id,rel);
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
  const state=await (await tx.topologyStore()).retirableState(sourceId);
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
  // The named Rust stop (topology-stop.ts): a managed clone or reclone refuses before its principal, replay or path checks run.
  if(input.operation==='reclone'||input.operation==='add'&&input.remoteUrl) requireTopologyRawSql(engine,'managed_source_clone');
  const principal=await topologyPrincipal(engine);
  const intent=topologyIntent(input);
  const prior=await priorTopologyChange(engine,principal,requestId,intent);
  const replayed=replayTopologyChange(prior);
  if(replayed) return replayed;
  // GST-2732: a plain folder outside any repository registers as one; a repository with nothing committed still refuses (#2707).
  if(input.requireGitContent&&input.path&&(!existsSync(input.path)||inGitCheckout(input.path)&&!hasTrackedContent(input.path)))
    throw opError('not_a_git_repo','The source path must contain committed Git content. Use --force to register an ordinary directory.',
      `Commit the content in that directory with git first, or, if '${input.sourceId}' is meant to be a plain directory, rerun the add with --force (sync then imports its files without Git; a file removed from it keeps its page); nothing was registered.`);
  if(input.operation==='reclone'||input.operation==='add'&&input.remoteUrl){
    const {runManagedSourceClone}=await import('./topology-clone.ts');
    return runManagedSourceClone(engine,input,principal,requestId,intent);
  }
  const root=input.path?localRoot(input.path,input.operation==='add'&&input.createDirectory):undefined;
  if(['rebind','claim'].includes(input.operation)&&!root) throw opError('invalid_params','The source operation requires its canonical path.',
    `Pass the canonical directory for '${input.sourceId}' (the one the command in fix reports, or its verified successor), then rerun the ${input.operation}.`,
    {fix:ownerStatusFix(input.sourceId)});
  const topology=await engine.topologyStore();
  const before=await topology.readSource(input.sourceId) as SourceState|null;
  // #8984: idempotency is per principal, so a request_id another CLI registration admitted against an earlier incarnation
  // (the registration was replaced since) refuses too; one bound to this incarnation still resumes under the new registration.
  const superseded:TopologyChange|null|undefined=prior?prior:['remove','purge'].includes(input.operation)?await topology.supersededRetire(requestId,input.sourceId,principal,before?.incarnation??null):undefined;
  if(superseded&&superseded.source_incarnation!==before?.incarnation){
    if(!input.dryRun) await topologyTransaction(engine,async tx=>{await lockTopologyPrincipal(tx,principal);await settleTopologyRetire(tx,superseded,'failed',{...superseded.outcome,error:RETIRE_SUPERSEDED});});
    throw retireSuperseded(superseded);
  }
  if(input.operation!=='add'&&!before) throw opError('not_found','Source not found.',
    `No source '${input.sourceId}' is registered on this brain. Check the ID against the command in fix, which lists archived sources too.`,{fix:sourcesListFix()});
  if(input.expectedIncarnation&&input.expectedIncarnation!==before?.incarnation) throw opError('source_changed','The source was replaced.',
    `Source '${input.sourceId}' was removed and re-added after expected_incarnation was read, so nothing was changed. Read its current incarnation with the command in fix and confirm the ${input.operation} still applies before running it again.`,
    {fix:ownerStatusFix(input.sourceId)});
  if(!input.dryRun&&input.confirmDestructive&&(input.operation==='remove'||input.operation==='purge'&&(input.expiredOnly||before?.archived))
    &&parseSourceConfig(before?.config).kind==='apple-contacts')
    await (await import('../apple-contacts/person-facts.ts')).retireAllPersonFacts(engine,input.sourceId);
  // #5200 (W14 P1.4): only an operation that compares or records checkout bytes hashes the manifest (add at an existing
  // root, claim, rebind, restore; reclone hashes in topology-clone.ts). Retiring a source (archive, remove, purge) compares
  // nothing, so when every binding already carries a verified digest it skips the walk and refreshes the stored manifest's
  // canonical_stamp in place; a symlink that appeared in the checkout after the claim no longer refuses a retire its dry
  // run said would succeed. A binding claimed before activation has no digest yet, and the retire records that first
  // manifest (clone recovery needs it), so its dry run says so.
  const retire=['archive','remove','purge'].includes(input.operation);
  const manifestRequired=!retire||(await topology.bindingDigests(input.sourceId)).some(row=>!row.digest);
  // #8625: the operation a moved checkout's exit names; restore, archive and the others pass no path.
  const exit={sourceId:input.sourceId,operation:input.operation as 'add'|'claim'|'rebind'};
  if(input.dryRun&&input.operation==='rebind'&&root){
    // #8625: the real rebind hashes the recorded checkout first, so a missing one refuses before anything else.
    const own=await getWorktreeBinding(engine,input.sourceId);
    if(own?.local_path&&own.owner_host_id===hostIdFor(engine)&&own.coordination_path&&!existsSync(own.local_path))
      throw await movedPhysicalRootRefusal(engine,root.worktree,exit,hostIdFor(engine),own.local_path)??missingCheckoutError(input.sourceId,own.local_path);
  }
  if(input.dryRun) await inspectTopologyPhysicalRoot(engine,input.sourceId,root?.worktree,{relocation:input.operation==='rebind',operation:input.operation});
  if(input.dryRun) return {dry_run:true,operation:input.operation,source_id:input.sourceId,source_incarnation:before?.incarnation??null,path:root?.source??before?.local_path??null,manifest_required:manifestRequired};
  return withTopologyLocks(engine,input.sourceId,async bindings=>{
    // Hash canonical bytes while holding native exclusion, without a database
    // connection checked out. The final transaction rejects new pending mirrors.
    const manifests=new Map<string,WorktreeManifest>();
    let missingCheckout:string|undefined;
    for(const path of new Set([...bindings.map(binding=>binding.local_path!).filter(Boolean),...(root?[root.worktree]:[])])) {
      if(!existsSync(path)) {
        if(input.operation==='add'&&input.createDirectory&&path===root?.worktree)continue;
        // #5219: retiring may skip a vanished checkout; the transaction proves the source is empty and its sole member.
        if(retire&&!root){missingCheckout=path;continue;}
        const moved=root&&await movedPhysicalRootRefusal(engine,root.worktree,exit,hostIdFor(engine),path);
        // #8625: the automatic first-write claim stays path-free, since a remote page write can reach it.
        if(input.automaticClaim) throw moved?physicalRootMovedError():sourceCheckoutMissingRefusal(input.sourceId,null);
        throw moved||missingCheckoutError(input.sourceId,path);
      }
      if(!manifestRequired)continue;
      const manifest=worktreeManifest(path,{progress:humanManifestProgress()});
      manifests.set(path,manifest);
    }
    // #6099: a rebind compares the new directory in the scope of the current checkout's manifest (Git-tracked files for a Git checkout).
    const currentRoot=bindings.find(binding=>binding.source_id===input.sourceId)?.local_path;
    if(input.operation==='rebind'&&root&&currentRoot&&currentRoot!==root.worktree&&manifests.has(currentRoot)&&manifests.has(root.worktree)
      &&storedManifestScope(manifests.get(currentRoot))!==storedManifestScope(manifests.get(root.worktree)))
      manifests.set(root.worktree,worktreeManifest(root.worktree,{progress:humanManifestProgress(),scope:storedManifestScope(manifests.get(currentRoot))}));
    // #7702/#8905: a remove or purge first deletes the source's pages in bounded batches, each its own transaction behind
    // the final transaction's preconditions; any precondition that would refuse or replay stops batching and the final
    // transaction reports it. Committed batches are durable, so a retry with the same request_id resumes. A batch
    // whose DELETE hits the statement bound is retried at half the size, so heavy pages still fit; any other bounded wait
    // (a lock wait, a busy writer, a slow precondition or commit) stops the run with write_pending, and the retry resumes at
    // full size. Only committed batches count toward the pages the run reports.
    let retiredPages=0;
    try{
    let deleting=false;
    const retireBatch=async(limit:number):Promise<number|null>=>{ deleting=false; try{ const n=await topologyTransaction(engine,async tx=>{
        await assertWriterAdminState(tx,input.expectedAdminState);
        const sources=await lockTopologyRows(tx,input.sourceId,bindings);
        const store=await tx.topologyStore();
        const source=await store.retireState(input.sourceId,input.expiredOnly===true);
        const admitted=await priorTopologyChange(tx,principal,requestId,intent);
        if(source?.incarnation!==before!.incarnation||!source.due||input.operation==='purge'&&!input.expiredOnly&&!source.archived
          ||admitted&&!(isRetireAdmission(admitted)&&admitted.source_incarnation===source.incarnation)
          ||await store.oauthClientOf(input.sourceId)!==null) return 0;
        await assertTopologyRequestsSettled(tx,sources,bindings.map(binding=>binding.worktree_id));
        await lockTopologyPrincipal(tx,principal);
        if(!admitted) await admitTopologyRetire(tx,{principal,requestId,intent,operation:input.operation,sourceId:input.sourceId,
          incarnation:source.incarnation,worktrees:bindings.map(binding=>binding.worktree_id),expiredOnly:input.expiredOnly});
        const gone=await withCoordinatedWrite(tx,sources,async()=>{
          deleting=true;
          const rows=await store.deletePageBatch(input.sourceId,limit);
          deleting=false;
          return rows;
        },principalAttribution({kind:'local_cli',id:principal}));
        return gone;
      }); retiredPages+=n; return n; }catch(error){
        if(deleting&&error instanceof OperationError&&error.code==='write_pending'&&error.reason==='statement_timeout'&&limit>1) return null;
        throw error;
      } };
    if(['remove','purge'].includes(input.operation)&&input.confirmDestructive&&!missingCheckout&&!admission)
      for(let limit=SOURCE_RETIRE_BATCH_PAGES,deleted=limit;deleted===limit;){
        const n=await retireBatch(limit);
        if(n===null)deleted=limit=Math.ceil(limit/2);else deleted=n;
      }
    return await topologyTransaction(engine,async tx=>{
    await assertWriterAdminState(tx,input.expectedAdminState);
    const store=await tx.topologyStore();
    await store.synchronousCommit();
    const sources=await lockTopologyRows(tx,input.sourceId,bindings);
    if(input.operation==='claim'&&!input.automaticClaim) await assertWriterAdminUnlocked(tx);
    const source=await store.readSource(input.sourceId) as SourceState|null;
    if(source)source.config=parseSourceConfig(source.config);
    const repeated=replayTopologyChange(await priorTopologyChange(tx,principal,requestId,intent));
    if(repeated){await lockTopologyPrincipal(tx,principal);return repeated;}
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
    const expired=input.expiredOnly?await store.isExpiredArchive(input.sourceId):null;
    const noop=expired===false || input.operation==='archive'&&source?.archived || input.operation==='restore'&&!source?.archived
      || ['claim','rebind'].includes(input.operation)&&sameBinding&&!!source?.local_path&&nativeFilesystemPath(source.local_path)===nativeFilesystemPath(root!.source);
    if(noop){
      await lockTopologyPrincipal(tx,principal);
      return topologyReceipt(await recordTopologyChange(tx,{principal,requestId,intent,operation:input.operation,sourceId:input.sourceId,incarnation:source!.incarnation,worktrees},
        {operation:input.operation,source_id:input.sourceId,source_incarnation:source!.incarnation,noop:true,invalidated_requests:0}));
    }
    const invalidated=await settleTopologyRequests(tx,sources,worktrees,principal);
    // All pending mirrors must settle before these manifests are read. A pure
    // path rebind may never substitute stale or incomplete canonical bytes.
    let relocated:ReturnType<typeof inspectRelocatedPhysicalRoot>|undefined;
    if(input.operation==='rebind'){
      const binding=bindings.find(value=>value.source_id===input.sourceId);
      if(!binding&&source?.local_path===null)throw new OperationError('writer_registration_required','This source has no canonical filesystem binding.',
        WRITER_INSPECTION_HINT);
      if(!binding?.local_path || !existsSync(binding.local_path)) throw opError('recovery_required','The original checkout is unavailable; recover its last verified manifest before rebinding.',
        `Nothing was rebound. Restore the original checkout of '${input.sourceId}' at the path the command in fix reports, with its last verified contents, then rerun set-path.`,
        {fix:ownerStatusFix(input.sourceId)});
      if(manifests.get(binding.local_path)!.digest!==manifests.get(root!.worktree)!.digest) throw rebindManifestMismatch(input.sourceId,binding.local_path,root!.worktree,
        storedManifestScope(manifests.get(binding.local_path)));
      if(binding.local_path!==root!.worktree&&realpathSync(binding.local_path)===root!.worktree)
        relocated=inspectRelocatedPhysicalRoot(binding.local_path,root!.worktree,{worktreeId:binding.worktree_id,coordinationPath:binding.coordination_path});
    }
    const ownedSourcePath=currentBinding?.local_path?join(currentBinding.local_path,currentBinding.relative_path):source?.local_path;
    if(input.operation==='restore'&&ownedSourcePath&&!existsSync(ownedSourcePath)) throw opError('recovery_required','Restore requires the verified canonical checkout. Reclone it before restoring the source.',
      `Nothing was restored. Recreate the checkout of '${input.sourceId}' with gbrain sources reclone ${input.sourceId}, then run gbrain sources restore ${input.sourceId} again.`,
      {fix:ownerStatusFix(input.sourceId)});
    await refreshManagedFilesystemRoots(tx,managedFilesystemDatastorePath(engine));
    await store.markTopologyChange();
    const result=await withCoordinatedWrite(tx,sources,async()=>{
      let incarnation=source?.incarnation??randomUUID();
      let pagesDeleted=retiredPages;
      if(input.operation==='add'||input.operation==='claim'){
        if(root&&input.createDirectory&&!existsSync(root.source)){mkdirSync(root.source,{recursive:true});flushTopologyDirectory(dirname(root.source));}
        if(source) await store.updateSourceRoot(input.sourceId,root!.source,input.name??null,{...source.config,...input.config});
        else await store.insertSource(input.sourceId,input.name??input.sourceId,root?.source??null,input.config??{},incarnation);
        if(root){const id=await installTopologyBinding(tx,input.sourceId,incarnation,root,bindings);if(!worktrees.includes(id))worktrees.push(id);}
      }else if(input.operation==='archive') await store.archiveSource(input.sourceId,{...source?.config,federated:false});
      else if(input.operation==='restore') await store.restoreSource(input.sourceId,{...source?.config,federated:input.refederate!==false&&source?.config?.qm_scope!==true});
      else if(input.operation==='rebind'&&relocated){
        // #5914 (P1.3c): the recorded root now resolves through a symlink to the new directory; the worktree keeps its id
        // and its ownership records move to the real path (reservation under the new sha256(root) name, stamp naming it).
        const moved=relocatePhysicalRoot(currentBinding!.local_path!,root!.worktree,relocated);
        await store.setSourceLocalPath(input.sourceId,root!.source);
        await store.setHostBindingPath(currentBinding!.worktree_id,hostIdFor(tx),moved.root);
        const rel=relative(nativeFilesystemPath(moved.root),nativeFilesystemPath(root!.source)).split(sep).join('/');
        await store.setBindingRelativePath(input.sourceId,rel);
        manifests.set(moved.root,manifests.get(root!.worktree)!);
      }else if(input.operation==='rebind'){
        await store.setSourceLocalPath(input.sourceId,root!.source);
        const id=await installTopologyBinding(tx,input.sourceId,incarnation,root!,bindings);if(!worktrees.includes(id))worktrees.push(id);
      }else{
        const ref=await store.oauthClientOf(input.sourceId);
        if(ref!==null) throw opError('source_referenced','OAuth clients still reference this source. Revoke and remove those registrations first.',
          `${retiredPages?`Only the ${retiredPages} page(s) this run already deleted were removed.`:'Nothing was removed.'} OAuth client ${ref} (and possibly others) is bound to '${input.sourceId}'; list them with the command in fix and ask the user before revoking any, since revoking disconnects that client.`,
          {fix:readFix('Lists OAuth clients with the source each is bound to.',{argv:['gbrain','auth','clients','--json']})});
        pagesDeleted+=await store.countSourcePages(input.sourceId);
        await store.deleteSourceIncarnation(input.sourceId,incarnation);
        await store.rescrubRemovedSource(input.sourceId);
        await store.deleteSourceBinding(input.sourceId,incarnation);
        await supersedeTopologyRetires(tx,input.sourceId,incarnation,principal,requestId);
        await store.deleteManagedSyncCursors(input.sourceId);
      }
      if(source&&!['remove','purge'].includes(input.operation)) await supersedeTopologyRetires(tx,input.sourceId,source.incarnation,principal,requestId);
      const contentReceipts=input.operation==='rebind'?await rebindContentReceipts(store,worktrees,hostIdFor(tx),relocated?undefined:[input.sourceId]):[];
      await advanceTopology(tx,worktrees);
      for(const id of worktrees){
        const host=await store.hostBinding(id,hostIdFor(tx));
        if(host&&manifests.has(host.local_path)) await store.setWorktreeManifest(id,{...manifests.get(host.local_path),canonical_stamp:await topologyCanonicalStamp(tx,id)});
        else if(!manifestRequired&&host) await store.mergeCanonicalStamp(id,await topologyCanonicalStamp(tx,id));
      }
      // This durable registry intentionally retains old checkout paths, so
      // stale installations cannot write after a source moved or disappeared.
      await refreshManagedFilesystemRoots(tx,managedFilesystemDatastorePath(engine));
      return {operation:input.operation,source_id:input.sourceId,source_incarnation:incarnation,invalidated_requests:invalidated,
        ...(missingCheckout?{retired_without_checkout:missingCheckout}:{}),...(contentReceipts.length?{content_receipts:contentReceipts}:{}),
        ...(root?{local_path:root.source}:{}),...(['remove','purge'].includes(input.operation)?{storage_retained:true,local_path:ownedSourcePath??null,pages_deleted:pagesDeleted}:{}),
        ...(input.operation==='add'?{name:input.name??source?.name??input.sourceId,config:redactSourceConfig({...source?.config,...input.config}),id:input.sourceId}: {})};
    },principalAttribution({kind:'local_cli',id:principal}));
    if(admission) await admission.after(tx,String(result.source_incarnation));
    const row=await recordTopologyChange(tx,{principal,requestId,intent,operation:input.operation,sourceId:input.sourceId,incarnation:source?.incarnation??String(result.source_incarnation),worktrees},result);
    return topologyReceipt(row);
    });
    }catch(error){
      if(retiredPages&&error instanceof OperationError&&!error.suggestion?.startsWith('Only the'))
        error.suggestion=`This run had already deleted ${retiredPages} page(s) of source '${input.sourceId}' in committed batches before it stopped; the source and its remaining pages are still registered. ${error.suggestion??''}`.trim();
      throw error;
    }
  },root?.worktree,5000,{relocation:input.operation==='rebind'}).catch(async(error:unknown)=>{
    // #8625: the claim's own refusal is path-free; a trusted local lifecycle names the move and its exit. The automatic
    // first-write claim keeps it path-free, since a remote page write can reach it.
    if(error instanceof OperationError&&error.detail==='physical_root_moved'&&root&&!input.automaticClaim)
      throw await movedPhysicalRootRefusal(engine,root.worktree,exit,hostIdFor(engine))??error;
    throw error;
  });
}

/** #6099: a rebind's new directory does not match the current checkout; names the first differing paths (Git-tracked paths in git scope). */
function rebindManifestMismatch(sourceId:string,current:string,candidate:string,scope:WorktreeManifestScope):OperationError{
  const diff=manifestDifferences(current,candidate,scope);
  const named=diff.total?` ${diff.total} file(s) differ, are missing or are extra${scope==='git'?' among the tracked Git files':''}: ${diff.paths.join(', ')}${diff.total>diff.paths.length?', …':''}.`:'';
  return opError('writer_manifest_mismatch','The new checkout differs from the current canonical manifest, including deletions.',
    scope==='git'
      ?`Nothing was rebound.${named} The comparison covers files Git tracks, so ignored files (such as .env files) never need copying. Make ${candidate} a clean clone of the current checkout `
        +`(for example move it aside, then git clone ${current} ${candidate}), then rerun gbrain sources set-path ${sourceId} ${candidate}.`
      :`Nothing was rebound.${named} Make the new directory an exact copy of the current checkout of '${sourceId}' (same files, nothing extra or missing), then rerun set-path.`,
    {fix:ownerStatusFix(sourceId)});
}
