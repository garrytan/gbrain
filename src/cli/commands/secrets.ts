/**
 * `gbrain secrets`: post-connect dispatch; the behavior lives in src/commands/secrets.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runSecrets } = await import('../../commands/secrets.ts');
  await runSecrets(engine, args);
}
