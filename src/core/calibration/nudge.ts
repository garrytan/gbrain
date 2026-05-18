/**
 * v0.36.1.0 (T13 / E7) — real-time pattern surfacing on take commit.
 *
 * The nudge surface that taps the user on the shoulder when a newly-committed
 * take matches an active bias pattern. Conversational voice (D24 mode='nudge'),
 * 14-day cooldown per (take_id, nudge_pattern) via take_nudge_log so the same
 * pattern doesn't re-fire on every cycle.
 *
 * Threshold rules (D16 / F3):
 *   - conviction-weight > 0.7 → eligible
 *   - take's holder is the calibration profile's holder
 *   - take's domain hint matches an active bias tag (same heuristic as the
 *     calibration-aware contradictions join — see eval-contradictions/calibration-join.ts)
 *
 * Feedback-loop prevention (D16 F3):
 *   - take_nudge_log records every fire keyed on (take_id|proposal_id,
 *     nudge_pattern). The cooldown probe checks "was this same pattern fired
 *     on this same take in the last NUDGE_COOLDOWN_DAYS?" If yes, silently skip.
 *   - Reset via `gbrain takes nudge --reset <take_id>` clears the cooldown
 *     for that take so the next sync re-fires fresh nudges.
 *
 * Output channel:
 *   v0.36.1.0 ship state: STDERR only. Multi-channel routing (webhook,
 *   admin SPA toast) is a v0.37+ follow-up — the schema's `channel` column
 *   already supports it.
 */

import type { BrainEngine, Take } from '../engine.ts';
import type { CalibrationProfileRow } from '../../commands/calibration.ts';
import { nudgeTemplate } from './templates.ts';

export const NUDGE_COOLDOWN_DAYS = 14;
export const NUDGE_CONVICTION_THRESHOLD = 0.7;

export interface NudgeDecision {
  /** Should the nudge fire? */
  shouldFire: boolean;
  /** Why not — surfaced for debugging + audit. */
  reason?:
    | 'no_profile'
    | 'below_conviction_threshold'
    | 'no_matching_bias_tag'
    | 'cooldown_active'
    | 'wrong_holder';
  /** The bias tag matched (when shouldFire=true). */
  matchedTag?: string;
  /** The conversational nudge text (when shouldFire=true). */
  text?: string;
}

/**
 * Map a take's metadata to a domain hint that joins against bias tags.
 * Same heuristic as eval-contradictions/calibration-join.ts to keep the
 * surfaces consistent.
 */
export function takeDomainHint(take: Take): string {
  const slug = take.page_slug.toLowerCase();
  if (slug.includes('/companies/') || slug.startsWith('companies/')) return 'hiring';
  if (slug.includes('/people/') || slug.startsWith('people/')) return 'founder-behavior';
  if (slug.includes('/deals/') || slug.startsWith('deals/')) return 'market-timing';
  if (slug.includes('macro')) return 'macro';
  if (slug.includes('geography')) return 'geography';
  if (slug.includes('tactics')) return 'tactics';
  if (slug.includes('/ai/') || slug.includes('-ai-')) return 'ai';
  return '';
}

/** Pure: decide whether a take should fire a nudge given the active profile. */
export function evaluateNudgeRule(
  take: Take,
  profile: CalibrationProfileRow | null,
): { matched: boolean; reason?: NudgeDecision['reason']; matchedTag?: string } {
  if (!profile) return { matched: false, reason: 'no_profile' };
  if (take.holder !== profile.holder) return { matched: false, reason: 'wrong_holder' };
  if (take.weight <= NUDGE_CONVICTION_THRESHOLD) {
    return { matched: false, reason: 'below_conviction_threshold' };
  }
  const hint = takeDomainHint(take);
  if (!hint) return { matched: false, reason: 'no_matching_bias_tag' };
  for (const tag of profile.active_bias_tags) {
    if (tag.toLowerCase().includes(hint)) {
      return { matched: true, matchedTag: tag };
    }
  }
  return { matched: false, reason: 'no_matching_bias_tag' };
}

