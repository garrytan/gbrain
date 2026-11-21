/**
 * Strict write-trust seam for tests: installs the tier trigger function that RAISEs `undeclared_write_trust` where the
 * production function would store a row at `unknown` because its writer never declared a tier (withWriteTrust, a
 * coordinated write's declaration, or a keep or backfill scope). The default function stays what migrations install.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { STRICT_STAMP_TIER_FUNCTION_FOR_TESTS, UNDECLARED_WRITE_TRUST } from '../../src/core/trust/schema.ts';

export { UNDECLARED_WRITE_TRUST };

/** Replaces the engine's tier trigger function with the strict one; the triggers keep pointing at it by name. */
export async function installStrictWriteTrust(engine: Pick<BrainEngine, 'executeRaw'>): Promise<void> {
  await engine.executeRaw(STRICT_STAMP_TIER_FUNCTION_FOR_TESTS);
}

/** True when `error` (or its cause chain) is the strict trigger's refusal of an undeclared write. */
export function isUndeclaredWriteTrust(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 6; e = (e as { cause?: unknown }).cause, depth++) {
    if (String((e as { message?: unknown }).message ?? '').includes(`${UNDECLARED_WRITE_TRUST}:`)) return true;
  }
  return false;
}
