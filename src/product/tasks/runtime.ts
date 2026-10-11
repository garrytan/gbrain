import { enqueueImportedEntityCapture } from './imported-entity-capture.ts';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { stat, mkdir, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import type { BrainEngine } from '../../core/engine.ts';
import { MinionQueue } from '../../core/minions/queue.ts';
import { MinionWorker } from '../../core/minions/worker.ts';
import { MINION_DEFERRED, type MinionJob, type MinionJobContext } from '../../core/minions/types.ts';
import type { ConsoleRun } from '../../commands/natural-lang/types.ts';
import { resolveImportSourceIdForPath } from '../../commands/natural-lang/api.ts';
import { ALL_PHASES } from '../../core/cycle.ts';
import { assertDreamPresetAllowGenerative, assertPhasesAllowGenerative } from '../../core/model-usage.ts';
import { TaskEngineHost } from './engine-host.ts';
import type { DreamTaskInput, ImportTaskInput, ProductTask, TaskWorkerMessage } from './types.ts';
import { removeAdminUploadTempDir } from '../../commands/pmbrain-admin-support.ts';
import { appendTaskCheckpoint, taskArtifactPath, resumeMaintenanceCheckpoint } from './checkpoint.ts';
import { FileProjection } from './file-projection.ts';
import { WorkerPgliteEngine } from '../database/worker-engine.ts';
import { TaskProgressAdapter, finishTaskProgress } from './progress-adapter.ts';
import type { TaskProductProgress } from '../../../shared/task-progress.ts';
import { withDatabasePriority } from '../database/priority';
import { SyncFileQueue, SYNC_FILE_QUEUE, SYNC_FILE_TASK } from './sync-file-queue.ts';
import type { MaintenanceCheckpoint, SyncFileInput } from './types.ts';
import { resolveSourceId } from '../../core/source-resolver.ts';
import { recordSyncedGitFile, commitQuickMaintenanceSource } from './synced-git.ts';
import type { SyncResult } from '../../commands/sync.ts';
import { claimMaintenanceCapture, maintenanceFailure } from './maintenance-orchestration.ts';
import { TaskResourceGuard, PRODUCT_QUEUE_CAPACITY, type TaskResourceOptions } from './resource-guard.ts';

export const PRODUCT_TASK_QUEUE = 'pmbrain-product';
const TASK_NAME = 'pmbrain-product-task';
const DEFAULT_PRODUCT_TASK_TIMEOUT_MS = 6 * 60 * 60 * 1000;
type Progress = { product?: TaskProductProgress; output?: string; result?: Record<string, unknown>; cancelRequested?: boolean; files?: Record<string, unknown>[] };

function toRun(job: MinionJob, stopping = false): ConsoleRun {
  const progress = (job.progress ?? {}) as Progress;
  const failure = job.status === 'completed' && String(job.data.kind).startsWith('dream_') ? maintenanceFailure(job.result ?? progress.result) : null;
  const status: ConsoleRun['status'] = stopping ? 'running' : failure ? 'failed' : job.status === 'completed' ? 'completed'
    : job.status === 'cancelled' ? 'cancelled' : ['dead', 'failed', 'paused'].includes(job.status) ? 'failed'
    : ['active', 'waiting-children'].includes(job.status) ? 'running' : 'queued';
  const adapter = new TaskProgressAdapter(String(job.data.kind), progress.product);
  if (!progress.product) adapter.write(progress.output ?? '');
  const task = job.data.task as ProductTask;
  adapter.view.relations = { available: Object.hasOwn(job.data, 'relations'), total: Object.keys((job.data.relations ?? {}) as object).length };
  adapter.view.gitResults = Object.values(job.data.gitResults ?? {});
  if (task?.type === 'import') adapter.view.material = { ...adapter.view.material,
    name: task.input.path.split(/[\\/]/).filter(Boolean).at(-1) ?? task.input.path,
    sourceId: task.input.sourceId ?? 'default', directory: task.input.directory === true,
  };
  return {
    product: finishTaskProgress(adapter.view, status, job.result ?? progress.result, failure ?? job.error_text),
    id: `task-${job.id}`, kind: String(job.data.kind), command: [], status,
    trigger: job.data.trigger === 'scheduled' ? 'scheduled' : 'manual',
    stdout: progress.output ?? '', stderr: '', error: stopping ? '正在停止任务…' : failure ?? job.error_text,
    exitCode: status === 'completed' ? 0 : ['failed', 'cancelled'].includes(status) ? 1 : null,
    startedAt: (job.started_at ?? job.created_at).toISOString(),
    completedAt: job.finished_at?.toISOString() ?? null,
    durationMs: job.finished_at ? job.finished_at.getTime() - (job.started_at ?? job.created_at).getTime() : null,
    result: job.result ?? progress.result,
  };
}

export class ProductTaskRuntime {
  private queue: MinionQueue;
  private worker: MinionWorker;
  private fileWorker: MinionWorker;
  private fileQueue: SyncFileQueue;
  private fileLoop: Promise<void> | null = null;
  private fileSessions = new Map<number, number>();
  private sessionViews = new Map<number, ConsoleRun>();
  private stoppingSessions = new Map<number, Promise<void>>();
  private stopIntents = new Set<number>();
  private fileProjection = new FileProjection();
  private recoveringOwner: Promise<void> | null = null;
  private dirtyFiles = new Map<number,Set<number>>();
  private idleFileThreads: Worker[] = [];
  private idleMaintenanceThreads: Worker[] = [];
  private sessionRefresh = new Map<number, { timer: ReturnType<typeof setTimeout>; file?: string }>();
  private loop: Promise<void> | null = null;
  private stopped = false;
  private paused = false;
  private failure: Error | null = null;
  private cached: ConsoleRun[] = [];
  private refreshingRuns: Promise<void> | null = null;
  private executions = new Map<number, { cancel: (reason?:string) => void; done: Promise<unknown>; run: () => ConsoleRun; ownsLockedTransaction: () => boolean; adjust:(constrained:boolean)=>void }>();
  private resources:TaskResourceGuard;
  private resourceDrain:Promise<void>|null=null;
  private submittingEntityCapture=false;
  private entityCaptureRequested=false;
  private resourceTimer:ReturnType<typeof setInterval>|null=null;
  private idleTimer:ReturnType<typeof setTimeout>|null=null;
  private localPressure=false;
  private externalPressure=false;
  private reclaiming:Promise<void>|null=null;

  constructor(private engine: BrainEngine, resourceOptions:TaskResourceOptions={}) {
    this.resources=new TaskResourceGuard(resourceOptions);
    this.fileProjection=new FileProjection({resources:this.resources});
    const memoryOptions={maxRssMb:0};
    this.queue = new MinionQueue(engine);
    this.fileQueue = new SyncFileQueue(engine,job=>this.fileProjection.record(job),id=>!this.stopIntents.has(id)&&!this.paused&&!this.stopped,this.resources);
    this.fileWorker = new MinionWorker(engine, { ...memoryOptions, queue: SYNC_FILE_QUEUE, concurrency: engine.kind==='pglite'?1:2, pollInterval: 100, healthCheckInterval: 0, lockDuration: 30_000, stalledInterval: 5000, ownsLockedTransaction: id => this.executions.get(id)?.ownsLockedTransaction() === true });
    this.fileWorker.on('job-finished', (job:MinionJob)=>{
      if(this.stopped||this.paused)return;
      void this.flushEntityCapture();
      void this.queue.getJob(job.id).then(async current=>{
        if(current){this.fileProjection.record(current);await this.fileQueue.cleanupCompleted(current);}
        this.scheduleSessionRefresh(Number(job.data.sessionId));
      }).catch(error=>console.error('[tasks] file completion:',error));
    });
    this.fileWorker.register(SYNC_FILE_TASK, async context => {
      const sessionId = Number(context.data.sessionId);
      if (this.stopIntents.has(sessionId)) throw new Error('同步会话已停止');
      this.fileSessions.set(context.id, sessionId);
      this.fileProjection.pin(sessionId);
      if(!this.dirtyFiles.has(sessionId))this.dirtyFiles.set(sessionId,new Set());
      this.dirtyFiles.get(sessionId)!.add(context.id);
      try {
        const parent = await this.queue.getJob(sessionId);
        if (parent?.queue !== PRODUCT_TASK_QUEUE || parent.status !== 'waiting-children') throw new Error('同步会话已停止，文件尚未开始');
        this.scheduleSessionRefresh(sessionId, ((context.data.task as ProductTask).input as SyncFileInput).relativePath);
        return await withDatabasePriority(2, () => this.execute(context));
      } catch (error) {
        if (this.stopIntents.has(sessionId) || this.recoveringOwner) throw error;
        await this.fileQueue.pause(sessionId);
        for (const [id, owner] of this.fileSessions) if (owner === sessionId && id !== context.id) this.executions.get(id)?.cancel();
        await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'paused', error_text = $2, lock_token = NULL, lock_until = NULL, updated_at = now() WHERE id = $1 AND status NOT IN ('completed','cancelled','dead','failed')`, [sessionId, error instanceof Error ? error.message : String(error)]);
        throw error;
      } finally {
        this.fileSessions.delete(context.id);
        if(![...this.fileSessions.values()].includes(sessionId))this.fileProjection.pin(sessionId,false);
        this.scheduleSessionRefresh(sessionId);
      }
    });
    this.worker = new MinionWorker(engine, {
      ...memoryOptions, queue: PRODUCT_TASK_QUEUE, concurrency: 2, pollInterval: 100,
      healthCheckInterval: 0, lockDuration: 30_000, stalledInterval: 5000,
      ownsLockedTransaction: id => this.executions.get(id)?.ownsLockedTransaction() === true,
    });
    this.worker.on('unhealthy', info => console.error('[tasks]', info));
    this.worker.on('job-finished',()=>void this.flushEntityCapture());
    this.worker.register(TASK_NAME, job => withDatabasePriority((job.data.task as ProductTask).type === 'import' ? 2 : 3, () => this.execute(job)));
  }

  async start(): Promise<void> {
    if (this.loop) return;
    await this.queue.ensureSchema();
    await this.engine.executeRaw(`UPDATE minion_jobs AS child SET parent_job_id=parent.id
      FROM minion_jobs AS parent WHERE child.queue=$1 AND child.parent_job_id IS NULL
      AND child.data->>'sessionId'=parent.id::text AND parent.queue=$2`,[SYNC_FILE_QUEUE,PRODUCT_TASK_QUEUE]);
    await this.loadStopIntents();
    const committed=await this.engine.executeRaw<{parent_job_id:number|null}>(`UPDATE minion_jobs AS child SET status='completed',lock_token=NULL,lock_until=NULL,finished_at=now(),updated_at=now()
      WHERE child.queue=$1 AND child.status='active' AND ($2::boolean OR child.lock_until<=now())
      AND child.result->>'status' IN ('imported','skipped') AND EXISTS(SELECT 1 FROM pages p
        WHERE p.slug=child.result->>'slug' AND p.source_id=child.data->'task'->'input'->'options'->>'sourceId'
        AND p.deleted_at IS NULL AND p.chunker_version>=0 AND p.content_hash=child.result->>'pageHash'
        AND (child.result->>'status'='skipped' OR (SELECT count(*) FROM content_chunks WHERE page_id=p.id)=(child.result->>'chunks')::bigint))
      RETURNING parent_job_id`,[SYNC_FILE_QUEUE,this.engine.kind==='pglite']);
    for(const id of new Set(committed.map(row=>row.parent_job_id).filter((id):id is number=>id!==null)))await this.queue.resolveParent(id);
    await this.fileQueue.cleanupCompletedSnapshots().catch(error => console.error('[tasks] snapshot recovery cleanup:', error));
    await this.recoverSessions();
    await this.queue.handleStalled([],SYNC_FILE_QUEUE);
    await this.engine.executeRaw(
      `UPDATE minion_jobs SET status = 'paused', lock_token = NULL, lock_until = NULL,
       error_text = '软件已退出，任务结果可能不完整。请查看已完成结果后手动继续；模型请求可能已产生费用。',
       finished_at = now(), updated_at = now()
       WHERE queue = $1 AND name = $2 AND status = 'active' AND data->'task'->'input'->>'preset' IS DISTINCT FROM 'quick'
       AND ($3::boolean OR lock_until <= now())`, [PRODUCT_TASK_QUEUE, TASK_NAME, this.engine.kind === 'pglite'],
    );
    await this.listRuns();
    for (const run of this.cached.filter(run=>run.kind==='dream_quick')) await this.fileProjection.load(Number(run.id.slice(5)));
    await this.hydrateFiles(this.cached.filter(run=>run.kind==='dream_quick').map(run=>Number(run.id.slice(5))));
    this.fileLoop = withDatabasePriority(2, () => this.fileWorker.start()).catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)); console.error('[tasks] file worker stopped:', error); });
    this.loop = withDatabasePriority(3, () => this.worker.start()).catch(error => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      console.error('[tasks] worker stopped:', error instanceof Error ? error.message : error);
    });
    this.resourceTimer=setInterval(()=>this.checkMemory(),this.resources.rssCheckIntervalMs);
    this.resourceTimer.unref();
    await this.flushEntityCapture();
  }

  private async flushEntityCapture():Promise<void>{
      if(this.stopped||this.paused)return;
      this.entityCaptureRequested=true;
      if(this.submittingEntityCapture)return;
      this.submittingEntityCapture=true;
      try{
        do{
          this.entityCaptureRequested=false;
          await withDatabasePriority(3,()=>enqueueImportedEntityCapture(this.engine));
        }while(this.entityCaptureRequested&&!this.stopped&&!this.paused);
      }
      catch(error){console.error('[tasks] imported entity capture:',error);}
      finally{this.submittingEntityCapture=false;}
  }

  private async submit(task: ProductTask, kind: string, idempotencyKey?: string, trigger: 'manual' | 'scheduled' = 'manual', queue = this.queue): Promise<ConsoleRun> {
    if (this.failure) throw this.failure;
    this.checkMemory();
    if (this.failure) throw this.failure;
    if (this.stopped || this.paused) throw new Error('数据库维护期间暂不能提交新任务');
    await this.resources.assertImportDisk();
    const job = await queue.add(TASK_NAME, { task, kind, trigger, relations: {} }, {
      queue: PRODUCT_TASK_QUEUE, max_attempts: 1, maxQueueSize: PRODUCT_QUEUE_CAPACITY,
      timeout_ms: task.input.timeoutMs ?? DEFAULT_PRODUCT_TASK_TIMEOUT_MS,
      idempotency_key: idempotencyKey ?? `product:${randomUUID()}`,
    });
    const run = toRun(job);
    if(kind==='dream_quick')this.fileProjection.seed(job.id,[]);
    this.cached = [run, ...this.cached.filter(row => row.id !== run.id)].slice(0, 100);
    return run;
  }

  async submitImport(input: ImportTaskInput): Promise<ConsoleRun> {
    return withDatabasePriority(2, () => this.submitImportCore(input));
  }

  private async submitImportCore(input: ImportTaskInput): Promise<ConsoleRun> {
    if (!input.path.trim()) throw new Error('Path is required');
    const sourceId = await resolveImportSourceIdForPath(this.engine, input.path, input.sourceId);
    const file = await stat(input.path).catch(() => null);
    const key = `product-import:${createHash('sha256').update(JSON.stringify([input, sourceId, file?.size, file?.mtimeMs])).digest('hex')}`;
    await this.engine.executeRaw(
      `UPDATE minion_jobs SET idempotency_key = NULL WHERE idempotency_key = $1
       AND status IN ('completed', 'dead', 'failed', 'cancelled', 'paused')`, [key],
    );
    return this.submit({ type: 'import', input: { ...input, directory: file?.isDirectory() ?? false, path: input.path.trim(), sourceId, timeoutMs: input.timeoutMs ?? 6 * 60 * 60_000 } }, 'import_path', key);
  }

  async submitDream(input: DreamTaskInput, trigger: 'manual' | 'scheduled' = 'manual'): Promise<ConsoleRun> {
    if (input.phase && input.preset) throw new Error('Dream phase and preset are mutually exclusive');
    if (input.phase && input.phase !== 'all' && !(ALL_PHASES as readonly string[]).includes(input.phase)) throw new Error(`Unsupported dream phase: ${input.phase}`);
    if (input.allSources && (input.sourceId || input.preset !== 'quick')) throw new Error('Dream allSources requires quick preset without sourceId');
    if (input.drainProposals && input.phase !== 'propose_takes') throw new Error('Dream proposal draining requires standalone propose_takes');
    for (const value of [input.maxPages, input.windowSeconds, input.timeoutMs]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('任务页数、窗口和超时必须为正数');
    }
    if (input.preset !== 'quick') {
      if (input.phase && input.phase !== 'all') assertPhasesAllowGenerative([input.phase]);
      else assertDreamPresetAllowGenerative(input.preset ?? 'full');
    }
    if (input.preset === 'quick' && !input.dryRun) {
      const sourceId = input.sourceId ? await resolveSourceId(this.engine, input.sourceId) : undefined;
      return this.engine.transaction(async tx => {
        await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtext('pmbrain_quick_submit'))`);
        const existing = await tx.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs WHERE queue = $1 AND name = $2
          AND data->'task'->'input'->>'preset' = 'quick' AND data->'task'->'input'->>'dryRun' IS DISTINCT FROM 'true'
          AND status IN ('waiting','active','waiting-children','delayed') AND ($3::boolean OR data->'task'->'input'->>'allSources' = 'true'
            OR COALESCE(data->'task'->'input'->>'sourceId', 'default') = $4) LIMIT 1`, [PRODUCT_TASK_QUEUE, TASK_NAME, input.allSources === true, sourceId ?? 'default']);
        if (existing.length) return toRun((await new MinionQueue(tx).getJob(existing[0].id))!);
        const scoped = Object.create(tx) as BrainEngine;
        scoped.transaction = async fn => fn(tx);
        return this.submit({ type: 'dream', input: { ...input, sourceId } }, 'dream_quick', undefined, trigger, new MinionQueue(scoped));
      });
    }
    return this.submit({ type: 'dream', input }, `dream_${input.preset ?? (input.phase && input.phase !== 'all' ? input.phase : 'cycle')}`, undefined, trigger);
  }

  async submitEmbed(input: { catchUp?: boolean; forceReembed?: boolean } = {}): Promise<ConsoleRun> {
    return this.submit({ type: 'embed', input }, 'embed_stale');
  }

  async submitSync(): Promise<ConsoleRun> {
    return this.submit({ type: 'sync', input: {} }, 'sync_all');
  }

  async files(id: string, after = 0): Promise<import('../../../shared/task-progress.ts').SyncFileDetails | null> {
    if (!/^task-\d+$/.test(id) || !Number.isSafeInteger(after) || after < 0) return null;
    const projected=this.fileProjection.details(Number(id.slice(5)),after);
    if (projected) return projected;
    if (this.executions.size || this.recoveringOwner) return null;
    const parent = await this.queue.getJob(Number(id.slice(5)));
    if (parent?.queue !== PRODUCT_TASK_QUEUE || parent.name !== TASK_NAME) return null;
    await this.hydrateFiles([parent.id]);
    return this.fileProjection.details(parent.id,after);
  }

  async listRuns(): Promise<ConsoleRun[]> {
    if (this.executions.size) {
      if (!this.refreshingRuns) {
        this.refreshingRuns = withDatabasePriority(3, () => this.queue.getJobs({ queue: PRODUCT_TASK_QUEUE, name: TASK_NAME, limit: 100 }))
          .then(jobs => { this.cached = jobs.map(job => toRun(job)); })
          .catch(error => console.error('[tasks] history read failed:', error instanceof Error ? error.message : error))
          .finally(() => { this.refreshingRuns = null; });
      }
      return this.cachedRuns();
    }
    this.cached = (await this.queue.getJobs({ queue: PRODUCT_TASK_QUEUE, name: TASK_NAME, limit: 100 }))
      .map(job => toRun(job, job.status === 'cancelled' && this.executions.has(job.id)));
    return this.cached;
  }

  cachedRuns(): ConsoleRun[] {
    const live = [...this.executions.values()].map(execution => execution.run()).filter(run => run.kind !== 'sync_file');
    live.push(...[...this.sessionViews.values()].filter(run => !live.some(row => row.id === run.id)
      && (this.stoppingSessions.has(Number(run.id.slice(5))) || !this.cached.some(row=>row.id===run.id && ['completed','cancelled'].includes(row.status)))));
    for (const run of live) {
      const saved = this.cached.find(item=>item.id===run.id)?.product;
      if(run.product && saved) {run.product.relations=saved.relations;run.product.gitResults=saved.gitResults;}
    }
    for (const run of live) if (run.product && run.kind === 'dream_quick') run.product.activeFiles = this.fileProjection.active(Number(run.id.slice(5)));
    return [...live, ...this.cached.filter(row => !live.some(run => run.id === row.id))]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100);
  }

  async getRun(id: string): Promise<ConsoleRun | null> {
    if (!/^task-\d+$/.test(id)) return null;
    const execution = this.executions.get(Number(id.slice(5)));
    if (execution) {
      const live = execution.run(), saved = await this.queue.getJob(Number(id.slice(5)));
      if (saved && live.product) { const fresh = toRun(saved).product!; live.product.relations=fresh.relations; live.product.gitResults=fresh.gitResults; }
      return live;
    }
    const session = this.sessionViews.get(Number(id.slice(5)));
    if (session && (this.stoppingSessions.has(Number(id.slice(5))) || session.status==='failed'
      || (['running','queued'].includes(session.status) && [...this.fileSessions.values()].includes(Number(id.slice(5)))))) {
      if(session.product)session.product.activeFiles=this.fileProjection.active(Number(id.slice(5)));
      return session;
    }
    const job = await this.queue.getJob(Number(id.slice(5)));
    if (job?.queue !== PRODUCT_TASK_QUEUE || job.name !== TASK_NAME) return null;
    const run = toRun(job, job.status === 'cancelled' && this.executions.has(job.id));
    if(!['running','queued'].includes(run.status))this.sessionViews.delete(job.id);
    this.cached = [run, ...this.cached.filter(row => row.id !== run.id)].slice(0, 100);
    return run;
  }

  async cancel(id: string): Promise<ConsoleRun | null> {
    const run = await this.getRun(id);
    if (!run || !['running', 'queued'].includes(run.status)) return run;
    const jobId = Number(id.slice(5));
    if (run.kind === 'dream_quick') {
      if (!this.stoppingSessions.has(jobId)) {
        this.sessionViews.set(jobId, { ...run, status: 'running', error: '正在停止任务…' });
        this.stopIntents.add(jobId);
        const pending = this.stopSession(jobId).catch(error=>{
          this.sessionViews.set(jobId,{...run,status:'failed',error:error instanceof Error?error.message:String(error),product:run.product?{...run.product,errorReason:error instanceof Error?error.message:String(error)}:undefined});
          throw error;
        }).finally(() => { this.stoppingSessions.delete(jobId); });
        this.stoppingSessions.set(jobId, pending);
      }
      await this.stoppingSessions.get(jobId);
      return this.getRun(id);
    }
    const execution = this.executions.get(jobId);
    this.stopIntents.add(jobId);
    execution?.cancel();
    await withDatabasePriority(0, () => this.queue.cancelJob(jobId));
    await execution?.done;
    const started=this.executions.get(jobId);
    started?.cancel();
    await started?.done;
    return this.getRun(id);
  }

  async requestCancel(id: string): Promise<ConsoleRun | null> {
    const execution = /^task-\d+$/.test(id) ? this.executions.get(Number(id.slice(5))) : undefined;
    const view = execution?.run() ?? await this.getRun(id);
    if (view?.kind === 'dream_quick' && ['running','queued'].includes(view.status)) {
      void this.cancel(id).catch(error => console.error('[tasks] stop sync:', error));
      return { ...view, status: 'running', error: '正在停止任务…' };
    }
    if (!execution) return this.cancel(id);
    execution.cancel();
    void withDatabasePriority(0, () => this.queue.cancelJob(Number(id.slice(5))))
      .catch(error => console.error('[tasks] cancel failed:', error instanceof Error ? error.message : error));
    return execution.run();
  }

  async retry(id: string): Promise<ConsoleRun | null> {
    if(this.failure)throw this.failure;
    if(this.paused)throw new Error('后台执行器已暂停，请恢复服务后继续任务');
    await this.resources.assertImportDisk();
    await this.fileProjection.recover();
    const run = await this.getRun(id);
    if (!run) return null;
    if (!['failed', 'cancelled'].includes(run.status) && !(run.kind === 'dream_quick' && (run.result as Record<string, unknown> | undefined)?.status === 'partial')) throw new Error('只有失败、中断或已取消的任务可以重新执行');
    const record = await this.queue.getJob(Number(id.slice(5)));
    const task = record!.data.task as ProductTask;
    if (task.type === 'dream' && task.input.preset === 'quick' && !task.input.dryRun) {
      const jobId = Number(id.slice(5));
      await this.stoppingSessions.get(jobId);
      await this.executions.get(jobId)?.done;
      await Promise.allSettled([...this.fileSessions].filter(([, owner]) => owner === jobId).map(([child]) => this.executions.get(child)?.done));
      await this.reconcileMaintenanceChildren(jobId);
      const checkpoint = task.input.checkpoint;
      delete record!.data.resourceStopReason;
      await this.engine.executeRaw(`UPDATE minion_jobs SET data=(data-'resourceStopReason') || ($2::jsonb - 'relations' - 'gitFiles' - 'gitResults') WHERE id=$1`,[jobId,record!.data]);
      if (checkpoint) {
        resumeMaintenanceCheckpoint(checkpoint,run.status==='completed' || maintenanceFailure(run.result)!==null);
        await this.engine.executeRaw(`UPDATE minion_jobs SET data = data || ($2::jsonb - 'relations' - 'gitFiles' - 'gitResults') WHERE id = $1`, [jobId, { ...record!.data, task }]);
      }
      await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'paused', result = NULL WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 AND result->>'status' IN ('failed','error','partial')`, [SYNC_FILE_QUEUE, jobId]);
      this.sessionViews.delete(jobId);
      this.stopIntents.delete(jobId);
      await unlink(taskArtifactPath(jobId,'stop.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await this.fileQueue.resume(jobId);
      return this.getRun(id);
    }
    if (task.type === 'import') {
      return this.submitImport({ ...task.input, resumeCheckpointId: Number(id.slice(5)) });
    }
    if (task.type === 'dream') return this.submitDream(task.input);
    if (task.type === 'sync') return this.submitSync();
    if (task.type === 'embed') return this.submitEmbed(task.input);
    throw new Error('文件任务请通过快速维护继续');
  }

  private async execute(context: MinionJobContext): Promise<unknown> {
    this.checkMemory();
    if(this.failure)throw this.failure;
    if (this.stopped || this.paused) throw new Error('后台任务执行器已停止，任务未开始，请稍后重试');
    context.signal.throwIfAborted();
    context.shutdownSignal.throwIfAborted();
    const record = await this.queue.getJob(context.id);
    if (!record?.lock_token) throw new Error('任务执行租约无效');
    const structuredTask = record.data.task as ProductTask;
    if (structuredTask.type === 'dream' && !structuredTask.input.dryRun) {
      const earlier = await this.engine.executeRaw(`SELECT id FROM minion_jobs WHERE queue=$1 AND id<$2
        AND data->'task'->>'type'='dream' AND data->'task'->'input'->>'dryRun' IS DISTINCT FROM 'true'
        AND status IN ('waiting','active','waiting-children','delayed') LIMIT 1`, [PRODUCT_TASK_QUEUE, context.id]);
      if (earlier.length) return this.deferMaintenance(record);
    }
    if(record.data.resourceStopReason && structuredTask.type==='dream' && structuredTask.input.preset==='quick'){
      const paused=await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused',lock_token=NULL,lock_until=NULL,error_text=$2,
        data=jsonb_set(data,'{resumeOnRestart}','false'::jsonb),updated_at=now() WHERE id=$1 AND status='active' AND lock_token=$3 RETURNING id`,[context.id,String(record.data.resourceStopReason),record.lock_token]);
      if(paused.length)this.sessionViews.delete(context.id);
      return MINION_DEFERRED;
    }
    if (this.stopIntents.has(context.id) || (structuredTask.type==='sync-file' && this.stopIntents.has(Number(record.data.sessionId)))) throw new Error('任务已停止');
    if (structuredTask.type==='sync-file') this.fileProjection.record(record);
    if (structuredTask.type === 'dream' && structuredTask.input.preset === 'quick' && record.attempts_started > 1) {
      const counts = await this.fileQueue.counts(context.id);
      if (counts.total > 0) record.progress = { ...(record.progress as Progress ?? {}), product: { ...toRun(record).product!, syncFiles: counts } };
    }
    if (record.attempts_started > 1 && structuredTask.type !== 'sync-file' && !(structuredTask.type === 'dream' && structuredTask.input.preset === 'quick' && !structuredTask.input.dryRun)) throw new Error('任务执行曾中断，结果不确定，请查看已完成内容后手动继续');
    let progress = (record.progress ?? {}) as Progress;
    const adapter = new TaskProgressAdapter(String(record.data.kind), toRun(record).product);
    let activity:import('../../../shared/task-progress.ts').SyncFileActivity|undefined=structuredTask.type==='sync-file'?{
      id:context.id,sourceId:structuredTask.input.options.sourceId??'default',path:structuredTask.input.relativePath,
      bytes:structuredTask.input.originalSize??0,stage:'读取资料',noEmbed:structuredTask.input.options.noEmbed,updatedAt:new Date().toISOString(),
    }:undefined;
    const updateActivity=(patch:Partial<import('../../../shared/task-progress.ts').SyncFileActivity>)=>{
      if(!activity)return;
      activity={...activity,...patch,updatedAt:new Date().toISOString()};
      adapter.view.activeFiles=[activity];adapter.view.file=activity.path;adapter.view.stage=activity.stage;
      this.fileProjection.activity(Number(record.data.sessionId),context.id,activity);
    };
    updateActivity({});
    let progressTail = Promise.resolve();
    let persisting = false;
    let progressVersion = 0;
    const persist = () => {
      progress.product = adapter.view;
      progressVersion++;
      if (!persisting) {
        persisting = true;
        progressTail = (async () => {
          let saved = 0;
          while (saved < progressVersion) {
            const version = progressVersion;
            await context.updateProgress(structuredClone(progress));
            saved = version;
          }
        })().finally(() => { persisting = false; });
      }
      return progressTail;
    };
    const host = new TaskEngineHost(this.engine, context.id, record.lock_token, async file => {
      await appendTaskCheckpoint(context.id, file);
      progress.files = [...(progress.files ?? []), file].slice(-100);
      await persist();
    }, structuredTask.type === 'sync-file', structuredTask.type === 'sync-file' ? structuredTask.input : undefined,this.resources,
    structuredTask.type === 'sync-file' ? Number(record.data.sessionId) : context.id);
    const workerPath = /\/(?:~BUN|\$bunfs)\//.test(decodeURIComponent(import.meta.url))
      ? './product/tasks/task-worker.ts'
      : new URL(import.meta.url.endsWith('.ts') ? './task-worker.ts' : './task-worker.js', import.meta.url);
    if(structuredTask.type!=='sync-file')await this.releaseIdleThreads(this.idleFileThreads);
    if(this.localPressure||this.externalPressure)await this.reclaimIdleThreads();
    const reusableThreads=structuredTask.type==='sync-file'?this.idleFileThreads
      :structuredTask.type==='dream'?this.idleMaintenanceThreads:undefined;
    const thread = reusableThreads?.pop() ?? new Worker(workerPath, { env: { ...process.env } });
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    thread.once('exit', stop);
    let settleResolve!: (value: unknown) => void;
    let settleReject!: (error: Error) => void;
    const result = new Promise<unknown>((resolve, reject) => { settleResolve = resolve; settleReject = reject; });
    let cancelRequested = false;
    const gitController = new AbortController();
    const gitOperations = new Set<Promise<unknown>>();
    let completed = false;
    let deferred = false;
    let flush: ReturnType<typeof setInterval> | undefined;
    const cancel = (reason?:string) => {
      if (cancelRequested) return;
      cancelRequested = true;
      gitController.abort();
      host.cancel();
      thread.postMessage({ type: 'cancel',reason:reason??'user_stop: 任务已取消' });
      settleReject(new Error(reason??'任务已取消'));
    };
    const finished = (async () => {
      try { return await result; }
      finally {
        clearInterval(flush);
        thread.removeAllListeners('message');
        try { await host.close(); }
        finally {
          await Promise.allSettled([...gitOperations]);
          try {
            if (reusableThreads && reusableThreads.length<1 && (completed || deferred) && !cancelRequested && !this.stopped && !this.paused && !this.localPressure && !this.externalPressure) {
              thread.removeAllListeners('error');
              thread.removeAllListeners('exit');
              reusableThreads.push(thread);
              this.scheduleIdleRelease();
            } else {
              await thread.terminate();
              await stopped;
            }
            await progressTail;
            const task = record.data.task as ProductTask;
            if (task.type === 'import' && task.input.stagingDir && completed) {
              await removeAdminUploadTempDir(task.input.stagingDir);
            }
          } finally { this.executions.delete(context.id); }
        }
      }
    })();
    this.executions.set(context.id, { cancel, done: finished.catch(() => {}), ownsLockedTransaction: () => host.ownsLockedTransaction(), adjust:constrained=>thread.postMessage({type:'resource-pressure',constrained}), run: () => {
      progress.product = adapter.view;
      const run=toRun({ ...record, progress }, cancelRequested);
      if (run.product && structuredTask.type==='dream' && structuredTask.input.preset==='quick') run.product.activeFiles=this.fileProjection.active(context.id);
      return run;
    } });
    const cancelFromSignal=()=>cancel(context.shutdownSignal.aborted?'service_shutdown: 本地服务关闭':context.signal.reason instanceof Error?context.signal.reason.message:undefined);
    context.signal.addEventListener('abort', cancelFromSignal, { once: true });
    context.shutdownSignal.addEventListener('abort', cancelFromSignal, { once: true });
    if (context.signal.aborted || context.shutdownSignal.aborted || this.stopIntents.has(context.id)) cancel();
    thread.once('error', error => settleReject(error instanceof Error ? error : new Error(String(error))));
    thread.once('exit', code => settleReject(new Error(`任务 Worker 意外退出（${code}）`)));
    thread.on('message', (message: TaskWorkerMessage) => {
      if (message.type === 'rpc') {
        updateActivity({operation:message.method,operationStartedAt:new Date().toISOString()});
        const dispatch = async () => {
          if(cancelRequested) throw new Error('任务已取消');
          if (message.method === 'task.syncFileHash') return this.fileQueue.sourceHash(message.args[0] as SyncFileInput);
          if (message.method === 'task.captureRequest') {
            const slugs = await claimMaintenanceCapture(this.engine, context.id, record.lock_token!, String(message.args[0]));
            if (slugs && structuredTask.type === 'dream') {
              const checkpoint = structuredTask.input.checkpoint ?? { phases: {}, reports: {} };
              checkpoint.captureRequests = { ...checkpoint.captureRequests, [String(message.args[0])]: slugs };
              structuredTask.input.checkpoint = checkpoint;
            }
            return slugs;
          }
          if (message.method === 'task.syncFile') {
            const file = message.args[0] as SyncFileInput;
            const result = await this.fileQueue.enqueue(context.id, record.lock_token!, file);
            if (!result.deferred && ['imported', 'skipped'].includes(result.status)) await recordSyncedGitFile(this.engine, context.id,
              file.options.sourceId ?? 'default', { path: file.relativePath, hash: file.hash });
            return result;
          }
          if (message.method === 'task.gitCommit') {
            if (structuredTask.type !== 'dream' || structuredTask.input.preset !== 'quick' || structuredTask.input.dryRun) throw new Error('无效的自动 Git 提交任务');
            adapter.view.stage = '保存本地版本'; await persist();
            const sourceId = String(message.args[0]), root = String(message.args[1]);
            const operation = commitQuickMaintenanceSource(this.engine, context.id, sourceId, root, message.args[2] as SyncResult, {
              signal: gitController.signal,
              beforeCommit: async () => {
                const valid = await this.engine.executeRaw(`SELECT j.id FROM minion_jobs j JOIN sources s ON s.id=$3
                  WHERE j.id=$1 AND j.status='active' AND j.lock_token=$2 AND s.local_path=$4 AND NOT s.archived`,
                [context.id, record.lock_token, sourceId, root]);
                if (!valid.length) throw new Error('任务租约或 Source 路径已改变，未提交 Git');
              },
            });
            gitOperations.add(operation);
            try { return await operation; } finally { gitOperations.delete(operation); }
          }
          if (message.method === 'task.maintenanceCheckpoint') {
            if (structuredTask.type !== 'dream') throw new Error('无效的维护检查点');
            structuredTask.input.checkpoint = message.args[0] as MaintenanceCheckpoint;
            const rows = await this.engine.executeRaw(`UPDATE minion_jobs SET data = data || ($3::jsonb - 'relations' - 'gitFiles' - 'gitResults'), updated_at = now() WHERE id = $1 AND status = 'active' AND lock_token = $2 RETURNING id`, [context.id, record.lock_token, record.data]);
            if (!rows.length) throw new Error('维护任务已停止或租约失效');
            return null;
          }
          return host.dispatch(message);
        };
        void withDatabasePriority(['import','sync-file'].includes(structuredTask.type) ? 2 : 3, dispatch).then(value => {
          if(activity?.operation===message.method)updateActivity({operation:undefined,operationStartedAt:undefined});
          if (!cancelRequested) thread.postMessage({ type: 'reply', id: message.id, value });
        }, error => {
          if(activity?.operation===message.method)updateActivity({operation:undefined,operationStartedAt:undefined});
          if (!cancelRequested) thread.postMessage({ type: 'reply', id: message.id, error: error instanceof Error ? error.message : String(error) });
        });
      } else if (message.type === 'log') {
        adapter.write(message.text);
        progress.output = `${progress.output ?? ''}${message.text}`.slice(-100_000);
      } else if (message.type === 'progress') {
        if (message.phases) adapter.plan(message.phases);
        if (message.scope) adapter.scope(message.scope);
        if (message.event) { adapter.event(message.event); host.setRelationPhase(message.event.phase); }
        if (message.syncScan) adapter.scan(message.syncScan);
        if (message.page && adapter.view.material) adapter.view.material.page = message.page;
        if(message.event)updateActivity({stage:({'import.process':'解析与切分','import.vector':'生成向量','import.write':'写入知识库'} as Record<string,string>)[message.event.phase]??activity?.stage});
        if(message.largeDocument){
          const large=message.largeDocument;
          updateActivity({stage:({parsed:'解析完成',chunked:'切分完成',writing:'写入正文分块',embedding:'生成并写入向量',partial:'向量部分完成',completed:'资料处理完成',failed:'资料处理失败'})[large.phase],
            chunksTotal:large.chunksTotal,bodyWritten:large.bodyWritten,bodyCommitted:large.bodyCommitted,bodyBatchesCompleted:large.bodyBatchesCompleted,bodyBatchesTotal:large.bodyBatchesTotal,generated:large.generated,
            embedded:large.embedded,reused:large.reused,pending:large.pending,batchesCompleted:large.batchesCompleted});
        }
      } else if (message.type === 'result') {
        completed = true;
        progress.result = message.result;
        void persist().then(() => settleResolve(message.result), settleReject);
      } else if (message.type === 'error') {
        progress.result = message.result;
        void persist().then(() => settleReject(new Error(message.error)), settleReject);
      } else if (message.type === 'deferred') {
        deferred = true;
        void persist().then(() => settleResolve(MINION_DEFERRED), settleReject);
      }
    });
    flush = setInterval(() => void persist().catch(settleReject), 1000);
    thread.postMessage({ type: 'start', kind: this.engine.kind, task: record.data.task, ownerJobId: context.id, constrained:this.localPressure||this.externalPressure });
    try {
      const outcome = await finished;
      if (structuredTask.type === 'dream' && outcome !== MINION_DEFERRED && (outcome as { reason?: string })?.reason === 'cycle_already_running') return this.deferMaintenance(record);
      if (outcome === MINION_DEFERRED && !this.stopIntents.has(context.id)) {
        if(adapter.view.syncScan)adapter.view.syncScan.active=false;
        const counts = await this.fileQueue.counts(context.id);
        adapter.view.syncFiles = counts;
        adapter.view.processed = counts.completed + counts.failed;
        adapter.view.total = counts.total;
        adapter.view.stage = '同步资料';
        adapter.view.phasePercent = counts.total ? Math.floor((counts.completed + counts.failed) / counts.total * 1000)/10 : null;
        await persist();
        await this.fileQueue.release(context.id, record.lock_token);
        this.sessionViews.set(context.id, toRun({ ...record, progress, status: counts.remaining > 0 ? 'waiting-children' : 'waiting' }));
        this.scheduleSessionRefresh(context.id);
      } else {
        if (structuredTask.type === 'dream' && structuredTask.input.preset === 'quick' && !this.stopIntents.has(context.id)) {
          const counts=await this.fileQueue.counts(context.id);
          if (counts.total>0) {
            adapter.view.syncFiles=counts;adapter.view.processed=counts.completed+counts.failed;adapter.view.total=counts.total;
            adapter.view.activeFiles=[];await persist();
          }
        }
        if (structuredTask.type === 'dream' && structuredTask.input.preset === 'quick') await this.fileQueue.cleanup(context.id).catch(error => console.error('[tasks] snapshot cleanup:', error));
      }
      return outcome;
    }
    catch(error){
      if(structuredTask.type==='dream'&&structuredTask.input.preset==='quick' && String(error).includes('资源保护：')){
        const message=error instanceof Error?error.message:String(error);
        if(/队列容量|快照容量/.test(message) && !this.stopIntents.has(context.id) && !this.paused){
          const counts=await this.fileQueue.counts(context.id);
          if(counts.remaining>0){
            record.data.resourceStopReason=message;
            const owned=await this.engine.executeRaw(`UPDATE minion_jobs SET data=data || ($2::jsonb - 'relations' - 'gitFiles' - 'gitResults'),error_text=$3 WHERE id=$1 AND status='active' AND lock_token=$4 RETURNING id`,[context.id,record.data,message,record.lock_token]);
            if(!owned.length)return MINION_DEFERRED;
            await this.fileQueue.release(context.id,record.lock_token);
            this.scheduleSessionRefresh(context.id);
            return MINION_DEFERRED;
          }
        }
        await this.fileQueue.pause(context.id);
      }
      throw error;
    }
    finally {
      clearInterval(flush);
      context.signal.removeEventListener('abort', cancelFromSignal);
      context.shutdownSignal.removeEventListener('abort', cancelFromSignal);
    }
  }

  private async deferMaintenance(record: MinionJob): Promise<typeof MINION_DEFERRED> {
    const progress = (record.progress ?? {}) as Progress;
    delete progress.result;
    const view = progress.product ?? new TaskProgressAdapter(String(record.data.kind)).view;
    view.stage = '等待前面的整理任务完成'; view.percent = null; view.errorReason = null;
    progress.product = view;
    await this.engine.executeRaw(`UPDATE minion_jobs SET status='delayed',delay_until=now()+interval '1 second',
      lock_token=NULL,lock_until=NULL,error_text=NULL,result=NULL,progress=$3::jsonb,
      attempts_started=GREATEST(attempts_started-1,0),updated_at=now()
      WHERE id=$1 AND status='active' AND lock_token=$2`, [record.id, record.lock_token, progress]);
    this.sessionViews.delete(record.id);
    return MINION_DEFERRED;
  }

  private checkMemory():number{
    if(this.stopped)return 0;
    const pressure=this.resources.memoryPressure();
    this.localPressure=pressure.level!=='normal';
    this.applyResourcePressure();
    if(pressure.level==='critical')this.stopForResourcePressure(`资源保护：${pressure.reason}，已停止后台任务，普通服务继续运行。`);
    return this.resources.memoryBytes();
  }

  async adjustResourcePressure(constrained:boolean):Promise<void>{
    this.externalPressure=constrained;
    this.applyResourcePressure();
    if(constrained)await this.reclaimIdleThreads();
  }

  private applyResourcePressure():void{
    const constrained=this.localPressure||this.externalPressure;
    this.worker.setConcurrency(constrained?1:2);
    this.fileWorker.setConcurrency(constrained||this.engine.kind==='pglite'?1:2);
    for(const execution of this.executions.values())execution.adjust(constrained);
    if(constrained)void this.reclaimIdleThreads().catch(error=>console.error('[tasks] resource reclaim:',error));
  }

  private async releaseIdleThreads(pool:Worker[]):Promise<void>{
    await Promise.all(pool.splice(0).map(thread=>thread.terminate()));
  }

  private reclaimIdleThreads():Promise<void>{
    if(!this.reclaiming){
      this.reclaiming=Promise.all([this.releaseIdleThreads(this.idleFileThreads),this.releaseIdleThreads(this.idleMaintenanceThreads)])
        .then(()=>{if(typeof Bun!=='undefined')Bun.gc(false);}).finally(()=>{this.reclaiming=null;});
    }
    return this.reclaiming;
  }

  private scheduleIdleRelease():void{
    if(this.idleTimer)clearTimeout(this.idleTimer);
    this.idleTimer=setTimeout(()=>{this.idleTimer=null;void this.reclaimIdleThreads().catch(error=>console.error('[tasks] idle release:',error));},30000);
    this.idleTimer.unref();
  }

  stopForResourcePressure(message:string):void{
    if(!this.resourceDrain&&!this.stopped){
      this.failure=new Error(message);this.paused=true;this.worker.stop();this.fileWorker.stop();
      for(const execution of this.executions.values())execution.cancel(message);
      this.resourceDrain=(async()=>{
        await Promise.all([...this.idleFileThreads.splice(0),...this.idleMaintenanceThreads.splice(0)].map(thread=>thread.terminate()));
        await Promise.allSettled([...this.executions.values()].map(execution=>execution.done));
        await this.loop;await this.fileLoop;
        await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused',lock_token=NULL,lock_until=NULL,
          data=jsonb_set(data,'{resumeOnRestart}','false'::jsonb),error_text=$3,updated_at=now()
          WHERE queue IN ($1,$2) AND status NOT IN ('completed','failed','dead','cancelled')`,[PRODUCT_TASK_QUEUE,SYNC_FILE_QUEUE,message]);
      })().catch(error=>console.error('[tasks] resource stop:',error));
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if(this.resourceTimer)clearInterval(this.resourceTimer);
    if(this.idleTimer)clearTimeout(this.idleTimer);
    await this.reclaiming;
    await this.resourceDrain;
    for (const refresh of this.sessionRefresh.values()) clearTimeout(refresh.timer);
    this.sessionRefresh.clear();
    this.worker.stop();
    this.fileWorker.stop();
    const resume = this.engine.executeRaw(`UPDATE minion_jobs SET data = jsonb_set(data, '{resumeOnRestart}', 'true'::jsonb)
      WHERE queue = $1 AND data->'task'->'input'->>'preset' = 'quick' AND status IN ('active','waiting-children')`, [PRODUCT_TASK_QUEUE]);
    const interrupted = [...this.executions.keys()];
    for (const execution of this.executions.values()) execution.cancel('service_shutdown: 本地服务关闭');
    const drained = Promise.all([resume, Promise.allSettled([...this.executions.values()].map(execution => execution.done))]);
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([drained.then(() => true), new Promise<boolean>(resolve => { closeTimer=setTimeout(()=>resolve(false),3000); })]).finally(()=>clearTimeout(closeTimer));
    if (!closed) {
      if (!(this.engine instanceof WorkerPgliteEngine)) throw new Error('退出尚未完成：数据库操作未响应取消');
      await (this.engine as unknown as WorkerPgliteEngine).interruptAndRecover();
      await drained.catch(()=>{});
      await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused',lock_token=NULL,lock_until=NULL,
        data=jsonb_set(data,'{resumeOnRestart}','false'::jsonb),error_text='退出时数据库操作未响应，已保留提交内容，请手动继续。',updated_at=now()
        WHERE queue IN ($1,$2) AND status IN ('active','waiting-children')`,[PRODUCT_TASK_QUEUE,SYNC_FILE_QUEUE]);
    }
    await this.fileProjection.flush();
    await this.loop;
    await this.fileLoop;
    await Promise.all([...this.idleFileThreads.splice(0),...this.idleMaintenanceThreads.splice(0)].map(thread => thread.terminate()));
    await this.refreshingRuns;
    await Promise.allSettled([...this.executions.values()].map(execution => execution.done));
    if (interrupted.length) {
      await this.engine.executeRaw(
        `UPDATE minion_jobs SET status = 'paused', error_text = '软件退出，任务已中断。请查看已完成内容后手动继续；模型请求可能已产生费用。'
         WHERE id = ANY($1::bigint[]) AND queue = $2 AND status = 'dead'`, [interrupted, PRODUCT_TASK_QUEUE],
      );
    }
  }

  async pauseAndDrain(): Promise<void> {
    this.paused = true;
    this.worker.stop();
    this.fileWorker.stop();
    await Promise.allSettled([...this.executions.values()].map(execution => execution.done));
    await this.loop;
    await this.fileLoop;
    await Promise.all([...this.idleFileThreads.splice(0),...this.idleMaintenanceThreads.splice(0)].map(thread => thread.terminate()));
    await Promise.allSettled([...this.executions.values()].map(execution => execution.done));
    this.loop = null;
  }

  async resume(): Promise<void> {
    if(this.resourceDrain)throw this.failure??new Error('资源保护已停止执行器，请重启服务');
    this.paused = false;
    this.failure = null;
    if (!this.stopped) await this.start();
  }

  private async refreshSession(id: number, file?: string) {
    if(this.stopIntents.has(id)||this.recoveringOwner)return;
    const job = await this.queue.getJob(id);
    if (!job || ['completed','cancelled','dead','failed','paused'].includes(job.status)) { this.sessionViews.delete(id); return; }
    const run = toRun(job);
    const counts = await this.fileQueue.counts(id);
    await this.hydrateFiles([id],true);
    if(this.stopIntents.has(id))return;
    if (run.product && counts.total > 0) {
      run.product.syncFiles = counts;
      run.product.processed = counts.completed + counts.failed;
      run.product.total = counts.total;
      run.product.activeFiles=this.fileProjection.active(id);
      if (job.status === 'waiting-children') {
        run.product.stage = '同步资料';
        run.product.phasePercent = Math.floor((counts.completed + counts.failed) / counts.total * 1000)/10;
        if (file) run.product.file = file;
      }
      job.progress = { ...(job.progress as Record<string, unknown> ?? {}), product: run.product };
      await this.engine.executeRaw(`UPDATE minion_jobs SET progress = $2::jsonb WHERE id = $1 AND status IN ('waiting-children','waiting')`, [id, job.progress]);
    }
    this.sessionViews.set(id, run);
    this.cached = [run, ...this.cached.filter(row => row.id !== run.id)].slice(0, 100);
  }

  private scheduleSessionRefresh(id: number, file?: string) {
    if (this.stopped) return;
    const queued = this.sessionRefresh.get(id);
    if (queued) { if (file) queued.file = file; return; }
    const refresh = { file, timer: setTimeout(() => {
      this.sessionRefresh.delete(id);
      if (!this.stopped) void this.refreshSession(id, refresh.file).catch(error => console.error('[tasks] sync progress:', error));
    }, 500) };
    this.sessionRefresh.set(id, refresh);
  }

  private async stopSession(id: number) {
    this.executions.get(id)?.cancel();
    const files = [...this.fileSessions].filter(([, owner]) => owner === id).map(([child]) => this.executions.get(child)).filter(Boolean);
    for (const execution of files) execution!.cancel();
    const path=taskArtifactPath(id,'stop.json');
    await mkdir(dirname(path),{recursive:true});
    const temporary=path+'.tmp';
    await writeFile(temporary,JSON.stringify({id,requestedAt:new Date().toISOString()}),{mode:0o600});
    await rename(temporary,path);
    const stopping=withDatabasePriority(0, async () => {
      await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'cancelled', lock_token = NULL, lock_until = NULL,
        data = jsonb_set(data, '{resumeOnRestart}', 'false'::jsonb), finished_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('waiting','active','waiting-children','delayed')`, [id]);
      await this.fileQueue.pause(id);
      await Promise.allSettled([this.executions.get(id)?.done, ...files.map(execution => execution!.done)]);
      await this.reconcileMaintenanceChildren(id);
    });
    let timer:ReturnType<typeof setTimeout>|undefined;
    const settled=await Promise.race([stopping.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),3000);})]).finally(()=>clearTimeout(timer));
    if(!settled){
      const view=this.sessionViews.get(id);if(view?.product)view.product.stage='停止当前操作并恢复数据库';
      if(!(this.engine instanceof WorkerPgliteEngine))throw new Error('停止尚未完成：数据库操作未响应取消，请检查数据库连接');
      if(!this.recoveringOwner){
        this.paused=true;this.worker.stop();this.fileWorker.stop();
        for(const execution of this.executions.values())execution.cancel();
        this.recoveringOwner=(async()=>{
          await (this.engine as unknown as WorkerPgliteEngine).interruptAndRecover();
          await Promise.allSettled([...this.executions.values()].map(execution=>execution.done));
          await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused',lock_token=NULL,lock_until=NULL,
            data=jsonb_set(data,'{resumeOnRestart}','false'::jsonb),error_text='数据库执行曾中断，请查看已完成资料后手动继续。',updated_at=now()
            WHERE queue IN ($1,$2) AND status IN ('active','waiting-children')`,[PRODUCT_TASK_QUEUE,SYNC_FILE_QUEUE]);
          await this.loop;await this.fileLoop;
          this.loop=null;this.fileLoop=null;this.failure=null;
          this.sessionViews.clear();
        })();
      }
      try{await this.recoveringOwner;}finally{this.recoveringOwner=null;}
      await stopping.catch(()=>{});
      await this.applyStop(id);
      this.paused=false;
      await this.start();
    }
    await this.hydrateFiles([id]);
    await this.fileProjection.flush();
    this.sessionViews.delete(id);
  }

  private async reconcileMaintenanceChildren(id: number) {
    const queues = await this.engine.executeRaw<{ queue: string }>(`SELECT DISTINCT child.queue FROM minion_jobs child
      JOIN minion_jobs owner ON owner.id=child.private_queue_owner_job_id
      WHERE owner.id=$1 AND owner.status IN ('completed','cancelled','dead','failed','paused')
      AND child.queue LIKE 'dream-inline-%' AND child.status IN ('waiting','active','delayed','waiting-children','paused')`, [id]);
    for (const row of queues) await this.queue.reconcilePrivateQueue(row.queue, 'maintenance stopped before continuation');
  }

  private async applyStop(id:number){
    await this.engine.executeRaw(`UPDATE minion_jobs SET status='cancelled',lock_token=NULL,lock_until=NULL,
      data=jsonb_set(data,'{resumeOnRestart}','false'::jsonb),finished_at=now(),updated_at=now()
      WHERE id=$1 AND queue=$2 AND status NOT IN ('completed','cancelled')`,[id,PRODUCT_TASK_QUEUE]);
    await this.fileQueue.pause(id);
  }

  private async loadStopIntents(){
    const example=taskArtifactPath(1,'stop.json');
    const prefix=basename(example).split('-job-')[0]+'-job-';
    const entries=await readdir(dirname(example)).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    for(const name of entries){
      if(!name.startsWith(prefix)||!name.endsWith('.stop.json'))continue;
      const id=Number(name.slice(prefix.length,-'.stop.json'.length));
      if(Number.isSafeInteger(id)&&id>0){this.stopIntents.add(id);await this.applyStop(id);}
    }
  }

  private async hydrateFiles(ids:number[],dirtyOnly=false){
    for(const id of ids){
      const selected=dirtyOnly?[...(this.dirtyFiles.get(id)??[])]:null;
      if(selected?.length===0)continue;
      let after=0;
      for(;;){
        const rows=await this.engine.executeRaw<import('../../../shared/task-progress.ts').SyncFileDetails['rows'][number]>(
          `SELECT id, data->'task'->'input'->'options'->>'sourceId' AS "sourceId",data->'task'->'input'->>'relativePath' AS path,
           CASE WHEN result->>'status' IN ('failed','partial','error') OR status IN ('dead','failed') THEN 'failed'
             WHEN status='completed' THEN 'completed' WHEN status='active' THEN 'running' ELSE 'pending' END AS status,
           COALESCE(result->>'error',error_text) AS error,progress->'product'->'activeFiles'->0 AS activity
           FROM minion_jobs WHERE queue=$1 AND (data->>'sessionId')::bigint=$2 AND id>$3
             AND data->>'superseded' IS DISTINCT FROM 'true' AND ($4::bigint[] IS NULL OR id=ANY($4::bigint[])) ORDER BY id LIMIT 200`,[SYNC_FILE_QUEUE,id,after,selected]);
          this.fileProjection.seed(id,rows);
          await this.fileProjection.flush();
        for(const row of rows)if(row.status!=='running')this.dirtyFiles.get(id)?.delete(row.id);
        if(rows.length<200)break;
        after=rows.at(-1)!.id;
      }
    }
  }

  private async recoverSessions() {
    const rows = await this.engine.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs AS parent WHERE queue = $1
      AND data->'task'->'input'->>'preset' = 'quick' AND (status IN ('active','waiting-children')
        OR (status = 'paused' AND data->>'resumeOnRestart' = 'true'))
      AND ($2::boolean OR ((parent.lock_until IS NULL OR parent.lock_until <= now()) AND NOT EXISTS (
        SELECT 1 FROM minion_jobs child WHERE (child.data->>'sessionId')::bigint = parent.id
        AND child.status = 'active' AND child.lock_until > now())))`, [PRODUCT_TASK_QUEUE, this.engine.kind === 'pglite']);
    for (const { id } of rows) {
      await this.engine.executeRaw(`UPDATE minion_jobs SET stalled_counter=stalled_counter+1
        WHERE queue=$1 AND parent_job_id=$2 AND status='active' AND lock_until<=now()`,[SYNC_FILE_QUEUE,id]);
      const uncertain = await this.engine.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs WHERE queue = $1
        AND (data->>'sessionId')::bigint = $2 AND status NOT IN ('completed','waiting','delayed')
        AND COALESCE((data->'task'->'input'->>'modelMayRun')::boolean, data->'task'->'input'->'options'->>'documentOcr' = 'true')
        AND attempts_started > 0 AND NOT EXISTS (SELECT 1 FROM pages WHERE slug = result->>'slug'
          AND source_id = data->'task'->'input'->'options'->>'sourceId' AND deleted_at IS NULL AND content_hash = result->>'pageHash') LIMIT 1`, [SYNC_FILE_QUEUE, id]);
      if (uncertain.length) {
        await this.fileQueue.pause(id);
        await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'paused', lock_token = NULL, lock_until = NULL,
          data = jsonb_set(data, '{resumeOnRestart}', 'false'::jsonb), error_text = '模型处理曾中断，结果及费用不确定，请查看已完成资料后继续。' WHERE id = $1`, [id]);
      } else {
        const parent = await this.queue.getJob(id);
        const task = parent?.data.task as ProductTask;
        const synced = task.type === 'dream' && Object.values(task.input.checkpoint?.phases ?? {}).some(phases => phases.some(phase => phase.phase === 'sync'));
        if (synced && parent?.status === 'active') {
          await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'paused', lock_token = NULL, lock_until = NULL,
            data = jsonb_set(data, '{resumeOnRestart}', 'false'::jsonb), error_text = '后续知识增强阶段曾中断，请查看已完成资料后继续。' WHERE id = $1`, [id]);
        } else {
          await this.fileQueue.pause(id);
          await this.fileQueue.resume(id);
        }
      }
    }
  }
}
