/**
 * Policy resolution for the dream-cycle decide slots (S7 triage, S8
 * grounding). Returns undefined when the slot is off, so an all-off brain
 * does no decide work at all (byte-identical cycle output). A slot requested
 * `on` that cannot act resolves with `effective: 'off'` and its catalogued
 * cause: the call site runs today's path and records the reason.
 */
import type { BrainEngine } from '../engine.ts';
import { loadConfigSnapshot } from '../config-snapshot.ts';
import { readDecideConfig, type DecideConfig } from '../ai/decide/config.ts';
import { hasTypesafeKey } from '../ai/decide/index.ts';
import { packShape } from '../ai/decide/pack.ts';
import { resolveSlotPolicy, type SlotPolicy } from '../ai/decide/policy.ts';
import { listCalibrations, recentResolvedModels } from '../ai/decide/store.ts';
import type { DecideSlot } from '../ai/decide/types.ts';

export interface CycleDecideSlot {
  engine: BrainEngine;
  cfg: DecideConfig;
  policy: SlotPolicy;
}

/** S7 and S8 ask one question per request (background lane, paced under decide.background_concurrency). */
export function cycleSlotPackShape(slot: 'triage' | 'grounding'): string {
  return packShape(slot, [], { unpacked: true });
}

export async function resolveCycleDecideSlot(engine: BrainEngine, slot: 'triage' | 'grounding', callSite = 'dream'): Promise<CycleDecideSlot | undefined> {
  const cfg = readDecideConfig(await loadConfigSnapshot(engine), { typesafeKey: hasTypesafeKey() });
  if (cfg.slots[slot as DecideSlot].mode === 'off') return undefined;
  const [calibrations, recent] = await Promise.all([
    listCalibrations(engine, { slot }).catch(() => []),
    recentResolvedModels(engine, 24 * 7).catch(() => []),
  ]);
  const lastResolved: Record<string, string> = {};
  for (const r of recent) lastResolved[r.provider] ??= r.model_resolved;
  const policy = resolveSlotPolicy({
    cfg, slot, callSite, packShape: cycleSlotPackShape(slot), calibrations, lastResolved, hasTypesafeKey: hasTypesafeKey(),
  });
  return { engine, cfg, policy };
}
