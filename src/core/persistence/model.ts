import type { BrainEngine } from '../engine.ts';
import { assertRecoveryVersion } from './recovery-version.ts';
import { UNATTRIBUTED_MEMORY_SLUG } from '../facts-fence.ts';

export type Principal = { kind: 'oauth_client' | 'legacy_token' | 'local_cli' | 'local_stdio' | 'application'; id: string };
/** `deferred` (PR B, docs/designs/REFRESH_WRITE_BARRIER.md): admitted during a worktree refresh, unclaimable until it is released. */
export type RequestState = 'queued' | 'deferred' | 'running' | 'recovering' | 'committed' | 'conflict' | 'failed' | 'cancelled';
export interface WriteAuthority {
  /** The caller's self-declared agent label (X-Gbrain-Agent-Label). Unverified text: nothing authorizes on it. */
  agentLabel?: string;
  version: 1;
  principal: Principal;
  remote: boolean;
  /** Original page-visibility ceiling; current policy can only narrow it. */
  excludePrivate?: boolean;
  /**
   * GBRA-231: the audience a shared agent asserted for the write (normalized member:<id>, group:<g>, guest). Preparation
   * and publication re-resolve it against the principal's live may_act_for and members, never the principal's own member.
   */
  /**
   * GST-359 C1: or the attested actor { system, external_id, member } the write was accepted for. Preparation and
   * publication re-resolve it through actorCoverage (access/actor.ts): the principal's live attest right and a live
   * link from the id to the same enabled member, so an unlink, a disabled member or a revoked right refuses it.
   */
  actingFor?: string[] | { system: string; external_id: string; member: string };
  /**
   * GST-363: the member a local_stdio writer's serve was started with (`gbrain serve --stdio-member`). Preparation and
   * publication re-resolve it live (a disabled member reads as nobody); absent, they read config mcp.stdio_member.
   */
  stdioMember?: string;
  /** GST-359 D: the attested operation this write serves when it differs from the stored one (memory_write as remember). */
  attestedOp?: string;
  /** GST-1113: the scope source an attested memory_write named instead of the principal's own; publication re-checks attest_sources. */
  attestedSource?: string;
  /**
   * GST-2492: the entity a remember held on memory/unattributed is for (a strict source, the entity has no page). The
   * write is authorized as a write to that entity (its slug fences, grant prefixes and visibility), never to the
   * holding page, which is gbrain's own companion to it.
   */
  heldFor?: string;
  databaseOnlyReason?: 'subagent_sandbox' | 'disabled_by_config' | 'no_repo_configured' | 'connector_database' | 'unbound_source' | 'overwrite_restore' | 'detached' | 'entity_page_missing';
  autoLinkTrusted?: boolean;
  restrictedNamespace?: boolean;
  sourceId: string;
  sourceIncarnation: string;
  scopes: string[];
  operations: string[] | null;
  slugPrefixes: string[] | null;
  delegatedPrefixes?: string[] | null;
  delegated?: boolean;
  /** Minions job that accepted an OAuth-delegated write; a live `job` grant re-derives only that job's namespace from it. */
  delegatedJobId?: number;
  takesHolders?: string[] | null;
  /** Actual holders touched by a published take mutation; retained after intent compaction. */
  takeHoldersUsed?: string[];
}
/** GST-2492: the slug a write is authorized as: a held remember's entity in place of the holding page, else the page itself. */
export function authorizedSlug(authority: Pick<WriteAuthority, 'heldFor'>, slug: string): string {
  return authority.heldFor && slug === UNATTRIBUTED_MEMORY_SLUG ? authority.heldFor : slug;
}

/**
 * One file's publication recovery. The prior bytes are embedded (`before`, base64), except for a prior file over the
 * single-string ceiling (large-file.ts): `before` is null and the bytes are the staged copy `staging.before` (path,
 * SHA-256 = `beforeHash`, length), which recovery renames back. Its `.tmp.before-<uuid>` name is not a stage name
 * binaries that predate it accept, so they block on it (`unexpected_staging_bytes`) instead of reading `before: null`
 * as an absent file.
 */
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
  /** G2 (git-door.ts): a strict source's publication, which commits before its database row; the checkout and the HEAD it started from. */
  door?: { root: string; head: string | null };
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
/**
 * GBRA-190 G4 (D2): the page files one publication writes together (a withdrawal's pages), restored together and
 * committed in one Git commit. Each file is a page file record (version 1 fields, door included on a strict source);
 * `files[0]` is the request's own page when it has a file. Binaries that predate it refuse version 3 unread.
 */
