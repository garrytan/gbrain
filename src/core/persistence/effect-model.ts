import type { WriteRequest } from './model.ts';
import type { WithdrawalTarget } from '../facts/withdrawal-discovery.ts';
import { fenceRepairCommitSubject, type FenceRepairReceipt } from '../fence-repair/receipt.ts';
import { contentRepairCommitSubject, contentRepairTrailer, type ContentRepairReceipt } from '../content-repair/receipt.ts';

export type EffectKind = 'git' | 'embedding' | 'withdrawal-mirror' | 'facts-backstop' | 'links';
/** Brain config key gating the remote mention-links effect; unset is on, false/0/no/off turns it off. */
export const REMOTE_AUTO_LINKS_KEY = 'mcp.remote_auto_links';
/** link_source owned by the `links` effect; reconciliation of this producer never touches other producers' edges. */
export const REMOTE_MENTION_LINK_SOURCE = 'mcp-remote-mention';
/**
 * Operations whose remote publications queue a whole-page `links` effect. #7122: a remote append_page queues one
 * scoped to the truth bytes it appended (`data.range`, effect-links.ts), so it never re-reads the page.
 */
export const REMOTE_MENTION_OPERATIONS: readonly string[] = ['put_page', 'capture', 'edit_page'];
/** #7122: the stored truth-region bytes [start, end) an append added and their SHA-256, the only text its `links` effect reads. */
export interface AppendedRange { start: number; end: number; sha256: string }
/**
 * Commit metadata a trusted local preparer attaches to a page file target
 * (a fence or content repair): the subject when the file commits alone, its
 * body line when it commits with other files, and the `gbrain-repair:` Git
 * trailer (`<hold_code> <tier> <confidence>`) the Git effect prints after a
 * blank line, so `git log --format=%(trailers)` finds every repair commit.
 * Location only, never page text.
 */
export interface GitCommitNote { subject: string; line: string; trailer?: string }
const safe = (path: string) => path.replace(/[\u0000-\u001f\u007f]/g, '?');
/** A fence-repaired file's note: `fenceRepairCommitSubject` alone, `<path> (<classes>)` as its line in a batched commit, trailer `gbrain-repair: invalid_fence <tier> high`. */
export function fenceRepairCommit(path: string, classes: readonly string[], tier: FenceRepairReceipt['tier'] = 'deterministic'): GitCommitNote {
  return { subject: fenceRepairCommitSubject(path, classes), line: `${safe(path)} (${classes.join(', ')})`, trailer: `gbrain-repair: invalid_fence ${tier} high` };
}
/** #6377 a slug-conflict repair's note: `gbrain: repair frontmatter slug in <path>`, `<path> (frontmatter_slug_conflict)` in a batch, trailer from the receipt's tier and confidence. */
export function contentRepairCommit(path: string, receipt: Pick<ContentRepairReceipt, 'tier' | 'confidence'>): GitCommitNote {
  return { subject: contentRepairCommitSubject(path), line: `${safe(path)} (frontmatter_slug_conflict)`, trailer: contentRepairTrailer(receipt) };
}
/** `rule`: for `git_target_ignored`, the .gitignore rule that excludes the file (`<file>:<line>: <pattern>`). */
export interface ParkedTarget { slug?: string; error_code: string; rule?: string }
/** #7423 / #7378: a settled target: under a declared db_only dir (`declared`), or its current bytes proved on the fetched remote (effect-settle.ts). */
export type SettledTarget = { slug: string; declared: string }
  | { slug: string; path: string; remote_ref: string; remote_commit: string; blob: string; receipt_request_id: string };
export type SettlementProof = { kind: 'db_only'; worktree_id: string; targets: SettledTarget[] }
  | { kind: 'superseded_remote'; former_worktree_id: string; worktree_id: string; targets: SettledTarget[] };
/** The disposition `gbrain sources writer settle-effects` records on a Git effect whose retry can never succeed. */
export interface EffectSettlement { reason: SettlementProof['kind']; at: string; host_id: string; plan_hash: string; proof: SettlementProof }
/** `page_body_segmented`: a segmented page an older binary's mirror or Git scan passed by; this one mirrors and commits it. */
/** `preview_changed`: a `gbrain repair segmented-mirror` target whose file or render no longer has the hash its preview approved (`data.approved_file`). */
export interface SkippedTarget { slug: string; reason: 'metafile' | 'file_database_drift' | 'page_body_segmented' | 'withdrawal_not_mirrored' | 'preview_changed' }
/** The code a page behind a failed withdrawal mirror is parked with: its file may still hold the withdrawn text. */
export const WITHHELD_BY_MIRROR = 'withdrawal_mirror_failed';
/** A Git or withdrawal target parks after this many consecutive execution failures. */
export const PARK_AFTER_FAILURES = 5;
/**
 * A withdrawal mirror's recovery record. Version 1 embeds the mirrored file (`after`, base64). Version 2 is a segmented
 * page's file, never held whole: `after` is null and `staging.publication` names the file streamed from the page's
 * segments by path, SHA-256 (`afterHash`) and length, written once the record is durable (effect-recovery.ts).
 */
export interface EffectRecovery {
  version: 1 | 2;
  kind: 'withdrawal-mirror';
  path: string;
  root: string;
  beforeHash: string | null;
  afterHash: string;
  after: string | null;
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
    /** Wave B: the occurrences a segmented write added; its embedding effect embeds only their chunk rows. */
    occurrence_ids?: number[];
    /** #7122: an append's `links` effect mines only these appended truth bytes and never removes an edge. */
    range?: AppendedRange;
    /** A single-file Git target's GitCommitNote, when its preparer gave one. */
    commit_subject?: string;
    commit_line?: string;
    commit_trailer?: string;
    /** G2 (git-door.ts): the file was committed with its publication (a strict source); the effect only pushes. */
    push_only?: boolean;
    /** Consecutive execution failures of the current Git or withdrawal target. */
    target_failures?: number;
    /** GBRA-133: consecutive `writer_busy` retries of this streak, when the streak began and when its last retry was recorded (ISO). */
    busy_retries?: number;
    busy_since?: string;
    busy_at?: string;
    /** The target `target_failures` belongs to; a different target starts from zero. */
    failing_target?: string;
    /** Targets set aside after repeated failures; a slugless entry parks the whole effect. */
    parked?: ParkedTarget[];
    /** Parked scan targets an explicit retry authorized for one more attempt. */
    retry_slugs?: string[];
    /** Explicit retry authorizations granted to this effect's parked targets. */
    retried?: number;
    /** #5396: scan targets passed without a file publication (a sync-skip metafile, or a file with an uncoordinated local edit). */
    skipped?: SkippedTarget[];
    /** A `gbrain repair segmented-mirror` target: the file and render SHA-256 its preview approved; the mirror rewrites the file only while both still match. */
    approved_file?: { slug: string; file_sha256: string; expected_sha256: string };
    /** GBRA-130 A-12: pages whose file this withdrawal mirror rewrote, recorded by its recovery with the cursor step. */
    published?: string[];
    /** The SHA-256 of the bytes this mirror wrote to each published page's file, at the page revision it rendered. */
    published_files?: Record<string, { hash: string; revision: string }>;
    /** #7423 / #7378: present while the effect is settled; every reader of parked and held effects skips it. */
    settled?: EffectSettlement;
    /** Every settle and unsettle of this effect, oldest first; never trimmed. */
    settlements?: Array<Record<string, unknown> & { action: 'settled' | 'unsettled'; at: string; host_id: string; plan_hash: string }> };
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
