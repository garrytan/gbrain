/** Explicit, preview-bound repair of one ASCII case alias. No generic dirty
 * exemption. Call only while the official refresh and owner locks are held. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from '../spawn.ts';
import { flushDirectory, flushFile, sameFileMode } from '../fs-durable.ts';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { gitChildEnv } from '../git-env.ts';
import { OperationError } from '../ops/contract.ts';
import { persistenceHome } from './identity.ts';
import { isPhysicalRootMetadata } from './physical-root-record.ts';
import type { WorktreeBinding } from './ownership.ts';
import type { WorktreeRefreshRow } from './worktree-refresh.ts';

export interface CaseRecoveryPreview {
  version: 1; worktreeId: string; ownerEpoch: string; topologyGeneration: string;
  oldHead: string; targetHead: string; indexSha256: string;
  keep: string; remove: string; materializedSha256: string;
}
/** Strict CLI boundary: this is a reviewed document, never arbitrary repair commands. */
export function parseCaseRecoveryPreview(value:unknown):CaseRecoveryPreview {
  if(!value||typeof value!=='object'||Array.isArray(value)) refuse('preview must be an object');
  const p=value as Record<string,unknown>;
  const keys=['version','worktreeId','ownerEpoch','topologyGeneration','oldHead','targetHead','indexSha256','keep','remove','materializedSha256'];
  if(Object.keys(p).some(k=>!keys.includes(k))||p.version!==1||keys.slice(1).some(k=>typeof p[k]!=='string')) refuse('invalid preview fields');
  if(!/^[a-f0-9-]{36}$/.test(p.worktreeId as string)||!/^\d+$/.test(p.ownerEpoch as string)||!/^\d+$/.test(p.topologyGeneration as string)) refuse('invalid owner identity');
  for(const key of ['oldHead','targetHead'])if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(p[key] as string)) refuse('invalid commit');
  for(const key of ['indexSha256','materializedSha256'])if(!/^[a-f0-9]{64}$/.test(p[key] as string)) refuse('invalid hash');
  for(const key of ['keep','remove']) { if((p[key] as string).length>4096) refuse('path too long');pathOK(p[key] as string); }
  return value as CaseRecoveryPreview;
}
export interface CaseRecoveryReceipt {
  version: 1; preview: CaseRecoveryPreview; backupDir: string;
  originalIndexSha256: string; transitionIndexSha256: string;
}
const MAX_FILE = 64 * 1024 ** 2;
const CASE_ENTRIES = 2048, CASE_BLOBS = 512, CASE_BUDGET_MS = 120000;
const caseBudget=new AsyncLocalStorage<{deadline:number}>();
function budgeted<T>(fn:()=>T):T { return caseBudget.getStore()?fn():caseBudget.run({deadline:performance.now()+CASE_BUDGET_MS},fn); }

