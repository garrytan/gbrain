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
  return (await engine.chronicleStore()).queueCampaignRow({ sourceId: w.sourceId, pageId: w.pageId, contentHash: w.contentHash,
    extractorVersion: CHRONICLE_EXTRACTOR_VERSION, slug: w.slug, campaignId: stamp.campaignId, attemptCapUsd: stamp.attemptCapUsd,
    maxAttempts: stamp.maxAttempts, pricingPolicy: CAMPAIGN_PRICING_POLICY, maxUsd: stamp.maxUsd, defaultMaxAttempts: CHRONICLE_DEFAULTS.maxAttempts });
}

/** Recorded spend of a campaign's rows, summed across attempts. */
export async function campaignSpentUsd(engine: BrainEngine, campaignId: string): Promise<number> {
  const row = await (await engine.chronicleStore()).campaignSpentUsd(campaignId);
  return Math.round(Number(row?.usd ?? 0) * 10_000) / 10_000;
}

/**
 * A campaign row whose attempts are all consumed but which never finished (its executor crashed
 * after the claim) fails as `campaign_exhausted` once its lease ends, so it stops waiting.
 */
export async function failExhaustedCampaignRows(engine: BrainEngine): Promise<void> {
  await (await engine.chronicleStore()).failExhaustedCampaignRows(CHRONICLE_DEFAULTS.maxAttempts);
}