/**
 * Check the take_nudge_log for an active cooldown on this (take_id,
 * pattern) within the last NUDGE_COOLDOWN_DAYS days.
 */
export async function checkCooldown(
  engine: BrainEngine,
  takeId: number,
  nudgePattern: string,
): Promise<boolean> {
  const cutoffDate = new Date(Date.now() - NUDGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM take_nudge_log
     WHERE take_id = $1 AND nudge_pattern = $2 AND fired_at >= $3
     LIMIT 1`,
    [takeId, nudgePattern, cutoffDate.toISOString()],
  );
  return rows.length > 0;
}

/**
 * Write a take_nudge_log row with channel='stderr'.
 */
export async function recordNudgeFire(
  engine: BrainEngine,
  opts: { sourceId: string; takeId: number; nudgePattern: string; channel?: string },
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO take_nudge_log (source_id, take_id, nudge_pattern, channel)
     VALUES ($1, $2, $3, $4)`,
    [opts.sourceId, opts.takeId, opts.nudgePattern, opts.channel ?? 'stderr'],
  );
}

/**
 * Build the conversational nudge text via the templates module. v0.36.1.0
 * ship state: uses the template directly (no LLM-generation path). The
 * voice gate (T6) wraps this surface at v0.37+ when we have enough
 * production examples to tune the LLM prompt.
 */
export function buildNudgeText(opts: {
  matchedTag: string;
  conviction: number;
  /** Optional: count of recent misses in same conviction bucket. */
  nRecentMisses?: number;
  nRecentTotal?: number;
}): string {
  // Domain extracted from tag — kebab-case last segment after axis prefix.
  const domain = opts.matchedTag.split('-').slice(-1)[0] ?? 'this area';
  return nudgeTemplate({
    domain,
    conviction: opts.conviction,
    nRecentMisses: opts.nRecentMisses ?? 0,
    nRecentTotal: opts.nRecentTotal ?? 0,
    hushPattern: opts.matchedTag,
  });
}

export interface EvaluateAndFireOpts {
  engine: BrainEngine;
  take: Take;
  profile: CalibrationProfileRow | null;
  sourceId: string;
  /** Override the stderr stream (tests). Production: process.stderr. */
  stderr?: { write: (s: string) => void };
}

/**
 * Main entry point: evaluate, check cooldown, fire if appropriate, log.
 * Returns the NudgeDecision so callers can audit / surface in UI.
 *
 * Always succeeds (no-fire is success). Errors surface in the result's
 * reason field, not via throw.
 */
export async function evaluateAndFireNudge(opts: EvaluateAndFireOpts): Promise<NudgeDecision> {
  const rule = evaluateNudgeRule(opts.take, opts.profile);
  if (!rule.matched) {
    return {
      shouldFire: false,
      ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
    };
  }
  // Cooldown probe.
  const onCooldown = await checkCooldown(opts.engine, opts.take.id, rule.matchedTag!);
  if (onCooldown) {
    return {
      shouldFire: false,
      reason: 'cooldown_active',
      matchedTag: rule.matchedTag!,
    };
  }
  // Build + fire.
  const text = buildNudgeText({
    matchedTag: rule.matchedTag!,
    conviction: opts.take.weight,
  });
  const stream = opts.stderr ?? process.stderr;
  stream.write(text + '\n');
  // Log the fire (cooldown starts now).
  await recordNudgeFire(opts.engine, {
    sourceId: opts.sourceId,
    takeId: opts.take.id,
    nudgePattern: rule.matchedTag!,
  });
  return { shouldFire: true, matchedTag: rule.matchedTag!, text };
}

/**
 * Reset cooldown for a take. Deletes the take's nudge_log rows so the
 * next sync re-evaluates fresh.
 */
export async function resetNudgeCooldown(
  engine: BrainEngine,
  takeId: number,
): Promise<{ deleted: number }> {
  const rows = await engine.executeRaw<{ id: number }>(
    `DELETE FROM take_nudge_log WHERE take_id = $1 RETURNING id`,
    [takeId],
  );
  return { deleted: rows.length };
}
