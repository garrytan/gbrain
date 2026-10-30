import { resolve } from 'node:path';
import type { GBrainConfig } from '../core/config.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { resolveSourceIdEngineFree } from '../core/source-resolver.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { PersistenceIpcTransportError } from '../core/persistence/ipc.ts';
import { SYNC_BOOLEAN_FLAGS, SYNC_CLIENT_FLAGS, SYNC_VALUE_FLAGS, validateSyncWireParams } from '../core/persistence/sync-wire.ts';
import { SYNC_FLAGS, type SyncFlagSpec } from '../core/sync-flags.ts';
import { deriveDelegatedTimeoutSeconds } from './sync-delegate.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import type { SyncResult } from './sync.ts';
import { buildSingleSyncJsonEnvelope } from '../core/sync-embed-backfill.ts';
import { printManagedSyncDiagnostic } from './sync-diagnostics.ts';
import { parseDurationSeconds } from '../core/sync-concurrency.ts';
import { runDrain, drainJsonFields, formatDrainSummary, syncOutcome } from '../core/persistence/sync-drain.ts';
import { resolveStallAbortSeconds, resolveSyncHardDeadline, syncDeadlineStallNotice, syncResumeCommand } from '../core/sync-reconcile.ts';
import { noteCommittedProgress } from '../core/forward-progress.ts';

const invalid=(message:string,suggestion:string)=>opError('invalid_params',message,suggestion,
  {fix:readFix('Prints the gbrain sync flags.',{argv:['gbrain','sync','--help']})});

export async function parsePersistenceSyncArgs(args:string[],cwd=process.cwd()) {
  const options:Record<string,unknown>={};
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    const boolean=SYNC_BOOLEAN_FLAGS[arg];
    if(boolean){options[boolean]=true;continue;}
    // The client's own flags (output, deadlines) and the ones a PGLite owner has no use for (--lanes: no bulk lanes).
    if(SYNC_CLIENT_FLAGS.has(arg)){
      if((SYNC_FLAGS as Record<string,SyncFlagSpec>)[arg]!.arity==='value'&&(!args[++i]||args[i].startsWith('--')))throw invalid(`${arg} requires a value.`,`Give ${arg} its value right after it, e.g. ${arg==='--lanes'?`${arg} 4`:`${arg} 10m`}.`);
      continue;
    }
    const key=SYNC_VALUE_FLAGS[arg];
    if(!key)throw invalid(`Unsupported owner-delegated sync option: ${arg.split('=')[0]}.`,
      `Remove ${arg.split('=')[0]}; while the running serve holds the brain, sync runs inside it and accepts ${[...Object.keys(SYNC_BOOLEAN_FLAGS),...Object.keys(SYNC_VALUE_FLAGS),...SYNC_CLIENT_FLAGS].join(', ')}.`);
    const value=args[++i];if(!value||value.startsWith('--'))throw invalid(`${arg} requires a value.`,`Give ${arg} its value right after it, as ${arg} VALUE.`);
    if(key==='exclude'||key==='includeHidden')options[key]=[...(options[key] as string[]??[]),value];
    else options[key]=key==='repoPath'?resolve(cwd,value):value;
  }
  const source=resolveSourceIdEngineFree(typeof options.sourceId==='string'?options.sourceId:null,cwd);
  if(source==='__all__')throw opError('invalid_params','Owner-delegated sync requires one explicit source.',
    'Name one source with --source while the running serve holds the brain (repeat the command per source); gbrain sources list --json lists them.',
    {fix:readFix('Lists the source ids to sync one at a time, read-only.',{argv:['gbrain','sources','list','--json']})});
  if(source)options.sourceId=source;
  const softTimeout=parseDurationSeconds(args.find((_,i)=>args[i-1]==='--timeout'),'--timeout');
  const hardTimeout=await deriveDelegatedTimeoutSeconds(args);
  const timeoutSeconds=softTimeout && softTimeout>0 ? hardTimeout>0 ? Math.min(softTimeout,hardTimeout) : softTimeout : hardTimeout;
  return validateSyncWireParams({options,cwd,timeoutSeconds});
}

/**
 * The delegated sync's progress window: the default and env deadlines extend
 * while the owner keeps committing pages, exactly as a local `gbrain sync`
 * does; `--timeout` and `--hard-deadline` stay strict wall-clock caps.
 */