export interface PagesRecoveryRecord {
  version: 3;
  target: 'pages';
  root: string;
  ownerEpoch: string;
  attempt: string;
  files: FileRecoveryRecord[];
  staging?: never;
  beforeHash?: never;
}
export type RecoveryRecord = FileRecoveryRecord | BundleRecoveryRecord | PagesRecoveryRecord;
/** The most page files one publication writes together (a withdrawal's bound, withdrawal-discovery.ts). */
export const PAGES_RECOVERY_MAX_FILES = 256;
export function recoveryFiles(record: RecoveryRecord): FileRecoveryRecord[] {
  assertRecoveryVersion('persistence_requests', record, null);
  if (record.version === 1) return [record];
  if (record.version === 2 && record.target === 'skill_bundle' && Array.isArray(record.files)
    && record.files.length > 0 && record.files.length <= 128 && record.files.every(file => file.version === 1)) return record.files;
  if (record.version === 3 && record.target === 'pages' && Array.isArray(record.files)
    && record.files.length > 0 && record.files.length <= PAGES_RECOVERY_MAX_FILES && record.files.every(file => file.version === 1)) return record.files;
  throw new Error('unsupported_mutation_protocol');
}
/** A shared-skill bundle's record, whose files are bundle files (bundle-files.ts), not page files. */
export function isBundleRecovery(record: RecoveryRecord): record is BundleRecoveryRecord {
  return record.version === 2;
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
  /** The refresh a deferred write was admitted behind; kept after it drains, so its claim runs the refresh-change check. */
  deferred_refresh_id?: string | null;
  /** GST-1582: the source's last imported commit ('' for none) when a claimed write was held for an import; kept after it lands. */
  deferred_import_from?: string | null;
  execution_token: string | null;
  claim_expires_at: Date | string | null;
  recovery: RecoveryRecord | null;
  recovery_bytes: string | number;
  intent_bytes: string | number;
  terminal_reservation: string | number;
  outcome: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  /** #5974 structured failure (publication-failure.ts); receipts expose only its public view. */
  error_detail?: Record<string, unknown> | null;
  blocked_reason: string | null;
  /** F6: the non-UUID request_id the client sent (request_id is its UUIDv5); outside the intent digest, kept through compaction. */
  client_request_id?: string | null;
  compacted: boolean;
  publication_started: boolean;
  /** #6278 (v220): preparations cut off by a deadline or an expired `preparing` claim; reset by a commit. Absent on rows read before the migration. */
  /** #6176 (v217): the owner's claim-phase stamp (claim-phase.ts), read back by `claimStateOf`; absent on rows read before the migration. */
  claim_phase?: unknown;
  preparation_attempts?: number;
  /** Large-pages hardening (v261): transient interruptions counted against `persistence.max_transient_retries` (transient-retry.ts). */
  transient_interruptions?: number;
  /** v261: the earliest time a claim takes this queued row again (a transient interruption's backoff); null means now. */
  next_attempt_at?: Date | string | null;
  /** #6278: on a row the claim statements return: the stamp the previous claim left (its last recorded step). Never stored. */
  previous_claim_phase?: unknown;
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
/**
 * Cumulative defaults are sized so one principal admitting 600 writes a day
 * (the reported autopilot workload) runs at least one year: lifetime IDs last
 * about 417 days; receipt bytes hold a 30-day window of 16 KiB reservations
 * plus about 4 KiB retained per compacted receipt for about 590 days.
 * Outstanding intent per principal holds two page-ceiling writes
 * (page-size-policy.ts, 24 MiB each, JSON-escaped) plus headroom, so one
 * large write never refuses another from the same principal.
 */
export const DEFAULT_JOURNAL_LIMITS: Readonly<JournalLimits> = Object.freeze({
  principalOutstanding: 100, brainOutstanding: 1000,
  principalIntentBytes: 64 * 1024 ** 2, brainIntentBytes: 256 * 1024 ** 2,
  // GBRA-108: the cumulative caps are opt-in (Infinity until persistence.limits.* sets one); housekeeping and doctor bound receipt storage.
  principalLifetimeIds: Infinity, brainLifetimeIds: Infinity,
  principalTerminalBytes: Infinity, brainTerminalBytes: Infinity,
  brainRecoveryBytes: 1024 ** 3, worktreeRecoveryBytes: 256 * 1024 ** 2,
});
export type SqlEngine = Pick<BrainEngine, 'executeRaw'>;
export function principalKey(p: Principal): string { return `principal:${p.kind}:${p.id}`; }
export function requestPrincipal(r: WriteRequest): Principal { return { kind: r.principal_kind, id: r.principal_id }; }
export function isTerminal(r: Pick<WriteRequest, 'state'>): boolean { return TERMINAL_STATES.has(r.state); }
