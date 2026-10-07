/**
 * #5876 — cycle phase `chronicle`: Life Chronicle automatic extraction.
 *
 * Default ON (`gbrain config set auto_chronicle false` opts out). One global
 * phase under the cycle lock executes `chronicle_page_state` ledger rows:
 *
 *   1. Housekeeping: rows whose content is no longer live become
 *      `superseded`; reservations older than two days are pruned.
 *   2. Discovery per active source (bounded): pages changed since activation
 *      with no row for their current content. Unmanaged brains (trusted
 *      local writers) get a decision here; managed brains, where every
 *      coordinated publication decides at write time, record
 *      `no_write_decision` (an older binary wrote it) and leave it to backfill.
 *   3. Execution: settled pending rows (automatic first, then backfill),
 *      due retries and retire-only rows, round-robin across sources, at most
 *      50 items and a wall-time bound per run. Automatic rows take a rolling
 *      daily reservation immediately before the judge; with automatic
 *      extraction off only backfill rows run.
 *
 * No chat provider → no calls and no churn (reason `no_chat_provider`). An
 * explicit `chronicle.job_budget_usd` with an unpriced model refuses with the
 * no_pricing guidance; a default cap on an unpriced model warns and runs.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult, PhaseStatus } from '../cycle.ts';
import { getChatModel, isAvailable } from '../ai/gateway.ts';
import { loadPricingOverrides } from '../budget/budget-tracker.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { resolveExtractAtomsCostGate, settleExtractAtomsCostGate } from './extract-atoms-cost-gate.ts';
import { CHRONICLE_ACTIVATED_AT_KEY, chronicleSettings, chronicleTz, isAutoChronicleEnabled } from '../chronicle/config.ts';
import {
  CHRONICLE_DEFAULTS, CHRONICLE_EXTRACTOR_VERSION, RUN_NOW_COMMAND,
  type ChronicleLedgerRow, type ChronicleRunDetails,
} from '../chronicle/contract.ts';
import { CHRONICLE_TYPES, RESCUE_SLUG_PREFIXES } from '../chronicle/eligibility.ts';
import { claimChronicleRow, executeChronicleRow } from '../chronicle/execute.ts';
import { failExhaustedCampaignRows } from '../chronicle/campaign.ts';
import { defaultJudge, type ChronicleDropReason, type ChronicleJudge } from '../chronicle/extract-events.ts';
import {
  RETIRE_REASONS, chronicleDailyRemaining, decideChronicle, pruneChronicleReservations, upsertChronicleRow,
} from '../chronicle/ledger.ts';
import { CHRONICLE_REASONS, type ChronicleReasonCode } from '../chronicle/reasons.ts';

export interface ChroniclePhaseOpts {
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Test seam; the gateway judge otherwise. */
  judge?: ChronicleJudge;
  now?: () => Date;
  maxItems?: number;
  maxRunMs?: number;
  yieldDuringPhase?: () => Promise<void>;
  deadlineAtMs?: number | null;
}

/** Config key prefix of a recorded no_pricing refusal (doctor reads it); the gate is brain-wide. */
export const CHRONICLE_NO_PRICING_KEY_PREFIX = 'chronicle.no_pricing.';
const DISCOVERY_PER_SOURCE = 200;

