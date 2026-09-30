/**
 * `gbrain skillopt`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.41.20.0 — Self-evolving skill optimization (SkillOpt-paper-grounded).
  // Mutating CLI: validation-gated (D12), budget-capped (D3), per-skill
  // DB-locked (D14), bundled-skill-gated (D16), bootstrap-sentinel-reviewed
  // (D15). See: src/core/skillopt/ + plan at
  // ~/.claude/plans/system-instruction-you-are-working-drifting-falcon.md.
  const { runSkillOptCommand } = await import('../../commands/skillopt.ts');
  await runSkillOptCommand(engine, args);
}
