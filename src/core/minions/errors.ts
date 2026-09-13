/** Dependency-free handler errors, shared by policy and worker entrypoints. */

/** Throw this from a handler to skip all retry logic and go straight to 'dead'. */
export class UnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}
