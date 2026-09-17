/** Existing trusted core source entry points retain their ordinary result shapes. */
import { resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { msysToNativePath } from '../path-confine.ts';
import { defaultCloneDir, type AddSourceOpts, type SourceRow } from '../sources-ops.ts';
import { DEFAULT_CALENDAR_ID } from '../google/types.ts';
import { runManagedSourceLifecycle, type SourceLifecycleInput } from './source-lifecycle.ts';
import { isValidSourceId } from '../source-id.ts';
import { WRITE_ERROR_CODES, type WriteErrorCode } from './types.ts';

export function assertTopologyCommitted(result:Record<string,unknown>):void{
  if(result.state==='committed')return;
  const code=result.state==='failed'?String(result.write_error??'storage_error'):'write_pending';
  const error=new OperationError(code,'Source lifecycle has not committed.','Inspect the same request_id before submitting another lifecycle intent.');
  error.writeError=(WRITE_ERROR_CODES as readonly string[]).includes(code)?code as WriteErrorCode:'storage_error';
  error.writeRequest={request_id:String(result.request_id),state:result.state==='failed'?'failed':'recovering',retry_after_ms:result.state==='failed'?null:1000};
  throw error;
}
/** Normalize one caller intent without provider, database or canonical write work. */
export function managedSourceAddInput(opts:AddSourceOpts):SourceLifecycleInput{
  if(!isValidSourceId(opts.id))throw new OperationError('invalid_params','A valid explicit source ID is required.');
  if(opts.remoteUrl&&opts.localPath||opts.github&&opts.google||(opts.github||opts.google)&&(opts.remoteUrl||opts.localPath))
    throw new OperationError('invalid_params','Choose exactly one source location: path, remote URL, GitHub, or Google.');
  if(opts.cloneDir&&!opts.remoteUrl)throw new OperationError('invalid_params','cloneDir requires a remote URL.');
  if(opts.force!==undefined&&typeof opts.force!=='boolean'||opts.federated!=null&&typeof opts.federated!=='boolean')
    throw new OperationError('invalid_params','force and federated must be boolean values.');
  let path=opts.localPath?resolve(msysToNativePath(opts.localPath)):undefined;
  let config:Record<string,unknown>=opts.federated==null?{}:{federated:opts.federated};
  if(opts.remoteUrl){path=resolve(opts.cloneDir??defaultCloneDir(opts.id));config={...config,remote_url:opts.remoteUrl,managed_clone:true};}
  if(opts.github){
    const gh=opts.github;path=resolve(msysToNativePath(gh.dir));
    config={kind:'github',gh_token_env:gh.tokenEnv,gh_handle:gh.handle,gh_scope:gh.scope,gh_repos:gh.repos.join(','),gh_involvement:gh.involvement,
      gh_managed:path===defaultCloneDir(`${opts.id}-github`),federated:opts.federated??true,
      ...(gh.appId!==undefined&&gh.appPemPath!==undefined?{gh_app_id:gh.appId,gh_app_pem_path:gh.appPemPath}:{}),
      ...(gh.appInstallId!==undefined?{gh_app_install_id:gh.appInstallId}:{})};
  }
  if(opts.google){
    const google=opts.google;path=resolve(msysToNativePath(google.dir));
    config={kind:'google',g_account:google.account,g_services:google.services.join(','),g_history_days:google.historyDays,
      ...(google.calendarId&&google.calendarId!==DEFAULT_CALENDAR_ID?{g_calendar_id:google.calendarId}:{}),
      ...(google.access&&google.access!=='vault'?{g_access:google.access}:{}),...(google.tokenCommand?{g_token_command:google.tokenCommand}:{}),
      ...(google.tokenEnv?{g_token_env:google.tokenEnv}:{}),g_managed:path===defaultCloneDir(`${opts.id}-google`),federated:opts.federated??true};
  }
  return {operation:'add',sourceId:opts.id,path,name:opts.name,config,remoteUrl:opts.remoteUrl,
    createDirectory:!!(opts.github||opts.google),requireGitContent:!!(path&&!opts.remoteUrl&&!opts.github&&!opts.google&&!opts.force),requestId:opts.requestId,expectedIncarnation:opts.expectedIncarnation};
}
export async function addManagedSource(engine:BrainEngine,opts:AddSourceOpts):Promise<SourceRow>{
  const result=await runManagedSourceLifecycle(engine,managedSourceAddInput(opts));
  assertTopologyCommitted(result);
  const [row]=await engine.executeRaw<SourceRow>('SELECT * FROM sources WHERE id=$1 AND incarnation=$2::uuid',[opts.id,result.source_incarnation]);
  if(!row)throw new OperationError('source_changed','The created source was subsequently removed.');
  return row;
}
