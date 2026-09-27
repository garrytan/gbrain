/**
 * Keyless clean-skip for the cycle's embed phase.
 *
 * The scheduled cycle calls runEmbedCore directly, bypassing the CLI's
 * keyless `embed --stale` guard. Explicitly disabled embeddings
 * (`init --no-embedding`, file or DB plane) are deferred work, not a failed
 * provider call on every maintenance run. Returns the skipped PhaseResult,
 * or null when embeddings are enabled and the phase should run.
 */

import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { loadConfig } from '../config.ts';

export async function embedDisabledSkip(engine: BrainEngine): Promise<PhaseResult | null> {
  if (loadConfig()?.embedding_disabled !== true
      && await engine.getConfig('embedding_disabled') !== 'true') {
    return null;
  }
  return {
    phase: 'embed', status: 'skipped', duration_ms: 0,
    summary: 'embeddings disabled; no provider call made',
    details: { reason: 'embedding_disabled' },
  };
}
