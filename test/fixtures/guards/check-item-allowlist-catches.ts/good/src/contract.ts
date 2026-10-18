export class OperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