/** Record a row for every chronicle-shaped page changed since activation that has none for its live content. */
async function discover(engine: BrainEngine, sourceId: string, ctx: {
  managed: boolean; enabled: boolean; activatedAt: Date; settings: Awaited<ReturnType<typeof chronicleSettings>>; now: Date; dryRun: boolean;
}): Promise<number> {
  const prefixes = RESCUE_SLUG_PREFIXES.map((p) => `${p}%`);
  const pages = await engine.executeRaw<{
    id: number; slug: string; type: string; compiled_truth: string | null; frontmatter: Record<string, unknown> | null;
    effective_date: Date | string | null; effective_date_source: string | null; content_hash: string; updated_at: Date | string;
  }>(
    `SELECT p.id, p.slug, p.type, p.compiled_truth, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash, p.updated_at
       FROM pages p
      WHERE p.source_id=$1 AND p.deleted_at IS NULL AND p.content_hash IS NOT NULL AND p.updated_at >= $2::timestamptz
        AND p.type <> 'event' AND p.slug NOT LIKE 'life/%'
        AND (p.type = ANY($3::text[]) OR p.slug LIKE ANY($4::text[]) OR EXISTS (SELECT 1 FROM chronicle_page_state e
          WHERE e.page_id=p.id AND e.state='extracted' AND cardinality(e.event_hashes) > 0))
        AND NOT EXISTS (SELECT 1 FROM chronicle_page_state c
          WHERE c.page_id=p.id AND c.content_hash=p.content_hash AND c.extractor_version=$5)
      ORDER BY p.updated_at, p.id LIMIT $6`,
    [sourceId, ctx.activatedAt.toISOString(), [...CHRONICLE_TYPES], prefixes, CHRONICLE_EXTRACTOR_VERSION, DISCOVERY_PER_SOURCE]);
  if (ctx.dryRun) return pages.length;
  for (const page of pages) {
    const base = { sourceId, pageId: Number(page.id), contentHash: page.content_hash, slug: page.slug, trigger: 'auto' as const };
    const shaped = (CHRONICLE_TYPES as string[]).includes(page.type) || RESCUE_SLUG_PREFIXES.some((p) => page.slug.startsWith(p));
    if (!shaped) {
      await upsertChronicleRow(engine, { ...base, state: 'skipped', reason: 'not_chronicle_shaped', nextAttemptAt: ctx.now });
      continue;
    }
    if (ctx.managed) {
      await upsertChronicleRow(engine, { ...base, state: 'skipped', reason: 'no_write_decision', nextAttemptAt: null });
      continue;
    }
    const decision = decideChronicle({ page, authority: null, noExtract: false, enabled: ctx.enabled, settings: ctx.settings, now: ctx.now });
    const settled = new Date(new Date(page.updated_at).getTime() + ctx.settings.settleSeconds * 1000);
    const retire = decision.state === 'skipped' && (RETIRE_REASONS as readonly string[]).includes(String(decision.reason));
    await upsertChronicleRow(engine, { ...base, state: decision.state, reason: decision.reason,
      nextAttemptAt: decision.state === 'pending' && decision.reason === null ? settled : retire ? ctx.now : decision.nextAttemptAt });
  }
  return pages.length;
}

/** Claimable rows of one source, retire-only rows first, then automatic, then backfill, oldest decision first. */
async function candidates(engine: BrainEngine, sourceId: string, enabled: boolean, limit: number): Promise<ChronicleLedgerRow[]> {
  return engine.executeRaw<ChronicleLedgerRow>(
    `SELECT c.* FROM chronicle_page_state c
       JOIN pages p ON p.id=c.page_id AND p.source_id=c.source_id AND p.content_hash=c.content_hash AND p.deleted_at IS NULL
      WHERE c.source_id=$1 AND c.extractor_version=$2
        AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
        AND ((c.state='pending' AND ($3 OR c.trigger='backfill') AND (c.max_attempts IS NULL OR c.attempts < c.max_attempts))
          OR (c.state='failed' AND c.attempts < COALESCE(c.max_attempts, $4) AND ($3 OR c.trigger='backfill')
            AND (c.next_attempt_at IS NOT NULL OR c.reason IN ('judge_llm_unavailable','no_pricing')))
          OR (c.state='skipped' AND c.next_attempt_at IS NOT NULL AND c.reason = ANY($5::text[])))
      ORDER BY (c.state='skipped') DESC, (c.trigger='auto') DESC, c.decided_at, c.page_id
      LIMIT $6`,
    [sourceId, CHRONICLE_EXTRACTOR_VERSION, enabled, CHRONICLE_DEFAULTS.maxAttempts, [...RETIRE_REASONS], limit]);
}

function result(status: PhaseStatus, summary: string, details: ChronicleRunDetails & Record<string, unknown>): PhaseResult {
  return { phase: 'chronicle', status, duration_ms: 0, summary, details };
}

