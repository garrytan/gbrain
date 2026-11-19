/**
 * The handle a delegated client's admission policy (src/core/minions/delegated-admission.ts) runs on in the Rust engine,
 * for `admitJob` and `retryJob`.
 *
 * It serves the job reads, the client's open-job count and an agent job's source state from the store. The store keeps
 * no `oauth_clients` or `access_tokens` table (the grants family is not in the Rust store), so `lockOAuthClient`
 * resolves without locking anything and the policy's grant read (`readClientGrant`, or the job authority check's
 * owner read, both through `executeRaw`) stops on a typed refusal. Any other member refuses as before.
 *
 * `locked()` reports whether the policy took the client lock. A caller refuses before it writes when it did: the policy's
 * reads and the store's write are separate store calls, so on Rust the lock would hold nothing across them, and the grant
 * check, the capacity count and the write would not be one admission. Today the grant read refuses first, so this guard
 * fires only if that read is ever served without the admission moving into one store write.
 */
import type { BrainEngine } from '../engine.ts';
import type { JobRow } from '../engine-sql/jobs.ts';
import type { JobSourceState } from '../engine-sql/jobs-queue.ts';
import { withDates } from './store-codec.ts';
import { refuseMember, storeCall } from './store-members/common.ts';
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
    lockOAuthClient: async () => { locked = true; },
    executeRaw: async () => refuseMember(member, 'the job owner\'s grant read (oauth_clients or access_tokens) is not in the Rust store'),
  };
  const tx = new Proxy(served, {
    get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : refuseMember(member, 'the delegated admission policy read the database')),
  }) as BrainEngine;
  return { tx, locked: () => locked };
}

