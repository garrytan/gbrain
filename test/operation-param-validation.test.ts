import { describe, expect, test } from 'bun:test';
import { OperationError, operations, validateOperationParams, type Operation } from '../src/core/operations.ts';

function operation(params: Operation['params']): Operation {
  return {
    name: 'test_operation',
    description: 'Test-only operation.',
    params,
    handler: async () => ({ ok: true }),
  };
}

function operationByName(name: string): Operation {
  const op = operations.find((candidate) => candidate.name === name);
  expect(op).toBeDefined();
  return op!;
}

describe('operation parameter validation', () => {
  test('preserves params that explicitly accept either string or array', () => {
    const op = operation({
      events: {
        type: ['array', 'string'],
        items: { type: 'object' },
      },
    });

    expect(validateOperationParams(op, { events: 'jsonl payload' })).toEqual({
      events: 'jsonl payload',
    });
  });

  test('accepts object-or-array params used for structured patches', () => {
    const op = operation({
      patch_body: { type: ['object', 'array'] },
    });

    expect(validateOperationParams(op, { patch_body: { op: 'replace' } })).toEqual({
      patch_body: { op: 'replace' },
    });
    expect(validateOperationParams(op, { patch_body: [{ op: 'replace' }] })).toEqual({
      patch_body: [{ op: 'replace' }],
    });
  });

  test('rejects arrays for object-only params', () => {
    const op = operation({
      payload: { type: 'object' },
    });

    expect(() => validateOperationParams(op, { payload: [] })).toThrow(OperationError);
    expect(() => validateOperationParams(op, { payload: [] })).toThrow('payload must be an object');
  });

  test('honors nullable params and ignores unknown params', () => {
    const op = operation({
      optional_note: { type: 'string', nullable: true },
    });

    expect(validateOperationParams(op, {
      optional_note: null,
      passthrough: ['left alone'],
    })).toEqual({
      optional_note: null,
      passthrough: ['left alone'],
    });
  });

  test('keeps documented string-list operation params schema-compatible', () => {
    expect(validateOperationParams(operationByName('put_page'), {
      source_refs: 'Source: one\nSource: two',
    })).toEqual({ source_refs: 'Source: one\nSource: two' });
    expect(validateOperationParams(operationByName('record_retrieval_trace'), {
      route: 'retrieve_context,read_context',
      source_refs: 'Source: one',
      derived_consulted: 'atlas',
      verification: 'checked locally',
    })).toEqual({
      route: 'retrieve_context,read_context',
      source_refs: 'Source: one',
      derived_consulted: 'atlas',
      verification: 'checked locally',
    });
    expect(validateOperationParams(operationByName('route_memory_writeback'), {
      source_refs: 'Source: one',
    })).toEqual({ source_refs: 'Source: one' });
    expect(validateOperationParams(operationByName('upsert_memory_realm'), {
      source_refs: 'Source: one',
    })).toEqual({ source_refs: 'Source: one' });
    expect(validateOperationParams(operationByName('refresh_task_working_set'), {
      active_paths: 'src/core/operations.ts,test/operation-param-validation.test.ts',
      active_symbols: 'validateOperationParams',
      blockers: 'none',
      open_questions: 'none',
      next_steps: 'ship PR',
      verification_notes: 'focused tests passed',
    })).toEqual({
      active_paths: 'src/core/operations.ts,test/operation-param-validation.test.ts',
      active_symbols: 'validateOperationParams',
      blockers: 'none',
      open_questions: 'none',
      next_steps: 'ship PR',
      verification_notes: 'focused tests passed',
    });
    expect(validateOperationParams(operationByName('reverify_code_claims'), {
      claims: 'code_claim:src/core/operations.ts:validateOperationParams',
    })).toEqual({ claims: 'code_claim:src/core/operations.ts:validateOperationParams' });
    expect(validateOperationParams(operationByName('reverify_code_claims'), {
      claims: ['code_claim:src/core/operations.ts:validateOperationParams'],
    })).toEqual({ claims: ['code_claim:src/core/operations.ts:validateOperationParams'] });
  });
});
