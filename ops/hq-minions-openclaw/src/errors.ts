export class OperatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 1,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'OperatorError';
  }
}

export function isOperatorError(error: unknown): error is OperatorError {
  return error instanceof OperatorError;
}
