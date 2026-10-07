/**
 * `gbrain chronicle-backfill` core (#5876, D6/E10): the history path.
 *
 * Discovers meeting, conversation and calendar pages by type AND by the
 * rescue slug prefixes (any type), applies the shared eligibility rules
 * (invite end always; recency only with `recent`), consults the ledger so
 * content already extracted or queued is never paid for again (the ledger
 * survives `gbrain jobs prune`), and queues `pending` rows with
 * trigger='backfill' up to one global limit. The `chronicle` phase executes
 * them (`gbrain dream --phase chronicle`); backfill rows are exempt from the
 * daily limit and run even when automatic extraction is off. A dry run
 * changes nothing and reports the candidates, an estimated cost and the skip
 * reasons. Spending needs explicit consent (`yes`), keyed on the flag only.
 *
 * `maxUsd` (#6199) is a hard bound fixed at queue time: a page is queued only
 * while queued × (per-attempt cap + one call's ceiling) × maximum attempts
 * stays within it, and each queued row carries the campaign stamp every
 * executor obeys (campaign.ts). An unpriced model cannot be bounded, so a cap
 * refuses it with `no_pricing` and the register-price fix.
 */
import { randomUUID } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import { loadPricingOverrides } from '../budget/budget-tracker.ts';
import { usageCostUsd } from '../budget/reservation-cost.ts';
import { noPricingFix, noPricingGuidance, noPricingMessage, noPricingSteps, pricingSetCommand } from '../budget/no-pricing.ts';
import { opError } from '../ops/contract.ts';
import { campaignPageWorstCaseUsd, campaignSpentUsd, chronicleCallCeilingUsd, queueCampaignRow, type ChronicleCampaignStamp } from './campaign.ts';
import { chronicleJudgeMaxTokens } from './extract-events.ts';
import { CHRONICLE_DEFAULTS, CHRONICLE_EXTRACTOR_VERSION, RUN_NOW_COMMAND } from './contract.ts';
import { chronicleSettings } from './config.ts';
import { CHRONICLE_TYPES, RESCUE_SLUG_PREFIXES, chroniclePageDate, isChronicleEligible } from './eligibility.ts';
import { upsertChronicleRow } from './ledger.ts';

export interface ChronicleBackfillOpts {
  /** Only pages updated on/after this date (YYYY-MM-DD). */
  since?: string;
  /** Only pages whose own date (authored effective_date, else frontmatter date/start) is on/after this date. */
  datedSince?: string;
  /** Apply the automatic path's recency window (chronicle.auto_recent_days). */
  recent?: boolean;
  /** Global cap on pages queued in this run, across types and sources. */
  limit?: number;
  dryRun?: boolean;
  /** Explicit consent to queue paid extraction. Required unless dryRun. */
  yes?: boolean;
  /** Source scope (resolved by the op layer). */
  sourceId?: string;
  sourceIds?: string[];
  /** Model whose price the estimate uses (the configured chat model). */
  model?: string;
  /** Hard spend bound for everything this run queues, retries included (USD). */
  maxUsd?: number;
  now?: Date;
}

export interface ChronicleBackfillResult {
  dry_run: boolean;
  scanned: number;
  eligible: number;
  /** Pages this run queued (or, on a dry run, would queue). */
  queued: number;
  /** Current content already extracted, queued or running: never paid for twice. */
  already_done: number;
  skipped: Record<string, number>;
  limit: number;
  limit_reached: boolean;
  estimated_usd: number | 'unpriced';
  /** Per-page cap the estimate is clamped to (chronicle.job_budget_usd). */
  job_budget_usd: number;
  /** The --max-usd bound, or null. */
  max_usd: number | null;
  /** Most the queued pages can spend: queued × per_page_worst_case_usd; 'unpriced' when it cannot be bounded. */
  worst_case_usd: number | 'unpriced';
  /** (per-attempt cap + one call's ceiling) × max_attempts; null when unpriced. */
  per_page_worst_case_usd: number | null;
  /** Attempts each queued page may use (stamped on capped rows). */
  max_attempts: number;
  /** Pages that fit under max_usd (this run's queued count); null without --max-usd. */
  fits_under_cap: number | null;
  /** Eligible pages were left out because max_usd was reached. */
  cap_reached: boolean;
  /** Campaign id stamped on the rows this run queued under --max-usd; null otherwise. */
  campaign_id: string | null;
  /** Recorded spend of this campaign's rows so far, summed across attempts; null without one. */
  spent_usd: number | null;
  next_command: string;
  ask_user: boolean;
  message: string;
}

const DEFAULT_LIMIT = 1000;
const PAGE_BATCH = 500;
const JUDGE_OVERHEAD_CHARS = 900;
const EST_OUTPUT_TOKENS = 800;

