import { isAbsolute } from 'node:path';
import type { SyncOpts } from '../../commands/sync.ts';
import { opError } from '../ops/contract.ts';
import { SYNC_FLAGS, syncFlagsRouted, syncWireFields, type SyncFlagSpec } from '../sync-flags.ts';
import { retiredWireFields } from '../wire-skew.ts';

const OWNER_FLAGS = SYNC_FLAGS as Record<string, SyncFlagSpec>;
const forwarded = syncFlagsRouted('owner', 'forward');
/** The owner lane's view of the one sync flag table (`src/core/sync-flags.ts`): boolean flags it forwards. */
export const SYNC_BOOLEAN_FLAGS: Record<string, string> = Object.fromEntries(forwarded.filter(flag => OWNER_FLAGS[flag].arity === 'boolean').map(flag => [flag, OWNER_FLAGS[flag].field!]));
/** Value flags it forwards (`--exclude` and `--include-hidden` repeat). */
export const SYNC_VALUE_FLAGS: Record<string, string> = Object.fromEntries(forwarded.filter(flag => OWNER_FLAGS[flag].arity !== 'boolean').map(flag => [flag, OWNER_FLAGS[flag].field!]));
/** Flags the CLI consumes itself or that mean nothing to a PGLite owner (`--lanes`: PGLite runs no bulk lanes); never sent. */
export const SYNC_CLIENT_FLAGS: ReadonlySet<string> = new Set(syncFlagsRouted('owner', 'client'));
export interface SyncWireParams { options: SyncOpts; cwd: string; timeoutSeconds: number; ignored?: string[] }
const invalid = () => opError('invalid_params','Invalid or unsupported local sync options.',
  'Run gbrain sync from the CLI (gbrain sync --help lists its flags); it builds the options this owner lane accepts.');
export function validateSyncWireParams(value: Record<string,unknown>): SyncWireParams {
  if (Object.keys(value).some(k=>!['options','cwd','timeoutSeconds'].includes(k)) || typeof value.cwd!=='string' ||
      !isAbsolute(value.cwd) || value.cwd.length>32768 || value.cwd.includes('\0') || typeof value.timeoutSeconds!=='number' ||
      !Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds<0 || value.timeoutSeconds>86400 ||
      !value.options || typeof value.options!=='object' || Array.isArray(value.options)) throw invalid();
  const fields=syncWireFields('owner'), retired=retiredWireFields('owner'), ignored:string[]=[];
  const options:Record<string,unknown>={};
  for(const [key,item] of Object.entries(value.options)) {
    const window=retired.get(key);
    if(window) { if(!window.accepts(item))throw invalid(); ignored.push(key); continue; }
    const type=fields[key];
    if(type==='boolean') { if(typeof item!=='boolean')throw invalid(); }
    else if(type==='string') { if(typeof item!=='string'||!item||item.length>32768||item.includes('\0'))throw invalid(); }
    else if(type==='string[]') {
      if(!Array.isArray(item)||item.length>256||item.some(v=>typeof v!=='string'||!v||v.length>4096||v.includes('\0')))throw invalid();
    } else throw invalid();
    options[key]=item;
  }
  if(options.strategy&&!['markdown','code','auto'].includes(options.strategy as string))throw invalid();
  return {options:options as SyncOpts,cwd:value.cwd,timeoutSeconds:value.timeoutSeconds,...(ignored.length?{ignored}:{})};
}
