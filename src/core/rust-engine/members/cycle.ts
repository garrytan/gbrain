/** The dream cycle and contradiction members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const CYCLE_MEMBERS = {
  listLiveChunksByIds: 'chunks',
  listLiveTakesByIds: 'takes',
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
