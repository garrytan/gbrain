import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { flushDirectory, flushFile } from '../fs-durable.ts';
import type { Action } from '../agent-output.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { durableSsrfFlags, GIT_ENV, GIT_SSRF_SUBCOMMAND_FLAGS, parseRemoteUrl } from '../git-remote.ts';
import { persistenceHome } from './identity.ts';

export { flushDirectory as flushTopologyDirectory } from '../fs-durable.ts';
const recoveryFix=(why:string):Action=>readFix(why,{argv:['gbrain','sources','writer','status','--json']});
export function topologyDirectoryIdentity(path:string):{device:string;inode:string;birthNs:string}{
  const info=lstatSync(path,{bigint:true});
  if(!info.isDirectory()||info.isSymbolicLink())throw opError('recovery_required','The staging directory was substituted.',
    `The topology staging path ${path} is no longer the directory gbrain created, so the lifecycle step stopped for recovery. Inspect the pending recovery in writer status; do not delete or recreate the staging directory by hand.`,
    {fix:recoveryFix('Shows pending lifecycle requests and their recovery records, read-only.')});
  return {device:info.dev.toString(),inode:info.ino.toString(),birthNs:info.birthtimeNs.toString()};
}
/** Complete tree accounting includes .git, sparse files, and metadata headroom. */
export async function topologyDirectoryBytes(root:string,limit=Number.MAX_SAFE_INTEGER):Promise<number>{
  let bytes=0;
  const pending=[root];
  while(pending.length){
    const path=pending.pop()!;
    let info;
    try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    bytes+=4096+info.size;
    if(!Number.isSafeInteger(bytes)||bytes>limit)throw opError('request_too_large','The staged checkout exceeds its reserved recovery capacity.',
      `The checkout staged at ${root} is larger than the ${limit} bytes reserved for its recovery. Inspect the pending lifecycle request in writer status; it needs a smaller repository or a larger recovery budget, which is the user's call.`,
      {fix:recoveryFix('Shows the pending lifecycle request and the recovery capacity it holds, read-only.')});
    if(info.isDirectory())for(const entry of await readdir(path))pending.push(join(path,entry));
  }
  return bytes;
}
export function flushTopologyTree(root:string):void{
  const visit=(path:string)=>{
    const info=lstatSync(path);
    if(info.isSymbolicLink())throw opError('writer_manifest_unsafe','Canonical checkout recovery refuses symbolic links.',
      `The staged checkout contains a symbolic link at ${path}, and canonical recovery never follows links. Replace it with a regular file or directory in the repository, then inspect the pending recovery in writer status.`,
      {fix:recoveryFix('Shows the pending lifecycle request this staged checkout belongs to, read-only.')});
    if(info.isDirectory()){
      for(const entry of readdirSync(path))visit(join(path,entry));
      flushDirectory(path);
    }else if(info.isFile()){
      flushFile(path);
    }
  };
  visit(root);
}

/** Reserved staging, no DB checkout; kill only this owned Git child on overflow. */
export async function cloneTopologyCheckout(url:string,destination:string,maxBytes:number,timeoutMs=600_000):Promise<void>{
  parseRemoteUrl(url);
  if(!existsSync(destination)||!lstatSync(destination).isDirectory()||lstatSync(destination).isSymbolicLink()||readdirSync(destination).length)
    throw opError('recovery_required','The reserved clone staging directory must remain empty before cloning.',
      `The reserved clone directory ${destination} is missing or not empty, so cloning stopped for recovery. Inspect the pending recovery in writer status; recovery owns that directory, so do not clear it by hand.`,
      {fix:recoveryFix('Shows pending lifecycle requests and their recovery records, read-only.')});
  const base=join(persistenceHome(),'empty-hooks');mkdirSync(base,{recursive:true,mode:0o700});
  const hooks=mkdtempSync(join(base,'clone-'));
  const child=spawn('git',[...durableSsrfFlags(),'-c',`core.hooksPath=${hooks}`, 'clone',...GIT_SSRF_SUBCOMMAND_FLAGS,'--depth=1','--',url,destination],
    {stdio:['ignore','ignore','ignore'],detached:process.platform!=='win32',env:{...process.env,...GIT_ENV}});
  let failure:unknown,check:Promise<void>|undefined,stopping:Promise<void>|undefined,abandon=()=>{};
  const stop=(error:unknown)=>{
    failure??=error;
    if(stopping)return;
    // Git can launch index-pack/remote helpers that still own staging files.
    // Terminate this invocation's complete process tree before cleanup.
    stopping=new Promise<void>((resolve)=>{
      if(!child.pid){resolve();return;}
      if(process.platform==='win32'){
        const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});
        killer.once('exit',()=>resolve());killer.once('error',()=>{child.kill('SIGKILL');resolve();});
      }else{try{process.kill(-child.pid,'SIGKILL');}catch{}resolve();}
    });
    abandon();
  };
  const monitor=setInterval(()=>{
    if(!check)check=topologyDirectoryBytes(destination,maxBytes).then(()=>{}).catch(stop).finally(()=>{check=undefined;});
  },50);
  const timer=setTimeout(()=>stop(opError('storage_error','The staged clone exceeded its execution deadline.',
    `Cloning into ${destination} ran past ${Math.round(timeoutMs/1000)} seconds and was stopped. Check that the remote is reachable and not unexpectedly large, and inspect the pending lifecycle request in writer status before submitting it again.`,
    {fix:recoveryFix('Shows the pending lifecycle request and whether it is held for recovery, read-only.')})),timeoutMs);
  try{
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);abandon=()=>resolve(null);});
    await check;await stopping;
    if(failure)throw failure;
    if(code!==0)throw new OperationError('storage_error','The reserved source clone failed.','Inspect the configured remote and owner Git credentials.');
    await topologyDirectoryBytes(destination,maxBytes);
  }finally{clearInterval(monitor);clearTimeout(timer);await check;await stopping;rmSync(hooks,{recursive:true,force:true});}
}
