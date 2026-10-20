/**
 * apple loops-status — what the open-loop engine may claim about an Apple Mail source, from config and the
 * connector cursor state alone. Dependency-light on purpose: `open_loops` (ops/loops.ts) imports it to decide
 * whether an Apple source can answer at all, and the detection code (loops.ts) pulls in the Google loop engine.
 *
 * Policy (issue #6855, finding 8):
 *  - Direction comes ONLY from `a_mail_owner_addresses`. The account label is a free text and Sent-mailbox
 *    membership is never read as identity (aliases, shared mailboxes). Without owner addresses the feature is
 *    `unavailable: identity_missing`, which is not "clean": nothing is detected, nothing is claimed.
 *  - Freshness comes ONLY from a Mail sweep that was complete, in the same run that detected loops
 *    (`mail_loops.complete_at`). A Contacts or Calendar sync, a partial Mail run or a stale listing never
 *    makes Mail loops fresh.
 *  - Apple has no Gmail labels: label exclusions and the bulk-category rule have no Apple equivalent. The
 *    reader's header verdicts (`automated`, `bulk`) stand in for list/auto-submitted mail, and anything the
 *    Apple side cannot evaluate fails closed (see loops.ts).
 */
import { createHash } from 'node:crypto';
import type { AppleMailLoopsState, AppleSourceConfig, AppleSourceState } from './types.ts';

export const APPLE_LOOPS_STALE_AFTER_MS = 24 * 3_600_000;

/** Hold keys that can hide an unanswered-mail loop: a Mail thread (`mail:<thread>`) or an unreadable Mail message (`mail-message:<id>`). */
export const isAppleMailHoldKey = (key: string): boolean => key.startsWith('mail:') || key.startsWith('mail-message:');

export type AppleLoopsUnavailableReason = 'mail_disabled' | 'identity_missing';

export type AppleLoopsAvailability =
  | { available: false; reason: AppleLoopsUnavailableReason }
  | { available: true; extraction: 'enabled' | 'consent_missing' };

/** Whether deterministic tracking can run (and whether paid extraction has its Apple consent). */
export function appleLoopsAvailability(cfg: Pick<AppleSourceConfig, 'services' | 'mailOwnerAddresses' | 'loopsExtractConsent'>): AppleLoopsAvailability {
  if (!cfg.services.includes('mail')) return { available: false, reason: 'mail_disabled' };
  if (cfg.mailOwnerAddresses.length === 0) return { available: false, reason: 'identity_missing' };
  return { available: true, extraction: cfg.loopsExtractConsent ? 'enabled' : 'consent_missing' };
}

/** Digest of the owner set: stored loops are valid for exactly this identity. */
export function appleOwnerDigest(owners: Iterable<string>): string {
  return createHash('sha256').update([...new Set(owners)].sort().join('\n')).digest('hex').slice(0, 16);
}

export interface AppleLoopsFreshness {
  last_sync_at: string | null;
  stale: boolean;
}

/**
 * Freshness of one available Apple source. `null` timestamp (never completed, or completed for another owner
 * set) reads as stale: the caller refuses to answer confidently from it.
 */
export function appleLoopsFreshness(
  cfg: Pick<AppleSourceConfig, 'mailOwnerAddresses'>,
  state: Pick<AppleSourceState, 'mail_loops'> | Record<string, unknown> | null | undefined,
  nowMs: number = Date.now(),
): AppleLoopsFreshness {
  const loops = (state as { mail_loops?: AppleMailLoopsState } | null | undefined)?.mail_loops;
  const at = loops?.digest === appleOwnerDigest(cfg.mailOwnerAddresses) && loops.reread !== true && !loops.coverage_gap && !(loops.pending_threads?.length) ? loops.complete_at : undefined;
  const ms = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(ms)) return { last_sync_at: null, stale: true };
  return { last_sync_at: new Date(ms).toISOString(), stale: nowMs - ms > APPLE_LOOPS_STALE_AFTER_MS };
}

/**
 * The disclosure shown before extraction is enabled. Deterministic unanswered tracking makes no model call
 * and needs no consent; extraction sends thread TEXT to the chat provider configured for this brain.
 */
export const APPLE_LOOPS_EXTRACT_DISCLOSURE =
  'Commitment and decision extraction sends the text of recent Mail threads (sender, recipients, subject and plain-text body) '
  + 'to the chat provider configured for this brain, one model call per eligible thread, within the daily loop-extraction spend cap. '
  + 'It also needs the global switch loops.extraction_enabled (default on). Unanswered-mail tracking does not use a model and is not affected.';