export function delegatedProgressWindowMs(args:string[],env:Record<string,string|undefined>=process.env,isTty=Boolean(process.stdout.isTTY)):number|undefined {
  if(args.includes('--timeout')||args.includes('--hard-deadline')||args.includes('--no-hard-deadline'))return undefined;
  return (resolveSyncHardDeadline(args,{isTty,env})?.progressWindowMs)??resolveStallAbortSeconds(env)*1000;
}

/**
 * The client-side stop for a delegated sync. Past `timeoutMs` a progress-aware
 * deadline extends to one progress window after the last slice that committed
 * work (a cursor that advanced, or a pass that wrote, deleted or renamed pages),
 * and stops only after a full window without it. GBRA-133 PR 3a: a run that
 * committed nothing never extends; its stop is a stall (`stalled`), and a pass
 * that only settled paths (screened them unchanged) is not progress. A slice
 * reports only when it returns, so a first slice still running at the deadline
 * is waited for, up to one progress window from the start, and decides then.
 */
export class DelegatedSyncDeadline {
  readonly stop=new AbortController();
  private at:number;
  private lastProgressAt:number;
  private lastIndex=-1;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private extended=false;
  private progressed=false;
  private readonly startedAt:number;
  private sliceSeen=false;
  private waitingFirstSlice=false;
  /** True when the deadline stopped a run that committed nothing (`sync_deadline_stalled`). */
  stalled=false;
  constructor(timeoutMs:number,private readonly progressWindowMs:number|undefined,private readonly log:(line:string)=>void=line=>console.error(line)) {
    this.lastProgressAt=this.startedAt=performance.now();
    this.at=timeoutMs>0?this.lastProgressAt+timeoutMs:Infinity;
    this.arm();
  }
  /**
   * Seconds the next slice may run (the owner ends a slice that reaches it as
   * timed out). A progress-aware slice gets at least one progress window, so
   * the owner's own slice bound ends it and this deadline decides between
   * slices whether the run continues.
   */
  sliceSeconds(fallback:number):number {
    if(!Number.isFinite(this.at))return fallback;
    const remainingMs=Math.max(this.at-performance.now(),this.progressWindowMs??0);
    return Math.max(1,Math.ceil(remainingMs/1000));
  }
  /** Call with each slice's result; an advanced cursor index, or a pass that committed pages, is progress. */
  noteSlice(slice:Pick<SyncResult,'managedCursor'|'pass'|'added'|'modified'|'deleted'|'renamed'>):void {
    const index=slice.managedCursor?.index;
    this.sliceSeen=true;
    if(index!==undefined&&index>this.lastIndex)this.lastIndex=index;
    else if(!slice.pass||slice.added+slice.modified+slice.deleted+(slice.renamed??0)===0)return this.firstSliceReturned();
    this.progressed=true;
    this.lastProgressAt=performance.now();
    noteCommittedProgress();
    this.firstSliceReturned();
  }
  /** The deadline passed while the first slice ran: decide now that it reported. */
  private firstSliceReturned():void {
    if(!this.waitingFirstSlice)return;
    this.waitingFirstSlice=false;
    this.dispose();
    this.check();
  }
  dispose():void { if(this.timer)clearTimeout(this.timer); }
  private arm():void {
    if(!Number.isFinite(this.at))return;
    this.timer=setTimeout(()=>this.check(),Math.max(0,this.at-performance.now()));
    this.timer.unref?.();
  }
  private check():void {
    const now=performance.now();
    // A slice reports only when it returns: a first slice still running at the deadline is waited for, up to one progress window.
    if(this.progressWindowMs&&!this.sliceSeen&&now-this.startedAt<this.progressWindowMs) {
      this.waitingFirstSlice=true;
      this.at=this.startedAt+this.progressWindowMs;
      this.arm();
      return;
    }
    if(this.progressWindowMs&&this.progressed&&now-this.lastProgressAt<this.progressWindowMs) {
      this.at=this.lastProgressAt+this.progressWindowMs;
      if(!this.extended){this.extended=true;this.log(`[sync] past the delegated deadline and still progressing; extends while the owner keeps committing pages (stops after ${Math.round(this.progressWindowMs/1000)}s without progress).`);}
      this.arm();
      return;
    }
    if(this.progressWindowMs&&!this.progressed){this.stalled=true;this.log('[sync] code=sync_deadline_stalled: the delegated deadline passed and the owner committed nothing (no page written and no cursor advanced); stopping as a stall.');}
    this.stop.abort();
  }
}
/** Any resident native owner may proxy; its durable registration, not a process label, authorizes work. */
export async function maybeDelegateSyncToPersistence(hostConfig:GBrainConfig|null,args:string[]):Promise<boolean> {
  if(args.includes('--no-delegate')||process.env.GBRAIN_SYNC_NO_DELEGATE==='1')return false;
  const brainId=resolveBrainId(getCliOptions().brain,process.cwd());
  const config=persistenceConfigForBrain(hostConfig,brainId,brainId==='host'?[]:loadMounts());
  if(config?.engine!=='pglite'||!config.database_path||config.database_url||!inspectLockHolder(config.database_path).held)return false;
  try {
    const params=await parsePersistenceSyncArgs(args);
    const deadline=new DelegatedSyncDeadline(params.timeoutSeconds*1000,delegatedProgressWindowMs(args));
    console.error('[sync] Delegating to the registered PGLite owner.');
    // #5984: the owner returns one bounded slice per call; the shared drain owns re-entry and the stop rules.
    let result:SyncResult&{source_id?:string};
    try {
      result=await runDrain({signal:deadline.stop.signal,announce:true,pass:async()=>{
        const sliceSeconds=deadline.sliceSeconds(params.timeoutSeconds);
        const delegated=await maybeDelegateLocalAdministration('writer_sync',{...params,timeoutSeconds:sliceSeconds} as unknown as Record<string,unknown>,config,
          {timeoutMs:sliceSeconds>0?Math.min(86_400_000,Math.max(30_000,sliceSeconds*1000+30_000)):86_400_000});
        if(!delegated.handled)throw opError('owner_unavailable','The observed PGLite owner stopped before sync admission.','Retry the same sync options to resume its durable cursor.',
          {fix:{argv:['gbrain','sync',...args],consent:[],actor:'agent',requires_exclusive:false,why:'The owner stopped before admission; the same options resume the durable cursor.'}});
        const slice=delegated.result as SyncResult;
        deadline.noteSlice(slice);
        return slice;
      }});
    } finally { deadline.dispose(); }
    const sourceId=result.source_id??params.options.sourceId??'default';
    const resume=syncResumeCommand(args,getCliOptions().brain);
    // GBRA-133 PR 3a: a deadline that stopped a run which committed nothing is a stall (code, why, fix), never a clean resumable stop.
    const stall=deadline.stalled?syncDeadlineStallNotice(args,{deadlineMs:params.timeoutSeconds*1000,graceMs:0,reason:'delegated deadline'}):null;
    if(stall)setCliExitVerdict(1);
    if(args.includes('--json')) {
      await writeStdoutFinal(JSON.stringify({ ...buildSingleSyncJsonEnvelope(sourceId,result),
        ...(result.managedWrite ? { managed_write: result.managedWrite } : {}), ...drainJsonFields(result,resume,sourceId), ...(stall ? { deadline_stall: JSON.parse(stall) } : {}) })+'\n');
      printManagedSyncDiagnostic(result, process.stderr);
      for(const line of formatDrainSummary(result,resume,sourceId))process.stderr.write(line+'\n');
    }
    else {
      (await import('./sync.ts')).printSyncResult(result);
      for(const line of formatDrainSummary(result,resume,sourceId))process.stdout.write(line+'\n');
      if(stall)process.stdout.write(stall+'\n');
      if(!params.options.dryRun&&!params.options.noEmbed&&result.added+result.modified>0) {
        console.error('[sync] embeds deferred — the owner drains them using its configured provider and keys.');
      }
    }
    if(syncOutcome(result)==='blocked')setCliExitVerdict(1);
    return true;
  }catch(error){
    if(error instanceof PersistenceIpcTransportError&&error.sent)error=new OperationError('write_pending','The sync acknowledgment was lost; accepted page requests retain their IDs.','Repeat the same sync options to resume the durable cursor.');
    if(await reportPersistenceCliError(error,args.includes('--json')))return true;
    throw error;
  }
}
