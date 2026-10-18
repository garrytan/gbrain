/**
 * GBRA-130: the item-vs-run classifier and the per-run breaker every
 * per-item loop uses (src/core/item-failure.ts).
 */
import { describe, expect, test } from 'bun:test';
import { CODES } from '../../src/core/error-registry.ts';
import { classifyItemFailure, CONTENT_ITEM_CODES, ItemRun, RUN_SCOPED_CODES } from '../../src/core/item-failure.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { PageSourceMissingError } from '../../src/core/page-state/guards.ts';
import { AIConfigError, AITransientError } from '../../src/core/ai/errors.ts';
import { runScopedErrors } from './harness.ts';

const op = (code: string, extra: Partial<OperationError> = {}) => Object.assign(new OperationError(code as never, `refused: ${code}`), extra);
const sql = (code: string) => Object.assign(new Error(`sql ${code}`), { code });

describe('classifyItemFailure', () => {
  test('run-scoped errors stop the unit', () => {
    for (const { name, error } of runScopedErrors()) expect({ name, scope: classifyItemFailure(error()).scope }).toEqual({ name, scope: 'run' });
    expect(classifyItemFailure(Object.assign(new Error('stolen'), { name: 'LockStolenError' })).code).toBe('lock_stolen');
    expect(classifyItemFailure(Object.assign(new Error('budget'), { name: 'BudgetExhausted' })).code).toBe('budget_exhausted');
    expect(classifyItemFailure(sql('42P01'))).toMatchObject({ scope: 'run', code: 'schema_behind' });
    expect(classifyItemFailure(Object.assign(new Error('no space'), { code: 'ENOSPC' }))).toMatchObject({ scope: 'run', code: 'disk_full' });
    expect(classifyItemFailure(op('storage_error', { detail: 'database_contention' })).scope).toBe('run');
  });

  test('an item refusal is the item\'s: content codes are content, the rest transient', () => {
    expect(classifyItemFailure(op('invalid_fence'))).toMatchObject({ scope: 'item', class: 'content', code: 'invalid_fence' });
    expect(classifyItemFailure(op('storage_error', { writeError: 'request_too_large' as never }))).toMatchObject({ scope: 'item', code: 'request_too_large', class: 'content' });
    expect(classifyItemFailure(sql('57014'))).toMatchObject({ scope: 'item', class: 'transient', code: 'statement_timeout' });
    expect(classifyItemFailure(sql('22P05'))).toMatchObject({ scope: 'item', class: 'content', code: 'invalid_data' });
    expect(classifyItemFailure(sql('23505'))).toMatchObject({ scope: 'item', class: 'content' });
    expect(classifyItemFailure(Object.assign(new Error('denied'), { code: 'EACCES' }))).toMatchObject({ scope: 'item', class: 'content', code: 'unreadable_item' });
  });

  test('an unknown error is an item failure that never counts as content', () => {
    expect(classifyItemFailure(new TypeError('x is undefined'))).toMatchObject({ scope: 'item', class: 'transient', code: 'internal' });
  });

  test('a missing page source (#6808, PageSourceMissingError) is a content failure of the item; an untyped error with its text is not', () => {
    expect(classifyItemFailure(new PageSourceMissingError('ghost-example'))).toMatchObject({ scope: 'item', class: 'content', code: 'unknown_source' });
    expect(classifyItemFailure(new Error('Page source does not exist: ghost-example'))).toMatchObject({ scope: 'item', class: 'transient', code: 'internal' });
  });

  test('the cause chain is walked', () => {
    const wrapped = new Error('wrapper', { cause: sql('25P02') });
    expect(classifyItemFailure(wrapped)).toMatchObject({ scope: 'run', code: 'database_contention', message: 'wrapper' });
  });

  test('authorization and security refusals stop the unit, from SQL or as canonical codes', () => {
    expect(classifyItemFailure(sql('42501'))).toMatchObject({ scope: 'run', code: 'permission_denied' });
    expect(classifyItemFailure(sql('28P01'))).toMatchObject({ scope: 'run', code: 'auth' });
    expect(classifyItemFailure(sql('28000'))).toMatchObject({ scope: 'run', code: 'auth' });
    for (const code of ['invalid_token', 'insufficient_scope', 'trusted_local_only', 'recovery_required', 'cancelled']) {
      expect({ code, scope: classifyItemFailure(op(code)).scope }).toEqual({ code, scope: 'run' });
    }
  });

  test('a run-scoped stop wrapped under a recognized item error still stops the unit', () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const wrapped = Object.assign(op('invalid_params'), { cause: abort });
    expect(classifyItemFailure(wrapped)).toMatchObject({ scope: 'run', code: 'aborted', message: 'refused: invalid_params' });
    expect(classifyItemFailure(new Error('outer', { cause: Object.assign(op('invalid_fence'), { cause: sql('42501') }) }))).toMatchObject({ scope: 'run', code: 'permission_denied' });
    expect(classifyItemFailure(Object.assign(op('invalid_fence'), { cause: sql('23505') }))).toMatchObject({ scope: 'item', code: 'invalid_fence', class: 'content' });
  });

  test('an accepted pending write is progress, not a failure', () => {
    const pending = op('write_pending', { writeRequest: { request_id: 'req-1', state: 'queued' } as never });
    expect(classifyItemFailure(pending)).toMatchObject({ scope: 'pending', requestId: 'req-1' });
    const terminal = op('write_pending', { writeRequest: { request_id: 'req-2', state: 'failed' } as never });
    expect(classifyItemFailure(terminal).scope).toBe('item');
  });

  test('every run-scoped and content code is a registry code or one of the classifier\'s own codes (no typos)', () => {
    const own = new Set(['aborted', 'lock_stolen', 'budget_exhausted', 'schema_behind', 'database_contention', 'disk_full', 'connection_lost',
      'writer_busy', 'config', 'auth', 'malformed', 'invalid_data', 'unreadable_item', 'maintenance_backpressure', 'transfer_in_progress']);
    const unknown = [...RUN_SCOPED_CODES, ...CONTENT_ITEM_CODES].filter(code => !(code in CODES) && !own.has(code));
    expect(unknown).toEqual([]);
  });
});

