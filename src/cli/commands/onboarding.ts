/**
 * `gbrain onboarding`: post-connect dispatch (record in src/cli/command-table.ts; behavior in
 * src/commands/onboarding.ts).
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runOnboarding } = await import('../../commands/onboarding.ts');
  await runOnboarding(engine, args);
}
