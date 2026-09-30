import { LocalConfigurationError } from '../minions/configuration-error.ts';

export function hasPostgresCancellationCapability(owner: unknown): boolean {
  return typeof (owner as { discard?: unknown } | null)?.discard === 'function';
}

export function postgresCancellationUnavailable(): LocalConfigurationError {
  return new LocalConfigurationError(
    'postgres_cancellation_unavailable',
    'The installed Postgres driver lacks safe cancellation support (discard). ' +
    'Repair this installation, then restart the worker: reinstall the current GBrain package ' +
    '(global: bun install -g github:garrytan/gbrain; checkout: bun install; compiled: replace with the current release). ' +
    'See docs/guides/minions-fix.md#postgres-cancellation-unavailable.',
  );
}

export async function reserveWithCancellation<T extends { release(): void }>(
  reserve: (opts: { signal: AbortSignal }) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  let abandoned = false;
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      abandoned = true;
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const reserving = reserve({ signal }).then(owner => {
      if (abandoned) {
        owner.release();
        throw new DOMException('aborted', 'AbortError');
      }
      return owner;
    });
    return await Promise.race([reserving, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
