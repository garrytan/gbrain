/**
 * `chronicle-backfill --max-usd` campaigns (#6199): a hard spend bound fixed at queue time.
 *
 * The executor makes a fresh BudgetTracker per attempt and retries failed pages, and the tracker
 * sees an overrun only after the call that causes it. So a campaign admits a page only while
 * queued pages × (per-attempt cap + one call's ceiling) × maximum attempts stays within
 * `--max-usd`, and stamps each queued ledger row with the campaign, the per-attempt cap, the
 * maximum attempts and the pricing policy. Every executor reads the stamp, never current
 * settings; attempts are consumed when a row is claimed (execute.ts), so a crash cannot hand out
 * an extra attempt. No campaign table and no runtime reservation are needed.
 */
import type { BrainEngine } from '../engine.ts';
import type { PricingOverrides } from '../budget/budget-tracker.ts';
import { usageCostUsd } from '../budget/reservation-cost.ts';
import { CHRONICLE_DEFAULTS, CHRONICLE_EXTRACTOR_VERSION, type ChronicleLedgerRow } from './contract.ts';
import { JUDGE_BODY_CHARS, JUDGE_PROMPT_CHARS } from './extract-events.ts';

/** The only stamped pricing policy: the stamped per-attempt cap is enforced (an unpriced model refuses). */
export const CAMPAIGN_PRICING_POLICY = 'enforced';

export interface ChronicleCampaignStamp {
  campaignId: string;
  attemptCapUsd: number;
  maxAttempts: number;
  maxUsd: number;
}

/**
 * Upper bound of one judge call in USD: every input character counted as up to three tokens
 * (its UTF-8 bytes, which bound a byte-level tokenizer) plus the full output cap. Null when the
 * model is unpriced.
 */
export function chronicleCallCeilingUsd(model: string, maxOutputTokens: number, overrides?: PricingOverrides): number | null {
  return usageCostUsd(model, 3 * (JUDGE_BODY_CHARS + JUDGE_PROMPT_CHARS), maxOutputTokens, 'chat', overrides);
}

/** The most one queued page can spend: every attempt at its cap plus one call's overshoot. */
export function campaignPageWorstCaseUsd(stamp: Pick<ChronicleCampaignStamp, 'attemptCapUsd' | 'maxAttempts'>, callCeilingUsd: number): number {
  return (stamp.attemptCapUsd + callCeilingUsd) * stamp.maxAttempts;
}

/** A row's attempt limit: its stamp, else the default. */
export function rowMaxAttempts(row: Pick<ChronicleLedgerRow, 'max_attempts'>): number {
  return row.max_attempts ?? CHRONICLE_DEFAULTS.maxAttempts;
}

/**
 * Queue one page into a campaign. Never takes a row another backfill already queued (pending, or
 * failed with attempts left), a row an executor holds right now, or current extracted content;
 * otherwise the row restarts as this campaign's with zero attempts. false = not queued here.
 */
export async function queueCampaignRow(engine: BrainEngine,
  w: { sourceId: string; pageId: number; contentHash: string; slug: string }, stamp: ChronicleCampaignStamp): Promise<boolean> {
  const written = await engine.executeRaw(
    `INSERT INTO chronicle_page_state AS c (source_id, page_id, content_hash, extractor_version, slug, state, reason, trigger,
       campaign_id, attempt_cap_usd, max_attempts, pricing_policy, campaign_max_usd)
     VALUES ($1, $2, $3, $4, $5, 'pending', NULL, 'backfill', $6, $7::numeric, $8, $9, $10::numeric)
     ON CONFLICT (source_id, page_id, content_hash, extractor_version) DO UPDATE SET
       slug=EXCLUDED.slug, state='pending', reason=NULL, trigger='backfill', principal_kind=NULL, principal_id=NULL,
       request_id=NULL, no_extract=false, next_attempt_at=NULL, attempts=0, cost_attempts='{}',
       campaign_id=EXCLUDED.campaign_id, attempt_cap_usd=EXCLUDED.attempt_cap_usd, max_attempts=EXCLUDED.max_attempts,
       pricing_policy=EXCLUDED.pricing_policy, campaign_max_usd=EXCLUDED.campaign_max_usd, decided_at=now(), updated_at=now()
     WHERE NOT (c.trigger='backfill' AND c.state IN ('pending','failed') AND c.attempts < COALESCE(c.max_attempts, $11))
       AND NOT (c.state IN ('pending','failed') AND c.attempts > 0 AND c.next_attempt_at > now())
       AND (c.state <> 'extracted' OR EXISTS (SELECT 1 FROM chronicle_page_state newer
         WHERE newer.source_id=c.source_id AND newer.page_id=c.page_id AND newer.content_hash<>c.content_hash
           AND newer.state='extracted' AND newer.updated_at > c.updated_at))
     RETURNING page_id`,
    [w.sourceId, w.pageId, w.contentHash, CHRONICLE_EXTRACTOR_VERSION, w.slug, stamp.campaignId, stamp.attemptCapUsd,
      stamp.maxAttempts, CAMPAIGN_PRICING_POLICY, stamp.maxUsd, CHRONICLE_DEFAULTS.maxAttempts]);
  return written.length > 0;
}

/** Recorded spend of a campaign's rows, summed across attempts. */
export async function campaignSpentUsd(engine: BrainEngine, campaignId: string): Promise<number> {
  const [row] = await engine.executeRaw<{ usd: number | string | null }>(
    'SELECT COALESCE(sum(cost_usd), 0)::float8 AS usd FROM chronicle_page_state WHERE campaign_id=$1', [campaignId]);
  return Math.round(Number(row?.usd ?? 0) * 10_000) / 10_000;
}

/**
 * A campaign row whose attempts are all consumed but which never finished (its executor crashed
 * after the claim) fails as `campaign_exhausted` once its lease ends, so it stops waiting.
 */
export async function failExhaustedCampaignRows(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(
    `UPDATE chronicle_page_state SET state='failed', reason='campaign_exhausted', next_attempt_at=NULL, updated_at=now()
      WHERE campaign_id IS NOT NULL AND state='pending' AND attempts >= COALESCE(max_attempts, $1)
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())`, [CHRONICLE_DEFAULTS.maxAttempts]);
}
