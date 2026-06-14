import { describe, expect, test } from 'bun:test';
import {
  OperationError,
  operations,
  validateOperationParams,
  type Operation,
  type OperationContext,
} from '../src/core/operations.ts';
import { handleToolCall } from '../src/mcp/server.ts';

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

  test('put_raw_data rejects non-JSON-serializable data before engine writes', async () => {
    const calls: Array<{ slug: string; source: string; data: object }> = [];
    const ctx = {
      engine: {
        putRawData: async (slug: string, source: string, data: object) => {
          calls.push({ slug, source, data });
        },
      },
    } as unknown as OperationContext;
    const op = operationByName('put_raw_data');
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const invalidCases: Array<{ data: unknown; message: string }> = [
      { data: null, message: 'data must be an object' },
      { data: [], message: 'data must be an object' },
      { data: circular, message: 'JSON-serializable' },
      { data: { score: Number.NaN }, message: 'JSON-serializable' },
      { data: { created_at: new Date('2026-06-14T00:00:00.000Z') }, message: 'JSON-serializable' },
      { data: { callback: () => 'not json' }, message: 'JSON-serializable' },
    ];

    for (const { data, message } of invalidCases) {
      await expect(op.handler(ctx, {
        slug: 'people/alice',
        source: 'test',
        data,
      })).rejects.toThrow(OperationError);
      await expect(op.handler(ctx, {
        slug: 'people/alice',
        source: 'test',
        data,
      })).rejects.toThrow(message);
    }

    await expect(op.handler({ ...ctx, dryRun: true }, {
      slug: 'people/alice',
      source: 'test',
      data: circular,
    })).rejects.toThrow('JSON-serializable');
    expect(calls).toEqual([]);
  });

  test('put_raw_data rejects missing required fields before engine writes', async () => {
    const calls: Array<{ slug: string; source: string; data: object }> = [];
    const engine = {
      putRawData: async (slug: string, source: string, data: object) => {
        calls.push({ slug, source, data });
      },
    };
    const ctx = { engine } as unknown as OperationContext;
    const op = operationByName('put_raw_data');

    for (const params of [
      { source: 'test', data: { ok: true } },
      { slug: 'people/alice', data: { ok: true } },
      { slug: '  ', source: 'test', data: { ok: true } },
      { slug: 'people/alice', source: '', data: { ok: true } },
    ]) {
      await expect(op.handler(ctx, params)).rejects.toThrow(OperationError);
      await expect(op.handler({ ...ctx, dryRun: true }, params)).rejects.toThrow(OperationError);
      await expect(handleToolCall(engine as OperationContext['engine'], 'put_raw_data', params))
        .rejects.toThrow(OperationError);
    }

    expect(calls).toEqual([]);
  });

  test('put_raw_data accepts JSON-serializable object data', async () => {
    const calls: Array<{ slug: string; source: string; data: object }> = [];
    const ctx = {
      engine: {
        putRawData: async (slug: string, source: string, data: object) => {
          calls.push({ slug, source, data });
        },
      },
    } as unknown as OperationContext;
    const data = {
      nested: {
        values: ['alpha', 1, true, null],
      },
    };

    await expect(operationByName('put_raw_data').handler(ctx, {
      slug: 'people/alice',
      source: 'test',
      data,
    })).resolves.toEqual({ status: 'ok' });

    expect(calls).toEqual([{ slug: 'people/alice', source: 'test', data }]);
  });
});
