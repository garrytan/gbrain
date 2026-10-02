/**
 * `gbrain facts relink` (#5836): link active facts saved without an entity to
 * the entity they are about, moving each row by id onto that entity page's
 * `## Facts` fence (see relink-publish.ts for the publication contract).
 *
 * Subject tiers, cheapest first: the recorded source page and a unique
 * entity mention (inferFactSubject, zero LLM), then the configured
 * fact-extraction model for the rest (capped by --max-usd, private facts only
 * with --include-private). Candidates are walked by id from --after-id, so a
 * fact that can never be linked never blocks the ones after it; every run
 * reports the continuation point.
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { inferFactSubject, recordedPageSlug } from './subject-infer.ts';
import { RELINK_REASONS, type RelinkReason } from './relink-reasons.ts';
import { estimateModelTokens, judgeBatch, MODEL_BATCH_SIZE, type ModelVerdict } from './relink-model.ts';
import { relinkFactHash, submitRelinkGroup, type RelinkIntentFact } from './relink-publish.ts';

export const RELINK_DEFAULT_LIMIT = 1000;
export const RELINK_DEFAULT_MAX_USD = 1;
export const RELINK_SCHEMA_VERSION = 1;

export interface RelinkOptions {
  sourceId: string;
  afterId?: number;
  since?: Date;
  limit?: number;
  dryRun?: boolean;
  /** Model tier on (default true). */
  llm?: boolean;
  retryModel?: boolean;
  /** USD cap for the model tier; null = uncapped. */
  maxUsd?: number | null;
  includePrivate?: boolean;
  /** Queue linked facts for the conflict sweep when the slot is not off (default true). */
  conflictQueue?: boolean;
  examples?: number;
  config: GBrainConfig;
  signal?: AbortSignal;
  /** Called before the first model call with the provider line. */
  onModelStart?: (line: string) => void;
  onProgress?: (done: number, total: number) => void;
}

export type RelinkTier = 'page' | 'mention' | 'model';
interface Example { id: number; fact: string; target?: string }

export interface RelinkReport {
  schema_version: number;
  run_id: string;
  status: 'complete' | 'partial';
  dry_run: boolean;
  source_id: string;
  scanned: number;
  linked: number;
  linked_by_tier: Record<RelinkTier, number>;
  deduped: number;
  skipped: Partial<Record<RelinkReason, number>>;
  fence_owned: number;
  queued_for_conflict: number;
  eligible_for_conflict: number;
  provider: string | null;
  facts_sent_to_model: number;
  private_excluded_from_model: number;
  estimated_model_cost_usd: number | null;
  spend_usd: number;
  has_more: boolean;
  next_after_id: number | null;
  stopped?: string;
  examples: Record<string, Example[]>;
}

interface Candidate { id: number; fact: string; visibility: 'private' | 'world'; context: string | null; source: string | null }
interface Planned { id: number; slug: string; tier: RelinkTier; model: string | null }

const MODEL_VERDICT_SKIP = new Set<string>(['no_subject', 'ambiguous', 'unverified_match']);

function emptyReport(opts: RelinkOptions, runId: string): RelinkReport {
  return {
    schema_version: RELINK_SCHEMA_VERSION, run_id: runId, status: 'complete', dry_run: opts.dryRun === true, source_id: opts.sourceId,
    scanned: 0, linked: 0, linked_by_tier: { page: 0, mention: 0, model: 0 }, deduped: 0, skipped: {}, fence_owned: 0,
    queued_for_conflict: 0, eligible_for_conflict: 0, provider: null, facts_sent_to_model: 0, private_excluded_from_model: 0,
    estimated_model_cost_usd: null, spend_usd: 0, has_more: false, next_after_id: null, examples: {},
  };
}

