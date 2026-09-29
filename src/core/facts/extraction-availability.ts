import type { BrainEngine } from '../engine.ts';
import type { CapabilityReport } from '../capability.ts';

/** Check the extraction model the engine will actually use, including DB-plane overrides. */
export async function extractionAvailableForEngine(
  engine: BrainEngine,
  capabilityOverride?: CapabilityReport,
): Promise<boolean> {
  if (capabilityOverride) return capabilityOverride.extraction.available;
  const { getFactsExtractionModel } = await import('./extract.ts');
  const { isAvailable } = await import('../ai/gateway.ts');
  return isAvailable('chat', await getFactsExtractionModel(engine));
}
