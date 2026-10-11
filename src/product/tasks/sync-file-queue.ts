import { createHash } from 'node:crypto';
import { mkdir, stat, unlink, rmdir } from 'node:fs/promises';
import { basename, join, dirname, resolve, sep } from 'node:path';
import type { BrainEngine } from '../../core/engine.ts';
import { MinionQueue } from '../../core/minions/queue.ts';
import { gbrainPath, loadConfig } from '../../core/config.ts';
import type { SyncFileInput } from './types.ts';
import type { ImportResult } from '../../core/import-file.ts';
import { rowToMinionJob, type MinionJob } from '../../core/minions/types.ts';
import { importFile, isImageFilePath } from '../../core/import-file.ts';
import { isCodeFilePath, isOfficeFilePath } from '../../core/sync.ts';
import { isSessionExportPath } from '../../core/conversation-parser/session-import.ts';
import { syncFileContentFingerprint } from './checkpoint.ts';
import { TaskResourceGuard, SYNC_QUEUE_CAPACITY, streamFileHash, copyFileSnapshot, assertImportFileSize } from './resource-guard.ts';

export const SYNC_FILE_QUEUE = 'pmbrain-sync-files';
export const SYNC_FILE_TASK = 'pmbrain-sync-file';

export class SyncFileQueue {
  private queue: MinionQueue;
  private enqueueTail:Promise<unknown>=Promise.resolve();
  constructor(private engine: BrainEngine, private observe?: (job:MinionJob)=>void, private allowed: (id:number)=>boolean = ()=>true, private resources=new TaskResourceGuard()) { this.queue = new MinionQueue(engine); }

  async enqueue(sessionId: number, token: string, file: SyncFileInput): Promise<ImportResult & { deferred?: boolean; unchanged?: boolean }> {
    const operation=this.enqueueTail.then(()=>this.enqueueCore(sessionId,token,file));
    this.enqueueTail=operation.catch(()=>{});
    return operation;
  }

