/**
 * Every provenance tag the facts backstop writes into `facts.source`, as one
 * runtime list (#6091). `FactsBackstopCtx['source']` derives from it, so a new
 * writer is a one-line addition here, and the ambient subset (`hook:*`,
 * `sweep:*`) — the lanes `memory.auto_writeback` governs — is derived rather
 * than restated. test/capture-consent-inventory.test.ts pins the capture-lane
 * lists in capture-dedup.ts and repair/captured-facts.ts to that subset.
 */

import type { BrainEngine } from '../engine.ts';
import { loadConfig } from '../config.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { captureGateDecision, resolveWritebackConfig, type CaptureGateLane } from './writeback-config.ts';

export const FACTS_BACKSTOP_SOURCES = [
  'sync:import',
  'mcp:put_page',
  'mcp:extract_facts',
  'file_upload',
  'code_import',
  'hook:compact',
  'hook:writeback',
  'sweep:corpus',
] as const;
export type FactsBackstopSource = (typeof FACTS_BACKSTOP_SOURCES)[number];

export const AMBIENT_CAPTURE_SOURCES: readonly FactsBackstopSource[] = Object.freeze(
  FACTS_BACKSTOP_SOURCES.filter((s) => s.startsWith('hook:') || s.startsWith('sweep:')),
);

/** The capture gate lane a provenance tag answers to; null for explicit writers. */
export function captureGateLaneForSource(source: string | null | undefined): CaptureGateLane | null {
  if (source === 'hook:writeback') return 'writeback';
  if (source === 'hook:compact') return 'compact';
  if (source === 'sweep:corpus') return 'session_end';
  return null;
}

/**
 * Publication side: refuses a capture-lane fact admission when the gate no
 * longer extracts for that lane. Explicit writers (`remember`, `extract_facts`,
 * page extraction) are never affected.
 */
export async function assertAmbientCaptureAdmissible(engine: BrainEngine, source: string | null | undefined): Promise<void> {
  const lane = captureGateLaneForSource(source);
  if (!lane) return;
  const decision = captureGateDecision(await resolveWritebackConfig(engine, loadConfig(), { gate: true }), lane);
  if (decision.action === 'extract') return;
  throw opError('ambient_capture_off', 'Ambient capture is off for this brain; the captured facts were not saved.',
    `memory.auto_writeback no longer allows the ${lane} capture lane (${decision.reason}), so facts extracted from captured session text were dropped before admission. Nothing needs to be done: this is the off switch working. Explicit remember and extract_facts calls are unaffected.`,
    {
      reason: decision.reason,
      fix: readFix('Shows the setting and which capture lanes it stops, read-only.', { argv: ['gbrain', 'config', 'get', 'memory.auto_writeback'] }),
    });
}
