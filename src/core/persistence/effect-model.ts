import type { WriteRequest } from './model.ts';
import type { WithdrawalTarget } from '../facts/withdrawal-discovery.ts';
import { fenceRepairCommitSubject, type FenceRepairReceipt } from '../fence-repair/receipt.ts';
import { contentRepairCommitSubject, contentRepairTrailer, type ContentRepairReceipt } from '../content-repair/receipt.ts';

export type EffectKind = 'git' | 'embedding' | 'withdrawal-mirror' | 'facts-backstop' | 'links';
/** Brain config key gating the remote mention-links effect; unset is on, false/0/no/off turns it off. */
export const REMOTE_AUTO_LINKS_KEY = 'mcp.remote_auto_links';
/** link_source owned by the `links` effect; reconciliation of this producer never touches other producers' edges. */
export const REMOTE_MENTION_LINK_SOURCE = 'mcp-remote-mention';
/** Operations whose remote publications queue a `links` effect. */
export const REMOTE_MENTION_OPERATIONS: readonly string[] = ['put_page', 'capture', 'edit_page'];
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
    /** A single-file Git target's GitCommitNote, when its preparer gave one. */
    commit_subject?: string;
    commit_line?: string;
    commit_trailer?: string;
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
