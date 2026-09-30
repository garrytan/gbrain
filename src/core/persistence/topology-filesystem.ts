import { spawn } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import { durableSsrfFlags, GIT_ENV, GIT_SSRF_SUBCOMMAND_FLAGS, parseRemoteUrl } from '../git-remote.ts';
import { persistenceHome } from './identity.ts';

export function flushTopologyDirectory(path:string):void{
  let fd:number|undefined;
  try{fd=openSync(path,'r');fsyncSync(fd);}
  catch(error){if(!(process.platform==='win32'&&['EISDIR','EPERM','EINVAL','ENOTSUP'].includes((error as NodeJS.ErrnoException).code??'')))throw error;}
  finally{if(fd!==undefined)closeSync(fd);}
}
export function topologyDirectoryIdentity(path:string):{device:string;inode:string;birthNs:string}{
  const info=lstatSync(path,{bigint:true});
  if(!info.isDirectory()||info.isSymbolicLink())throw new OperationError('recovery_required','The staging directory was substituted.');
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
    if(!Number.isSafeInteger(bytes)||bytes>limit)throw new OperationError('request_too_large','The staged checkout exceeds its reserved recovery capacity.');
    if(info.isDirectory())for(const entry of await readdir(path))pending.push(join(path,entry));
  }
  return bytes;
}
export function flushTopologyTree(root:string):void{
  const visit=(path:string)=>{
    const info=lstatSync(path);
    if(info.isSymbolicLink())throw new OperationError('writer_manifest_unsafe','Canonical checkout recovery refuses symbolic links.');
    if(info.isDirectory()){
      for(const entry of readdirSync(path))visit(join(path,entry));
      flushTopologyDirectory(path);
    }else if(info.isFile()){
      const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    }
  };
  visit(root);
}

/** Reserved staging, no DB checkout; kill only this owned Git child on overflow. */
export async function cloneTopologyCheckout(url:string,destination:string,maxBytes:number,timeoutMs=600_000):Promise<void>{
  parseRemoteUrl(url);
  if(!existsSync(destination)||!lstatSync(destination).isDirectory()||lstatSync(destination).isSymbolicLink()||readdirSync(destination).length)
    throw new OperationError('recovery_required','The reserved clone staging directory must remain empty before cloning.');
  const base=join(persistenceHome(),'empty-hooks');mkdirSync(base,{recursive:true,mode:0o700});
  const hooks=mkdtempSync(join(base,'clone-'));
  const child=spawn('git',[...durableSsrfFlags(),'-c',`core.hooksPath=${hooks}`, 'clone',...GIT_SSRF_SUBCOMMAND_FLAGS,'--depth=1','--',url,destination],
    {stdio:['ignore','ignore','ignore'],detached:process.platform!=='win32',env:{...process.env,...GIT_ENV}});
  let failure:unknown,check:Promise<void>|undefined,stopping:Promise<void>|undefined;
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
  };
  const monitor=setInterval(()=>{
    if(!check)check=topologyDirectoryBytes(destination,maxBytes).then(()=>{}).catch(stop).finally(()=>{check=undefined;});
  },50);
  const timer=setTimeout(()=>stop(new OperationError('storage_error','The staged clone exceeded its execution deadline.')),timeoutMs);
  try{
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    await check;await stopping;
    if(failure)throw failure;
    if(code!==0)throw new OperationError('storage_error','The reserved source clone failed.','Inspect the configured remote and owner Git credentials.');
    await topologyDirectoryBytes(destination,maxBytes);
  }finally{clearInterval(monitor);clearTimeout(timer);await check;await stopping;rmSync(hooks,{recursive:true,force:true});}
}
