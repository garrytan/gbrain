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
import { createHash } from 'node:crypto';
import { getEmbeddingModel, isAvailable } from '../ai/gateway.ts';
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

/**
 * #6785: a fingerprint of the extraction configuration (the resolved model,
 * its provider, and whether the chat and embedding models are servable),
 * never a key or other value. A corpus window capped after repeated failures
 * is retried once when it changes.
 */
export async function extractionConfigFingerprint(engine: BrainEngine): Promise<string> {
  const { model, available } = await resolveExtractionAvailability(engine);
  let embedding: { model: string | null; available: boolean } = { model: null, available: false };
  try {
    const m = getEmbeddingModel();
    embedding = { model: m, available: isAvailable('embedding', m) };
  } catch { /* gateway unconfigured: no embedding model */ }
  const provider = model.includes(':') ? model.slice(0, model.indexOf(':')) : null;
  return createHash('sha256').update(JSON.stringify({ model, provider, chat: available, embedding })).digest('hex').slice(0, 16);
}
