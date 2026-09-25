/** Dependency-free handler errors, shared by policy and worker entrypoints. */

/** Throw this from a handler to skip all retry logic and go straight to 'dead'. */
export class UnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

/**
 * Throw this from a handler when the job must run later, not fail: the worker
 * requeues it as `delayed` for exactly `retryInMs`, without burning an attempt,
 * appending to `stacktrace`, or writing lease-pressure telemetry. For
 * scheduling conditions (a busy lock the job must not skip), not failures.
 */
export class JobDeferredError extends Error {
  constructor(message: string, public readonly retryInMs: number) {
    super(message);
    this.name = 'JobDeferredError';
  }
}
