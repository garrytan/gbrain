/**
 * Facts extraction availability — the ONE gate for "can this process run
 * fact extraction right now?" (#5735).
 *
 * It resolves the model extraction will actually use (facts.extraction_model
 * on the DB plane / models.default / tier config / key-aware default, via
 * getFactsExtractionModel) and asks the configured gateway whether that
 * model is servable. The engine-blind detectCapabilities() probe reads only
 * the file/env plane, so a servable DB-plane override (a local model on a
 * keyless install) was misclassified as keyless and its corpus left
 * unprocessed. An unconfigured gateway answers unavailable, so work stays
 * banked for a process that can run it.
 */

import type { BrainEngine } from '../engine.ts';
import type { CapabilityReport } from '../capability.ts';
import { isAvailable } from '../ai/gateway.ts';
import { getFactsExtractionModel } from './extract.ts';

/** The resolved extraction model and whether the gateway can serve it. A
 * caller-pinned `model` is checked instead of the engine resolution. */
export async function resolveExtractionAvailability(
  engine: BrainEngine,
  model?: string,
): Promise<{ model: string; available: boolean }> {
  const resolved = model ?? (await getFactsExtractionModel(engine));
  return { model: resolved, available: isAvailable('chat', resolved) };
}

/** Corpus-harvest gate. An explicit capability report (caller-computed or a
 * test seam) wins; otherwise the engine-resolved model decides. */
export async function extractionAvailableForEngine(
  engine: BrainEngine,
  capabilityOverride?: CapabilityReport,
): Promise<boolean> {
  if (capabilityOverride) return capabilityOverride.extraction.available;
  return (await resolveExtractionAvailability(engine)).available;
}
