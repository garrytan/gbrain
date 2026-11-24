/**
 * v0.41.39 (issue #1700) — cycle phase `enrich_thin`.
 *
 * Opt-in autopilot trickle around `runEnrichCore`. Default OFF; enable with
 * `gbrain config set cycle.enrich_thin.enabled true`. Each tick develops a few
 * thin (stub) pages per source so the brain gets smarter over time, not just
 * bigger — the issue's explicit payoff.
 *
 * Architecture mirrors `conversation-facts-backfill.ts` (the precedent):
 *
 *   - Per-source iteration HERE. PHASE_SCOPE='source' is taxonomy-only (no
 *     runtime fan-out exists yet); the wrapper loops `listSources(engine)`.
 *   - ONE brain-wide BudgetTracker per tick, passed into every per-source
 *     `runEnrichCore` via `opts.budgetTracker` so the core uses it as-is (no
 *     nested `withBudgetTracker`, which would REPLACE the brain-wide cap).
 *   - Brain-wide walltime cap checked between sources.
 *   - Small per-source page cap (`max_pages_per_tick`, default 3) so a tick
 *     trickles rather than draining the whole stub backlog at once.
 *   - Optional daily caps on top of the per-tick caps, across every run in the
 *     owner's day (`brain.timezone`, UTC when unset). The running total lives
 *     in the internal config row `enrich_thin.daily_spend` ({day, spent_usd,
 *     pages}); before each source runs it is charged that source's full cap
 *     and pages, then trued up to what the source really spent, so a run that
 *     dies mid-source never under-counts (maintenance's embed_spend pattern).
 *   - Default order: `owner-contact` when the owner's page resolves
 *     (src/core/enrich/owner-contact.ts: no ownerIdentity conflict, page
 *     live), else `inbound-links`. A set `order` always wins. The ranking is
 *     keyless SQL, so dry-run and keyless runs report it and spend nothing.
 *
 * Config keys (defaults explicit):
 *   cycle.enrich_thin.enabled                (false)
 *   cycle.enrich_thin.max_cost_usd           (1.00)   per source per tick
 *   cycle.enrich_thin.max_total_cost_usd     (5.00)   brain-wide per tick
 *   cycle.enrich_thin.max_total_walltime_min (30)     brain-wide per tick
 *   cycle.enrich_thin.max_pages_per_tick     (3)      per source per tick
 *   cycle.enrich_thin.types                  (["person","company"])
 *   cycle.enrich_thin.order                  ("owner-contact" when the owner resolves, else "inbound-links")
 *   cycle.enrich_thin.max_daily_cost_usd     (unset: no daily cap)  every run in the owner's day
 *   cycle.enrich_thin.max_daily_pages        (unset: no daily cap)  every run in the owner's day
 *   cycle.enrich_thin.workers                (1)
 *   cycle.enrich_thin.model                  (configured chat model)
 */

import type { BrainEngine } from '../engine.ts';
import type { PageType } from '../types.ts';
import { BudgetExhausted } from '../budget/budget-tracker.ts';
import { hasCapability } from '../engine-capabilities.ts';
import { utcDate } from './cycle-date.ts';
import { resolveOwnerContactAnchor, type OwnerContactAnchor } from '../enrich/owner-contact.ts';
import { DEFAULT_THIN_THRESHOLD } from '../enrich/thin.ts';
import { isAvailable } from '../ai/gateway.ts';
import { listSources } from '../sources-ops.ts';
import {
  runEnrichCore,
  COST_ESTIMATE_PER_PAGE_USD,
  DEFAULT_TYPES,
  ENRICH_ORDERS,
  type EnrichOrder,
  type EnrichResult,
} from '../../commands/enrich.ts';

export interface EnrichThinPhaseOpts {
  dryRun?: boolean;
  signal?: AbortSignal;
  /**
   * issue #2860 — `gbrain dream --phase enrich_thin --once`. Bypasses the
   * `cycle.enrich_thin.enabled` gate for THIS call only; never reads or
   * writes config. Per-source + brain-wide cost/walltime caps still apply.
   */
  once?: boolean;
  /** Clock seam for the owner's day (tests). */
  now?: () => Date;
  /** Test seam: the per-source enrich run (default runEnrichCore). */
  enrichCore?: typeof runEnrichCore;
}

export interface EnrichThinPhaseResult {
  phase: 'enrich_thin';
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
}

