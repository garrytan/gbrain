import { createHash, randomUUID } from 'node:crypto';
import { open, statfs, stat, rename, unlink, opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gbrainPath, loadConfig } from '../../core/config.ts';
import { getAccurateRss } from '../../core/minions/worker.ts';
import { MAX_FILE_SIZE, MAX_IMAGE_BYTES, isImageFilePath } from '../../core/import-file.ts';
import { MAX_OFFICE_BYTES } from '../../core/office-import.ts';
import { isOfficeFilePath } from '../../core/sync.ts';
import { freemem, totalmem } from 'node:os';
import { memoryPressure } from '../../../shared/memory-budget.ts';

export const PRODUCT_QUEUE_CAPACITY=128;
export const SYNC_QUEUE_CAPACITY=10000;
export const SNAPSHOT_QUOTA_BYTES=1024*1024*1024;
export const TASK_LOG_MAX_BYTES=32*1024*1024;
export function assertImportFileSize(path:string,size:number){
  const limit=isImageFilePath(path)?MAX_IMAGE_BYTES:isOfficeFilePath(path)?MAX_OFFICE_BYTES:MAX_FILE_SIZE;
  if(size>limit)throw new Error(`资源保护：文件过大（${size} bytes，当前格式上限 ${limit} bytes）：${path}。请拆分后继续。`);
}

export interface TaskResourceOptions {
  memoryBytes?:()=>number;
  availableMemoryBytes?:()=>number;
  totalMemoryBytes?:()=>number;
  rssCheckIntervalMs?:number;
  diskReserveBytes?:number;
  freeDiskBytes?:(path:string)=>Promise<number>;
  snapshotQuotaBytes?:number;
}

export class TaskResourceGuard {
  private snapshotBytes=0;
  private measuringSnapshots:Promise<void>|null=null;
  constructor(private options:TaskResourceOptions={}){}
  memoryBytes(){return (this.options.memoryBytes??getAccurateRss)();}
  memoryPressure(){return memoryPressure({bytes:this.memoryBytes(),availableBytes:(this.options.availableMemoryBytes??freemem)(),totalBytes:(this.options.totalMemoryBytes??totalmem)()});}
  get rssCheckIntervalMs(){return this.options.rssCheckIntervalMs??5000;}
  async assertDisk(path:string,additionalBytes=0){
    let target=path;
    while(true){
      try{await stat(target);break;}catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT'||dirname(target)===target)throw error;
        target=dirname(target);
      }
    }
    const free=this.options.freeDiskBytes?await this.options.freeDiskBytes(target):await statfs(target).then(fs=>fs.bavail*fs.bsize);
    const needed=(this.options.diskReserveBytes??1024*1024*1024)+additionalBytes;
    if(!Number.isFinite(free)||free<needed)throw new Error(`资源保护：磁盘空间不足，已停止导入。${target} 可用 ${Math.floor(free/1024/1024)} MB，需要保留 ${Math.ceil(needed/1024/1024)} MB；释放空间后手动继续。`);
  }
  async assertImportDisk(additionalBytes=0){
    await this.assertDisk(gbrainPath('task-artifacts'),additionalBytes);
    const config=loadConfig();
    if(config?.engine==='pglite')await this.assertDisk(config.database_path??gbrainPath('brain.pglite'),additionalBytes);
  }
  private async measureSnapshots(){
    let total=0;
    const pending=[gbrainPath('task-artifacts','sync-files')];
    while(pending.length){
      const path=pending.pop()!;
      const info=await stat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(!info)continue;
      const directory=await opendir(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(!directory)continue;
      try{for await(const entry of directory){
        if(entry.isDirectory())pending.push(join(path,entry.name));
        else if(entry.isFile())total+=(await stat(join(path,entry.name)).catch(error=>{if(error.code==='ENOENT')return {size:0};throw error;})).size;
      }}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    return total;
  }
  async reserveSnapshot(additionalBytes:number):Promise<()=>void>{
    if(!this.measuringSnapshots)this.measuringSnapshots=this.measureSnapshots().then(total=>{this.snapshotBytes=total;});
    await this.measuringSnapshots;
    const total=this.snapshotBytes;
    const limit=this.options.snapshotQuotaBytes??SNAPSHOT_QUOTA_BYTES;
    if(total+additionalBytes>limit)throw new Error(`资源保护：同步快照容量已达到 ${Math.ceil(limit/1024/1024)} MB，已拒绝入队。请先完成已有任务后手动继续。`);
    this.snapshotBytes=total+additionalBytes;
    let released=false;
    return ()=>{if(!released){released=true;this.snapshotRemoved(additionalBytes);}};
  }
  snapshotRemoved(bytes:number){
    this.snapshotBytes=Math.max(0,this.snapshotBytes-bytes);
  }
}

export async function streamFileHash(path:string,signal?:AbortSignal):Promise<string>{
  const file=await open(path,'r');const hash=createHash('sha256');const buffer=Buffer.allocUnsafe(64*1024);
  try{
    while(true){signal?.throwIfAborted();const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));}
    return hash.digest('hex');
  }finally{await file.close();}
}

export async function copyFileSnapshot(source:string,destination:string,expectedHash:string,check:()=>Promise<void>){
  await check();
  const temporary=destination+'.part-'+randomUUID();
  const input=await open(source,'r');
  let output:Awaited<ReturnType<typeof open>>|undefined;
  try{
    output=await open(temporary,'wx',0o600);const hash=createHash('sha256');const buffer=Buffer.allocUnsafe(64*1024);
    while(true){
      await check();const {bytesRead}=await input.read(buffer,0,buffer.length,null);if(!bytesRead)break;
      hash.update(buffer.subarray(0,bytesRead));let offset=0;
      while(offset<bytesRead)offset+=(await output.write(buffer,offset,bytesRead-offset,null)).bytesWritten;
    }
    if(hash.digest('hex')!==expectedHash)throw new Error('原始文件在扫描期间已改变，请继续同步');
    await check();await output.close();output=undefined;await rename(temporary,destination);
  }finally{
    await input.close();await output?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
}