function quote(value: string): string {
  return /^[\w.:/@+=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function runChronicleBackfill(engine: BrainEngine, opts: ChronicleBackfillOpts): Promise<ChronicleBackfillResult> {
  const dryRun = opts.dryRun === true;
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  const now = opts.now ?? new Date();
  const settings = await chronicleSettings(engine);
  const overrides = await loadPricingOverrides(engine);
  const maxUsd = opts.maxUsd ?? null;
  const maxAttempts = CHRONICLE_DEFAULTS.maxAttempts;
  const ceiling = opts.model ? chronicleCallCeilingUsd(opts.model, await chronicleJudgeMaxTokens(engine), overrides) : null;
  if (maxUsd !== null && ceiling === null) {
    const g = noPricingGuidance(opts.model ?? 'unknown', 'chat');
    throw opError('no_pricing', noPricingMessage(g, { label: 'chronicle-backfill', capUsd: maxUsd }), noPricingSteps(g),
      { fix: noPricingFix(g), docs: g.docs, why: 'A --max-usd bound needs a price for every call; nothing was queued.' });
  }
  const perPage = ceiling === null ? null : campaignPageWorstCaseUsd({ attemptCapUsd: settings.jobBudgetUsd, maxAttempts }, ceiling);
  const stamp: ChronicleCampaignStamp | null = maxUsd !== null && !dryRun && opts.yes
    ? { campaignId: randomUUID(), attemptCapUsd: settings.jobBudgetUsd, maxAttempts, maxUsd } : null;
  const datedSince = opts.datedSince ? new Date(opts.datedSince) : null;
  const params: unknown[] = [[...CHRONICLE_TYPES], RESCUE_SLUG_PREFIXES.map((p) => `${p}%`), CHRONICLE_EXTRACTOR_VERSION];
  let scope = '';
  if (opts.sourceIds?.length) { params.push(opts.sourceIds); scope += ` AND p.source_id = ANY($${params.length}::text[])`; }
  else if (opts.sourceId) { params.push(opts.sourceId); scope += ` AND p.source_id = $${params.length}`; }
  if (opts.since) { params.push(opts.since); scope += ` AND p.updated_at >= $${params.length}::date`; }

  const result: ChronicleBackfillResult = {
    dry_run: dryRun, scanned: 0, eligible: 0, queued: 0, already_done: 0, skipped: {}, limit, limit_reached: false,
    estimated_usd: 0, job_budget_usd: settings.jobBudgetUsd, max_usd: maxUsd, worst_case_usd: 0,
    per_page_worst_case_usd: perPage === null ? null : round(perPage), max_attempts: maxAttempts,
    fits_under_cap: maxUsd === null ? null : 0, cap_reached: false, campaign_id: stamp?.campaignId ?? null, spent_usd: null,
    next_command: '', ask_user: true, message: '',
  };
  let worst = 0;
  const skip = (reason: string) => { result.skipped[reason] = (result.skipped[reason] ?? 0) + 1; };
  let estimate = 0;
  let unpriced = false;
  let lastId = 0;
  for (;;) {
    params.push(lastId);
    const cursor = params.length;
    const pages = await engine.executeRaw<{
      id: number; source_id: string; slug: string; type: string; compiled_truth: string | null; frontmatter: Record<string, unknown> | null;
      effective_date: Date | string | null; effective_date_source: string | null; content_hash: string | null; done: boolean;
    }>(
      `SELECT p.id, p.source_id, p.slug, p.type, p.compiled_truth, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash,
              EXISTS (SELECT 1 FROM chronicle_page_state c WHERE c.page_id=p.id AND c.content_hash=p.content_hash
                AND c.extractor_version=$3 AND (c.state='extracted' OR (c.state IN ('pending','failed') AND c.trigger='backfill' AND c.attempts < ${CHRONICLE_DEFAULTS.maxAttempts}))) AS done
         FROM pages p
        WHERE p.deleted_at IS NULL AND (p.type = ANY($1::text[]) OR p.slug LIKE ANY($2::text[]))${scope} AND p.id > $${cursor}
        ORDER BY p.id LIMIT ${PAGE_BATCH}`, params);
    params.pop();
    if (pages.length === 0) break;
    lastId = Number(pages[pages.length - 1].id);
    for (const page of pages) {
      result.scanned++;
      const eligible = isChronicleEligible({
        type: page.type as never, slug: page.slug, body: page.compiled_truth ?? '',
        dreamGenerated: page.frontmatter?.dream_generated === true, effectiveDate: page.effective_date,
        effectiveDateSource: page.effective_date_source, frontmatter: page.frontmatter,
      }, { now, recentDays: opts.recent ? settings.recentDays : null });
      if (!eligible.ok) { skip(eligible.reason.startsWith('kind:') ? 'not_chronicle_shaped' : eligible.reason); continue; }
      if (datedSince) {
        const dated = chroniclePageDate({ effectiveDate: page.effective_date, effectiveDateSource: page.effective_date_source, frontmatter: page.frontmatter });
        if (!dated || dated.getTime() < datedSince.getTime()) { skip('before_dated_since'); continue; }
      }
      if (!page.content_hash) { skip('no_content_hash'); continue; }
      result.eligible++;
      if (page.done) { result.already_done++; continue; }
      if (result.queued >= limit) { result.limit_reached = true; continue; }
      if (maxUsd !== null && worst + perPage! > maxUsd + 1e-9) { result.cap_reached = true; continue; }
      const row = { sourceId: page.source_id, pageId: Number(page.id), contentHash: page.content_hash, slug: page.slug };
      if (stamp && !(await queueCampaignRow(engine, row, stamp))) { result.already_done++; continue; }
      if (!stamp && !dryRun && opts.yes) {
        await upsertChronicleRow(engine, { ...row, state: 'pending', reason: null, trigger: 'backfill', nextAttemptAt: null });
      }
      result.queued++;
      worst += perPage ?? 0;
      const chars = Math.min((page.compiled_truth ?? '').length, 12_000) + JUDGE_OVERHEAD_CHARS;
      const cost = opts.model ? usageCostUsd(opts.model, Math.ceil(chars / 4), EST_OUTPUT_TOKENS, 'chat', overrides) : null;
      if (cost === null) unpriced = true;
      else estimate += Math.min(cost, settings.jobBudgetUsd);
    }
  }
  result.estimated_usd = unpriced ? 'unpriced' : round(estimate);
  result.worst_case_usd = perPage === null ? 'unpriced' : round(worst);
  if (maxUsd !== null) result.fits_under_cap = result.queued;
  if (stamp) result.spent_usd = await campaignSpentUsd(engine, stamp.campaignId);
  const flags = [opts.since ? `--since ${quote(opts.since)}` : '', opts.datedSince ? `--dated-since ${quote(opts.datedSince)}` : '',
    opts.recent ? '--recent' : '', `--limit ${limit}`, maxUsd !== null ? `--max-usd ${maxUsd}` : ''].filter(Boolean).join(' ');
  const cost = result.estimated_usd === 'unpriced'
    ? `The chat model has no registered price, so the cost is unknown and no per-page cap applies; to bound spend, register its price (${pricingSetCommand(opts.model ?? '<model>', 'chat')}) and pass --max-usd`
    : `Estimated cost ~$${result.estimated_usd.toFixed(2)} (each page capped at $${settings.jobBudgetUsd.toFixed(2)})` +
      (maxUsd === null ? '' : `; worst case $${(result.worst_case_usd as number).toFixed(2)} of the $${maxUsd.toFixed(2)} --max-usd bound ` +
        `($${result.per_page_worst_case_usd!.toFixed(2)} per page: ${maxAttempts} attempts at the per-page cap plus one call's overshoot)`);
  const capNote = result.cap_reached
    ? ` More eligible pages did not fit under --max-usd $${maxUsd!.toFixed(2)}; a larger bound is a new paid run, so ask the user first (preview: gbrain chronicle-backfill ${flags} --dry-run).`
    : '';
  if (dryRun || !opts.yes) {
    result.next_command = result.queued > 0 ? `gbrain chronicle-backfill ${flags} --yes` : '';
    result.ask_user = result.queued > 0;
    result.message = result.queued === 0
      ? `Nothing to backfill: ${result.eligible} eligible page(s), ${result.already_done} already extracted or queued.`
      : `${result.queued} page(s) would be extracted (one paid chat call each). ${cost}. Ask the user before running: ${result.next_command}` +
        (dryRun ? '' : ' (backfill spends money, so it needs --yes; nothing was queued).');
    if (result.queued === 0 && result.cap_reached) {
      result.ask_user = true;
      result.next_command = `gbrain chronicle-backfill ${flags} --dry-run`;
      result.message = `No page fits under --max-usd $${maxUsd!.toFixed(2)}: each page can spend up to $${result.per_page_worst_case_usd!.toFixed(2)} ` +
        `(${maxAttempts} attempts at the $${settings.jobBudgetUsd.toFixed(2)} per-page cap plus one call's overshoot). Ask the user for a larger --max-usd.`;
    } else result.message += capNote;
    if (!dryRun) result.dry_run = true;
    return result;
  }
  result.next_command = result.queued > 0 ? RUN_NOW_COMMAND : '';
  result.ask_user = false;
  if (result.queued === 0 && result.cap_reached) {
    result.ask_user = true;
    result.next_command = `gbrain chronicle-backfill ${flags} --dry-run`;
    result.message = `Nothing queued: no page fits under --max-usd $${maxUsd!.toFixed(2)} (each page can spend up to $${result.per_page_worst_case_usd!.toFixed(2)}). Ask the user for a larger --max-usd.`;
    return result;
  }
  result.message = result.queued === 0
    ? `Nothing queued: ${result.eligible} eligible page(s), ${result.already_done} already extracted or queued.`
    : `Queued ${result.queued} page(s). ${cost}. They run in the next cycle (at most 50 per run); to run now: ${RUN_NOW_COMMAND}` +
      (result.limit_reached ? `. More pages remain; each batch is paid, so ask the user before the next one (preview: gbrain chronicle-backfill ${flags} --dry-run).` : '.') +
      capNote;
  return result;
}

function round(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}
