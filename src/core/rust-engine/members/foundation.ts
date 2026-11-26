/** The lifecycle, raw SQL, schema and transaction members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const FOUNDATION_MEMBERS = {
  beginSnapshotRead: 'transactions',
  declarePersistence: 'transactions',
  requireSynchronousCommit: 'transactions',
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
