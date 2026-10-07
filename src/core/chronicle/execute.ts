/**
 * Life Chronicle execution (#5876): run one ledger row to its outcome.
 *
 * Shared by the `chronicle` cycle phase and the `chronicle_extract` job
 * handler. Order: live-content check → time rules (shared eligibility) →
 * rolling daily reservation (automatic rows only, taken immediately before the
 * judge; attempts and retries count) → judge one immutable snapshot inside a
 * BudgetTracker scope labelled `chronicle:<trigger>` with the per-page cap →
 * explicit post-call budget check → publish with re-validation and
 * reconciliation → ledger outcome. An ended calendar invite takes the judge's
 * place with its deterministic projection (invite-projection.ts): no
 * reservation, no model call. A failed or superseded run never retires
 * the previous generation.
 */
import type { BrainEngine } from '../engine.ts';
import { BudgetTracker, type PricingOverrides } from '../budget/budget-tracker.ts';
import { recordOnTracker } from '../ai/budget-record.ts';
import { getCurrentBudgetTracker, withBudgetTracker } from '../ai/gateway.ts';
import type { ExtractAtomsCostGate } from '../cycle/extract-atoms-cost-gate.ts';
import type { MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { CHRONICLE_DEFAULTS, CHRONICLE_EXTRACTOR_VERSION, type ChronicleLedgerRow } from './contract.ts';
import type { ChronicleReasonCode } from './reasons.ts';
import type { ChronicleSettings } from './config.ts';
import { isChronicleEligible } from './eligibility.ts';
import {
  allDroppedReason, buildChronicleEvents, chronicleJudgeContext, isValidProposal,
  type ChronicleDropCounts, type ChronicleJudge, type ChronicleJudgeResult,
} from './extract-events.ts';
import { endedInviteProposal, markInviteEvents } from './invite-projection.ts';
import { RETIRE_REASONS, reserveChronicleSlot } from './ledger.ts';
import { CAMPAIGN_PRICING_POLICY, rowMaxAttempts } from './campaign.ts';
import { pinDepth, publishChronicleGeneration, type ChronicleDepthPin } from './publish.ts';

export interface ChronicleExecContext {
  engine: BrainEngine;
  settings: ChronicleSettings;
  judge: ChronicleJudge;
  gate: ExtractAtomsCostGate;
  pricingOverrides?: PricingOverrides;
  tz: string;
  now?: () => Date;
  signal?: AbortSignal;
  /** Managed maintenance authority of the row's source; null on an unmanaged brain. */
  maintenance: MaintenanceAuthority | null;
  /** BudgetTracker label; `chronicle:<trigger>` by default. */
  label?: string;
}

export type ChronicleRowOutcome =
  | { kind: 'waiting'; reason: string }
  | { kind: 'deferred'; reason: 'daily_limit' }
  | { kind: 'done'; state: ChronicleLedgerRow['state']; reason: string | null; judged: boolean;
      written: number; retired: number; costUsd: number | null; unpriced: boolean; dropped: ChronicleDropCounts };

const CONFIG_BLOCKED = new Set(['judge_llm_unavailable', 'no_pricing']);
const LEASE_MS = 15 * 60_000;

function key(row: ChronicleLedgerRow) {
  return [row.source_id, Number(row.page_id), row.content_hash, CHRONICLE_EXTRACTOR_VERSION] as const;
}

/**
 * Lease one claimable row so a second executor (another host's cycle, a job) skips it. A
 * `--max-usd` campaign row (#6199) consumes its attempt here, atomically with the lease, and is
 * not claimable once its stamped attempts are used, so a crash between claim and outcome never
 * yields an extra paid attempt.
 */
export async function claimChronicleRow(engine: BrainEngine, row: ChronicleLedgerRow): Promise<ChronicleLedgerRow | null> {
  const [claimed] = await engine.executeRaw<ChronicleLedgerRow>(
    `UPDATE chronicle_page_state SET next_attempt_at = now() + ($5::int * interval '1 millisecond'),
       attempts = attempts + CASE WHEN campaign_id IS NOT NULL AND state IN ('pending','failed') THEN 1 ELSE 0 END
      WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND state=$6
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        AND NOT (campaign_id IS NOT NULL AND state IN ('pending','failed') AND attempts >= COALESCE(max_attempts, $7))
      RETURNING *`, [...key(row), LEASE_MS, row.state, CHRONICLE_DEFAULTS.maxAttempts]);
  return claimed ?? null;
}

/** A claimed row that belongs to a campaign: its attempt was consumed by the claim. */
function campaignAttempt(row: ChronicleLedgerRow): boolean {
  return row.campaign_id != null && (row.state === 'pending' || row.state === 'failed');
}

async function setNextAttempt(engine: BrainEngine, row: ChronicleLedgerRow, at: Date | null): Promise<void> {
  await engine.executeRaw(
    `UPDATE chronicle_page_state SET next_attempt_at=$5::timestamptz
      WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4`,
    [...key(row), at ? at.toISOString() : null]);
}

/**
 * Record an attempt's outcome. Spend accumulates per attempt (#6199): keyed to `attempt`, so a
 * replayed completion adds nothing, and recorded even from a stale executor because the money was
 * spent. The outcome itself applies only while `attempt` is still the row's latest attempt, so a
 * completion arriving after its lease expired and another executor claimed the row is fenced.
 */
async function finish(engine: BrainEngine, row: ChronicleLedgerRow, attempt: number, patch: {
  state: ChronicleLedgerRow['state']; reason: string | null; nextAttemptAt: Date | null;
  costUsd?: number | null; unpriced?: boolean; events?: Array<{ slug: string; hash: string }>;
}): Promise<void> {
  if (patch.costUsd != null) {
    await engine.executeRaw(
      `UPDATE chronicle_page_state SET cost_usd=COALESCE(cost_usd, 0) + $5::numeric, cost_attempts=array_append(cost_attempts, $6::int)
        WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND NOT ($6::int = ANY(cost_attempts))`,
      [...key(row), patch.costUsd, attempt]);
  }
  await engine.executeRaw(
    `UPDATE chronicle_page_state SET state=$5, reason=$6, next_attempt_at=$7::timestamptz, unpriced=COALESCE($8::boolean, unpriced),
       event_slugs=COALESCE($9::text[], event_slugs), event_hashes=COALESCE($10::text[], event_hashes), updated_at=now()
      WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND attempts=$11`,
    [...key(row), patch.state, patch.reason, patch.nextAttemptAt ? patch.nextAttemptAt.toISOString() : null, patch.unpriced ?? null,
      patch.events ? patch.events.map((e) => e.slug) : null, patch.events ? patch.events.map((e) => e.hash) : null, attempt]);
}

function backoff(attempts: number, now: Date, maxAttempts: number): Date | null {
  if (attempts >= maxAttempts) return null;
  return new Date(now.getTime() + Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** Math.max(0, attempts - 1)));
}

