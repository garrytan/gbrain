/** Operator opt-in for the native cycle; default remains review-only. */
import type { BrainEngine } from '../engine.ts';
import { isConfigTruthy } from '../config.ts';

export async function readGradeTakesPolicy(engine: BrainEngine): Promise<{ autoResolve: boolean; model?: string }> {
  const enabled = await engine.getConfig('cycle.grade_takes.auto_resolve.enabled');
  const model = (await engine.getConfig('models.dream.grade_takes'))?.trim();
  return { autoResolve: isConfigTruthy(enabled), ...(model ? { model } : {}) };
}
