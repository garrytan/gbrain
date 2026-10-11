import type { BrainEngine } from '../../core/engine.ts';
import type { ProductTask, TaskWorkerMessage, MaintenanceCheckpoint } from './types.ts';
import { loadConfig } from '../../core/config.ts';
import { reloadLiveGateway } from '../../core/ai/reload-live-gateway.ts';
import { DEFAULT_CLI_OPTIONS, setCliOptions } from '../../core/cli-options.ts';
import { runStructuredImport, importSyncFile } from '../../commands/import.ts';
import { runCycle, type CyclePhase } from '../../core/cycle.ts';
import { resolveDreamPresetPhases, resolveDreamRelationOptions, resolveBrainDir } from '../../commands/dream.ts';
import { runQuickMaintenance, combineQuickMaintenanceReports, resolveQuickMaintenancePhases } from '../../core/quick-maintenance.ts';
import { ALL_PHASES } from '../../core/cycle.ts';
import { chooseCaptureModel, configuredCnyPrices, storedPrice } from '../../core/cycle/capture-entities.ts';
import { DEFAULT_ENTITY_CAPTURE_MAX_INPUT_TOKENS, DEFAULT_ENTITY_CAPTURE_MAX_OUTPUT_TOKENS, readEntityCaptureCostCap, readTokenCap } from '../../core/cycle/entity-capture-budget.ts';
import { splitProviderModelId } from '../../core/model-id.ts';
import { maintenanceFailure } from './maintenance-orchestration.ts';
import { fetchSource, loadAllSources, parseSourceConfig } from '../../core/sources-load.ts';
import { resolveSourceId } from '../../core/source-resolver.ts';
import { runEmbedCore } from '../../commands/embed.ts';
import { parentPort } from 'node:worker_threads';
import { format } from 'node:util';
import { stat } from 'node:fs/promises';
import { setImmediate as yieldExecution } from 'node:timers/promises';
import { streamFileHash, assertImportFileSize } from './resource-guard.ts';
import { relative, isAbsolute, join } from 'node:path';
import { SyncFilesDeferred, type SyncFileRuntime } from '../../core/sync-file-runtime.ts';
import { classifyErrorCode, isInfrastructureFailureCode } from '../../core/sync-failure-ledger.ts';
import { performSync } from '../../commands/sync.ts';
import { readTaskCheckpoint, taskModelFingerprint, syncFileContentFingerprint } from './checkpoint.ts';
import { isGinRepairAbortText } from '../../core/pglite-gin-repair.ts';
import type { SyncStrategy } from '../../core/sync.ts';
import { isOfficeFilePath } from '../../core/sync.ts';
import { isImageFilePath } from '../../core/import-file.ts';

let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let abort = new AbortController();
let ownerJobId: number | null = null;
const send = (message: TaskWorkerMessage) => parentPort!.postMessage(message);
let importFile: string | undefined;
let constrained=false;
const originalFetch = globalThis.fetch;
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  const target = args[0] instanceof Request ? args[0].url : String(args[0]);
  if (importFile && /\/embeddings(?:\?|$)|:embedContent|:batchEmbedContents|\/api\/embed(?:\?|$)/.test(target)) send({ type: 'progress', event: { phase: 'import.vector', file: importFile } });
  const requestSignal=args[1]?.signal??(args[0] instanceof Request?args[0].signal:undefined);
  return originalFetch(args[0],{...args[1],signal:AbortSignal.any([abort.signal,...(requestSignal?[requestSignal]:[])])});
}) as typeof fetch;

function rpcValue(value: unknown): unknown {
  if (value instanceof AbortSignal || typeof value === 'function') return undefined;
  if (Array.isArray(value)) return value.map(rpcValue);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rpcValue(child)]));
  }
  return value;
}

function rpc(method: string, args: unknown[], scope?: number): Promise<unknown> {
  abort.signal.throwIfAborted();
  const id = ++sequence;
  if (importFile && ['putPage', 'upsertChunks', 'updateChunkEmbedding', 'setPageAliases'].includes(method)) {
    send({ type: 'progress', event: { phase: 'import.write', file: importFile } });
    if (method === 'putPage') {
      const page = args[1] as { title: string; type: string };
      send({ type: 'progress', page: { slug: String(args[0]), title: page.title, type: page.type } });
    }
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'rpc', id, method, args: args.map(rpcValue), scope });
  });
}

