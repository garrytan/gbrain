/**
 * Backoff calculation for job retries.
 * Exponential: 2^(attempts-1) * delay, with jitter.
 * Fixed: constant delay, with jitter.
 * From Sidekiq's formula, with BullMQ-style jitter parameter.
 */

import type { MinionJob } from './types.ts';

export function calculateBackoff(job: Pick<MinionJob, 'backoff_type' | 'backoff_delay' | 'backoff_jitter' | 'attempts_made'>): number {
  const { backoff_type, backoff_delay, backoff_jitter, attempts_made } = job;

  let delay: number;
  if (backoff_type === 'exponential') {
    delay = Math.pow(2, Math.max(attempts_made - 1, 0)) * backoff_delay;
  } else {
    delay = backoff_delay;
  }

  if (backoff_jitter > 0) {
    const jitterRange = delay * backoff_jitter;
    delay += Math.random() * jitterRange * 2 - jitterRange;
  }

  return Math.max(delay, 0);
}