describe('ItemRun breaker', () => {
  test('a few bad items among good ones are recorded and the run continues', () => {
    const run = new ItemRun('links.extract_stale' as never);
    for (let i = 0; i < 8; i++) run.succeed();
    run.fail('a', op('invalid_fence'));
    run.fail('b', op('invalid_fence'));
    expect(run.failures.map(f => f.key)).toEqual(['a', 'b']);
    expect(run.systemic()).toBeNull();
  });

  test('a run where nothing succeeds trips at the floor and names the site', () => {
    const run = new ItemRun('links.extract_stale' as never);
    for (let i = 0; i < 4; i++) run.fail(`p${i}`, op('invalid_fence'));
    expect(() => run.fail('p4', op('invalid_fence'))).toThrow(/items failed at links\.extract_stale/);
  });

  test('half the attempts failing transiently trips', () => {
    const run = new ItemRun('links.extract_stale' as never);
    for (let i = 0; i < 3; i++) run.succeed();
    run.fail('x', new TypeError('boom'));
    run.fail('y', new TypeError('boom'));
    expect(() => run.fail('z', new TypeError('boom'))).toThrow(OperationError);
  });

  test('a run-scoped error is rethrown untouched and records nothing', () => {
    const run = new ItemRun('links.extract_stale' as never);
    const lost = runScopedErrors()[0]!.error();
    expect(() => run.fail('p', lost)).toThrow(lost as Error);
    expect(run.failures).toEqual([]);
  });

  test('pending writes are kept apart and never trip the breaker', () => {
    const run = new ItemRun('links.extract_stale' as never);
    for (let i = 0; i < 10; i++) run.fail(`p${i}`, op('write_pending', { writeRequest: { request_id: `r${i}`, state: 'queued' } as never }));
    expect(run.pending.length).toBe(10);
    expect(run.failures).toEqual([]);
    expect(run.systemic()).toBeNull();
  });
});