function proxyEngine(kind: BrainEngine['kind'], scope?: number): BrainEngine {
  return new Proxy({ kind }, {
    get(target, property) {
      if (property === 'kind') return target.kind;
      if (['then', '_db', '_sql'].includes(String(property))) return undefined;
      if (property === 'db') return {
        query: async (sql: string, args: unknown[] = []) => ({ rows: await rpc('executeRaw', [sql, args], scope) }),
      };
      if (property === 'sql') return (parts: TemplateStringsArray, ...args: unknown[]) => {
        const sql = parts.reduce((text, part, index) => `${text}${index ? `$${index}` : ''}${part}`, '');
        return rpc('executeRaw', [sql, args], scope);
      };
      if (property === 'transaction' || property === 'withReservedConnection') {
        return async (fn: (engine: BrainEngine) => Promise<unknown>) => {
          const child = await rpc(`${String(property)}.open`, [], scope) as number;
          try {
            const result = await fn(proxyEngine(kind, child));
            await rpc('scope.close', [true], child);
            return result;
          } catch (error) {
            if (!abort.signal.aborted) await rpc('scope.close', [false], child).catch(() => {});
            throw error;
          }
        };
      }
      return (...args: unknown[]) => rpc(String(property), args, scope);
    },
  }) as BrainEngine;
}

const writeLog = (chunk: unknown) => {
  const text=String(chunk);
  for(const line of text.split('\n')){
    if(line.startsWith('[pmbrain large-document] ')){
      try{send({type:'progress',largeDocument:JSON.parse(line.slice('[pmbrain large-document] '.length))});}catch{}
    }
  }
  send({ type: 'log', text });
  return true;
};
process.stdout.write = writeLog as typeof process.stdout.write;
process.stderr.write = writeLog as typeof process.stderr.write;
for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
  console[method] = (...args: unknown[]) => { writeLog(`${format(...args)}\n`); };
}
setCliOptions({ ...DEFAULT_CLI_OPTIONS, progressJson: true });

