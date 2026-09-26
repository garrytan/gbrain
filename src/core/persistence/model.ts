import type { BrainEngine } from '../engine.ts';

export type Principal = { kind: 'oauth_client' | 'legacy_token' | 'local_cli' | 'local_stdio' | 'application'; id: string };
export type RequestState = 'queued' | 'running' | 'recovering' | 'committed' | 'conflict' | 'failed' | 'cancelled';
export interface WriteAuthority {
  version: 1;
  principal: Principal;
  remote: boolean;
  /** Original page-visibility ceiling; current policy can only narrow it. */
  excludePrivate?: boolean;
  databaseOnlyReason?: 'subagent_sandbox' | 'disabled_by_config' | 'no_repo_configured' | 'connector_database';
  autoLinkTrusted?: boolean;
  restrictedNamespace?: boolean;
  sourceId: string;
  sourceIncarnation: string;
  scopes: string[];
  operations: string[] | null;
  slugPrefixes: string[] | null;
  delegatedPrefixes?: string[] | null;
  delegated?: boolean;
  takesHolders?: string[] | null;
  /** Actual holders touched by a published take mutation; retained after intent compaction. */
  takeHoldersUsed?: string[];
}
export interface FileRecoveryRecord {
  version: 1;
  path: string;
  root: string;
  before: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  mode: number | null;
  afterMode?: number;
  ownerEpoch: string;
  attempt: string;
  after?: string | null;
  /** Absent on recovery records created by older binaries. */
  staging?: import('./staging.ts').RecoveryStaging;
}
export interface BundleRecoveryRecord {
  version: 2;
  target: 'skill_bundle';
  root: string;
  ownerEpoch: string;
  attempt: string;
  files: FileRecoveryRecord[];
  staging?: never;
  beforeHash?: never;
}
export type RecoveryRecord = FileRecoveryRecord | BundleRecoveryRecord;
export function recoveryFiles(record: RecoveryRecord): FileRecoveryRecord[] {
  if (record.version === 1) return [record];
  if (record.version === 2 && record.target === 'skill_bundle' && Array.isArray(record.files)
    && record.files.length > 0 && record.files.length <= 128 && record.files.every(file => file.version === 1)) return record.files;
  throw new Error('unsupported_mutation_protocol');
}
export interface WriteRequest {
  id: string;
  principal_kind: Principal['kind'];
  principal_id: string;
  request_id: string;
  operation: string;
  target_kind?: 'page' | 'skill_bundle';
  protocol_version?: 1 | 2;
  source_id: string;
  source_incarnation: string;
  page_id: number | null;
  slug: string;
  worktree_id: string | null;
  topology_generation: string | number | null;
  digest: string;
  intent: Record<string, unknown> | null;
  authority: WriteAuthority;
  sequence: string | number;
  state: RequestState;
  execution_token: string | null;
  claim_expires_at: Date | string | null;
  recovery: RecoveryRecord | null;
  recovery_bytes: string | number;
  intent_bytes: string | number;
  terminal_reservation: string | number;
  outcome: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  blocked_reason: string | null;
  compacted: boolean;
  publication_started: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}
export const TERMINAL_STATES: ReadonlySet<RequestState> = new Set(['committed', 'conflict', 'failed', 'cancelled']);
export interface JournalLimits {
  principalOutstanding: number; brainOutstanding: number;
  principalIntentBytes: number; brainIntentBytes: number;
  principalLifetimeIds: number; brainLifetimeIds: number;
  principalTerminalBytes: number; brainTerminalBytes: number;
  brainRecoveryBytes: number; worktreeRecoveryBytes: number;
}
export const DEFAULT_JOURNAL_LIMITS: Readonly<JournalLimits> = Object.freeze({
  principalOutstanding: 100, brainOutstanding: 1000,
  principalIntentBytes: 32 * 1024 ** 2, brainIntentBytes: 256 * 1024 ** 2,
  principalLifetimeIds: 100_000, brainLifetimeIds: 1_000_000,
  principalTerminalBytes: 128 * 1024 ** 2, brainTerminalBytes: 1024 ** 3,
  brainRecoveryBytes: 1024 ** 3, worktreeRecoveryBytes: 256 * 1024 ** 2,
});
export type SqlEngine = Pick<BrainEngine, 'executeRaw'>;
export function principalKey(p: Principal): string { return `principal:${p.kind}:${p.id}`; }
export function requestPrincipal(r: WriteRequest): Principal { return { kind: r.principal_kind, id: r.principal_id }; }
export function isTerminal(r: Pick<WriteRequest, 'state'>): boolean { return TERMINAL_STATES.has(r.state); }
