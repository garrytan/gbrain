import type { WriteRequest } from './model.ts';
import type { WithdrawalTarget } from '../facts/withdrawal-discovery.ts';

export type EffectKind = 'git' | 'embedding' | 'withdrawal-mirror' | 'facts-backstop';
export interface ParkedTarget { slug?: string; error_code: string }
export interface SkippedTarget { slug: string; reason: 'metafile' | 'file_database_drift' }
/** A Git or withdrawal target parks after this many consecutive execution failures. */
export const PARK_AFTER_FAILURES = 5;
export interface EffectRecovery {
  version: 1;
  kind: 'withdrawal-mirror';
  path: string;
  root: string;
  beforeHash: string | null;
  afterHash: string;
  after: string;
  mode: number | null;
  ownerEpoch: string;
  pageId: number;
  sourceIncarnation: string;
  slug: string;
  revision: string;
  staging?: import('./staging.ts').RecoveryStaging;
}
export interface PersistenceEffect {
  id: string | number;
  request_id: string;
  kind: EffectKind;
  revision: string | null;
  source_id: string;
  source_incarnation: string;
  worktree_id: string | null;
  data: { version?: 2; targets?: WithdrawalTarget[]; slug?: string; page_id?: number; relative_path?: string; expected_hash?: string | null; after_slug?: string; source_id?: string; source_scan?: boolean; visibility?: 'private' | 'world'; embedding_attempt_base?: number; embedding_retry_base?: number;
    /** Consecutive execution failures of the current Git or withdrawal target. */
    target_failures?: number;
    /** The target `target_failures` belongs to; a different target starts from zero. */
    failing_target?: string;
    /** Targets set aside after repeated failures; a slugless entry parks the whole effect. */
    parked?: ParkedTarget[];
    /** Parked scan targets an explicit retry authorized for one more attempt. */
    retry_slugs?: string[];
    /** Explicit retry authorizations granted to this effect's parked targets. */
    retried?: number;
    /** #5396: scan targets passed without a file publication (a sync-skip metafile, or a file with an uncoordinated local edit). */
    skipped?: SkippedTarget[] };
  state: 'queued' | 'running' | 'committed' | 'failed';
  execution_token: string | null;
  claim_expires_at: string | Date | null;
  attempts: number;
  error_code: string | null;
  recovery: EffectRecovery | null;
  recovery_bytes: string | number;
  outcome: Record<string, unknown> | null;
}
export type EffectRequest = Pick<WriteRequest, 'id' | 'source_id' | 'source_incarnation' | 'slug' | 'worktree_id'>;