export async function loadRelinkCandidates(engine: BrainEngine, opts: RelinkOptions): Promise<{ rows: Candidate[]; hasMore: boolean }> {
  const limit = opts.limit ?? RELINK_DEFAULT_LIMIT;
  const rows = await engine.executeRaw<Candidate & { id: number | string }>(
    `SELECT id, fact, visibility, context, source FROM facts
      WHERE source_id = $1 AND entity_slug IS NULL AND expired_at IS NULL
        AND row_num IS NULL AND source_markdown_slug IS NULL
        AND (valid_until IS NULL OR valid_until > now())
        AND id > $2 AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
      ORDER BY id LIMIT $4`,
    [opts.sourceId, opts.afterId ?? 0, opts.since ? opts.since.toISOString() : null, limit + 1],
  );
  return { rows: rows.slice(0, limit).map(r => ({ ...r, id: Number(r.id) })), hasMore: rows.length > limit };
}

export async function runFactsRelink(engine: BrainEngine, opts: RelinkOptions): Promise<RelinkReport> {
  const runId = randomUUID();
  const report = emptyReport(opts, runId);
  const keep = opts.examples ?? 3;
  const note = (outcome: string, c: Candidate, target?: string) => {
    const list = report.examples[outcome] ??= [];
    if (list.length < keep) list.push({ id: c.id, fact: c.fact.length > 120 ? `${c.fact.slice(0, 117)}...` : c.fact, ...(target ? { target } : {}) });
  };
  const skip = (reason: RelinkReason, c: Candidate) => {
    report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
    note(reason, c);
  };

  const [owned] = await engine.executeRaw<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM facts WHERE source_id = $1 AND entity_slug IS NULL AND expired_at IS NULL
       AND (row_num IS NOT NULL OR source_markdown_slug IS NOT NULL)`, [opts.sourceId]);
  report.fence_owned = Number(owned?.n ?? 0);

  const { rows, hasMore } = await loadRelinkCandidates(engine, opts);
  report.scanned = rows.length;
  report.has_more = hasMore;
  report.next_after_id = hasMore && rows.length ? rows[rows.length - 1]!.id : null;
  if (hasMore) report.status = 'partial';

  // Free tiers.
  const planned: Planned[] = [];
  const leftovers: Array<Candidate & { freeReason: RelinkReason; resolved: string[] }> = [];
  for (const [i, c] of rows.entries()) {
    opts.signal?.throwIfAborted();
    const r = await inferFactSubject(engine, opts.sourceId, { fact: c.fact, pageSlug: recordedPageSlug(c.context, c.source), mode: 'relink' });
    if (r.slug !== null) planned.push({ id: c.id, slug: r.slug, tier: r.via, model: null });
    else leftovers.push({ ...c, freeReason: r.reason, resolved: r.resolved });
    opts.onProgress?.(i + 1, rows.length);
  }

  // Model tier.
  const byId = new Map(rows.map(c => [c.id, c]));
  await runModelTier(engine, opts, report, leftovers, planned, skip);

  // Publication, one coordinator request per entity page.
  const groups = new Map<string, Planned[]>();
  for (const p of planned) groups.set(p.slug, [...(groups.get(p.slug) ?? []), p]);
  const queue = opts.conflictQueue !== false && await conflictSlotOn(engine);
  const linkedIds: number[] = [];
  for (const [slug, group] of groups) {
    opts.signal?.throwIfAborted();
    if (opts.dryRun) {
      for (const p of group) {
        report.linked += 1;
        report.linked_by_tier[p.tier] += 1;
        note('linked', byId.get(p.id)!, slug);
      }
      continue;
    }
    const { readFacts } = await import('../persistence/prepared-maintenance.ts');
    const snaps = await readFacts(engine, opts.sourceId, group.map(p => p.id));
    const facts: RelinkIntentFact[] = group.flatMap(p => {
      const snap = snaps.find(s => s.id === p.id);
      if (!snap) return [];
      const how = p.tier === 'model' ? `by model (${p.model})` : `from ${p.tier}`;
      return [{ id: p.id, hash: relinkFactHash(snap), tier: p.tier, model: p.model, note: `entity relinked ${how}` }];
    });
    const result = await submitRelinkGroup(engine, opts.config, opts.sourceId, slug, { kind: 'relink_facts', run_id: runId, queue_conflict: queue, facts });
    if (!result.ok) {
      for (const p of group) skip(result.reason, byId.get(p.id)!);
      continue;
    }
    const tierOf = new Map(group.map(p => [p.id, p.tier]));
    for (const l of result.outcome.linked) {
      report.linked += 1;
      report.linked_by_tier[tierOf.get(l.id)!] += 1;
      linkedIds.push(l.id);
      note('linked', byId.get(l.id)!, slug);
    }
    for (const d of result.outcome.deduped) {
      report.deduped += 1;
      note('deduped', byId.get(d.id)!, slug);
    }
    for (const s of result.outcome.skipped) skip(s.reason, byId.get(s.id)!);
    report.queued_for_conflict += result.outcome.queued;
  }
  if (linkedIds.length) {
    const [eligible] = await engine.executeRaw<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[]) AND embedding IS NOT NULL', [opts.sourceId, linkedIds]);
    report.eligible_for_conflict = Number(eligible?.n ?? 0);
  }
  if (report.stopped) report.status = 'partial';
  if (!opts.dryRun) await logRun(engine, report);
  return report;
}

async function runModelTier(engine: BrainEngine, opts: RelinkOptions, report: RelinkReport,
  leftovers: Array<Candidate & { freeReason: RelinkReason; resolved: string[] }>, planned: Planned[],
  skip: (reason: RelinkReason, c: Candidate) => void): Promise<void> {
  if (opts.llm === false || leftovers.length === 0) {
    for (const c of leftovers) skip(c.freeReason, c);
    return;
  }
  const memo = opts.retryModel ? new Map<number, string>() : await modelVerdicts(engine, opts.sourceId, leftovers.map(c => c.id));
  const eligible: typeof leftovers = [];
  for (const c of leftovers) {
    const prior = memo.get(c.id);
    if (prior) skip(prior as RelinkReason, c);
    // Two entities resolved in the text is real ambiguity; the model would only be picking one.
    else if (c.resolved.length > 1) skip(c.freeReason, c);
    else if (c.visibility === 'private' && !opts.includePrivate) { report.private_excluded_from_model += 1; skip(c.freeReason, c); }
    else eligible.push(c);
  }
  if (eligible.length === 0) return;

  const { resolveExtractionAvailability } = await import('./extraction-availability.ts');
  const { model, available } = await resolveExtractionAvailability(engine);
  report.provider = model;
  const est = estimateModelTokens(eligible);
  report.estimated_model_cost_usd = await estimateUsd(model, est);
  if (!available) {
    for (const c of eligible) skip('model_unavailable', c);
    return;
  }
  if (opts.dryRun) {
    report.facts_sent_to_model = eligible.length;
    for (const c of eligible) skip(c.freeReason, c);
    return;
  }
  opts.onModelStart?.(`model tier: ${eligible.length} fact(s) to ${model}, estimated $${(report.estimated_model_cost_usd ?? 0).toFixed(4)}` +
    `${opts.maxUsd == null ? ' (uncapped)' : `, cap $${opts.maxUsd.toFixed(2)}`}`);

  const { BudgetTracker, BudgetExhausted, loadPricingOverrides } = await import('../budget/budget-tracker.ts');
  const { withBudgetTracker } = await import('../ai/gateway.ts');
  const tracker = new BudgetTracker({ label: 'facts:relink', pricingOverrides: await loadPricingOverrides(engine),
    ...(opts.maxUsd == null ? {} : { maxCostUsd: opts.maxUsd }) });
  const verdicts: ModelVerdict[] = [];
  let i = 0;
  try {
    await withBudgetTracker(tracker, async () => {
      for (; i < eligible.length; i += MODEL_BATCH_SIZE) {
        opts.signal?.throwIfAborted();
        const batch = eligible.slice(i, i + MODEL_BATCH_SIZE);
        report.facts_sent_to_model += batch.length;
        try {
          verdicts.push(...await judgeBatch(engine, opts.sourceId, model, batch, opts.signal));
        } catch (err) {
          if (err instanceof BudgetExhausted) throw err;
          if ((err as Error)?.name === 'AbortError') throw err;
          for (const c of batch) skip('model_unavailable', c);
        }
      }
    });
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    report.stopped = 'budget_exhausted';
    const judged = new Set(verdicts.map(v => v.id));
    for (const c of eligible.slice(i)) if (!judged.has(c.id)) skip('budget_exhausted', c);
  }
  report.spend_usd = Number(tracker.totalSpent.toFixed(6));
  // The gateway records a call's real cost after it returns; a last call that
  // went over the cap surfaces here rather than at a next reservation.
  if (opts.maxUsd != null && tracker.totalSpent > opts.maxUsd) report.stopped ??= 'budget_exhausted';
  const byId = new Map(eligible.map(c => [c.id, c]));
  for (const v of verdicts) {
    if (v.slug !== null) { planned.push({ id: v.id, slug: v.slug, tier: 'model', model }); continue; }
    skip(v.reason, byId.get(v.id)!);
    if (MODEL_VERDICT_SKIP.has(v.reason)) await recordModelVerdict(engine, opts.sourceId, v.id, v.reason, model, report.run_id);
  }
}

async function modelVerdicts(engine: BrainEngine, sourceId: string, ids: number[]): Promise<Map<number, string>> {
  const memoized = Object.entries(RELINK_REASONS).filter(([, r]) => r.memoized).map(([code]) => code);
  const rows = await engine.executeRaw<{ fact_id: number | string; outcome: string }>(
    `SELECT fact_id, outcome FROM fact_relink_attempts WHERE source_id = $1 AND fact_id = ANY($2::bigint[]) AND outcome = ANY($3::text[])`,
    [sourceId, ids, memoized]);
  return new Map(rows.map(r => [Number(r.fact_id), r.outcome]));
}

async function recordModelVerdict(engine: BrainEngine, sourceId: string, factId: number, outcome: string, model: string, runId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier, model, target_slug, run_id, attempted_at)
     VALUES ($1, $2, $3, $3, 'model', $4, NULL, $5, now())
     ON CONFLICT (source_id, fact_id) DO UPDATE SET outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, tier = 'model',
       model = EXCLUDED.model, target_slug = NULL, run_id = EXCLUDED.run_id, attempted_at = EXCLUDED.attempted_at`,
    [sourceId, factId, outcome, model, runId]);
}

