import { describe, expect, test } from 'bun:test';
import {
  getMissingRequiredParams,
  OperationError,
  type ParamDef,
  validateOperationParams,
} from '../src/core/operation-params.ts';
import {
  dispatchOperation,
  type Operation,
  type OperationContext,
  operations,
  validateOperationParams as registryValidateOperationParams,
} from '../src/core/operations.ts';

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

describe('operation-params validation seam', () => {
  test('rejects missing required params with the pinned message shape', () => {
    const op = operation({
      slug: { type: 'string', required: true },
    });

    expect(() => validateOperationParams(op, {})).toThrow(OperationError);
    expect(() => validateOperationParams(op, {})).toThrow('Missing required parameter: slug');
    try {
      validateOperationParams(op, {});
      throw new Error('expected throw');
    } catch (error) {
      expect((error as OperationError).code).toBe('invalid_params');
    }
  });

  test('lists every missing required param in one error', () => {
    const op = operation({
      slug: { type: 'string', required: true },
      source: { type: 'string', required: true },
      optional_note: { type: 'string' },
    });

    expect(() => validateOperationParams(op, {})).toThrow('Missing required parameters: slug, source');
    expect(getMissingRequiredParams(op, { slug: 'people/alice' })).toEqual(['source']);
  });

  test('lets optional params stay absent', () => {
    const op = operation({
      limit: { type: 'number' },
    });

    expect(validateOperationParams(op, {})).toEqual({});
  });

  test('rejects type mismatches with the pinned message shape', () => {
    const op = operation({
      slug: { type: 'string' },
      limit: { type: 'number' },
      flag: { type: 'boolean' },
      payload: { type: 'object' },
      tags: { type: 'array' },
    });

    expect(() => validateOperationParams(op, { slug: 7 })).toThrow('slug must be a string.');
    expect(() => validateOperationParams(op, { limit: 'ten' })).toThrow('limit must be a number.');
    expect(() => validateOperationParams(op, { flag: 'yes' })).toThrow('flag must be a boolean.');
    expect(() => validateOperationParams(op, { payload: [] })).toThrow('payload must be an object.');
    expect(() => validateOperationParams(op, { tags: 'a,b' })).toThrow('tags must be an array.');
  });

  test('rejects non-finite numbers', () => {
    const op = operation({
      limit: { type: 'number' },
    });

    expect(() => validateOperationParams(op, { limit: Number.NaN })).toThrow('limit must be a number.');
    expect(() => validateOperationParams(op, { limit: Number.POSITIVE_INFINITY })).toThrow('limit must be a number.');
    expect(validateOperationParams(op, { limit: 5 })).toEqual({ limit: 5 });
  });

  test('rejects enum values outside the contract, with optional hint', () => {
    const op = operation({
      source_kind: { type: 'string', enum: ['chat', 'note'] },
      route: { type: 'string', enum: ['fast', 'slow'], enumErrorHint: 'Pick a lane.' },
    });

    expect(() => validateOperationParams(op, { source_kind: 'email' })).toThrow(OperationError);
    expect(() => validateOperationParams(op, { source_kind: 'email' }))
      .toThrow('source_kind must be one of: chat, note');
    expect(() => validateOperationParams(op, { route: 'medium' }))
      .toThrow('route must be one of: fast, slow. Pick a lane.');
  });

  test('honors nullable, ignores unknown params, rejects bare null otherwise', () => {
    const op = operation({
      optional_note: { type: 'string', nullable: true },
      strict_note: { type: 'string' },
    });

    expect(validateOperationParams(op, { optional_note: null, passthrough: ['left alone'] }))
      .toEqual({ optional_note: null, passthrough: ['left alone'] });
    expect(() => validateOperationParams(op, { strict_note: null })).toThrow('strict_note must be a string.');
  });

  test('trims strings only when the descriptor opts in', () => {
    const op = operation({
      slug: { type: 'string', trim: true },
      content: { type: 'string' },
    });

    const input = { slug: '  people/alice  ', content: '## Page\n\nBody.\n' };
    const result = validateOperationParams(op, input);

    expect(result.slug).toBe('people/alice');
    expect(result.content).toBe('## Page\n\nBody.\n');
    // Coercion must not mutate the caller's object.
    expect(input.slug).toBe('  people/alice  ');
  });

  test('validates enum membership against the trimmed value', () => {
    const op = operation({
      source_kind: { type: 'string', enum: ['chat', 'note'], trim: true },
    });

    expect(validateOperationParams(op, { source_kind: '  chat ' })).toEqual({ source_kind: 'chat' });
    expect(() => validateOperationParams(op, { source_kind: ' email ' }))
      .toThrow('source_kind must be one of: chat, note');
  });

  test('validates and trims array items via the item descriptor', () => {
    const itemDef: ParamDef = { type: 'string', trim: true };
    const op = operation({
      tags: { type: 'array', items: itemDef },
    });

    const input = { tags: [' a ', 'b'] };
    expect(validateOperationParams(op, input)).toEqual({ tags: ['a', 'b'] });
    expect(input.tags).toEqual([' a ', 'b']);
    expect(() => validateOperationParams(op, { tags: ['a', 7] })).toThrow('tags[1] must be a string.');
  });

  test('returns the original object when no coercion applies', () => {
    const op = operation({
      slug: { type: 'string', trim: true },
    });
    const params = { slug: 'people/alice' };

    expect(validateOperationParams(op, params)).toBe(params);
  });

  test('preserves symbol-keyed params when coercion copies the object', () => {
    const marker = Symbol('internal');
    const op = operation({
      slug: { type: 'string', trim: true },
    });
    const params: Record<string | symbol, unknown> = { slug: ' people/alice ', [marker]: true };

    const result = validateOperationParams(op, params as Record<string, unknown>);
    expect(result.slug).toBe('people/alice');
    expect((result as Record<string | symbol, unknown>)[marker]).toBe(true);
  });

  test('dispatch rejects a real operation call missing required params before the handler runs', async () => {
    const calls: unknown[] = [];
    const ctx = {
      engine: {
        putRawData: async (...args: unknown[]) => {
          calls.push(args);
        },
      },
    } as unknown as OperationContext;

    await expect(dispatchOperation(ctx, operationByName('put_raw_data'), { source: 'test', data: { ok: true } }))
      .rejects.toThrow('Missing required parameter: slug');
    expect(calls).toEqual([]);
  });

  test('dispatch rejects a real operation enum violation before the handler runs', async () => {
    const ctx = {} as OperationContext;

    await expect(dispatchOperation(ctx, operationByName('retrieve_context'), {
      requested_scope: 'compiled technical context',
    })).rejects.toThrow('requested_scope is the access scope; put retrieval details in query');
  });

  test('dispatch delivers validated params of a real operation to the handler', async () => {
    const calls: Array<{ slug: string; source: string; data: object }> = [];
    const ctx = {
      engine: {
        putRawData: async (slug: string, source: string, data: object) => {
          calls.push({ slug, source, data });
        },
      },
    } as unknown as OperationContext;

    await expect(dispatchOperation(ctx, operationByName('put_raw_data'), {
      slug: 'people/alice',
      source: 'test',
      data: { ok: true },
    })).resolves.toEqual({ status: 'ok' });
    expect(calls).toEqual([{ slug: 'people/alice', source: 'test', data: { ok: true } }]);
  });

  test('dispatch trims opt-in string params end to end', async () => {
    let seen: Record<string, unknown> | undefined;
    const op = operation({
      slug: { type: 'string', required: true, trim: true },
    });
    op.handler = async (_ctx, p) => {
      seen = p;
      return { ok: true };
    };

    await expect(dispatchOperation({} as OperationContext, op, { slug: '  people/alice  ' }))
      .resolves.toEqual({ ok: true });
    expect(seen).toEqual({ slug: 'people/alice' });
  });

  test('registry wrapper keeps the put_page route-first precondition ahead of missing-required errors', () => {
    // Mirrors the defensive registry hook: when a put_page-shaped op requires
    // expected_content_hash, the route-first explanation must win over the
    // generic missing-parameter error.
    const op: Operation = {
      name: 'put_page',
      description: 'Test-only put_page shape.',
      params: {
        expected_content_hash: { type: 'string', nullable: true, required: true },
      },
      handler: async () => ({ ok: true }),
    };

    expect(() => registryValidateOperationParams(op, {}))
      .toThrow('route_first: put_page must observe the target before writing');
    expect(() => registryValidateOperationParams(op, { write_session_id: 'ws-1' }))
      .toThrow('Missing required parameter: expected_content_hash');
  });
});
