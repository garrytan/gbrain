/**
 * `sync-retry-failed` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

export function makeSyncRetryFailedHandler(engine: BrainEngine): MinionHandler {
  return async () => {
    const { runSync } = await import('../../../commands/sync.ts');
    // #6712 PR 3 (L7): a plain sync retries recorded failures; the job name stays for queued jobs and doctor's remediation.
    await runSync(engine, []);
    return { ok: true };
  };
}