/** Copy a child scope's spend onto the ambient tracker so an enclosing budget sees it. */
function propagateSpend(parent: BudgetTracker | null, child: BudgetTracker): void {
  if (!parent || parent === child) return;
  for (const m of child.snapshot().models) {
    recordOnTracker(parent, { modelId: m.model, inputTokens: m.input_tokens, outputTokens: m.output_tokens, label: 'chronicle', kind: 'chat' });
  }
}

/** Classify a judge result or throw into the ledger vocabulary (E2/D5). */
function classifyJudge(result: ChronicleJudgeResult | null, thrown: unknown): { state: 'failed' | 'skipped'; reason: ChronicleReasonCode } | null {
  if (thrown) {
    const budget = thrown as { tag?: string; reason?: string };
    if (budget.tag === 'BUDGET_EXHAUSTED') return { state: 'failed', reason: budget.reason === 'no_pricing' ? 'no_pricing' : 'budget_exhausted' };
    return { state: 'failed', reason: 'judge_chat_error' };
  }
  switch (result?.failure) {
    case undefined: break;
    case 'refused': return { state: 'skipped', reason: 'judge_refused' };
    case 'llm_unavailable': return { state: 'failed', reason: 'judge_llm_unavailable' };
    case 'chat_error': return { state: 'failed', reason: 'judge_chat_error' };
    case 'truncated': return { state: 'failed', reason: 'judge_truncated' };
    case 'parse_failed': return { state: 'failed', reason: 'judge_parse_failed' };
  }
  const events = Array.isArray(result?.events) ? result!.events : [];
  if (!events.every(isValidProposal)) return { state: 'failed', reason: 'malformed_proposal' };
  return null;
}