async function conflictSlotOn(engine: BrainEngine): Promise<boolean> {
  const { loadConfigSnapshot } = await import('../config-snapshot.ts');
  const { readDecideConfig } = await import('../ai/decide/config.ts');
  const { hasTypesafeKey } = await import('../ai/decide/index.ts');
  const cfg = readDecideConfig(await loadConfigSnapshot(engine), { typesafeKey: hasTypesafeKey() });
  return cfg.slots.conflict.mode !== 'off';
}

async function estimateUsd(model: string, tokens: { input: number; output: number }): Promise<number | null> {
  const { canonicalLookup } = await import('../model-pricing.ts');
  const price = canonicalLookup(model);
  return price ? Number(((tokens.input * price.input + tokens.output * price.output) / 1_000_000).toFixed(6)) : null;
}

async function logRun(engine: BrainEngine, report: RelinkReport): Promise<void> {
  try {
    await engine.logIngest({
      source_id: report.source_id, source_type: 'facts:relink', source_ref: report.run_id, pages_updated: [],
      summary: `relink ${report.status}: scanned ${report.scanned}, linked ${report.linked} (page ${report.linked_by_tier.page}, mention ${report.linked_by_tier.mention}, model ${report.linked_by_tier.model}), ` +
        `deduped ${report.deduped}, skipped ${Object.values(report.skipped).reduce((n, v) => n + (v ?? 0), 0)}, spend $${report.spend_usd.toFixed(4)}${report.provider ? ` (${report.provider})` : ''}`,
    });
  } catch (err) {
    console.warn(`[facts:relink] run summary not logged: ${err instanceof Error ? err.message : String(err)}`);
  }
}
