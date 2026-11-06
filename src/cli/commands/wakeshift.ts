/**
 * `gbrain wakeshift`: post-connect dispatch (record in src/cli/command-table.ts); the command lives in
 * src/commands/wakeshift.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runWakeshift } = await import('../../commands/wakeshift.ts');
  await runWakeshift(engine, args);
}
