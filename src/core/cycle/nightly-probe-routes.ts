/**
 * Model routes of the nightly quality probe (#5872), resolved against the
 * live brain by the caller that holds the engine — the same shape as the
 * #3676 search-config snapshot. `gbrain eval longmemeval` and
 * `gbrain eval cross-modal` run without a brain by design, so the autopilot
 * step resolves here and passes the result through their existing flags and
 * `RunOpts`:
 *
 *   reader     models.eval.longmemeval → models.tier.reasoning → models.default
 *              → GBRAIN_MODEL → key-aware reasoning default
 *              → `gbrain eval longmemeval --model <reader>`
 *   extractor  models.tier.utility → models.default → GBRAIN_MODEL
 *              → key-aware utility default
 *              → LongMemEval `RunOpts.extractorModel`
 *   slots      models.eval.cross_modal.slot_{a,b,c}; unset or blank leaves the
 *              panel default (DEFAULT_SLOTS) under the #4636 substitution
 *              → `gbrain eval cross-modal --slot-<x>-model <m>`
 *
 * The reader chain is the one `gbrain models` reports for
 * `models.eval.longmemeval`; `gbrain models` reads these routes too, so the
 * report shows what the probe takes.
 */

import type { ConfigReader } from '../config-snapshot.ts';
import {
  TIER_DEFAULTS,
  resolveAlias,
  resolveModelDetailed,
  type ResolveModelOpts,
  type ResolvedModel,
} from '../model-config.ts';

export type NightlyProbeSlotId = 'A' | 'B' | 'C';

export const NIGHTLY_PROBE_READER_ROUTE = {
  configKey: 'models.eval.longmemeval',
  tier: 'reasoning',
  envVar: 'GBRAIN_MODEL',
  fallback: TIER_DEFAULTS.reasoning,
} as const satisfies ResolveModelOpts;

export const NIGHTLY_PROBE_EXTRACTOR_ROUTE = {
  tier: 'utility',
  fallback: TIER_DEFAULTS.utility,
} as const satisfies ResolveModelOpts;

export const NIGHTLY_PROBE_SLOT_KEYS: Readonly<Record<NightlyProbeSlotId, string>> = Object.freeze({
  A: 'models.eval.cross_modal.slot_a',
  B: 'models.eval.cross_modal.slot_b',
  C: 'models.eval.cross_modal.slot_c',
});

export interface NightlyProbeModelRoutes {
  reader: ResolvedModel;
  extractor: ResolvedModel;
  /** Alias-expanded model per slot whose config key is set; unset and blank keys are absent. */
  slots: Partial<Record<NightlyProbeSlotId, string>>;
}

/**
 * The probe could not refresh its gateway or read its model routes. The
 * message names the routes so the `error` audit row says what failed.
 */
export class NightlyProbeModelRoutesError extends Error {
  constructor(cause: unknown) {
    super(
      `nightly-quality-probe: could not resolve the model routes ` +
      `(reader, extractor, judge slots) from the brain: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'NightlyProbeModelRoutesError';
  }
}

export async function resolveNightlyProbeModelRoutes(
  engine: ConfigReader,
): Promise<NightlyProbeModelRoutes> {
  try {
    const reader = await resolveModelDetailed(engine, NIGHTLY_PROBE_READER_ROUTE);
    const extractor = await resolveModelDetailed(engine, NIGHTLY_PROBE_EXTRACTOR_ROUTE);
    const slots: NightlyProbeModelRoutes['slots'] = {};
    for (const [id, key] of Object.entries(NIGHTLY_PROBE_SLOT_KEYS) as Array<[NightlyProbeSlotId, string]>) {
      const value = (await engine.getConfig(key))?.trim();
      if (value) slots[id] = await resolveAlias(engine, value);
    }
    return { reader, extractor, slots };
  } catch (err) {
    throw new NightlyProbeModelRoutesError(err);
  }
}
