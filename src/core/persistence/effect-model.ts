import type { WriteRequest } from './model.ts';

export type EffectKind = 'git' | 'embedding' | 'withdrawal-mirror' | 'facts-backstop';
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
  data: { slug?: string; page_id?: number; relative_path?: string; expected_hash?: string | null; after_slug?: string; source_id?: string; source_scan?: boolean; visibility?: 'private' | 'world'; embedding_attempt_base?: number; embedding_retry_base?: number };
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
