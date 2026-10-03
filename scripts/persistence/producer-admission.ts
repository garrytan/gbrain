import { isRetryableAdmissionContention } from '../../src/core/persistence/admission-retry.ts';

const MAX_ADMISSION_ATTEMPTS = 3;
const ADMISSION_RETRY_BACKOFF_MS = 25;

/** Retry an admission whose contention outlasted the engine's retry window, reusing its request ID. */
export async function submitWithAdmissionRetry<T>(submit: () => Promise<T>, onRetry: () => void = () => {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await submit(); }
    catch (error) {
      if (!isRetryableAdmissionContention(error) || attempt >= MAX_ADMISSION_ATTEMPTS) throw error;
      onRetry();
      await Bun.sleep(ADMISSION_RETRY_BACKOFF_MS);
    }
  }
}