/** Run one claimed row. The caller claimed it (lease) and owns its outcome. */
export async function executeChronicleRow(ctx: ChronicleExecContext, row: ChronicleLedgerRow): Promise<ChronicleRowOutcome> {
  const { engine, settings } = ctx;
  const now = ctx.now?.() ?? new Date();
  const done = (state: ChronicleLedgerRow['state'], reason: string | null, extra: Partial<Extract<ChronicleRowOutcome, { kind: 'done' }>> = {}): ChronicleRowOutcome =>
    ({ kind: 'done', state, reason, judged: false, written: 0, retired: 0, costUsd: 0, unpriced: false, dropped: {}, ...extra });

  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || Number(snapshot.page.id) !== Number(row.page_id)) {
    await finish(engine, row, row.attempts, { state: 'skipped', reason: 'page_missing', nextAttemptAt: null });
    return done('skipped', 'page_missing');
  }
  if (String(snapshot.page.content_hash ?? '') !== row.content_hash) {
    await finish(engine, row, row.attempts, { state: 'skipped', reason: 'superseded', nextAttemptAt: null });
    return done('skipped', 'superseded');
  }
  const pin = pinDepth(snapshot);

  // An ineligible revision of a page that once produced events retires them (E8). No model call.
  if (row.state === 'skipped') {
    const generation = await publishChronicleGeneration(engine, { sourceId: row.source_id, pin, events: [],
      decisionRequestId: null, maintenance: ctx.maintenance, signal: ctx.signal });
    await setNextAttempt(engine, row, null);
    return done('skipped', row.reason, { retired: generation.retired.length });
  }

  if (row.no_extract) {
    await finish(engine, row, row.attempts, { state: 'skipped', reason: 'no_extract', nextAttemptAt: null });
    return done('skipped', 'no_extract');
  }
  const auto = row.trigger === 'auto';
  const eligible = isChronicleEligible({
    type: snapshot.page.type, slug: snapshot.page.slug, body: snapshot.page.compiled_truth ?? '',
    dreamGenerated: snapshot.page.frontmatter?.dream_generated === true,
    effectiveDate: snapshot.page.effective_date ?? null, effectiveDateSource: snapshot.page.effective_date_source ?? null,
    frontmatter: snapshot.page.frontmatter ?? null, changedAt: row.decided_at,
  }, { now, recentDays: auto ? settings.recentDays : null, settleSeconds: auto ? settings.settleSeconds : null });
  if (!eligible.ok) {
    if ('wait' in eligible) {
      await setNextAttempt(engine, row, eligible.until);
      return { kind: 'waiting', reason: eligible.reason };
    }
    const reason = eligible.reason.startsWith('kind:') ? 'not_chronicle_shaped' : eligible.reason;
    const retire = (RETIRE_REASONS as readonly string[]).includes(reason);
    await finish(engine, row, row.attempts, { state: 'skipped', reason, nextAttemptAt: retire ? now : null });
    return done('skipped', reason);
  }

  const judgeCtx = chronicleJudgeContext(snapshot.page);
  const invite = endedInviteProposal(snapshot.page, judgeCtx.attendees, now);
  if (auto && !invite && !(await reserveChronicleSlot(engine, settings.dailyLimit, { sourceId: row.source_id, pageId: Number(row.page_id), contentHash: row.content_hash }))) {
    await setNextAttempt(engine, row, null);
    return { kind: 'deferred', reason: 'daily_limit' };
  }
  const attempts = campaignAttempt(row) ? row.attempts : (await engine.executeRaw<{ attempts: number }>(
    `UPDATE chronicle_page_state SET attempts=attempts+1 WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 RETURNING attempts`,
    [...key(row)]))[0].attempts;
  const maxAttempts = rowMaxAttempts(row);
  // #6199: a campaign row runs under its stamped cap, whatever the settings or gate say now.
  const stampedCap = row.pricing_policy === CAMPAIGN_PRICING_POLICY && row.attempt_cap_usd != null ? Number(row.attempt_cap_usd) : undefined;

  const tracker = new BudgetTracker({
    maxCostUsd: stampedCap ?? (ctx.gate.enforceCap ? settings.jobBudgetUsd : undefined),
    label: ctx.label ?? `chronicle:${row.trigger}`,
    pricingOverrides: ctx.pricingOverrides,
  });
  let result: ChronicleJudgeResult | null = null;
  let thrown: unknown = null;
  const parent = getCurrentBudgetTracker();
  try {
    result = await withBudgetTracker(tracker, () => (invite ? Promise.resolve({ events: [invite] }) : ctx.judge(judgeCtx.input)));
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    thrown = error ?? new Error('judge failed');
  } finally {
    propagateSpend(parent, tracker);
  }
  const models = tracker.snapshot().models;
  const unpriced = models.some((m) => m.cost_usd === null && m.calls > 0);
  const spend = { costUsd: unpriced ? null : tracker.totalSpent, unpriced };
  const judged = { judged: !invite, ...spend };

  // E4: gateway accounting defers a breach to the next reservation; check the cap explicitly.
  const overCap = tracker.cap !== undefined && tracker.totalSpent > tracker.cap;
  const failure = overCap && !thrown ? { state: 'failed' as const, reason: 'budget_exhausted' as const } : classifyJudge(result, thrown);
  if (failure) {
    const next = failure.state === 'skipped' || CONFIG_BLOCKED.has(failure.reason) ? null : backoff(attempts, now, maxAttempts);
    await finish(engine, row, attempts, { state: failure.state, reason: failure.reason, nextAttemptAt: next, ...spend });
    return done(failure.state, failure.reason, judged);
  }

  const proposals = result?.events ?? [];
  const { events, dropped } = buildChronicleEvents(proposals, judgeCtx,
    { slug: pin.slug, visibility: pin.visibility, contentHash: pin.contentHash }, { tz: ctx.tz, now });
  let generation;
  try {
    generation = await publishChronicleGeneration(engine, {
      sourceId: row.source_id, pin, decisionRequestId: row.request_id, maintenance: ctx.maintenance, signal: ctx.signal,
      events: invite ? markInviteEvents(events) : events,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    console.warn(`[chronicle] ${row.slug}: publishing events failed (${error instanceof Error ? error.message : String(error)}); the row retries with backoff. Run now: gbrain dream --phase chronicle`);
    await finish(engine, row, attempts, { state: 'failed', reason: 'publish_error', nextAttemptAt: backoff(attempts, now, maxAttempts), ...spend });
    return done('failed', 'publish_error', { ...judged, dropped });
  }
  if (generation.superseded) {
    await finish(engine, row, attempts, { state: 'skipped', reason: 'superseded', nextAttemptAt: null, events: generation.written, ...spend });
    return done('skipped', 'superseded', { ...judged, written: generation.written.length, dropped });
  }
  const reason = events.length > 0 ? null : proposals.length === 0 ? 'no_events' : allDroppedReason(dropped);
  await finish(engine, row, attempts, { state: 'extracted', reason, nextAttemptAt: null, events: generation.written, ...spend });
  return done('extracted', reason, { ...judged, written: generation.written.length, retired: generation.retired.length, dropped });
}

export type { ChronicleDepthPin };
