/**
 * The explicit-budget packing surface of evidence delivery
 * (docs/evidence-delivery.md, "Explicit budgets"): the `search.auto_packing`
 * values, the documented minimum budget, and their validation. Kept apart
 * from the assembler so `gbrain config set` can validate a value without
 * loading it.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';

/**
 * How `auto` packs an explicit `token_budget` (`search.auto_packing`). Every
 * value but `off` makes the budget a hard cap on the delivered evidence; the
 * three differ only in how conversations share it. None of them runs without
 * an explicit budget.
 */
export const AUTO_PACKINGS = ['off', 'cap_only', 'breadth_capped', 'depth_first'] as const;
export type AutoPacking = typeof AUTO_PACKINGS[number];
export const AUTO_PACKING_CONFIG_KEY = 'search.auto_packing';
export const DEFAULT_AUTO_PACKING: AutoPacking = 'cap_only';
/**
 * The smallest explicit budget the cap accepts under `auto`: room for a cut
 * marker, a shortened title and a non-empty body, so a non-empty hit list
 * always yields non-empty evidence without exceeding the budget.
 */
export const MIN_EXPLICIT_AUTO_BUDGET = 32;

/** A library caller's per-call packing; throws invalid_params for an unknown value. */
export function parseAutoPacking(raw: unknown): AutoPacking | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string' && (AUTO_PACKINGS as readonly string[]).includes(raw)) return raw as AutoPacking;
  const shown = typeof raw === 'string' ? JSON.stringify(raw.slice(0, 40)) : typeof raw;
  throw new OperationError('invalid_params', `auto_packing must be one of ${AUTO_PACKINGS.join(', ')} (got ${shown}).`,
    `Pass auto_packing: "${DEFAULT_AUTO_PACKING}" (or set ${AUTO_PACKING_CONFIG_KEY}).`);
}

/** The value `gbrain config set search.auto_packing` refuses, as a message, or null. */
export function autoPackingValueProblem(value: string): string | null {
  return (AUTO_PACKINGS as readonly string[]).includes(value) ? null
    : `${AUTO_PACKING_CONFIG_KEY} must be one of ${AUTO_PACKINGS.join(', ')} (got "${value.slice(0, 40)}"). Nothing was written.`;
}

/** search.auto_packing as stored; an unknown or unreadable value reads as the default. */
export async function configPacking(engine: BrainEngine): Promise<AutoPacking> {
  try {
    const raw = await engine.getConfig(AUTO_PACKING_CONFIG_KEY);
    if (typeof raw === 'string' && (AUTO_PACKINGS as readonly string[]).includes(raw)) return raw as AutoPacking;
  } catch { /* config unreadable: stay on the default */ }
  return DEFAULT_AUTO_PACKING;
}
