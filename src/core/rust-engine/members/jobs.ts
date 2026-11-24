/** The Minion queue, queue health, spend ledger and job table members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const JOBS_MEMBERS = {
  takePageEmbeddingLease: 'minion_queue',
  renewPageEmbeddingLease: 'minion_queue',
  releasePageEmbeddingLease: 'minion_queue',
  readOauthClient: 'minion_queue',
  readScopeSourceConfigs: 'minion_queue',
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
