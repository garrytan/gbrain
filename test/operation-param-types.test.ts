import { describe, expect, test } from 'bun:test';
import {
  defineOperation,
  type OperationContext,
} from '../src/core/operations.ts';

describe('typed operation params', () => {
  test('defineOperation infers handler param values from ParamDef types', async () => {
    const op = defineOperation({
      name: 'typed_param_probe',
      description: 'Probe typed operation params',
      params: {
        slug: { type: 'string', required: true },
        limit: { type: 'number' },
        flags: { type: 'array', items: { type: 'string' } },
      },
      handler: async (_ctx: OperationContext, params) => {
        const slug: string = params.slug;
        const limit: number | undefined = params.limit;
        const flags: unknown[] | undefined = params.flags;
        return { slug, limit, flags };
      },
    });

    const result = await op.handler({} as OperationContext, {
      slug: 'systems/runtime',
      limit: 3,
      flags: ['a'],
    });

    expect(result).toEqual({
      slug: 'systems/runtime',
      limit: 3,
      flags: ['a'],
    });
  });
});
