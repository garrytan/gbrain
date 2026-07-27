// v0.42.x — Life Chronicle (#2390) config flags.
import type { BrainEngine } from '../engine.ts';

/**
 * Auto-emit is OFF by default (plan D5.5: spend posture — extraction spends LLM
 * tokens per eligible write). Enable with `gbrain config set auto_chronicle true`.
 * The eval-gated default-flip is the headline fast-follow (TODO T8).
 */
export async function isAutoChronicleEnabled(engine: BrainEngine): Promise<boolean> {
  const val = await engine.getConfig('auto_chronicle');
  if (val == null) return false; // default OFF
  return ['true', '1', 'yes', 'on'].includes(val.trim().toLowerCase());
}

/** Pinned timezone for the when→date projection cast (plan: default UTC). */
export async function chronicleTz(engine: BrainEngine): Promise<string> {
  const val = await engine.getConfig('chronicle.tz');
  return (val && val.trim()) || 'UTC';
}
