import { describe, expect, test } from 'bun:test';
import { OperationError } from '../src/core/ops/contract.ts';
import { ERROR_SCHEMA, RESPONSE_SCHEMAS } from '../src/core/verbs.ts';
import { validateAgainstSchema } from '../src/core/verbs/conformance.ts';
import { parseMutationPrecondition } from '../src/core/persistence/preconditions.ts';
import { committedVerbOutcome, frozenVerbWriteError } from '../src/core/persistence/verb-errors.ts';
import { isWriteReceipt, publicWriteReceipt, type WriteReceipt } from '../src/core/persistence/types.ts';

const REQUEST_ID = 'd7599b95-65c2-4d54-aa4e-cb5745af90cf';
const receipt = (state: WriteReceipt['state']): WriteReceipt => ({
  request_id: REQUEST_ID,
  state,
  retry_after_ms: ['queued', 'running', 'recovering'].includes(state) ? 1000 : null,
});

describe('mutation preconditions', () => {
  test('accepts create-only, revision and force requests without inventing a revision', () => {
    expect(parseMutationPrecondition({})).toEqual({});
    expect(parseMutationPrecondition({ expected_revision: REQUEST_ID.toUpperCase(), request_id: REQUEST_ID.toUpperCase() }))
      .toEqual({ expected_revision: REQUEST_ID, request_id: REQUEST_ID });
    expect(parseMutationPrecondition({ force: true })).toEqual({ force: true });
    expect(parseMutationPrecondition({ expected_revision: REQUEST_ID, force: false }))
      .toEqual({ expected_revision: REQUEST_ID, force: false });
  });

  test.each([
    { request_id: 'not-a-uuid' }, { request_id: null }, { expected_revision: '' },
    { expected_revision: 42 }, { force: 'true' }, { expected_revision: REQUEST_ID, force: true },
  ])('rejects invalid preconditions before mutation: %j', (params) => {
    expect(() => parseMutationPrecondition(params)).toThrow(OperationError);
  });
});

describe('public write receipts', () => {
  test('serialization excludes journal payload and execution details', () => {
    const internal = { ...receipt('recovering'), payload: 'private content', claim_token: 'private token', recovery_path: '/private/root' };
    const error = new OperationError('recovery_required', 'Publication is recovering.');
    error.writeRequest = internal;
    error.writeError = 'recovery_required';
    const body = JSON.parse(JSON.stringify(error));
    expect(body.write_request).toEqual(receipt('recovering'));
    expect(body.write_error).toBe('recovery_required');
    expect(JSON.stringify(body)).not.toContain('private');
  });

  test('non-write errors retain the existing wire shape', () => {
    expect(JSON.parse(JSON.stringify(new OperationError('invalid_params', 'Bad input.'))))
      .toEqual({ error: 'invalid_params', message: 'Bad input.' });
  });

  test('receipt parsing refuses invented completion states and unsafe polling intervals', () => {
    expect(isWriteReceipt(receipt('queued'))).toBe(true);
    expect(isWriteReceipt(receipt('committed'))).toBe(true);
    for (const patch of [{ state: 'done' }, { request_id: 'unknown' }, { retry_after_ms: -1 },
      { retry_after_ms: Infinity }, { retry_after_ms: 1.5 }, { retry_after_ms: undefined },
      { persistence: { mode: 'remote' } }, { outcome: [] }]) {
      expect(isWriteReceipt({ ...receipt('queued'), ...patch })).toBe(false);
    }
    expect(isWriteReceipt({ ...receipt('committed'), retry_after_ms: 1000 })).toBe(false);
  });

  test('public persistence details preserve mode without adding private fields', () => {
    const persisted = { ...receipt('committed'), revision: REQUEST_ID, compacted: true,
      outcome: { status: 'imported' }, persistence: { mode: 'filesystem' as const, file_written: true, git_state: 'pending', path: '/private' } };
    expect(publicWriteReceipt(persisted).persistence).toEqual({ mode: 'filesystem', file_written: true, git_state: 'pending' });
  });
});

describe('frozen memory write errors', () => {
  test.each(['queued', 'running', 'recovering'] as const)('%s can never report a frozen write success', (state) => {
    const pending = receipt(state);
    expect(() => committedVerbOutcome(pending)).toThrow(OperationError);
    const body = frozenVerbWriteError(pending).toJSON();
    expect(body.error).toBe('unavailable');
    expect(body.protocol_version).toBe(1);
    expect(body.suggestion).toContain(REQUEST_ID);
    expect(body.write_request).toEqual(pending);
    expect(validateAgainstSchema(body, ERROR_SCHEMA)).toEqual([]);
    expect(validateAgainstSchema(body, RESPONSE_SCHEMAS.remember).length).toBeGreaterThan(0);
    expect(validateAgainstSchema(body, RESPONSE_SCHEMAS.forget).length).toBeGreaterThan(0);
  });

  test('committed receipts preserve the original frozen result', () => {
    const outcome = { id: '17', expired: true, reason: 'user correction', protocol_version: 1 };
    expect(committedVerbOutcome({ ...receipt('committed'), outcome })).toBe(outcome);
    expect(() => committedVerbOutcome(receipt('committed'))).toThrow('no result');
  });

  test.each([
    ['conflict', 'revision_conflict', 'invalid_params'],
    ['failed', 'idempotency_conflict', 'invalid_params'],
    ['failed', 'source_changed', 'scope_denied'],
    ['cancelled', 'cancelled', 'unavailable'],
    ['failed', 'storage_error', 'unavailable'],
  ] as const)('%s/%s uses the frozen %s code', (state, reason, code) => {
    const body = frozenVerbWriteError(receipt(state), reason).toJSON();
    expect(body.error).toBe(code);
    expect(body.write_error).toBe(reason);
    expect(body.write_request?.retry_after_ms).toBeNull();
    expect(body.suggestion).not.toContain('after 1000');
    expect(validateAgainstSchema(body, ERROR_SCHEMA)).toEqual([]);
  });
});
