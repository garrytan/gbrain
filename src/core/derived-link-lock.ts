import type { BrainEngine } from './engine.ts';
import { getCode } from './retry-matcher.ts';

/** Only a bounded page-guard acquisition can produce this deferrable error. */
export class DerivedLinkLockBusyError extends Error {
  constructor() { super('Derived link page guard is busy; leave the page stale for the next extraction.'); }
}

/** Bound only acquisition; keep a shorter caller timeout and restore it before publication. */
export async function lockDerivedLinkPages(tx: Pick<BrainEngine, 'executeRaw' | 'lockPageKeys'>,
  keys: Parameters<BrainEngine['lockPageKeys']>[0], timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Link lock timeout must be a positive integer');
  const [prior] = await tx.executeRaw<{ value: string; ms: string }>(
    "SELECT current_setting('lock_timeout') AS value, setting AS ms FROM pg_settings WHERE name='lock_timeout'");
  if (!prior) throw new Error('Cannot read lock_timeout');
  const priorMs = Number(prior.ms);
  const effective = priorMs > 0 ? Math.min(priorMs, timeoutMs) : timeoutMs;
  await tx.executeRaw("SELECT set_config('lock_timeout',$1,true)", [`${effective}ms`]);
  try { await tx.lockPageKeys(keys); }
  catch (error) {
    // The failed transaction must roll back before replay; no queries in an aborted transaction.
    if (getCode(error) === '55P03') throw new DerivedLinkLockBusyError();
    throw error;
  }
  await tx.executeRaw("SELECT set_config('lock_timeout',$1,true)", [prior.value]);
}
