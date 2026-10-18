/**
 * #5575: the stricter memory-trust protections are owner opt-ins since the
 * preregistered paid eval set the shipped defaults to `write_gate.external_mode
 * = flag` and `trust.agent_activation = allow` (gbrain-evals
 * docs/benchmarks/2026-10-08-memory-trust-results-paid.md). Tests that probe
 * the protections themselves (holds, quarantine, proactive suppression) turn
 * them on explicitly; the protections are still shipped code.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

export async function enableTrustProtections(engine: Pick<BrainEngine, 'setConfig'>): Promise<void> {
  await engine.setConfig('write_gate.external_mode', 'quarantine');
  await engine.setConfig('trust.agent_activation', 'suppress');
}
