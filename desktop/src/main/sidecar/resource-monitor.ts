import { execFile } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import { memoryPressure } from '../../../../shared/memory-budget.js';
import { readWindowsResourceSample,closeWindowsResourceReader } from './windows-resource-reader.js';

export interface ResourceSample {bytes:number;availableBytes:number;totalBytes?:number;commitHeadroomBytes?:number;startedAt?:string;}
export type ResourceAction='adjust'|'drain'|'emergency';
export function resourcePressure(sample:ResourceSample):string|null{
  const pressure=memoryPressure(sample);
  return pressure.level==='normal'?null:pressure.reason;
}

function execute(command:string,args:string[]):Promise<string>{
  return new Promise((resolve,reject)=>execFile(command,args,{windowsHide:true,timeout:4000,maxBuffer:512*1024},(error,stdout)=>error?reject(error):resolve(stdout)));
}

export function parseWindowsResourceSample(text:string):ResourceSample{
  const sample=JSON.parse(text);
  if(!sample||[sample.bytes,sample.availableBytes,sample.commitLimitBytes,sample.committedBytes].some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0)
    ||sample.commitLimitBytes===0||typeof sample.startedAt!=='string'||!Number.isFinite(Date.parse(sample.startedAt)))throw new Error('内存采样数据无效');
  return {bytes:sample.bytes,availableBytes:sample.availableBytes,commitHeadroomBytes:Math.max(0,sample.commitLimitBytes-sample.committedBytes),startedAt:sample.startedAt};
}

export async function readSidecarResources(pid:number):Promise<ResourceSample|null>{
  if(!Number.isSafeInteger(pid)||pid<1)throw new Error('监控 PID 无效');
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null; throw error; }
  if(process.platform==='win32'){
    const text=await readWindowsResourceSample(pid);
    if(!text.trim())return null;
    const sample=parseWindowsResourceSample(text);
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
  private normalSince:number|null=null;
  constructor(private pid:number,private halt:(message:string,sample:ResourceSample|null,action:ResourceAction)=>Promise<void>,private options:{intervalMs?:number;read?:(pid:number)=>Promise<ResourceSample|null>;onError?:(error:unknown)=>void;now?:()=>number}={}){}
  start(){if(this.timer||this.stopped)return;this.timer=setTimeout(()=>void this.tick(),this.options.intervalMs??2000);this.timer.unref();}
  stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;if(!this.options.read)closeWindowsResourceReader();}
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
      if(pressure.level==='normal' && this.level!=='normal'){
        this.normalSince??=now;
        if(now-this.normalSince<15000)return;
      }else this.normalSince=null;
      if(pressure.level!==this.level){
        await this.halt(pressure.reason,sample,pressure.level==='critical'?'drain':'adjust');
        this.level=pressure.level;
      }
    }catch(error){
      if(this.stopped)return;
      this.options.onError?.(error);
      this.criticalSince=null;
      this.normalSince=null;
      if(this.level==='normal'){
        try{
          await this.halt('资源采样暂不可用，后台暂按单并发运行',null,'adjust');
          this.level='constrained';
        }catch(adjustError){this.options.onError?.(adjustError);}
      }
    }
    finally{if(!this.stopped){this.timer=null;this.start();}}
  }
}
