import { execFile } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import { memoryPressure } from '../../../../shared/memory-budget.js';

export interface ResourceSample {bytes:number;availableBytes:number;totalBytes?:number;commitHeadroomBytes?:number;startedAt?:string;}
export type ResourceAction='adjust'|'drain'|'emergency';
export function resourcePressure(sample:ResourceSample):string|null{
  const pressure=memoryPressure(sample);
  return pressure.level==='normal'?null:pressure.reason;
}

function execute(command:string,args:string[]):Promise<string>{
  return new Promise((resolve,reject)=>execFile(command,args,{windowsHide:true,timeout:4000,maxBuffer:512*1024},(error,stdout)=>error?reject(error):resolve(stdout)));
}

export async function readSidecarResources(pid:number):Promise<ResourceSample|null>{
  if(!Number.isSafeInteger(pid)||pid<1)throw new Error('监控 PID 无效');
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null; throw error; }
  if(process.platform==='win32'){
    const script=`$ErrorActionPreference='Stop'; $root=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if(!$root){exit 0}; $owned=[System.Collections.Generic.List[object]]::new(); $owned.Add($root); $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($root.Id); $bytes=[double]0; for($index=0; $index -lt $owned.Count; $index++){if($owned.Count -gt 128){throw 'Controlled process tree exceeds resource limit'}; $parent=$owned[$index]; $bytes += [double]$parent.PrivateMemorySize64; foreach($row in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$parent.Id) -Property ProcessId,CreationDate)){if(!$ids.Contains([int]$row.ProcessId) -and $row.CreationDate -ge $parent.StartTime){$child=Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue; if($child){[void]$ids.Add($child.Id); $owned.Add($child)}}}}; $memory=Get-CimInstance Win32_PerfRawData_PerfOS_Memory; @{bytes=$bytes; availableBytes=[double]$memory.AvailableBytes; commitHeadroomBytes=[double]$memory.CommitLimit-[double]$memory.CommittedBytes; startedAt=$root.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`;
    const text=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script]);
    if(!text.trim())return null;
    const sample=JSON.parse(text) as ResourceSample;
    if(!Number.isFinite(sample.bytes)||!Number.isFinite(sample.availableBytes)||!Number.isFinite(sample.commitHeadroomBytes))throw new Error('内存采样数据无效');
    return {...sample,totalBytes:totalmem()};
  }
  const text=await execute('ps',['-e','-o','pid=,ppid=,rss=']);
  const rows=text.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
  if(!rows.some(row=>row[0]===pid))return null;
  const ids=new Set([pid]);let added=true;
  while(added){added=false;for(const [id,parent] of rows)if(ids.has(parent)&&!ids.has(id)){ids.add(id);added=true;}}
  return {bytes:rows.filter(row=>ids.has(row[0])).reduce((sum,row)=>sum+row[2]*1024,0),availableBytes:freemem(),totalBytes:totalmem()};
}

export class SidecarResourceMonitor {
  private timer:ReturnType<typeof setTimeout>|null=null;
  private stopped=false;
  private startedAt:string|undefined;
  private createdAt=Date.now();
  private level:'normal'|'constrained'|'critical'='normal';
  private criticalSince:number|null=null;
  constructor(private pid:number,private halt:(message:string,sample:ResourceSample|null,action:ResourceAction)=>Promise<void>,private options:{intervalMs?:number;read?:(pid:number)=>Promise<ResourceSample|null>;onError?:(error:unknown)=>void;now?:()=>number}={}){}
  start(){if(this.timer||this.stopped)return;this.timer=setTimeout(()=>void this.tick(),this.options.intervalMs??2000);this.timer.unref();}
  stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;}
  private async tick(){
    try{
      const sample=await (this.options.read??readSidecarResources)(this.pid);
      if(this.stopped)return;
      if(!sample){this.stop();return;}
      if(sample.startedAt){
        if(this.startedAt && this.startedAt!==sample.startedAt){this.stop();return;}
        if(!this.startedAt && Date.parse(sample.startedAt)<this.createdAt-10000){this.stop();return;}
        this.startedAt=sample.startedAt;
      }
      const pressure=memoryPressure(sample);
      const now=(this.options.now??Date.now)();
      if(pressure.level==='critical'){
        if(this.criticalSince===null)this.criticalSince=now;
        if(now-this.criticalSince>=30000){
          this.stop();await this.halt(`资源保护：${pressure.reason}持续 30 秒，后台任务已停止仍无法回收，紧急停止本地服务。`,sample,'emergency');return;
        }
      }else this.criticalSince=null;
      if(pressure.level!==this.level){
        await this.halt(pressure.reason,sample,pressure.level==='critical'?'drain':'adjust');
        this.level=pressure.level;
      }
    }catch(error){
      this.options.onError?.(error);
      this.criticalSince=null;
    }
    finally{if(!this.stopped){this.timer=null;this.start();}}
  }
}
