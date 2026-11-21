/**
 * The handle a delegated client's admission policy (src/core/minions/delegated-admission.ts) runs on in the Rust engine,
 * for `admitJob` and `retryJob`.
 *
 * It serves the job reads, the client's open-job count, an agent job's source state, the client's row (`readOauthClient`:
 * the grant read, `readClientGrant`) and the active source ids (`listAllSources`: `grantValidationContext`) from the store.
 * `lockOAuthClient` resolves without locking anything. `executeRaw` still refuses: the job authority check's owner read
 * (`oauth_clients` principal columns, or `access_tokens` for a legacy token) is raw SQL. Any other member refuses as before.
 *
 * `locked()` reports whether the policy took the client lock. A caller refuses before it writes when it did: the policy's
 * reads and the store's write are separate store calls, so on Rust the lock would hold nothing across them, and the grant
 * check, the capacity count and the write would not be one admission. The grant read is served now, so a policy with a
 * lock or a capacity check gets past it and this guard is what stops it; a spend reservation takes no lock and runs its
 * reads inside the store's own transaction, so the guard does not touch it.
 */
import type { BrainEngine } from '../engine.ts';
import type { JobRow } from '../engine-sql/jobs.ts';
import type { JobSourceState } from '../engine-sql/jobs-queue.ts';
import { withDates } from './store-codec.ts';
import { refuseMember, storeCall } from './store-members/common.ts';
import { readOauthClient } from './store-members/jobs-oauth-clients.ts';
import { listAllSources } from './store-members/sources.ts';
import type { StoreBrain } from './store.ts';

const JOB_DATES = ['lock_until', 'delay_until', 'timeout_at', 'private_queue_lease_until', 'created_at', 'started_at', 'finished_at', 'updated_at'] as const;

export interface DelegatedPolicyHandle {
  tx: BrainEngine;
  locked(): boolean;
}

export function delegatedPolicyHandle(brain: StoreBrain, member: string): DelegatedPolicyHandle {
  const call = <T>(run: () => Promise<T>): Promise<T> => storeCall({ member }, run);
  let locked = false;
  const served: Partial<BrainEngine> = {
    getJob: async (jobId: number) => {
      const row: JobRow | null = await call(() => brain.getJob(jobId));
      return row ? withDates(row, JOB_DATES) : null;
    },
    getFailedJobForRetry: (jobId: number) => call(() => brain.getFailedJobForRetry(jobId)),
    countOpenJobsByOwner: (clientId: string) => call(() => brain.countOpenJobsByOwner(clientId)),
    readJobSourceState: async (sourceId: string) => {
      const row: JobSourceState | null = await call(() => brain.readJobSourceState(sourceId));
      return row ? withDates(row, ['created_at']) : null;
    },
    readOauthClient: (clientId: string) => readOauthClient(brain, clientId),
    listAllSources: () => listAllSources(brain),
    lockOAuthClient: async () => { locked = true; },
    executeRaw: async () => refuseMember(member, 'the job owner\'s principal read (oauth_clients or access_tokens) is raw SQL'),
  };
  const tx = new Proxy(served, {
    get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop] : refuseMember(member, 'the delegated admission policy read the database')),
  }) as BrainEngine;
  return { tx, locked: () => locked };
}