  private async enqueueCore(sessionId:number,token:string,file:SyncFileInput):Promise<ImportResult & {deferred?:boolean;unchanged?:boolean}>{
    let sizeError:string|undefined;
    try{assertImportFileSize(file.relativePath,(await stat(file.path)).size);}catch(error){
      if(!(error instanceof Error)||!error.message.startsWith('资源保护：文件过大'))throw error;
      sizeError=error.message;
    }
    if (!this.allowed(sessionId)) throw new Error('同步任务已停止');
    const parent = await this.queue.getJob(sessionId);
    if (parent?.status !== 'active' || parent.lock_token !== token) throw new Error('同步任务已停止或租约失效');
    await this.resources.assertImportDisk();
    const key = createHash('sha256').update(JSON.stringify([sessionId, file.options.sourceId, file.sourceRoot, file.relativePath, file.hash, file.fingerprint])).digest('hex');
    const existing=await this.engine.executeRaw<Record<string,unknown>>('SELECT * FROM minion_jobs WHERE idempotency_key=$1',[`sync-file:${key}`]);
    let job=existing.length?rowToMinionJob(existing[0]):undefined;
    if(sizeError){
      const result={slug:'',status:'failed',chunks:0,error:sizeError,file:file.relativePath};
      if(!job){
        job=await this.queue.add(SYNC_FILE_TASK,{sessionId,kind:'sync_file',task:{type:'sync-file',input:file}},{queue:SYNC_FILE_QUEUE,delay:86400000,max_attempts:1,maxQueueSize:SYNC_QUEUE_CAPACITY,idempotency_key:`sync-file:${key}`,on_child_fail:'continue'});
        await this.engine.executeRaw("UPDATE minion_jobs SET parent_job_id=$2,status='completed',result=$3::jsonb,finished_at=now(),updated_at=now() WHERE id=$1",[job.id,sessionId,result]);
      }
      this.observe?.({...job,parent_job_id:sessionId,status:'completed',result});
      return {slug:'',status:'error',chunks:0,error:sizeError};
    }
    if(!job){
      const candidates=await this.engine.executeRaw<Record<string,unknown>>(`SELECT * FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2
        AND data->'task'->'input'->>'relativePath'=$3 AND data->'task'->'input'->>'sourceRoot'=$4
        AND COALESCE(data->'task'->'input'->'options'->>'sourceId','default')=$5 AND data->'task'->'input'->>'hash'=$6
        AND data->>'superseded' IS DISTINCT FROM 'true' ORDER BY id DESC`,[SYNC_FILE_QUEUE,sessionId,file.relativePath,file.sourceRoot,file.options.sourceId??'default',file.hash]);
      for(const candidate of candidates){
        const current=rowToMinionJob(candidate);
        const input=(current.data.task as {input:SyncFileInput}).input;
        if(syncFileContentFingerprint(input.options)===file.fingerprint){job=current;break;}
      }
    }
    await this.engine.executeRaw(`UPDATE minion_jobs SET data=jsonb_set(data,'{superseded}','true'::jsonb),
      status=CASE WHEN status IN ('paused','delayed','waiting') THEN 'cancelled' ELSE status END,updated_at=now()
      WHERE queue=$1 AND parent_job_id=$2 AND data->'task'->'input'->>'relativePath'=$3
      AND data->'task'->'input'->'options'->>'sourceId'=$4 AND data->'task'->'input'->>'hash' <> $5`,
      [SYNC_FILE_QUEUE,sessionId,file.relativePath,file.options.sourceId??'default',file.hash]);
    if (job) {
      this.observe?.(job);
      if (job?.result && (job.status === 'completed' || (job.result.pageHash && ['paused','delayed','waiting'].includes(job.status)))) {
        const stored = job.result as unknown as ImportResult & { pageHash?: string };
        if (!stored.pageHash) return stored;
        const page = await this.completePage(stored.slug,file,stored.status==='skipped');
        if (page && page.content_hash === stored.pageHash && !file.options.forceRechunk && (!stored.chunks || page.chunks===stored.chunks)) {
          if (job.status !== 'completed') await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'completed', finished_at = now(), lock_token = NULL, lock_until = NULL WHERE id = $1 AND status IN ('paused','delayed','waiting')`, [job.id]);
          if(stored.status==='skipped'){await this.validate(file);await this.remember(file,stored);}
          return stored;
        }
        await this.engine.executeRaw(`UPDATE minion_jobs SET idempotency_key = NULL, data = jsonb_set(data, '{superseded}', 'true'::jsonb) WHERE id = $1`, [job.id]);
      } else {
        if (['dead', 'failed'].includes(job.status)) throw new Error(job.error_text ?? '文件任务执行失败');
        if(job.status==='active')return { slug: '', status: 'skipped', chunks: 0, deferred: true };
      }
    }
    const rawManifest=await this.engine.getConfig(syncFileManifestKey(file));
    const manifest=rawManifest?JSON.parse(rawManifest) as SyncFileManifest:null;
    if(manifest?.hash===file.hash && manifest.fingerprint===file.fingerprint && !file.options.forceRechunk){
      const page=await this.completePage(manifest.slug,file,manifest.contentMatched===true);
      if(page?.content_hash===manifest.pageHash && manifest.chunks!==undefined && manifest.chunks!==page.chunks)file.options={...file.options,forceRechunk:true};
      if(page?.content_hash===manifest.pageHash && (manifest.chunks===undefined || manifest.chunks===page.chunks)){
        await this.validate(file);
        if(manifest.size!==file.originalSize||manifest.mtime!==file.originalMtime||manifest.chunks===undefined)await this.remember(file,{slug:manifest.slug,status:'skipped',chunks:page.chunks,pageHash:manifest.pageHash});
        await this.retireUnchanged(job);
        return {slug:manifest.slug,status:'skipped',chunks:0,unchanged:true};
      }
    }
    if (file.options.noEmbed && !(file.options.session && isSessionExportPath(file.relativePath)) && !isCodeFilePath(file.relativePath)
      && !isImageFilePath(file.relativePath) && !(file.options.documentOcr && isOfficeFilePath(file.relativePath))) {
      const inspected = isOfficeFilePath(file.relativePath)
        ? await (await import('../../core/office-import.ts')).importOfficeFile(this.engine,file.path,file.relativePath,{...file.options,checkOnly:true})
        : await importFile(this.engine, file.path, file.relativePath, { ...file.options, checkOnly: true });
      if (inspected.error === '同步检查：需要重新切分') file.options = {...file.options,forceRechunk:true};
      if (inspected.status === 'skipped' && !inspected.error) {
        await this.validate(file);
        const current = await this.queue.getJob(sessionId);
        if (current?.status !== 'active' || current.lock_token !== token) throw new Error('同步任务已停止或租约失效');
        const page=await this.completePage(inspected.slug,file);
        if(page)await this.remember(file,{...inspected,chunks:page.chunks,pageHash:page.content_hash});
        await this.retireUnchanged(job);
        return { ...inspected, unchanged: true };
      }
    }
    if(job && ['paused','delayed','waiting'].includes(job.status)){
      await this.engine.executeRaw(`UPDATE minion_jobs SET data=jsonb_set(data,'{task,input}', $2::jsonb),updated_at=now()
        WHERE id=$1 AND status IN ('paused','delayed','waiting')`,[job.id,{...file,path:((job.data.task as {input:SyncFileInput}).input).path}]);
      return { slug: '', status: 'skipped', chunks: 0, deferred: true };
    }
    const pending=await this.engine.executeRaw<{count:string}>("SELECT count(*)::text AS count FROM minion_jobs WHERE queue=$1 AND status NOT IN ('completed','failed','dead','cancelled')",[SYNC_FILE_QUEUE]);
    if(Number(pending[0].count)>=SYNC_QUEUE_CAPACITY)throw new Error(`资源保护：队列容量已达到 ${SYNC_QUEUE_CAPACITY}，已拒绝新文件。请先完成或停止已有任务。`);
    const size=(await stat(file.path)).size;
    await this.resources.assertImportDisk(size*2);
    const config = loadConfig();
    const brain = createHash('sha256').update(JSON.stringify([config?.engine, config?.database_path, config?.database_url])).digest('hex').slice(0, 24);
    const dir = join(gbrainPath('task-artifacts'), 'sync-files', brain, String(sessionId));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${key}-${basename(file.path)}`);
    const releaseReservation=await this.resources.reserveSnapshot(size);
    let queued=false;
    try {
    await copyFileSnapshot(file.path,path,file.hash,async()=>{
      if(!this.allowed(sessionId))throw new Error('同步任务已停止');
      await this.resources.assertDisk(dir,Math.min(size,64*1024));
    });
    const after = await this.queue.getJob(sessionId);
    if (!this.allowed(sessionId)) throw new Error('同步任务已停止');
    if (after?.status !== 'active' || after.lock_token !== token) throw new Error('同步任务已停止或租约失效');
    const added = await this.queue.add(SYNC_FILE_TASK, { sessionId, kind: 'sync_file', task: { type: 'sync-file', input: { ...file, path } } }, {
      queue: SYNC_FILE_QUEUE, delay: 24 * 60 * 60 * 1000, max_attempts: 1, maxQueueSize: SYNC_QUEUE_CAPACITY,
      timeout_ms: 6 * 60 * 60 * 1000, idempotency_key: `sync-file:${key}`, on_child_fail: 'continue',
    });
    queued=true;
    await this.engine.executeRaw('UPDATE minion_jobs SET parent_job_id=$1 WHERE id=$2',[sessionId,added.id]);
    added.parent_job_id=sessionId;
    this.observe?.(added);
    return { slug: '', status: 'skipped', chunks: 0, deferred: true };
    } catch(error){if(!queued){releaseReservation();await unlink(path).catch(failure=>{if(failure.code!=='ENOENT')throw failure;});}throw error;}
  }

  async release(sessionId: number, token: string) {
    await this.engine.transaction(async tx => {
      const rows = await tx.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs WHERE id = $1 AND status = 'active' AND lock_token = $2 FOR UPDATE`, [sessionId, token]);
      if (!rows.length) throw new Error('同步任务已停止或租约失效');
      await tx.executeRaw(`UPDATE minion_jobs SET parent_job_id = $1, status = CASE WHEN status IN ('delayed','paused') THEN 'waiting' ELSE status END,
        delay_until = NULL, updated_at = now() WHERE queue = $2 AND (data->>'sessionId')::bigint = $1 AND data->>'superseded' IS DISTINCT FROM 'true'`, [sessionId, SYNC_FILE_QUEUE]);
      await tx.executeRaw(`UPDATE minion_jobs SET status = CASE WHEN EXISTS (
        SELECT 1 FROM minion_jobs WHERE parent_job_id = $1 AND status NOT IN ('completed','dead','failed','cancelled')
        ) THEN 'waiting-children' ELSE 'waiting' END, lock_token = NULL, lock_until = NULL, updated_at = now() WHERE id = $1`, [sessionId]);
    });
  }

  async pause(sessionId: number) {
    await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'paused', lock_token = NULL, lock_until = NULL, updated_at = now()
      WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 AND status IN ('waiting','delayed','active')`, [SYNC_FILE_QUEUE, sessionId]);
  }

  async resume(sessionId: number) {
    await this.engine.transaction(async tx => {
      await tx.executeRaw(`UPDATE minion_jobs SET status = 'delayed', parent_job_id = $2, lock_token = NULL, lock_until = NULL,
        delay_until = now() + interval '1 day', error_text = NULL, updated_at = now()
        WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 AND status IN ('paused','dead','failed') AND data->>'superseded' IS DISTINCT FROM 'true'`, [SYNC_FILE_QUEUE, sessionId]);
      await tx.executeRaw(`UPDATE minion_jobs SET status = 'waiting', lock_token = NULL, lock_until = NULL, timeout_at = NULL,
        data = jsonb_set(data, '{resumeOnRestart}', 'false'::jsonb), error_text = NULL, finished_at = NULL, updated_at = now() WHERE id = $1`, [sessionId]);
    });
  }

  async counts(sessionId: number) {
    const rows = await this.engine.executeRaw<{ total: string; completed: string; failed: string }>(
      `SELECT count(*)::text AS total,
       count(*) FILTER (WHERE status = 'completed' AND result->>'status' IN ('imported','skipped'))::text AS completed,
       count(*) FILTER (WHERE status IN ('dead','failed') OR result->>'status' IN ('failed','partial','error'))::text AS failed
       FROM minion_jobs WHERE queue = $1 AND parent_job_id = $2 AND data->>'superseded' IS DISTINCT FROM 'true'`, [SYNC_FILE_QUEUE, sessionId]);
    const { total, completed, failed } = rows[0];
    return { total: Number(total), completed: Number(completed), failed: Number(failed), remaining: Number(total) - Number(completed) - Number(failed) };
  }

  async sourceHash(file: Pick<SyncFileInput,'sourceRoot'|'relativePath'|'options'|'originalSize'|'originalMtime'>): Promise<string|null> {
    const raw=await this.engine.getConfig(syncFileManifestKey(file));
    if(!raw)return null;
    const saved=JSON.parse(raw) as SyncFileManifest;
    return saved.size===file.originalSize && saved.mtime===file.originalMtime?saved.hash:null;
  }

  private async retireUnchanged(job:MinionJob|undefined){
    if(!job)return;
    await this.engine.executeRaw(`UPDATE minion_jobs SET status='cancelled',data=jsonb_set(data,'{superseded}','true'::jsonb),updated_at=now()
      WHERE id=$1 AND status IN ('paused','delayed','waiting')`,[job.id]);
  }

  private async completePage(slug:string,file:SyncFileInput,contentMatched=false){
    const page=await this.engine.executeRaw<{content_hash:string;source_path:string|null;chunker_version:number;chunks:number;hasBody:boolean}>(
      `SELECT content_hash,source_path,chunker_version,length(compiled_truth)>0 AS "hasBody",(SELECT count(*)::int FROM content_chunks WHERE page_id=p.id) AS chunks
       FROM pages p WHERE slug=$1 AND source_id=$2 AND deleted_at IS NULL`,[slug,file.options.sourceId??'default']);
    const row=page[0];
    return row && row.chunker_version>=0 && (!row.hasBody||row.chunks>0)
      && (contentMatched || row.source_path?.replace(/\\/g,'/')===file.relativePath.replace(/\\/g,'/'))?row:null;
  }

  async remember(file:SyncFileInput,result:ImportResult & {pageHash?:string}){
    if(!result.pageHash)return;
    const page=await this.completePage(result.slug,file,result.status==='skipped');
    if(!page || page.content_hash!==result.pageHash)return;
    await this.engine.setConfig(syncFileManifestKey(file),JSON.stringify(syncFileManifest(file,result.slug,result.pageHash,page.chunks,result.status==='skipped')));
  }

  async validate(file: SyncFileInput) {
    await validateSyncFileSnapshot(file);
  }

  async cleanup(sessionId: number) {
    let after = 0;
    while (true) {
      const rows = await this.engine.executeRaw<{ id: number; path: string }>(`SELECT id, data->'task'->'input'->>'path' AS path
        FROM minion_jobs WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 AND id > $3 AND status = 'completed'
        AND result->>'status' IN ('imported','skipped') ORDER BY id LIMIT 200`, [SYNC_FILE_QUEUE, sessionId, after]);
      for (const row of rows) {
        await this.removeSnapshot(sessionId,row.path);
      }
      if (rows.length < 200) return;
      after = rows.at(-1)!.id;
    }
  }

  async cleanupCompleted(job:MinionJob){
    if(job.status==='completed' && ['imported','skipped'].includes(String(job.result?.status))){
      const input=(job.data.task as {input:SyncFileInput}).input;
      await this.removeSnapshot(Number(job.data.sessionId),input.path);
    }
  }

  async cleanupCompletedSnapshots() {
    let after = 0;
    while (true) {
      const rows = await this.engine.executeRaw<{id:number;session_id:string;path:string}>(`SELECT id,data->>'sessionId' AS session_id,data->'task'->'input'->>'path' AS path
        FROM minion_jobs WHERE queue=$1 AND id>$2 AND status='completed' AND result->>'status' IN ('imported','skipped')
        AND data->>'sessionId' IS NOT NULL AND data->'task'->'input'->>'path' IS NOT NULL ORDER BY id LIMIT 200`, [SYNC_FILE_QUEUE,after]);
      for (const row of rows) await this.removeSnapshot(Number(row.session_id),row.path);
      if (rows.length < 200) return;
      after = rows.at(-1)!.id;
    }
  }

  private async removeSnapshot(sessionId:number,value:string){
    const root=resolve(gbrainPath('task-artifacts'),'sync-files');const path=resolve(value);
    if(!path.startsWith(root+sep)||basename(dirname(path))!==String(sessionId)||!/^[a-f0-9]{64}-/.test(basename(path)))throw new Error('文件任务快照清理路径无效');
    const info=await stat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(info){await unlink(path);this.resources.snapshotRemoved(info.size);}
    await rmdir(dirname(path)).catch(error=>{if(!['ENOENT','ENOTEMPTY'].includes(error.code))throw error;});
  }
}

export async function validateSyncFileSnapshot(file: SyncFileInput) {
  if (await streamFileHash(file.path) !== file.hash) throw new Error('文件任务快照已改变');
  if (file.originalPath) {
    const current = await stat(file.originalPath);
    if (current.size !== file.originalSize || current.mtimeMs !== file.originalMtime
      || await streamFileHash(file.originalPath) !== file.hash) throw new Error('原始文件在处理期间已改变，请继续同步');
  }
}

export interface SyncFileManifest {hash:string;fingerprint:string;slug:string;pageHash:string;size?:number;mtime?:number;chunks?:number;contentMatched?:boolean;}
export function syncFileManifestKey(file:Pick<SyncFileInput,'options'|'sourceRoot'|'relativePath'>){
  return 'sync.file.sha256:'+createHash('sha256').update(JSON.stringify([file.options.sourceId??'default',file.sourceRoot,file.relativePath])).digest('hex');
}
export function syncFileManifest(file:SyncFileInput,slug:string,pageHash:string,chunks?:number,contentMatched=false):SyncFileManifest {
  return {hash:file.hash,fingerprint:file.fingerprint,slug,pageHash,size:file.originalSize,mtime:file.originalMtime,chunks,...(contentMatched?{contentMatched:true}:{})};
}
