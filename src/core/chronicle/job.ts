/**
 * One-page Life Chronicle extraction outside the cycle (the legacy
 * `chronicle_extract` job). Records the page in the ledger as trusted local
 * work and runs the shared executor.
 */
import type { BrainEngine } from '../engine.ts';
import { getChatModel, isAvailable } from '../ai/gateway.ts';
import { loadPricingOverrides } from '../budget/budget-tracker.ts';
import { resolveExtractAtomsCostGate } from '../cycle/extract-atoms-cost-gate.ts';
import { maintenancePreflight } from '../persistence/prepared-maintenance.ts';
import { chronicleSettings, chronicleTz } from './config.ts';
import { claimChronicleRow, executeChronicleRow } from './execute.ts';
import { rowMaxAttempts } from './campaign.ts';
import { defaultJudge, type ChronicleJudge } from './extract-events.ts';
import { readChronicleRow, upsertChronicleRow } from './ledger.ts';
import { noPricingMessage } from '../budget/no-pricing.ts';

export interface ChronicleJobResult {
  slug: string;
  status: 'extracted' | 'no_events' | 'skipped' | 'failed';
  reason?: string;
  events_written?: number;
  events_retired?: number;
  /** A failed run worth retrying with backoff (provider error, publish error). */
  retry?: boolean;
}

const RETRYABLE = new Set(['judge_chat_error', 'publish_error', 'judge_parse_failed']);

export async function runChronicleJob(engine: BrainEngine, opts: {
  slug: string; sourceId: string; contentHash?: string; trigger: 'auto' | 'backfill' | 'legacy';
  judge?: ChronicleJudge; signal?: AbortSignal;
}): Promise<ChronicleJobResult> {
  const { slug, sourceId } = opts;
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) return { slug, status: 'skipped', reason: 'page_missing' };
  const contentHash = String(snapshot.page.content_hash ?? '');
  if (opts.contentHash && opts.contentHash !== contentHash) return { slug, status: 'skipped', reason: 'superseded' };
  const key = { sourceId, pageId: Number(snapshot.page.id), contentHash };
  const existing = await readChronicleRow(engine, key);
  if (existing?.state === 'extracted') return { slug, status: 'skipped', reason: 'already_extracted' };
  const judge = opts.judge ?? (isAvailable('chat') ? defaultJudge(engine) : null);
  if (!judge) return { slug, status: 'failed', reason: 'judge_llm_unavailable' };
  const settings = await chronicleSettings(engine);
  const pricingOverrides = await loadPricingOverrides(engine);
  const model = getChatModel();
  const gate = resolveExtractAtomsCostGate(model, null, pricingOverrides, { explicitBudget: settings.explicitBudget });
  if (gate.refusal) return { slug, status: 'failed', reason: `no_pricing: ${noPricingMessage(gate.refusal, { capUsd: settings.jobBudgetUsd })}` };
  const trigger = opts.trigger === 'auto' ? 'auto' : 'backfill';
  // A write decision or backfill already queued this content: the cycle phase owns it.
  // A capped backfill row with attempts left stays under its campaign's stamped bound (#6199).
  if (existing?.state === 'pending' || (existing?.campaign_id && existing.state === 'failed' && existing.attempts < rowMaxAttempts(existing))) {
    return { slug, status: 'skipped', reason: 'queued_for_cycle' };
  }
  await upsertChronicleRow(engine, { ...key, slug, state: 'pending', reason: null, trigger, nextAttemptAt: null });
  const row = await readChronicleRow(engine, key);
  const claimed = row && await claimChronicleRow(engine, row);
  if (!claimed) return { slug, status: 'skipped', reason: 'claimed_elsewhere' };
  const outcome = await executeChronicleRow({
    engine, settings, judge, gate, pricingOverrides, tz: await chronicleTz(engine), signal: opts.signal,
    maintenance: await maintenancePreflight(engine, sourceId),
    label: opts.trigger === 'legacy' ? 'chronicle:legacy' : undefined,
  }, claimed);
  if (outcome.kind !== 'done') return { slug, status: 'skipped', reason: outcome.reason };
  if (outcome.state === 'failed') return { slug, status: 'failed', reason: outcome.reason ?? 'failed', retry: RETRYABLE.has(outcome.reason ?? '') };
  if (outcome.state === 'extracted') {
    return { slug, status: outcome.reason ? 'no_events' : 'extracted', events_written: outcome.written, events_retired: outcome.retired };
  }
  return { slug, status: 'skipped', reason: outcome.reason ?? undefined };
}