export const digest = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
function refuse(message: string): never {
  throw new OperationError('refresh_recovery_required', `Case recovery refused: ${message}`,
    'Preserve the checkout and recovery backups. Inspect owner status and create a fresh preview; never reset or discard the index.');
}
function git(root: string, args: string[], index?: string): Buffer {
  const remaining=(caseBudget.getStore()?.deadline??(performance.now()+CASE_BUDGET_MS))-performance.now();
  if(remaining<=0) refuse('case recovery total time budget exceeded');
  return execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',root,...args], {
    env:gitChildEnv({GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C',...(index ? {GIT_INDEX_FILE:index}: {})}),
    timeout:Math.max(1,Math.floor(remaining)),maxBuffer:32*1024**2,stdio:['ignore','pipe','pipe'],
  });
}
function text(raw: Buffer): string {
  try { return new TextDecoder('utf-8',{fatal:true}).decode(raw); }
  catch { return refuse('non-UTF8 Git path'); }
}
function fields(raw: Buffer): string[] { return text(raw).split('\0').filter(Boolean); }
function file(path: string): Buffer {
  const st=lstatSync(path); if(!st.isFile() || st.size>MAX_FILE) refuse('nonregular or oversized file');
  return readFileSync(path);
}
function indexPath(root:string):string {
  const path=text(git(root,['rev-parse','--git-path','index'])).trim();
  return isAbsolute(path)?path:join(root,path);
}
function pathOK(path:string):void {
  if(!path || path.startsWith('/') || path.split('/').length>128 || path.split('/').some(p=>!p||p==='.'||p==='..')) refuse('invalid path');
}
function physical(root:string,path:string):string {
  pathOK(path); let here=root;
  for(const part of path.split('/')) { here=join(here,part); if(lstatSync(here).isSymbolicLink()) refuse('symlink in materialized path'); }
  const rel=relative(realpathSync(root),realpathSync(here));
  if(rel.startsWith('..')||isAbsolute(rel)) refuse('materialized file escaped root');
  return here;
}
interface Entry { mode:string; oid:string; path:string }
function entries(root:string, rev?:string):Entry[] {
  const raw=rev?git(root,['ls-tree','-rz',rev]):git(root,['ls-files','--stage','-z']);
  const rows=fields(raw); if(rows.length>100000) refuse('too many paths');
  return rows.map(row=>{
    const i=row.indexOf('\t'), header=row.slice(0,i).split(' '),path=row.slice(i+1); pathOK(path);
    if(i<0 || !['100644','100755'].includes(header[0]) || !/^[a-f0-9]{40,64}$/.test(header[rev?2:1]) || (!rev && header[2]!=='0')) refuse('unsupported index/tree entry');
    return {mode:header[0],oid:header[rev?2:1],path};
  });
}
function sameEntries(a:Entry[],b:Entry[]):boolean { return JSON.stringify(a)===JSON.stringify(b); }
function blob(root:string,oid:string):Buffer {
  if(Number(text(git(root,['cat-file','-s',oid])).trim())>MAX_FILE) refuse('oversized blob');
  return git(root,['cat-file','blob',oid]);
}
function targetPortable(rows:Entry[]):void {
  const seen=new Map<string,string>(); let total=0;
  for(const row of rows) {
    let prefix='';
    for(const part of row.path.split('/')) {
      prefix+=`${prefix?'/':''}${part}`; total+=Buffer.byteLength(prefix); if(total>64*1024**2) refuse('prefix limit');
      // This conservative adapter is qualified for ASCII path identity only.
      // Non-ASCII needs an explicit full Unicode casefold implementation.
      if(/[^\x20-\x7e]/.test(prefix)) refuse('non-ASCII path needs additional portability qualification');
      const key=prefix.toLowerCase(),old=seen.get(key); if(old && old!==prefix) refuse('target still has case-colliding prefixes'); seen.set(key,prefix);
    }
  }
}
function validateCasePreviewImpl(root:string,binding:WorktreeBinding,oldHead:string,targetHead:string,p:CaseRecoveryPreview,overlap:string[]):void {
  parseCaseRecoveryPreview(p);
  if(p.version!==1||binding.worktree_id!==p.worktreeId||String(binding.owner_epoch)!==p.ownerEpoch||String(binding.topology_generation)!==p.topologyGeneration||oldHead!==p.oldHead||targetHead!==p.targetHead) refuse('preview identity/epoch/commit changed');
  if(!/^[a-f0-9]{64}$/.test(p.indexSha256)||! /^[a-f0-9]{64}$/.test(p.materializedSha256)) refuse('invalid digest');
  if(p.keep===p.remove||p.keep.toLowerCase()!==p.remove.toLowerCase()||/[^\x20-\x7e]/.test(p.keep+p.remove)) refuse('not an ASCII case alias');
  if(overlap.some(path=>path!==p.keep && path!==p.remove)) refuse('unbound dirt overlaps incoming files');
  if(text(git(root,['rev-parse','HEAD'])).trim()!==p.oldHead||text(git(root,['rev-parse','@{upstream}'])).trim()!==p.targetHead) refuse('HEAD/upstream changed');
  if(digest(file(indexPath(root)))!==p.indexSha256) refuse('index drifted');
  const before=entries(root),old=entries(root,p.oldHead),target=entries(root,p.targetHead);
  if(Math.max(old.length,target.length)>CASE_ENTRIES || new Set(old.map(e=>e.oid)).size>CASE_BLOBS) refuse('case manifest exceeds bounded recovery work limit');
  if(!sameEntries(before,old)) refuse('staged entries differ from frozen old HEAD');
  targetPortable(target);
  const keep=old.find(e=>e.path===p.keep),remove=old.find(e=>e.path===p.remove),next=target.find(e=>e.path===p.keep);
  if(!keep||!remove||!next||target.some(e=>e.path===p.remove)||keep.mode!==remove.mode||next.mode!==keep.mode) refuse('alias entries/modes do not match');
  // Identical aliases can report a clean worktree. Deleting one Git entry can
  // still unlink their shared physical file, so an explicit bound transition
  // is required. Empty overlap is allowed only for exact identical old blobs.
  if(!overlap.length && keep.oid!==remove.oid) refuse('clean alias entries differ');
  const a=physical(root,p.keep),b=physical(root,p.remove),as=statSync(a),bs=statSync(b);
  if(as.dev!==bs.dev||as.ino!==bs.ino) refuse('paths are not aliases on this filesystem');
  const materialized=file(a),older=blob(root,keep.oid),newer=blob(root,remove.oid);
  if(digest(materialized)!==p.materializedSha256||!materialized.equals(newer)||!blob(root,next.oid).equals(newer)||!newer.subarray(0,older.length).equals(older)) refuse('records/physical bytes not preserved exactly');
  // Every unrelated old object survives by exact blob+mode, or a JSONL file
  // retains its exact byte prefix. No set merge, deduplication or reordering.
  const targetByPath=new Map(target.map(e=>[e.path,e])),targetObjects=new Set(target.map(e=>e.mode+':'+e.oid));
  let bytes=older.length+newer.length;
  for(const row of old) {
    if(row.path===p.keep||targetObjects.has(row.mode+':'+row.oid)) continue;
    const next=targetByPath.get(row.path);
    if(!next || next.mode!==row.mode || !row.path.endsWith('.jsonl')) refuse(`old object is not retained: ${row.path}`);
    const was=blob(root,row.oid),now=blob(root,next.oid); bytes+=was.length+now.length;
    if(bytes>512*1024**2||!now.subarray(0,was.length).equals(was)) refuse('old JSONL bytes not retained');
  }
}
function syncDir(path:string):void { flushDirectory(path); }
function durable(path:string,data:Buffer|string):void {
  const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}syncDir(dirname(path));
}
function lockedIndex(root:string,fn:(index:string,lock:string,fd:number)=>void):void {
  const index=indexPath(root),lock=`${index}.lock`;let fd:number;
  try{fd=openSync(lock,'wx',0o600);}catch{return refuse('index.lock already exists');}
  const mine=lstatSync(lock);
  try{fn(index,lock,fd);}finally{
    closeSync(fd);
    if(existsSync(lock)) { const now=lstatSync(lock); if(now.dev===mine.dev&&now.ino===mine.ino) unlinkSync(lock); }
  }
}
async function applyCaseRecoveryImpl(root:string,row:WorktreeRefreshRow,binding:WorktreeBinding,p:CaseRecoveryPreview,overlap:string[],save:(receipt:CaseRecoveryReceipt)=>Promise<void>,boundary?:(stage: 'locked'|'prepared'|'index-replaced')=>Promise<void>|void):Promise<CaseRecoveryReceipt> {
  // Hold the standard Git lock through backup, the durable DB receipt, and the
  // index rename. The async receipt flush deliberately precedes replacement.
  const index=indexPath(root),lock=`${index}.lock`;
  let fd:number;try{fd=openSync(lock,'wx',0o600);}catch{return refuse('index.lock already exists');}
  const inode=lstatSync(lock);
  try {
    await boundary?.('locked');
    validateCasePreview(root,binding,row.old_head,row.target_head,p,overlap);
    const homeBase=join(persistenceHome(),'case-recovery');mkdirSync(homeBase,{recursive:true,mode:0o700});syncDir(persistenceHome());const base=realpathSync(homeBase);
    const backup=join(base,row.id);mkdirSync(backup,{mode:0o700});syncDir(base);
    const original=file(index);durable(join(backup,'original.index'),original);
    const old=entries(root,row.old_head);
    let saved=0;
    for(const entry of old) {
      const dest=join(backup,`${entry.oid}.blob`); if(existsSync(dest)) continue;
      const value=blob(root,entry.oid);saved+=value.length;if(saved>512*1024**2) refuse('backup size limit');durable(dest,value);
    }
    durable(join(backup,'physical.bin'),file(physical(root,p.keep)));
    const temporary=join(backup,'transition.index');durable(temporary,original);
    // On a case-insensitive filesystem both spellings name one directory
    // entry: removing that entry during merge would remove the kept file too.
    // Distinct hardlink entries share bytes but Git must remove the old name
    // through the ordinary fast-forward, so retain its original index entry.
    if(realpathSync(physical(root,p.keep))===realpathSync(physical(root,p.remove))) {
      git(root,['update-index','--force-remove',p.remove],temporary);
    }
    const next=entries(root,row.target_head).find(e=>e.path===p.keep)!;
    git(root,['update-index','--add','--cacheinfo',`${next.mode},${next.oid},${p.keep}`],temporary);
    const after=file(temporary);flushFile(temporary);syncDir(backup);
    const receipt:CaseRecoveryReceipt={version:1,preview:p,backupDir:backup,originalIndexSha256:digest(original),transitionIndexSha256:digest(after)};
    durable(join(backup,'prepared.json'),JSON.stringify(receipt));
    await save(receipt);
    await boundary?.('prepared');
    validateCasePreview(root,binding,row.old_head,row.target_head,p,overlap);
    writeFileSync(fd,after);fsyncSync(fd);renameSync(lock,index);syncDir(dirname(index));
    await boundary?.('index-replaced'); // crash injection: DB still says prepared after rename
    return receipt;
  } finally {
    closeSync(fd);
    if(existsSync(lock)){const now=lstatSync(lock);if(now.dev===inode.dev&&now.ino===inode.ino)unlinkSync(lock);}
  }
}
function reconcileCaseRecoveryImpl(root:string,row:WorktreeRefreshRow,head:string|null):'old'|'target' {
  if(existsSync(`${indexPath(root)}.lock`)) refuse('index.lock remains; its owner must be inspected while the worktree stays fenced');
  const r=row.outcome.case_recovery as CaseRecoveryReceipt|undefined;
  if(!r||r.version!==1||r.preview.worktreeId!==row.worktree_id||r.preview.oldHead!==row.old_head||r.preview.targetHead!==row.target_head||r.preview.ownerEpoch!==String(row.owner_epoch)||r.preview.topologyGeneration!==String(row.topology_generation)) refuse('recovery receipt identity mismatch');
  const expected=join(realpathSync(join(persistenceHome(),'case-recovery')),row.id);
  if(r.backupDir!==expected||lstatSync(expected).isSymbolicLink()||realpathSync(expected)!==expected) refuse('backup location mismatch');
  const original=file(join(expected,'original.index')),after=file(join(expected,'transition.index'));
  if(r.originalIndexSha256!==r.preview.indexSha256||digest(original)!==r.originalIndexSha256||digest(after)!==r.transitionIndexSha256||!file(join(expected,'physical.bin')).equals(blob(root,entries(root,row.target_head).find(e=>e.path===r.preview.keep)!.oid))) refuse('backup drift');
  if(head===row.target_head) {
    if(!sameEntries(entries(root),entries(root,row.target_head))) refuse('target index differs');
    // No old-index restore is allowed once HEAD reached the target.
    for(const e of entries(root,row.target_head)) {
      const materialized=physical(root,e.path);
      const mode=statSync(materialized).mode;
      // Windows exposes the read-only attribute, not POSIX executable bits.
      // The exact Git executable mode is already verified in the target index.
      const modeMatches=process.platform==='win32'
        ? sameFileMode(mode,Number.parseInt(e.mode,8))
        : Boolean(mode & 0o111)===(e.mode==='100755');
      if(!file(materialized).equals(blob(root,e.oid)) || !modeMatches) refuse('target materialization or mode differs');
    }
    const status=fields(git(root,['status','--porcelain=v1','-z','--untracked-files=normal']));
    for(let i=0;i<status.length;i++) {
      const record=status[i]; const paths=[record.slice(3)];
      if(record[0]==='R'||record[0]==='C') paths.push(status[++i]);
      for(const path of paths) {
        if(!path || (!isPhysicalRootMetadata(path.replace(/\/$/,'')) && path!=='.gbrain-managed' && !path.startsWith('.gbrain-managed/') && !row.preserved_uncommitted.some(p=>path===p||(p.endsWith('/')&&path.startsWith(p))))) refuse('target has unbound dirt');
      }
    }
    return 'target';
  }
  if(head!==row.old_head) refuse('unknown HEAD');
  const actual=digest(file(indexPath(root)));
  if(actual!==r.originalIndexSha256&&actual!==r.transitionIndexSha256) refuse('unknown index with old HEAD');
  if(digest(file(physical(root,r.preview.keep)))!==r.preview.materializedSha256) refuse('physical alias changed');
  if(actual===r.transitionIndexSha256) lockedIndex(root,(index,lock,fd)=>{
    if(digest(file(index))!==actual) refuse('index changed while locking');
    writeFileSync(fd,original);fsyncSync(fd);renameSync(lock,index);syncDir(dirname(index));
  });
  return 'old';
}

