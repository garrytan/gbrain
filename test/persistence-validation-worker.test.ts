import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { submitWithAdmissionRetry } from '../scripts/persistence/producer-admission.ts';
import { isRetryableAdmissionContention, retryWriteAdmission } from '../src/core/persistence/admission-retry.ts';

// A real exhausted-contention error from the engine helper (its retry window is 5 s).
let exhausted: unknown;
beforeAll(async () => {
  exhausted = await retryWriteAdmission('same-request-id', async () => { throw Object.assign(new Error('serialization failure'), { code: '40001' }); })
    .then(() => null, error => error);
}, 15_000);

describe('persistence validation producer admission', () => {
  test('only the exhausted-contention storage_error is classified as retryable', () => {
    expect(exhausted).toMatchObject({ code: 'storage_error', writeError: 'storage_error' });
    expect(isRetryableAdmissionContention(exhausted)).toBe(true);
    expect(isRetryableAdmissionContention(Object.assign(new Error('look-alike'), { code: 'storage_error', writeError: 'storage_error' }))).toBe(false);
  });

  test('retries a contention-blocked admission with the same request ID and counts the retry', async () => {
    const attempts: string[] = []; let retries = 0;
    const accepted = { request_id: 'same-request-id', state: 'queued' };
    const row = await submitWithAdmissionRetry(async () => {
      attempts.push('same-request-id');
      if (attempts.length === 1) throw exhausted;
      return accepted;
    }, () => { retries++; });
    expect(row).toBe(accepted);
    expect(attempts).toEqual(['same-request-id', 'same-request-id']);
    expect(retries).toBe(1);
  });

  test('stops after three attempts and rethrows when contention persists', async () => {
    let attempts = 0; let retries = 0;
    await expect(submitWithAdmissionRetry(async () => { attempts++; throw exhausted; }, () => { retries++; })).rejects.toBe(exhausted);
    expect(attempts).toBe(3);
    expect(retries).toBe(2);
  });

  test('does not retry any other error', async () => {
    const other = Object.assign(new Error('unrelated'), { code: 'storage_error', writeError: 'storage_error' });
    let attempts = 0;
    await expect(submitWithAdmissionRetry(async () => { attempts++; throw other; })).rejects.toBe(other);
    expect(attempts).toBe(1);
  });

  test('the soak producer routes admitWrite through the retry', () => {
    expect(readFileSync(new URL('../scripts/persistence/worker.ts', import.meta.url), 'utf8'))
      .toContain('submitWithAdmissionRetry(() => admitWrite');
  });
});
