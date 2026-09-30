import type { SourceLifecycleInput } from './source-lifecycle.ts';
export interface TopologyCloneRecovery {
  version:1;kind:'clone';phase:'reserved'|'prepared'|'aborting';operation:'add'|'reclone';
  sourceId:string;incarnation:string;worktreeId:string;ownerHostId:string;ownerEpoch:string;
  target:string;stage:string;aside:string;beforeHash:string|null;afterHash:string|null;
  manifest:{digest:string;files:Record<string,string>;canonical_stamp?:string}|null;
  canonicalStamp:string;checkpoint:string|null;sourceRemoteUrl:string|null;input:SourceLifecycleInput;cloneBudget:number;
  stageIdentity?:{device:string;inode:string;birthNs:string};failureCode?:string;
}