/** A kill before the prepared receipt cannot authorize deleting a Git lock.
 * Only a demonstrably untouched index with no lock may lift this fence. */
function reconcileCaseIntentImpl(root:string,row:WorktreeRefreshRow,head:string|null):void {
  const p=row.outcome.case_recovery_intent as CaseRecoveryPreview|undefined;
  if(!p||p.version!==1||p.worktreeId!==row.worktree_id||p.ownerEpoch!==String(row.owner_epoch)||p.topologyGeneration!==String(row.topology_generation)||p.oldHead!==row.old_head||p.targetHead!==row.target_head) refuse('incomplete case-recovery intent');
  if(head!==row.old_head||existsSync(`${indexPath(root)}.lock`)||digest(file(indexPath(root)))!==p.indexSha256||digest(file(physical(root,p.keep)))!==p.materializedSha256||!sameEntries(entries(root),entries(root,row.old_head))) refuse('unprepared recovery may hold an index lock or changed state; keep the fence for inspection');
}

export function validateCasePreview(...args:Parameters<typeof validateCasePreviewImpl>):ReturnType<typeof validateCasePreviewImpl> { return budgeted(()=>validateCasePreviewImpl(...args)); }

export function applyCaseRecovery(...args:Parameters<typeof applyCaseRecoveryImpl>):ReturnType<typeof applyCaseRecoveryImpl> { return budgeted(()=>applyCaseRecoveryImpl(...args)); }

export function reconcileCaseRecovery(...args:Parameters<typeof reconcileCaseRecoveryImpl>):ReturnType<typeof reconcileCaseRecoveryImpl> { return budgeted(()=>reconcileCaseRecoveryImpl(...args)); }

export function reconcileCaseIntent(...args:Parameters<typeof reconcileCaseIntentImpl>):ReturnType<typeof reconcileCaseIntentImpl> { return budgeted(()=>reconcileCaseIntentImpl(...args)); }