test('a provider refusal of one request\'s own input is the item\'s content failure; other provider 400s stay transient (A-25)', () => {
  const status = (error: Error, code: number) => Object.assign(error, { status: code });
  expect(classifyItemFailure(status(new AIConfigError('[chat(anthropic:claude-example)] prompt is too long: 250000 tokens > 200000 maximum'), 400)))
    .toMatchObject({ code: 'request_too_large', scope: 'item', class: 'content' });
  expect(classifyItemFailure(status(new AIConfigError('[chat(openai:gpt-example)] Request Entity Too Large'), 413))).toMatchObject({ code: 'request_too_large', class: 'content' });
  const blocked = Object.assign(new Error('Bad Request'), { statusCode: 400, responseBody: JSON.stringify({ error: { code: 'content_policy_violation' } }) });
  expect(classifyItemFailure(new AIConfigError('[chat(openai:gpt-example)] Bad Request', undefined, blocked))).toMatchObject({ code: 'content_rejected', class: 'content' });
  expect(classifyItemFailure(status(new AIConfigError('[chat(openai:gpt-example)] Unknown parameter: temperature'), 400))).toMatchObject({ scope: 'item', class: 'transient' });
  expect(classifyItemFailure(new AITransientError('[chat(openai:gpt-example)] context length exceeded upstream'))).toMatchObject({ class: 'transient' });
});

test('a model provider\'s transport failure is the item\'s transient failure, never a lost database connection (A-25)', () => {
  expect(classifyItemFailure(new Error('fetch failed: ECONNRESET'))).toMatchObject({ code: 'provider_error', scope: 'item', class: 'transient' });
  expect(classifyItemFailure(Object.assign(new Error("ENOSPC: no space left on device, open '/brain/fetch failed.md'"), { code: 'ENOSPC' }))).toMatchObject({ code: 'disk_full', scope: 'run' });
  expect(classifyItemFailure(Object.assign(new Error('could not write notes/fetch failed.md'), { code: '42501' }))).toMatchObject({ code: 'permission_denied', scope: 'run' });
  expect(classifyItemFailure(Object.assign(new Error('current transaction is aborted while importing /brain/fetch failed.md'), { code: '25P02' }))).toMatchObject({ code: 'database_contention', scope: 'run' });
  expect(classifyItemFailure(Object.assign(new Error('fetch failed.md: connection terminated'), { code: '08006' }))).toMatchObject({ code: 'database_contention', scope: 'run' });
  expect(classifyItemFailure(new OperationError('disk_full', "No space left writing '/brain/fetch failed.md'.", 'Free space, then rerun.'))).toMatchObject({ code: 'disk_full', scope: 'run' });
  expect(classifyItemFailure(new AITransientError('[chat(openai:gpt-example)] socket hang up', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))))
    .toMatchObject({ code: 'provider_error', scope: 'item' });
  expect(classifyItemFailure(Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' })).scope).toBe('run');
  expect(classifyItemFailure(new Error('read ECONNRESET')).scope).toBe('run');
});

test('RUN_SCOPED_CODES holds item_failures_systemic so a tripped inner loop stops its outer loop', () => {
  expect(RUN_SCOPED_CODES.has('item_failures_systemic')).toBe(true);
});

test('a role that may not create schema objects stops the run: schema_owner_required is run-scoped', () => {
  expect(classifyItemFailure(new OperationError('schema_owner_required', 'This database role may not create query_cache.'))).toMatchObject({ code: 'schema_owner_required', scope: 'run' });
});