export async function runPhaseChronicle(engine: BrainEngine, opts: ChroniclePhaseOpts = {}): Promise<PhaseResult> {
  const started = Date.now();
  const now = opts.now ?? (() => new Date());
  const dryRun = opts.dryRun === true;
  const maxItems = opts.maxItems ?? CHRONICLE_DEFAULTS.maxItemsPerRun;
  const remaining = opts.deadlineAtMs ? opts.deadlineAtMs - Date.now() - 30_000 : Infinity;
  const maxRunMs = Math.max(0, Math.min(opts.maxRunMs ?? CHRONICLE_DEFAULTS.maxRunMs, remaining));
  const [settings, enabled, managed] = await Promise.all([
    chronicleSettings(engine), isAutoChronicleEnabled(engine), managedPersistenceEnabled(engine)]);
  let activatedAt = settings.activatedAt;
  if (!activatedAt) {
    activatedAt = now();
    if (!dryRun) await engine.setConfig(CHRONICLE_ACTIVATED_AT_KEY, activatedAt.toISOString());
  }
  const details: ChronicleRunDetails & Record<string, unknown> = {
    dry_run: dryRun, sources: 0, candidates: 0, judged: 0, extracted: 0, no_events: 0, failed: 0, reasons: {},
    events_written: 0, events_retired: 0, events_dropped: {}, deferred_daily_limit: 0, daily_limit: settings.dailyLimit,
    daily_remaining: 0, spent_usd: 0, unpriced_calls: 0, max_items: maxItems, per_source: {},
    auto_chronicle: enabled ? 'on' : 'off',
  };
  const count = (reason: string | null) => {
    if (!reason) return;
    details.reasons[reason as ChronicleReasonCode] = (details.reasons[reason as ChronicleReasonCode] ?? 0) + 1;
  };

  if (!dryRun) {
    await pruneChronicleReservations(engine);
    await failExhaustedCampaignRows(engine);
    await engine.executeRaw(
      `UPDATE chronicle_page_state c SET state='skipped', reason='superseded', next_attempt_at=NULL, updated_at=now()
        WHERE c.state IN ('pending','failed') AND NOT EXISTS (SELECT 1 FROM pages p
          WHERE p.id=c.page_id AND p.content_hash=c.content_hash AND p.deleted_at IS NULL)`);
  }
  const sources = (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE NOT archived ORDER BY id')).map((s) => s.id);
  details.sources = sources.length;
  for (const sourceId of sources) {
    await discover(engine, sourceId, { managed, enabled, activatedAt, settings, now: now(), dryRun });
  }
  const queues = new Map<string, ChronicleLedgerRow[]>();
  for (const sourceId of sources) {
    const rows = await candidates(engine, sourceId, enabled, maxItems);
    if (rows.length) queues.set(sourceId, rows);
    details.candidates += rows.length;
    details.per_source[sourceId] = { candidates: rows.length, judged: 0 };
  }
  details.daily_remaining = await chronicleDailyRemaining(engine, settings.dailyLimit);
  const finishResult = (status: PhaseStatus, summary: string) => {
    if (details.candidates > 0 && !details.next_command) details.next_command = RUN_NOW_COMMAND;
    return result(status, summary, details);
  };
  if (details.candidates === 0) {
    details.reason = enabled ? 'nothing_pending' : 'auto_chronicle_off';
    return result(enabled ? 'ok' : 'skipped', enabled ? 'chronicle: nothing pending'
      : 'chronicle: auto_chronicle is off and no backfill rows are pending (turn on: gbrain config set auto_chronicle true)', details);
  }
  if (dryRun) return finishResult('ok', `chronicle (dry run): ${details.candidates} item(s) ready across ${queues.size} source(s)`);

  const judge = opts.judge ?? (isAvailable('chat') ? defaultJudge(engine) : null);
  if (!judge) {
    details.reason = 'no_chat_provider';
    details.fix = CHRONICLE_REASONS.no_chat_provider.fix();
    return result('skipped', `chronicle: no chat provider is configured; ${details.candidates} page(s) wait. ${details.fix.why}`, details);
  }
  const model = getChatModel();
  const pricingOverrides = await loadPricingOverrides(engine);
  const gate = resolveExtractAtomsCostGate(model, null, pricingOverrides, { explicitBudget: settings.explicitBudget });
  const refused = await settleExtractAtomsCostGate(engine, 'brain', gate, { budgetCap: settings.jobBudgetUsd, extractModel: model, dryRun },
    { phase: 'chronicle', keyPrefix: CHRONICLE_NO_PRICING_KEY_PREFIX, rollup: false });
  if (refused) return { ...refused, details: { ...details, ...refused.details } };

  const tz = await chronicleTz(engine);
  const maintenance = new Map<string, MaintenanceAuthority | null>();
  const sourceErrors: Record<string, string> = {};
  let items = 0;
  let limitHit = false;
  let lastYield = Date.now();
  while (queues.size > 0 && items < maxItems && Date.now() - started < maxRunMs) {
    for (const [sourceId, queue] of [...queues]) {
      if (items >= maxItems || Date.now() - started >= maxRunMs) break;
      if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const next = queue.shift();
      if (!next || queue.length === 0) queues.delete(sourceId);
      if (!next) continue;
      if (limitHit && next.trigger === 'auto' && next.state !== 'skipped') { details.deferred_daily_limit++; continue; }
      if (!maintenance.has(sourceId)) {
        try { maintenance.set(sourceId, await maintenancePreflight(engine, sourceId)); }
        catch (error) {
          sourceErrors[sourceId] = error instanceof Error ? error.message : String(error);
          queues.delete(sourceId);
          continue;
        }
      }
      const claimed = await claimChronicleRow(engine, next);
      if (!claimed) continue;
      const outcome = await executeChronicleRow({ engine, settings, judge, gate, pricingOverrides, tz, now, signal: opts.signal,
        maintenance: maintenance.get(sourceId) ?? null }, claimed);
      if (outcome.kind === 'deferred') {
        // The limit is brain-wide: every remaining automatic row waits for a free slot.
        limitHit = true;
        details.deferred_daily_limit++;
        count('daily_limit');
        continue;
      }
      if (outcome.kind === 'waiting') continue;
      if (outcome.judged) { items++; details.judged++; details.per_source[sourceId].judged++; }
      if (outcome.state === 'extracted') {
        if (outcome.reason) details.no_events++; else details.extracted++;
      }
      if (outcome.state === 'failed') details.failed++;
      if (outcome.state !== 'extracted' || outcome.reason) count(outcome.reason);
      details.events_written += outcome.written;
      details.events_retired += outcome.retired;
      for (const [reason, n] of Object.entries(outcome.dropped) as Array<[ChronicleDropReason, number]>) {
        details.events_dropped[reason] = (details.events_dropped[reason] ?? 0) + n;
      }
      details.spent_usd += outcome.costUsd ?? 0;
      if (outcome.unpriced) details.unpriced_calls++;
    }
    if (opts.yieldDuringPhase && Date.now() - lastYield > 30_000) {
      lastYield = Date.now();
      await opts.yieldDuringPhase().catch(() => undefined);
    }
  }
  details.daily_remaining = await chronicleDailyRemaining(engine, settings.dailyLimit);
  if (Object.keys(sourceErrors).length) details.source_errors = sourceErrors;
  const status: PhaseStatus = details.failed > 0 || Object.keys(sourceErrors).length > 0 ? 'warn' : 'ok';
  const left = [...queues.values()].reduce((n, rows) => n + rows.length, 0);
  const summary = `chronicle: ${details.judged} page(s) judged, ${details.events_written} event(s) written, ` +
    `${details.events_retired} retired, ${details.failed} failed, ~$${details.spent_usd.toFixed(4)} spent` +
    (details.deferred_daily_limit ? `; ${details.deferred_daily_limit} wait for the daily limit (${settings.dailyLimit}/24h)` : '') +
    (left ? `; ${left} left for the next run (${RUN_NOW_COMMAND})` : '');
  if (left > 0) details.next_command = RUN_NOW_COMMAND;
  return finishResult(status, summary);
}
