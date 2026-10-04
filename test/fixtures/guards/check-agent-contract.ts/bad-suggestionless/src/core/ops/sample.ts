declare class OperationError extends Error { constructor(...args: unknown[]); }
export function f() { throw new OperationError('invalid_params', 'Bad input.'); }
