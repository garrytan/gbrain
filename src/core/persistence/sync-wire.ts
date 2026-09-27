import { isAbsolute } from 'node:path';
import type { SyncOpts } from '../../commands/sync.ts';
import { OperationError } from '../ops/contract.ts';

export const SYNC_BOOLEAN_FLAGS = {
  '--full':'full','--dry-run':'dryRun','--no-pull':'noPull','--no-embed':'noEmbed','--no-extract':'noExtract',
  '--no-schema-pack':'noSchemaPack','--retry-failed':'retryFailed','--skip-failed':'skipFailed',
  '--include-gitignored':'includeGitignored','--working-tree':'workingTree',
} as const;
export const SYNC_VALUE_FLAGS = { '--source':'sourceId','--repo':'repoPath','--src-subpath':'srcSubpath','--strategy':'strategy',
  '--exclude':'exclude','--include-hidden':'includeHidden' } as const;
export interface SyncWireParams { options: SyncOpts; cwd: string; timeoutSeconds: number; }
const invalid = () => new OperationError('invalid_params','Invalid or unsupported local sync options.');
export function validateSyncWireParams(value: Record<string,unknown>): SyncWireParams {
  if (Object.keys(value).some(k=>!['options','cwd','timeoutSeconds'].includes(k)) || typeof value.cwd!=='string' ||
      !isAbsolute(value.cwd) || value.cwd.length>32768 || value.cwd.includes('\0') || typeof value.timeoutSeconds!=='number' ||
      !Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds<0 || value.timeoutSeconds>86400 ||
      !value.options || typeof value.options!=='object' || Array.isArray(value.options)) throw invalid();
  const booleanFields=new Set<string>(Object.values(SYNC_BOOLEAN_FLAGS));
  const stringFields=new Set<string>(['sourceId','repoPath','srcSubpath','strategy']);
  for(const [key,item] of Object.entries(value.options)) {
    if (booleanFields.has(key)) { if(typeof item!=='boolean')throw invalid(); }
    else if(stringFields.has(key)) { if(typeof item!=='string'||!item||item.length>32768||item.includes('\0'))throw invalid(); }
    else if(['exclude','includeHidden'].includes(key)) {
      if(!Array.isArray(item)||item.length>256||item.some(v=>typeof v!=='string'||!v||v.length>4096||v.includes('\0')))throw invalid();
    } else throw invalid();
  }
  const options=value.options as SyncOpts;
  if(options.strategy&&!['markdown','code','auto'].includes(options.strategy))throw invalid();
  return {options:{...options},cwd:value.cwd,timeoutSeconds:value.timeoutSeconds};
}
