import { createHash } from 'node:crypto';
import { OperationError } from '../ops/contract.ts';
import { isWriteRequestId, type MutationPrecondition } from './types.ts';

/**
 * F6: the one fixed namespace every non-UUID request_id maps under. It carries no operation name, so a
 * receipt lookup finds a write by the client's original string. Changing it orphans every journaled id.
 */
export const CLIENT_REQUEST_ID_NAMESPACE = '3f6a2c1e-9b47-4d2a-8e5f-7c0b1d9a6e24';
export const CLIENT_REQUEST_ID_MAX = 128;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/** RFC 4122 UUIDv5 of `name` under CLIENT_REQUEST_ID_NAMESPACE. */
export function clientRequestUuid(name: string): string {
  const h = createHash('sha1').update(Buffer.from(CLIENT_REQUEST_ID_NAMESPACE.replace(/-/g, ''), 'hex')).update(name, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A write op's request_id at the operation boundary: a UUID passes through (lowercased, as always), any
 * other id of 1-128 printable ASCII characters maps to its deterministic UUIDv5. The result is the
 * journal's canonical request_id; administration ids keep their own strict UUID checks.
 */
export function parseWriteRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (isWriteRequestId(value)) return value.toLowerCase();
  if (typeof value !== 'string' || !value.length || value.length > CLIENT_REQUEST_ID_MAX || !PRINTABLE_ASCII.test(value)) {
    const actual = typeof value === 'string' ? `this one has ${value.length} characters${value.length && value.length <= CLIENT_REQUEST_ID_MAX ? ', including a space or non-ASCII character' : ''}` : `this one is ${value === null ? 'null' : `a ${typeof value}`}`;
    throw new OperationError('invalid_params', `request_id must be 1 to ${CLIENT_REQUEST_ID_MAX} printable ASCII characters with no spaces (${actual}).`,
      'Omit request_id, or send an id you reuse only to retry the same write, for example "remember-acme-example-1".');
  }
  return clientRequestUuid(value);
}

/** The id the client sent when it is not already a UUID; receipts echo it as `client_request_id`. */
export function clientRequestIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && !isWriteRequestId(value) && parseWriteRequestId(value) ? value : undefined;
}

/** Syntax only; the coordinator checks the revision under its mutation lock. */
export function parseMutationPrecondition(params: Record<string, unknown>): MutationPrecondition {
  const expected = params.expected_revision;
  if (expected !== undefined && !isWriteRequestId(expected)) {
    throw new OperationError('invalid_params', 'expected_revision must be the UUID returned by a page read.',
      'Read the current page and pass its revision unchanged.');
  }
  if (params.force !== undefined && typeof params.force !== 'boolean') {
    throw new OperationError('invalid_params', 'force must be a boolean.', 'Pass force: true only for an intentional overwrite.');
  }
  if (expected !== undefined && params.force === true) {
    throw new OperationError('invalid_params', 'expected_revision and force: true are mutually exclusive.',
      'Use the observed revision for a conditional edit or force: true for an intentional overwrite.');
  }
  const requestId = parseWriteRequestId(params.request_id);
  return {
    ...(expected !== undefined ? { expected_revision: expected.toLowerCase() } : {}),
    ...(params.force !== undefined ? { force: params.force } : {}),
    ...(requestId !== undefined ? { request_id: requestId } : {}),
  };
}

/** Keep wire idempotency separate from engine row preconditions. */
export function engineMutationPrecondition(precondition: MutationPrecondition): { expectedRevision?: string; force?: boolean } {
  return {
    ...(precondition.expected_revision !== undefined ? { expectedRevision: precondition.expected_revision } : {}),
    ...(precondition.force !== undefined ? { force: precondition.force } : {}),
  };
}