const CFG_PREFIX = 'cycle.enrich_thin';
/** Internal state, not a knob: today's running enrich_thin total. */
export const ENRICH_THIN_DAILY_SPEND_KEY = 'enrich_thin.daily_spend';

export interface EnrichThinDailySpend { day: string; spent_usd: number; pages: number }

interface ResolvedConfig {
  enabled: boolean;
  maxCostUsd: number;          // per source per tick
  maxTotalCostUsd: number;     // brain-wide per tick
  maxTotalWalltimeMin: number; // brain-wide per tick
  maxPagesPerTick: number;     // per source per tick
  types: PageType[];
  /** Null when unset: the phase picks the default for this run. */
  order: EnrichOrder | null;
  maxDailyCostUsd: number;     // every run in the owner's day; Infinity = no cap
  maxDailyPages: number;       // every run in the owner's day; Infinity = no cap
  /** Daily cap keys set to a value that does not parse; the phase spends nothing until they are fixed. */
  invalidDailyCaps: string[];
  workers: number;
  model?: string;
}

async function loadCfg(engine: BrainEngine): Promise<ResolvedConfig> {
  const get = (k: string) => engine.getConfig(`${CFG_PREFIX}.${k}`);
  const [enabled, maxCost, maxTotalCost, maxTotalWall, maxPages, typesRaw, orderRaw, workersRaw, model, maxDailyCost, maxDailyPages] =
    await Promise.all([
      get('enabled'),
      get('max_cost_usd'),
      get('max_total_cost_usd'),
      get('max_total_walltime_min'),
      get('max_pages_per_tick'),
      get('types'),
      get('order'),
      get('workers'),
      get('model'),
      get('max_daily_cost_usd'),
      get('max_daily_pages'),
    ]);

  const enabledFlag = (() => {
    if (enabled == null) return false;
    const v = enabled.trim().toLowerCase();
    return !['false', '0', 'no', 'off', ''].includes(v);
  })();

  const parseFloatOrDefault = (raw: string | null, fallback: number): number => {
    if (raw == null) return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  // #2504 — cost knobs accept 'off'/'unlimited'/'none' (the same spellings
  // `gbrain enrich --max-usd` takes) → Infinity sentinel. Per-source 'off'
  // leaves the brain-wide total governing; both 'off' reaches runEnrichCore
  // as Infinity, which it maps to an uncapped tracker. parseFloat('off') used
  // to silently become the default cap — the operator's opt-out was ignored.
  const parseCostOrDefault = (raw: string | null, fallback: number): number => {
    if (raw != null && ['off', 'unlimited', 'none'].includes(raw.trim().toLowerCase())) {
      return Infinity;
    }
    const n = raw == null ? NaN : parseFloat(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const parseIntOrDefault = (raw: string | null, fallback: number): number => {
    if (raw == null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 ? n : fallback;
  };

  let types: PageType[] = [...DEFAULT_TYPES];
  if (typesRaw) {
    try {
      const parsed = JSON.parse(typesRaw);
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((t): t is string => typeof t === 'string' && t.length > 0);
        if (filtered.length > 0) types = filtered as PageType[];
      }
    } catch {
      // fall through to default
    }
  }

  // A set but unknown order keeps its historical meaning, inbound-links.
  const order: EnrichOrder | null = orderRaw == null ? null
    : (ENRICH_ORDERS as readonly string[]).includes(orderRaw.trim())
      ? (orderRaw.trim() as EnrichOrder)
      : 'inbound-links';
  const invalidDailyCaps: string[] = [];
  const parseDailyCap = (key: string, raw: string | null, parse: (s: string) => number): number => {
    if (raw == null || ['off', 'unlimited', 'none'].includes(raw.trim().toLowerCase())) return Infinity;
    const n = parse(raw);
    if (Number.isFinite(n) && n >= 0) return n;
    invalidDailyCaps.push(`${CFG_PREFIX}.${key}`);
    return 0;
  };

  return {
    enabled: enabledFlag,
    maxCostUsd: parseCostOrDefault(maxCost, 1.0),
    maxTotalCostUsd: parseCostOrDefault(maxTotalCost, 5.0),
    maxTotalWalltimeMin: parseFloatOrDefault(maxTotalWall, 30),
    maxPagesPerTick: parseIntOrDefault(maxPages, 3),
    types,
    order,
    maxDailyCostUsd: parseDailyCap('max_daily_cost_usd', maxDailyCost, parseFloat),
    maxDailyPages: parseDailyCap('max_daily_pages', maxDailyPages, s => parseInt(s, 10)),
    invalidDailyCaps,
    workers: parseIntOrDefault(workersRaw, 1),
    model: model ?? undefined,
  };
}

/** The owner's calendar day (YYYY-MM-DD) in `brain.timezone`; UTC when unset or invalid. */
async function ownerDay(engine: BrainEngine, at: Date): Promise<{ day: string; timezone: string }> {
  const configured = (await engine.getConfig('brain.timezone'))?.trim();
  for (const timeZone of configured ? [configured, 'UTC'] : ['UTC']) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
      const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
      return { day: `${part('year')}-${part('month')}-${part('day')}`, timezone: timeZone };
    } catch {
      // invalid zone: fall through to UTC
    }
  }
  return { day: utcDate(at), timezone: 'UTC' };
}

/**
 * Today's running total; a row from another day, or one that does not parse, counts as nothing spent.
 * A failed read throws: the phase never guesses zero spend.
 */
export async function readEnrichThinDailySpend(engine: BrainEngine, day: string): Promise<EnrichThinDailySpend> {
  const raw = await engine.getConfig(ENRICH_THIN_DAILY_SPEND_KEY);
  try {
    const v = raw ? JSON.parse(raw) as Partial<EnrichThinDailySpend> : null;
    if (v?.day === day && Number.isFinite(v.spent_usd) && Number.isFinite(v.pages)) {
      return { day, spent_usd: Number(v.spent_usd), pages: Number(v.pages) };
    }
  } catch {
    // unreadable row: start the day at zero
  }
  return { day, spent_usd: 0, pages: 0 };
}

async function writeDailySpend(engine: BrainEngine, v: EnrichThinDailySpend): Promise<void> {
  await engine.setConfig(ENRICH_THIN_DAILY_SPEND_KEY, JSON.stringify(v));
}

/** The order this run uses, and why: a set order wins, else owner-contact when the owner resolves. */
async function resolveOrder(engine: BrainEngine, configured: EnrichOrder | null): Promise<{ order: EnrichOrder; reason: string; owner?: OwnerContactAnchor | null }> {
  if (configured && configured !== 'owner-contact') return { order: configured, reason: 'configured' };
  const resolved = await resolveOwnerContactAnchor(engine);
  if (configured) return { order: configured, reason: 'configured', owner: resolved.owner };
  if (resolved.owner) return { order: 'owner-contact', reason: 'owner_resolved', owner: resolved.owner };
  return { order: 'inbound-links', reason: resolved.reason };
}

/** Thin pages the keyless count reads at most. */
const KEYLESS_CONTACTS_MAX = 5000;

/**
 * Keyless brains: how many thin pages of the phase's types the owner-contact ranking finds with recent contact
 * (contact_score > 0), and what filling them would cost (the daily cap when one is set, else the per-page estimate).
 * Null when a chat model is configured (the phase's own skip check) or the owner does not resolve. Ranks in SQL only:
 * no model call, no spend.
 */
export async function keylessThinContacts(engine: BrainEngine): Promise<{ count: number; cost_usd: number; cost_basis: 'daily_cap' | 'per_page_estimate' } | null> {
  if (isAvailable('chat')) return null;
  const resolved = await resolveOwnerContactAnchor(engine);
  if (!resolved.owner) return null;
  const cfg = await loadCfg(engine);
  const ranked = await engine.listEnrichCandidates({
    order: 'owner-contact', types: cfg.types, thinThreshold: DEFAULT_THIN_THRESHOLD, limit: KEYLESS_CONTACTS_MAX,
    ownerSlug: resolved.owner.slug, ownerSourceId: resolved.owner.source_id,
  });
  const count = ranked.filter(c => (c.contact_score ?? 0) > 0).length;
  if (Number.isFinite(cfg.maxDailyCostUsd)) return { count, cost_usd: cfg.maxDailyCostUsd, cost_basis: 'daily_cap' };
  return { count, cost_usd: Math.round(count * COST_ESTIMATE_PER_PAGE_USD * 100) / 100, cost_basis: 'per_page_estimate' };
}

export async function runPhaseEnrichThin(
  engine: BrainEngine,
  opts: EnrichThinPhaseOpts = {},
): Promise<EnrichThinPhaseResult> {
  const cfg = await loadCfg(engine);

  if (!cfg.enabled) {
    if (!opts.once) {
      return {
        phase: 'enrich_thin',
        status: 'skipped',
        duration_ms: 0,
        summary: 'cycle.enrich_thin.enabled=false (default OFF)',
        details: {
          reason: 'disabled',
          enable_hint: 'gbrain config set cycle.enrich_thin.enabled true',
        },
      };
    }
    process.stderr.write(
      '[dream] --once: cycle.enrich_thin.enabled is false but ' +
      '--phase enrich_thin --once forces this run (config untouched)\n',
    );
  }

  if (!hasCapability(engine, 'raw_sql')) {
    return {
      phase: 'enrich_thin',
      status: 'skipped',
      duration_ms: 0,
      summary: "skipped: this brain's engine cannot list enrich candidates yet",
      details: { reason: 'engine_capability_missing' },
    };
  }

  const startedAt = Date.now();
  const { order, reason: orderReason, owner } = await resolveOrder(engine, cfg.order);

  // Chat gateway required for synthesis (dry-run skips the LLM but still needs
  // the candidate query; allow dry-run without a gateway).
  if (!opts.dryRun && !isAvailable('chat')) {
    return {
      phase: 'enrich_thin',
      status: 'skipped',
      duration_ms: Date.now() - startedAt,
      summary: 'no chat gateway configured',
      details: { reason: 'no_chat_gateway', order, order_reason: orderReason, spent_usd: 0 },
    };
  }

  const { day, timezone } = await ownerDay(engine, opts.now?.() ?? new Date());
  const daily = await readEnrichThinDailySpend(engine, day);
  const dailyDetails = () => ({
    day, timezone, spent_usd: daily.spent_usd, pages: daily.pages,
    max_daily_cost_usd: Number.isFinite(cfg.maxDailyCostUsd) ? cfg.maxDailyCostUsd : 'off',
    max_daily_pages: Number.isFinite(cfg.maxDailyPages) ? cfg.maxDailyPages : 'off',
  });
  if (!opts.dryRun && cfg.invalidDailyCaps.length) {
    return {
      phase: 'enrich_thin',
      status: 'skipped',
      duration_ms: Date.now() - startedAt,
      summary: `daily cap set to a value that is not a number (${cfg.invalidDailyCaps.join(', ')}); nothing is spent until it is fixed`,
      details: { reason: 'daily_cap_invalid', keys: cfg.invalidDailyCaps, order, order_reason: orderReason, daily: dailyDetails(),
        fix_hint: `gbrain config set ${cfg.invalidDailyCaps[0]} <number>, or gbrain config unset ${cfg.invalidDailyCaps[0]} for no daily cap` },
    };
  }
  if (!opts.dryRun && (daily.spent_usd >= cfg.maxDailyCostUsd || daily.pages >= cfg.maxDailyPages)) {
    return {
      phase: 'enrich_thin',
      status: 'skipped',
      duration_ms: Date.now() - startedAt,
      summary: `daily cap reached for ${day} (~$${daily.spent_usd.toFixed(4)} spent, ${daily.pages} page(s) enriched)`,
      details: { reason: 'daily_cap_reached', order, order_reason: orderReason, daily: dailyDetails() },
    };
  }

  const maxTotalWalltimeMs = cfg.maxTotalWalltimeMin * 60_000;
  const { withoutGuestSources } = await import('../guests/derived.ts');
  const sources = await withoutGuestSources(engine, 'enrich_thin', await listSources(engine), src => src.id);
  if (sources.length === 0) {
    return {
      phase: 'enrich_thin',
      status: 'ok',
      duration_ms: Date.now() - startedAt,
      summary: 'no sources to process',
      details: { sources_count: 0 },
    };
  }

  // P2#2 (codex): enforce BOTH a per-source cap AND the brain-wide total. Per
  // source we run with maxCostUsd = min(per-source cap, brain-wide remaining);
  // runEnrichCore creates + enforces its own tracker for that cap (its internal
  // withBudgetTracker). We sum each source's spend and stop the loop once the
  // brain-wide total is reached. The prior single brain-wide tracker let one
  // source drain the whole tick; passing a per-source cap fixes that without
  // nested withBudgetTracker (which REPLACES, not stacks).
  const perSourceResults: Record<string, EnrichResult & { error?: string }> = {};
  let skippedByBrainWideWalltime = 0;
  let totalSpent = 0;

  for (const src of sources) {
    if (opts.signal?.aborted) throw new Error('aborted'); // propagates; cycle handles
    if (Date.now() - startedAt > maxTotalWalltimeMs) {
      skippedByBrainWideWalltime++;
      continue;
    }
    const remainingBrainWide = cfg.maxTotalCostUsd - totalSpent;
    if (remainingBrainWide <= 0) break; // brain-wide cap reached
    const remainingDailyUsd = cfg.maxDailyCostUsd - daily.spent_usd;
    const remainingDailyPages = cfg.maxDailyPages - daily.pages;
    if (!opts.dryRun && (remainingDailyUsd <= 0 || remainingDailyPages <= 0)) break; // daily cap reached
    const perSourceCap = Math.min(cfg.maxCostUsd, remainingBrainWide, opts.dryRun ? Infinity : remainingDailyUsd);
    const limit = Math.min(cfg.maxPagesPerTick, opts.dryRun ? Infinity : remainingDailyPages);
    const before = { ...daily };
    if (!opts.dryRun) {
      // Charge the whole source up front; a run that dies here stays charged.
      daily.spent_usd += Number.isFinite(perSourceCap) ? perSourceCap : 0;
      daily.pages += limit;
      await writeDailySpend(engine, daily);
    }
    try {
      const r = await (opts.enrichCore ?? runEnrichCore)(engine, {
        sourceId: src.id,
        types: cfg.types,
        order,
        ...(order === 'owner-contact' ? { owner: owner ?? null } : {}),
        limit,
        workers: cfg.workers,
        model: cfg.model,
        dryRun: opts.dryRun,
        maxCostUsd: perSourceCap,
      }, opts.signal);
      perSourceResults[src.id] = r;
      totalSpent += r.spent_usd ?? 0;
      if (!opts.dryRun) {
        daily.spent_usd = before.spent_usd + (r.spent_usd ?? 0);
        daily.pages = before.pages + r.pages_enriched;
        await writeDailySpend(engine, daily);
      }
      // r.budget_exhausted here means THIS source hit perSourceCap. Only stop the
      // whole tick when the brain-wide total is actually reached; otherwise move
      // on so a cheap source isn't starved by an expensive earlier one.
      if (totalSpent >= cfg.maxTotalCostUsd) break;
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        // Defensive: runEnrichCore returns partial on budget rather than throwing.
        continue;
      }
      perSourceResults[src.id] = {
        candidates_considered: 0,
        pages_enriched: 0,
        pages_skipped_insufficient: 0,
        pages_skipped_lock: 0,
        pages_skipped_disappeared: 0,
        pages_failed: 0,
        error: (err as Error).message,
      };
    }
  }

  const totals = { enriched: 0, skipped_insufficient: 0, sources_processed: 0 };
  for (const r of Object.values(perSourceResults)) {
    if (!r.error) totals.sources_processed++;
    totals.enriched += r.pages_enriched;
    totals.skipped_insufficient += r.pages_skipped_insufficient;
  }

  const anyError = Object.values(perSourceResults).some((r) => r.error);
  const status = anyError ? 'warn' : 'ok';
  const summary = `${totals.enriched} page(s) enriched across ${totals.sources_processed}/${sources.length} sources, ~$${totalSpent.toFixed(4)} spent`;

  return {
    phase: 'enrich_thin',
    status,
    duration_ms: Date.now() - startedAt,
    summary,
    details: {
      sources_count: sources.length,
      sources_processed: totals.sources_processed,
      pages_enriched: totals.enriched,
      pages_skipped_insufficient: totals.skipped_insufficient,
      spent_usd: totalSpent,
      skipped_by_brain_wide_walltime: skippedByBrainWideWalltime,
      // #2504 — Infinity would JSON-serialize to null; report the 'off'
      // spelling the operator configured instead.
      max_cost_usd: Number.isFinite(cfg.maxCostUsd) ? cfg.maxCostUsd : 'off',
      max_total_cost_usd: Number.isFinite(cfg.maxTotalCostUsd) ? cfg.maxTotalCostUsd : 'off',
      max_pages_per_tick: cfg.maxPagesPerTick,
      types: cfg.types,
      order,
      order_reason: orderReason,
      daily: dailyDetails(),
      per_source: perSourceResults,
    },
  };
}
