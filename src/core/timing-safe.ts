/**
 * Constant-time hex string compare (v0.40 D15.5 extraction).
 *
 * Before v0.40 this lived as a closure inside `runServeHttp` in
 * `src/commands/serve-http.ts:601`. It needs to be importable so the new
 * `POST /webhooks/github` handler can verify GitHub HMAC-SHA256 signatures
 * with the same constant-time semantics as the admin-cookie compare.
 *
 * Why extract instead of duplicate: codex outside-voice flagged the closure
 * scope as "hand-waving over actual module boundaries." Two consumers + one
 * function = extract. Source-text grep guard in `test/timing-safe.test.ts`
 * pins that callers import from here rather than re-implementing.
 *
 * Both inputs are expected to be hex strings of equal length (caller asserts
 * the length invariant — e.g. sha256 hex is always 64 chars). `timingSafeEqual`
 * throws on length mismatch; the early-return on length keeps the comparison
 * timing-independent of the length-check itself.
 */
import { timingSafeEqual } from 'node:crypto';

/**
 * True iff `a` and `b` are equal-length hex strings with the same bytes.
 * False on length mismatch (does NOT throw — admin-cookie + webhook callers
 * both prefer a clean boolean return so they can route to a 401 cleanly).
 *
 * Constant-time over the byte compare: `timingSafeEqual` is the underlying
 * primitive. Length mismatch short-circuits, which is acceptable because
 * length itself is not a secret (both callers know the expected hex length
 * from the algorithm — sha256 = 64 hex chars).
 */
export function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
