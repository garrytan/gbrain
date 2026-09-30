/**
 * `sync-retry-failed` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

export function makeSyncRetryFailedHandler(engine: BrainEngine): MinionHandler {
  return async () => {
    const { runSync } = await import('../../../commands/sync.ts');
    await runSync(engine, ['--retry-failed']);
    return { ok: true };
  };
}
