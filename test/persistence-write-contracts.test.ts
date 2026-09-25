import { describe, expect, test } from 'bun:test';
import { OperationError } from '../src/core/ops/contract.ts';
import { ERROR_SCHEMA, RESPONSE_SCHEMAS } from '../src/core/verbs.ts';
import { validateAgainstSchema } from '../src/core/verbs/conformance.ts';
import { parseMutationPrecondition } from '../src/core/persistence/preconditions.ts';
import { committedVerbOutcome, frozenVerbWriteError } from '../src/core/persistence/verb-errors.ts';
import { isWriteBlockedReason, isWriteReceipt, publicWriteReceipt, type WriteReceipt } from '../src/core/persistence/types.ts';
import { receiptFor } from '../src/core/persistence/journal.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { writeHealth, pendingWriteHint } from '../src/core/persistence/health.ts';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

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
  test.each([[0, 1000], [29999, 1000], [30000, 5000], [30001, 5000], [119999, 5000], [120000, 30000], [120001, 30000]])('age %d has advisory poll %d', (age, retry) => {
    const health = writeHealth({ state: 'running', created_at: new Date(0) }, {}, age);
    expect(health.retry_after_ms).toBe(retry);
    expect(health.diagnostic?.age_ms).toBe(age);
    expect(health.diagnostic?.next_action).toBe(age >= 120000 ? 'inspect_owner' : 'poll');
  });

  test('clock movement, terminal state and unknown internal reasons remain conservative', () => {
    expect(writeHealth({ state: 'queued', created_at: new Date(1000) }, {}, 0).diagnostic?.age_ms).toBe(0);
    expect(writeHealth({ state: 'committed', created_at: new Date(0) }, {}, 999999)).toEqual({ retry_after_ms: null });
    const health = writeHealth({ state: 'queued', created_at: new Date(0), blocked_reason: 'PRIVATE_UNKNOWN_MARKER' }, {}, 120000);
    expect(health.diagnostic?.reason).toBe('cause_unknown');
    expect(JSON.stringify(health)).not.toContain('PRIVATE_');
    expect(health.diagnostic).not.toHaveProperty('observed_at');
  });

  test('nested diagnostics are validated and explicitly redacted', () => {
    const health = writeHealth({ state: 'queued', created_at: new Date(0), blocked_reason: 'unexpected_file_bytes' }, { observed_at: '2026-01-01T00:00:00.000Z' }, 100);
    const value = { ...receipt('queued'), ...health };
    expect(isWriteReceipt(value)).toBe(true);
    expect(value.diagnostic?.next_action).toBe('inspect_owner');
    expect(pendingWriteHint(value)).toContain('inspect');
    expect(frozenVerbWriteError(value).suggestion).toBe(pendingWriteHint(value));
    expect(validateAgainstSchema(frozenVerbWriteError(value).toJSON(), ERROR_SCHEMA)).toEqual([]);
    for (const patch of [{ age_ms: -1 }, { age_ms: 1.5 }, { age_ms: NaN }, { age_ms: Infinity },
      { age_ms: '1' }, { assessment: 'dead' }, { reason: 'PRIVATE' }, { next_action: 'transfer' },
      { observed_at: 'yesterday' }, { observed_at: '2026-02-30T00:00:00.000Z' }]) {
      expect(isWriteReceipt({ ...value, diagnostic: { ...value.diagnostic, ...patch } })).toBe(false);
    }
    for (const diagnostic of [null, [], 'pending']) expect(isWriteReceipt({ ...value, diagnostic })).toBe(false);
    expect(isWriteReceipt({ ...receipt('committed'), diagnostic: value.diagnostic })).toBe(false);
    const extra = { ...value, diagnostic: { ...value.diagnostic!, path: 'PRIVATE_MARKER' } };
    expect(JSON.stringify(publicWriteReceipt(extra))).not.toContain('PRIVATE_MARKER');
  });
  test('accepted contention survives public serialization with actionable polling', () => {
    const row = { request_id: REQUEST_ID, state: 'queued', blocked_reason: 'database_contention',
      created_at: new Date(), updated_at: new Date() } as WriteRequest;
    expect(publicWriteReceipt(receiptFor(row))).toMatchObject({ retry_after_ms: 5000,
      diagnostic: { assessment: 'blocked', reason: 'database_contention', next_action: 'poll' } });
  });

  test('a claim released at the preparation deadline keeps its blocked reason beside the derived health', () => {
    const row = { request_id: REQUEST_ID, state: 'queued', blocked_reason: 'preparation_deadline',
      created_at: new Date(), updated_at: new Date() } as WriteRequest;
    const pending = publicWriteReceipt(receiptFor(row));
    expect(pending).toMatchObject({ state: 'queued', blocked_reason: 'preparation_deadline',
      diagnostic: { assessment: 'pending', reason: 'cause_unknown', next_action: 'poll' } });
    expect(validateAgainstSchema(frozenVerbWriteError(pending).toJSON(), ERROR_SCHEMA)).toEqual([]);
  });

  test('renewed aged requests request inspection without inventing owner failure', () => {
    const row = { request_id: REQUEST_ID, state: 'running', created_at: new Date(Date.now() - 130_000),
      updated_at: new Date() } as WriteRequest;
    expect(publicWriteReceipt(receiptFor(row))).toMatchObject({ retry_after_ms: 30000,
      diagnostic: { assessment: 'stalled', reason: 'cause_unknown', next_action: 'inspect_owner' } });
  });
  test.each([29999, 30000, 119999, 120000, 120001])('known contention remains blocked while its advice ages at %d', age => {
    expect(writeHealth({ state: 'queued', created_at: new Date(0), blocked_reason: 'database_contention' }, {}, age))
      .toMatchObject({ retry_after_ms: age >= 120000 ? 30000 : 5000,
        diagnostic: { assessment: 'blocked', reason: 'database_contention', next_action: age >= 120000 ? 'inspect_owner' : 'poll' } });
  });
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

  test('blocked reasons distinguish owner loss from ordinary queueing without changing state', () => {
    const blocked = { ...receipt('queued'), blocked_reason: 'owner_unavailable' as const };
    expect(isWriteReceipt(blocked)).toBe(true);
    expect(publicWriteReceipt(blocked)).toEqual(blocked);
    expect(publicWriteReceipt(receipt('queued'))).not.toHaveProperty('blocked_reason');
    const uncertain = { ...receipt('recovering'), blocked_reason: 'commit_outcome_uncertain' as const };
    expect(JSON.parse(JSON.stringify(Object.assign(new OperationError('write_pending', 'Pending.'), { writeRequest: uncertain })))
      .write_request).toEqual(uncertain);
  });

  test.each([['future', 'future_reason'], ['null', null], ['empty', ''], ['number', 7], ['object', { reason: 'x' }], ['array', ['owner_unavailable']]])(
    'a %s blocked_reason never invalidates a valid receipt and is dropped from public output', (_label, value) => {
      for (const state of ['queued', 'committed'] as const) {
        const received = { ...receipt(state), blocked_reason: value };
        expect(isWriteReceipt(received)).toBe(true);
        expect(publicWriteReceipt(received as unknown as WriteReceipt)).toEqual(receipt(state));
      }
    });

  test('every blocked_reason literal stored by source code is in the shared vocabulary', () => {
    const files = new Glob('src/**/*.ts').scanSync({ cwd: ROOT });
    const found = new Map<string, string>();
    const patterns = [
      /blocked_reason(?:='|: ')([a-z_]+)'/g,                                     // SQL assignment or object field
      /await (?:releaseUnpublishedClaim|markRecovering)\([^;]*;/g,               // every literal in a producer call
      /const reason: WriteBlockedReason = [^;]*;/g,                               // typed direct-SQL reason
    ];
    for (const file of files) {
      if (file.endsWith('schema-embedded.generated.ts')) continue;
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
        const literals = match[1] ? [match[1]] : [...match[0].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
        for (const literal of literals) found.set(literal, file);
      }
    }
    // Producers found by the scan: claim release, recovery marks, pool capacity and recovery blocks.
    for (const expected of ['owner_unavailable', 'writer_busy', 'database_contention', 'revision_changed_repreparing', 'recovery_required',
      'recovery_capacity', 'consumer_stopping', 'preparation_deadline', 'publication_failed', 'commit_outcome_uncertain', 'publication_not_started',
      'writer_pool_capacity', 'database_unavailable', 'unexpected_staging_bytes', 'unexpected_file_bytes'])
      expect(found.has(expected)).toBe(true);
    const unknown = [...found].filter(([literal]) => !isWriteBlockedReason(literal));
    expect(unknown).toEqual([]);
  });

  test('frozen verb receipt schema accepts the blocked reason', () => {
    const body = frozenVerbWriteError({ ...receipt('queued'), blocked_reason: 'owner_unavailable' }).toJSON();
    expect(body.write_error).toBe('write_pending');
    expect(body.write_request?.blocked_reason).toBe('owner_unavailable');
    expect(body.message).toContain('not committed');
    expect(validateAgainstSchema(body, ERROR_SCHEMA)).toEqual([]);
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
