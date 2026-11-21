/**
 * Whether a rejection is the engine refusing a malformed input, the only refusal the parity cases for bad inputs
 * accept. A Rust store refusal carries `code: 'invalid_argument'`; Postgres and PGLite raise the SQLSTATE of the cast
 * that failed (22P02 invalid text, 22007 or 22008 a bad timestamp, 22021 a NUL byte); the SQL page-window builder
 * throws its own "must be a positive integer" message, and postgres.js refuses a timestamp parameter it cannot parse
 * before sending it (RangeError "Invalid Date"). Anything else (a connection error, a capability refusal, an
 * engine fault) is not an input refusal, so a case that only sees `rejects` cannot pass on the wrong failure.
 */
const SQLSTATES = new Set(['22P02', '22007', '22008', '22021']);

export function isInputRefusal(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (e.code === 'invalid_argument' || (typeof e.code === 'string' && SQLSTATES.has(e.code))) return true;
  if (error instanceof RangeError && /Invalid Date/.test(error.message)) return true;
  return typeof e.message === 'string' && /must be a positive integer, got /.test(e.message);
}

/** Resolves true when `p` rejects with an input refusal, false when it resolves, and rethrows any other rejection. */
export function refusesInput(p: Promise<unknown>): Promise<boolean> {
  return p.then(() => false, (error: unknown) => { if (isInputRefusal(error)) return true; throw error; });
}