async function runDreamTask(engine: BrainEngine, input: Extract<ProductTask, { type: 'dream' }>['input']) {
  const checkpoint: MaintenanceCheckpoint = input.checkpoint ?? { phases: {}, reports: {} };
  const captureModel = input.preset === 'quick' && !input.dryRun ? await chooseCaptureModel(engine, {}) : null;
  let pendingFiles = false;
  let scanned = 0;
  let unchanged = 0;
  const roots = new Map<string, string>();
  const fileRuntime: SyncFileRuntime | undefined = input.preset === 'quick' && !input.dryRun ? {
    signal: abort.signal,
    importFile: async (path, relativePath, options) => {
      abort.signal.throwIfAborted();
      const sourceId = options.sourceId ?? 'default';
      if (!roots.has(sourceId)) roots.set(sourceId, (await fetchSource(engine, sourceId))?.local_path ?? '');
      const sourceRoot = roots.get(sourceId)!;
      const local = sourceRoot ? relative(sourceRoot, path) : '..';
      const originalPath = local.startsWith('..') || isAbsolute(local) ? undefined : path;
      const snapshot = await stat(path);
      let oversized=false;
      try{assertImportFileSize(relativePath,snapshot.size);}catch{oversized=true;}
      send({type:'progress',syncScan:{scanned,unchanged,path:relativePath,bytes:snapshot.size,updatedAt:new Date().toISOString(),active:true}});
      const knownHash=await rpc('task.syncFileHash',[{sourceRoot,relativePath,options,originalSize:snapshot.size,originalMtime:snapshot.mtimeMs}]) as string|null;
      const hash = oversized?`oversize:${snapshot.size}:${snapshot.mtimeMs}`:knownHash??await streamFileHash(path,abort.signal);
      const result = await rpc('task.syncFile', [{ path, relativePath, sourceRoot, originalPath,
        originalSize: snapshot.size, originalMtime: snapshot.mtimeMs, hash,
        modelFingerprint: taskModelFingerprint(),
        modelMayRun: options.documentOcr === true && (isOfficeFilePath(relativePath) || isImageFilePath(relativePath)),
        fingerprint: syncFileContentFingerprint(options), options,
      }]) as import('../../core/import-file.ts').ImportResult & { deferred?: boolean; unchanged?: boolean };
      if (result.deferred) pendingFiles = true;
      scanned++;
      if (result.unchanged) unchanged++;
      send({ type: 'progress', syncScan: { scanned, unchanged,path:relativePath,bytes:snapshot.size,updatedAt:new Date().toISOString(),active:true } });
      return result;
    },
    finish: async () => { if (pendingFiles) throw new SyncFilesDeferred(); },
  } : undefined;
  const resumeOptions = async (sourceId: string) => {
    let captureEntitySlugs: string[] | undefined;
    let captureEntityBudget: import('../../core/cycle/capture-entities.ts').CaptureEntitiesOpts['budget'];
    if (captureModel?.ok) {
      captureEntitySlugs = await rpc('task.captureRequest', [sourceId]) as string[] | undefined;
      if (captureEntitySlugs?.length) {
        checkpoint.captureRequests = { ...checkpoint.captureRequests, [sourceId]: captureEntitySlugs };
        const [usage] = await engine.executeRaw<{ input: string; output: string }>(`SELECT COALESCE(sum(tokens_input),0) AS input,COALESCE(sum(tokens_output),0) AS output FROM minion_jobs WHERE private_queue_owner_job_id=$1`, [ownerJobId]);
        const inputTokens = Number(usage?.input ?? 0), outputTokens = Number(usage?.output ?? 0);
        const cardPrices = configuredCnyPrices(captureModel.model, splitProviderModelId(captureModel.model).provider);
        const inputPrice = storedPrice(await engine.getConfig('dream.entity_capture.price.input_cny_per_million')) ?? cardPrices.input;
        const outputPrice = storedPrice(await engine.getConfig('dream.entity_capture.price.output_cny_per_million')) ?? cardPrices.output;
        const costCap = readEntityCaptureCostCap(await engine.getConfig('dream.entity_capture.cost_cap_cny'));
        captureEntityBudget = {
          maxInputTokens: Math.max(0, readTokenCap(await engine.getConfig('dream.entity_capture.max_input_tokens'), DEFAULT_ENTITY_CAPTURE_MAX_INPUT_TOKENS) - inputTokens),
          maxOutputTokens: Math.max(0, readTokenCap(await engine.getConfig('dream.entity_capture.max_output_tokens'), DEFAULT_ENTITY_CAPTURE_MAX_OUTPUT_TOKENS) - outputTokens),
          costCapCny: costCap === null || inputPrice === null || outputPrice === null ? costCap : Math.max(0, costCap - (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000),
        };
      }
    }
    for (const phase of checkpoint.phases[sourceId] ?? []) send({ type: 'progress', event: { phase: `cycle.${phase.phase}`, event: 'finish' } });
    return ({
    captureEntitySlugs,
    captureEntityBudget,
    syncFileRuntime: fileRuntime,
    completedPhases: checkpoint.phases[sourceId],
    phaseCheckpoint: input.preset === 'quick' ? async (phases: import('../../core/cycle.ts').PhaseResult[]) => {
      checkpoint.phases[sourceId] = phases;
      await rpc('task.maintenanceCheckpoint', [checkpoint]);
    } : undefined,
    });
  };
  const phases = input.preset === 'quick' ? ALL_PHASES.filter(phase => resolveQuickMaintenancePhases().includes(phase) || (captureModel?.ok && phase === 'capture_entities'))
    : input.phase && input.phase !== 'all' ? [input.phase]
    : resolveDreamPresetPhases(input.preset ?? 'full');
  send({ type: 'progress', phases: [...phases] });
  const sourceId = input.sourceId ? await resolveSourceId(engine, input.sourceId) : undefined;
  if (sourceId && (await fetchSource(engine, sourceId))?.archived) throw new Error(`Source ${sourceId} is archived`);
  const common = {
    afterSync: input.preset === 'quick' && !input.dryRun ? (sourceId: string, root: string, result: import('../../commands/sync.ts').SyncResult) => rpc('task.gitCommit', [sourceId, root, result]) : undefined,
    dryRun: input.dryRun, sourceId,
    captureEntitySlugs:input.slugs,
    privateQueueOwnerJobId: ownerJobId,
    signal: abort.signal,
    includeOffice: true,
    syncConcurrency: 1,
    synthInputFile: input.input,
    synthDate: input.date, synthFrom: input.from, synthTo: input.to,
    proposeTakesPageLimit: input.maxPages,
    embedPageLimit: input.maxPages,
    embedBatchSize: constrained?32:100,
    getEmbedBatchSize:()=>constrained?32:100,
    proposeTakesRequireChunks: true,
    proposeTakesDrain: input.drainProposals,
    proposeTakesWindowMs: (input.windowSeconds ?? 3600) * 1000,
    yieldBetweenPhases:async()=>{await yieldExecution();if(constrained)Bun.gc(false);},
    yieldDuringPhase:async()=>{abort.signal.throwIfAborted();await yieldExecution();if(constrained)Bun.gc(false);},
  };
  if (input.preset === 'quick' && input.allSources) {
    const reports = [];
    const startedAt = new Date();
    const sources = (await loadAllSources(engine)).filter(row => parseSourceConfig(row.config).syncEnabled !== false);
    for (const [index, source] of sources.entries()) {
      abort.signal.throwIfAborted();
      if (checkpoint.reports[source.id]) {
        reports.push({ sourceId: source.id, report: checkpoint.reports[source.id] as unknown as import('../../core/cycle.ts').CycleReport });
        continue;
      }
      scanned=0;unchanged=0;pendingFiles=false;
      send({ type: 'progress', scope: { name: source.name, index, total: sources.length } });
      const report = await runQuickMaintenance(engine, {
        ...common, sourceId: source.id, brainDir: await resolveBrainDir(engine, null, source.id),
        ...await resumeOptions(source.id),
      });
      if (report.reason === 'cycle_already_running') return report;
      checkpoint.reports[source.id] = { ...report };
      await rpc('task.maintenanceCheckpoint', [checkpoint]);
      reports.push({ sourceId: source.id, report });
      if (report.phases.some(phase => phase.status === 'fail' && isGinRepairAbortText(`${phase.error?.message ?? ''}\n${phase.summary}\n${JSON.stringify(phase.details ?? {})}`))) break;
    }
    return combineQuickMaintenanceReports(reports, startedAt);
  }
  const brainDir = await resolveBrainDir(engine, null, sourceId);
  if (input.preset === 'quick') return runQuickMaintenance(engine, { ...common, brainDir, ...await resumeOptions(sourceId ?? 'default') });
  return runCycle(engine, {
    ...resolveDreamRelationOptions(input.preset, input.phase),
    ...common, brainDir,
    phases: input.phase && input.phase !== 'all' ? [input.phase as CyclePhase]
      : input.preset ? resolveDreamPresetPhases(input.preset) : undefined,
    forcePackPhases: input.preset === 'meeting' ? ['extract_atoms'] : undefined,
  });
}

async function execute(task: ProductTask, kind: BrainEngine['kind']) {
  const engine = proxyEngine(kind);
  if (loadConfig()) await reloadLiveGateway(engine);
  let result: Record<string, unknown>;
  if (task.type === 'sync-file') {
    const input = task.input;
    if ((input.modelMayRun || !input.options.noEmbed) && input.modelFingerprint !== taskModelFingerprint()) throw new Error('模型配置已改变，请继续同步以重新扫描');
    const source = await fetchSource(engine, input.options.sourceId ?? 'default');
    if (!source || source.archived || source.local_path !== input.sourceRoot) throw new Error('Source 路径已改变或已归档，请重新扫描');
    const { SyncFileQueue } = await import('./sync-file-queue.ts');
    await new SyncFileQueue(engine).validate(input);
    const snapshot = await stat(input.originalPath ?? input.path);
    importFile = input.relativePath;
    send({type:'progress',event:{phase:'import.process',file:importFile}});
    await rpc('task.inputFile', [{ path: input.originalPath ?? input.path, size: snapshot.size, mtimeMs: snapshot.mtimeMs }]);
    try {
      const imported = await importSyncFile(engine, input.path, input.relativePath, input.options);
      abort.signal.throwIfAborted();
      const page = imported.slug ? await engine.getPage(imported.slug, { sourceId: input.options.sourceId }) : null;
      result = { slug: imported.slug, status: imported.error && imported.error !== 'unchanged' ? 'failed' : imported.status, chunks: imported.chunks,
        error: imported.error, documentSummary: imported.documentSummary, largeDocument: imported.largeDocument,
        pageHash: page?.content_hash, file: input.relativePath };
    } catch (error) {
      abort.signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (isInfrastructureFailureCode(classifyErrorCode(message)) || /租约|Source|配置|处理期间已改变|快照已改变|SQL|constraint|database/i.test(message)) throw error;
      result = { slug: '', status: 'failed', chunks: 0, error: message, file: input.relativePath };
    }
    send({ type: 'result', result });
    return;
  } else if (task.type === 'import') {
    const input = task.input;
    send({ type: 'progress', phases: input.noEmbed ? ['collect', 'process', 'write'] : ['collect', 'process', 'vector', 'write'] });
    send({ type: 'progress', event: { phase: 'import.collect' } });
    const completedPaths: string[] = [];
    if (input.resumeCheckpointId) {
      for (const file of await readTaskCheckpoint(input.resumeCheckpointId)) {
        if (file.completed !== true || file.modelFingerprint !== taskModelFingerprint()) continue;
        const current = await stat(String(file.absolutePath)).catch(() => null);
        if (current?.size === file.size && current?.mtimeMs === file.mtimeMs) {
          completedPaths.push(String(file.path));
          await rpc('task.checkpoint', [file]);
        }
      }
    }
    let fileSnapshot: Record<string, unknown> = {};
    const imported = await runStructuredImport(engine, {
      path: input.path, noEmbed: input.noEmbed, fresh: true, jsonOutput: true, reportFiles: true,
      includeOffice: input.includeOffice !== false,
      includeImages: input.includeImages !== false,
      documentOcr: input.documentOcr !== false,
      structuredDocuments: input.structuredDocuments,
    }, {
      sourceId: input.sourceId,
      runtime: {
        signal: abort.signal,
        completedPaths,
        beforeFile: async path => {
          importFile = path;
          send({ type: 'progress', event: { phase: 'import.process', file: path } });
          const file = await stat(path);
          fileSnapshot = { absolutePath: path, size: file.size, mtimeMs: file.mtimeMs, modelFingerprint: taskModelFingerprint() };
          await rpc('task.inputFile', [{ path, size: file.size, mtimeMs: file.mtimeMs }]);
        },
        onFile: async progress => {
          send({ type: 'progress', event: { phase: 'import.files', done: Number(progress.processed) } });
          importFile = undefined;
          await rpc('task.checkpoint', [{ ...progress, ...fileSnapshot }]);
        },
      },
    });
    result = { ...imported, resumedFiles: completedPaths.length };
  } else if (task.type === 'dream') {
    result = { ...await runDreamTask(engine, task.input) };
  } else if (task.type === 'sync') {
    const results = [];
    const gateway = await import('../../core/ai/gateway.ts');
    for (const source of (await loadAllSources(engine)).filter(row => row.local_path && parseSourceConfig(row.config).syncEnabled !== false)) {
      abort.signal.throwIfAborted();
      results.push(await performSync(engine, {
        sourceId: source.id, repoPath: source.local_path!,
        concurrency: 1, signal: abort.signal,
        strategy: parseSourceConfig(source.config).strategy as SyncStrategy | undefined,
        includeOffice: parseSourceConfig(source.config).includeOffice === true,
        includeImages: gateway.isOcrEnabled(), documentOcr: gateway.isOcrEnabled(),
      }));
    }
    result = { results, errors: results.filter(row => ['blocked_by_failures', 'partial'].includes(row.status)).length };
  } else {
    result = { ...await runEmbedCore(engine, {
      stale: true, forceReembed: task.input.forceReembed,
      catchUp: task.input.catchUp,
      batchSize: 100,
      getBatchSize:()=>constrained?32:100,
      signal: abort.signal,
    }), catchUp: task.input.catchUp === true, forceReembed: task.input.forceReembed === true };
  }
  abort.signal.throwIfAborted();
  const failure = task.type === 'dream' ? maintenanceFailure(result) : null;
  if (result.reason === 'cycle_already_running') send({ type: 'result', result });
  else if (failure || result.status === 'failed' || Number(result.errors ?? 0) > 0) {
    const failures = result.failures as Array<{ error: string }> | undefined;
    const phases = result.phases as Array<{ error?: { message?: string }; status?: string; summary?: string }> | undefined;
    const phase = phases?.find(row => row.status === 'fail');
    send({ type: 'error', error: failure ?? failures?.[0]?.error ?? phase?.error?.message ?? phase?.summary ?? `任务未全部完成：${result.errors ?? result.status}`, result });
  } else {
    send({ type: 'result', result });
  }
}

parentPort!.on('message', message => {
  if(message.type==='resource-pressure'){
    constrained=message.constrained===true;
    if(constrained)Bun.gc(false);
  }else if (message.type === 'reply') {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      if(message.error.startsWith('资源保护：'))abort.abort(new Error(message.error));
      waiter?.reject(new Error(message.error));
    }
    else waiter?.resolve(message.value);
  } else if (message.type === 'cancel') {
    const reason=typeof message.reason==='string'?message.reason:'user_stop: 任务已取消';
    abort.abort(new Error(reason));
    for (const waiter of pending.values()) waiter.reject(new Error(reason));
    pending.clear();
  } else if (message.type === 'start') {
    ownerJobId = Number.isSafeInteger(message.ownerJobId) ? message.ownerJobId : null;
    constrained=message.constrained===true;
    abort = new AbortController();
    importFile = undefined;
    void execute(message.task, message.kind).catch(error => {
      if (error instanceof SyncFilesDeferred) { send({ type: 'deferred' }); return; }
      send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    });
  }
});
