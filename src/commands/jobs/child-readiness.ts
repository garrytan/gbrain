/** `gbrain jobs child-readiness` (dispatched by runJobs in src/commands/jobs.ts). */
import type { JobsCommandContext } from './shared.ts';

export async function runJobsChildReadiness({ engine }: JobsCommandContext): Promise<void> {
  const { runChildReadinessEntry } = await import('../../core/minions/child-readiness.ts');
  const { assertWorkerDbReadiness } = await import('../../core/minions/db-probe.ts');
  const code = await runChildReadinessEntry(engine, assertWorkerDbReadiness);
  try { await engine.disconnect(); } catch {}
  process.exit(code);
}
