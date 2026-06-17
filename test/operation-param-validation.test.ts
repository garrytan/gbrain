import { describe, expect, test } from 'bun:test';
import {
  dispatchOperation,
  type Operation,
  type OperationContext,
  OperationError,
  operations,
  validateOperationParams,
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

  test('rejects missing required params before operation handlers run', async () => {
    const op = operation({
      slug: { type: 'string', required: true },
    });
    let called = false;
    op.handler = async () => {
      called = true;
      return { ok: true };
    };
    const ctx = {} as OperationContext;

    expect(() => validateOperationParams(op, {})).toThrow(OperationError);
    expect(() => validateOperationParams(op, {})).toThrow('Missing required parameter: slug');
    await expect(dispatchOperation(ctx, op, {})).rejects.toThrow('Missing required parameter: slug');
    expect(called).toBe(false);
  });

  test('rejects enum params outside the declared operation contract', async () => {
    const op = operation({
      source_kind: { type: 'string', enum: ['chat', 'note'] },
    });
    let called = false;
    op.handler = async () => {
      called = true;
      return { ok: true };
    };
    const ctx = {} as OperationContext;

    expect(() => validateOperationParams(op, { source_kind: 'email' })).toThrow(OperationError);
    expect(() => validateOperationParams(op, { source_kind: 'email' }))
      .toThrow('source_kind must be one of: chat, note');
    await expect(dispatchOperation(ctx, op, { source_kind: 'email' }))
      .rejects.toThrow('source_kind must be one of: chat, note');
    expect(called).toBe(false);
  });

  test('retrieval enum validation explains semantic fields', async () => {
    const ctx = {} as OperationContext;
    const invalidScopeError = 'requested_scope is the access scope; put retrieval details in query';
    const invalidScopeParams = { requested_scope: 'compiled technical context' };

    await expect(dispatchOperation(ctx, operationByName('retrieve_context'), {
      requested_scope: 'compiled technical context',
    })).rejects.toThrow(invalidScopeError);
    await expect(dispatchOperation(ctx, operationByName('read_context'), invalidScopeParams))
      .rejects.toThrow(invalidScopeError);
    await expect(handleToolCall({} as OperationContext['engine'], 'retrieve_context', invalidScopeParams))
      .rejects.toThrow(invalidScopeError);
    await expect(handleToolCall({} as OperationContext['engine'], 'read_context', invalidScopeParams))
      .rejects.toThrow(invalidScopeError);

    const directRequestedScopeCases: Array<[string, Record<string, unknown>]> = [
      ['write_profile_memory_entry', { ...invalidScopeParams, source_ref: 'Source: test' }],
      ['write_personal_episode_entry', { ...invalidScopeParams, source_ref: 'Source: test' }],
      ['get_mixed_scope_bridge', { ...invalidScopeParams, personal_route_kind: 'profile', query: 'topic', subject: 'Alice' }],
      ['get_mixed_scope_disclosure', { ...invalidScopeParams, personal_route_kind: 'profile', query: 'topic', subject: 'Alice' }],
      ['get_personal_profile_lookup_route', { ...invalidScopeParams, subject: 'Alice' }],
      ['get_personal_episode_lookup_route', { ...invalidScopeParams, title: 'Episode' }],
      ['select_personal_write_target', { ...invalidScopeParams, target_kind: 'profile_memory' }],
      ['preview_personal_export', invalidScopeParams],
      ['evaluate_scope_gate', { ...invalidScopeParams, intent: 'broad_synthesis' }],
      ['select_retrieval_route', { ...invalidScopeParams, intent: 'broad_synthesis', query: 'topic' }],
      ['plan_retrieval_request', invalidScopeParams],
      ['retrieve_context', invalidScopeParams],
      ['read_context', invalidScopeParams],
      ['classify_memory_scenario', invalidScopeParams],
      ['plan_scenario_memory_request', invalidScopeParams],
    ];

    for (const [name, params] of directRequestedScopeCases) {
      await expect(operationByName(name).handler(ctx, params)).rejects.toThrow(invalidScopeError);
    }

    await expect(dispatchOperation(ctx, operationByName('read_context'), {
      include_timeline: 'none',
    })).rejects.toThrow('use exclude when timeline text should be omitted');
    await expect(operationByName('read_context').handler(ctx, { include_timeline: 'none' }))
      .rejects.toThrow('use exclude when timeline text should be omitted');
    await expect(handleToolCall({} as OperationContext['engine'], 'read_context', { include_timeline: 'none' }))
      .rejects.toThrow('use exclude when timeline text should be omitted');
  });

  test('keeps documented string-list operation params schema-compatible', () => {
    expect(validateOperationParams(operationByName('put_page'), {
      slug: 'people/alice',
      content: 'Alice profile.',
      source_refs: 'Source: one\nSource: two',
    })).toEqual({ slug: 'people/alice', content: 'Alice profile.', source_refs: 'Source: one\nSource: two' });
    expect(validateOperationParams(operationByName('record_retrieval_trace'), {
      task_id: 'task-1',
      outcome: 'answered',
      route: 'retrieve_context,read_context',
      source_refs: 'Source: one',
      derived_consulted: 'atlas',
      verification: 'checked locally',
    })).toEqual({
      task_id: 'task-1',
      outcome: 'answered',
      route: 'retrieve_context,read_context',
      source_refs: 'Source: one',
      derived_consulted: 'atlas',
      verification: 'checked locally',
    });
    expect(validateOperationParams(operationByName('route_memory_writeback'), {
      content: 'Remember that Alice prefers concise checkpoints.',
      evidence_kind: 'direct_user_statement',
      source_refs: 'Source: one',
    })).toEqual({
      content: 'Remember that Alice prefers concise checkpoints.',
      evidence_kind: 'direct_user_statement',
      source_refs: 'Source: one',
    });
    expect(validateOperationParams(operationByName('upsert_memory_realm'), {
      id: 'realm:test',
      name: 'Test Realm',
      scope: 'work',
      source_refs: 'Source: one',
    })).toEqual({ id: 'realm:test', name: 'Test Realm', scope: 'work', source_refs: 'Source: one' });
    expect(validateOperationParams(operationByName('refresh_task_working_set'), {
      task_id: 'task-1',
      active_paths: 'src/core/operations.ts,test/operation-param-validation.test.ts',
      active_symbols: 'validateOperationParams',
      blockers: 'none',
      open_questions: 'none',
      next_steps: 'ship PR',
      verification_notes: 'focused tests passed',
    })).toEqual({
      task_id: 'task-1',
      active_paths: 'src/core/operations.ts,test/operation-param-validation.test.ts',
      active_symbols: 'validateOperationParams',
      blockers: 'none',
      open_questions: 'none',
      next_steps: 'ship PR',
      verification_notes: 'focused tests passed',
    });
    expect(validateOperationParams(operationByName('reverify_code_claims'), {
      repo_path: '/Users/meghendra/Work/mbrain',
      claims: 'code_claim:src/core/operations.ts:validateOperationParams',
    })).toEqual({
      repo_path: '/Users/meghendra/Work/mbrain',
      claims: 'code_claim:src/core/operations.ts:validateOperationParams',
    });
    expect(validateOperationParams(operationByName('reverify_code_claims'), {
      repo_path: '/Users/meghendra/Work/mbrain',
      claims: ['code_claim:src/core/operations.ts:validateOperationParams'],
    })).toEqual({
      repo_path: '/Users/meghendra/Work/mbrain',
      claims: ['code_claim:src/core/operations.ts:validateOperationParams'],
    });
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
