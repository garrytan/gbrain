import type { BrainEngine } from '../engine.ts';

/**
 * `cycle.lint_fix` (default on): only an explicit falsy value makes the
 * cycle's lint phase report-only; a config read failure keeps the default.
 * `gbrain lint --fix` is unaffected. Its own module so the cycle reads the
 * setting without depending on the lint command's export surface.
 */
export async function cycleLintFixEnabled(engine?: BrainEngine | null): Promise<boolean> {
  return !/^\s*(false|0|off|no)\s*$/i.test(await engine?.getConfig('cycle.lint_fix').catch(() => null) ?? '');
}
