import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import {
  OperationError,
  type Operation,
  type OperationContext,
} from '../src/core/operations.ts';
import {
  createGovernedMcpDispatcher,
  GOVERNED_INTERNAL_ERROR_MESSAGE,
  type GovernedOperationResolver,
} from '../src/mcp/governed-dispatch.ts';

const engine = {} as BrainEngine;
const logger = Object.freeze({
  info: (_message: string) => {},
  warn: (_message: string) => {},
  error: (_message: string) => {},
});

function op(
  name: string,
  handler: Operation['handler'],
  params: Operation['params'] = {},
): Operation {
  return {
    name,
    description: `${name} description`,
    params,
    scope: 'read',
    handler,
  };
}

function unpack(result: Awaited<ReturnType<ReturnType<typeof createGovernedMcpDispatcher>['dispatch']>>) {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

const explicitConfig: GBrainConfig = {
  engine: 'postgres',
  embedding_model: 'example:configured-once',
  provider_base_urls: { example: 'http://provider.invalid/v1' },
};

describe('createGovernedMcpDispatcher', () => {
  test('one snapshotted operation ceiling drives definitions and dispatch', async () => {
    let allowedCalls = 0;
    let hiddenCalls = 0;
    const allowed = op('allowed', async () => ({ ok: true, calls: ++allowedCalls }));
    const hidden = op('hidden', async () => ({ ok: true, calls: ++hiddenCalls }));
    const operations = [allowed];
    const dispatcher = createGovernedMcpDispatcher({ operations, config: explicitConfig, logger });

    // Mutating either the source array or the source Operation after factory
    // construction cannot widen or replace the executable capability.
    operations.push(hidden);
    allowed.handler = hidden.handler;

    expect(dispatcher.listTools().map(tool => tool.name)).toEqual(['allowed']);
    expect(Object.isFrozen(dispatcher.listTools())).toBe(true);

    const success = await dispatcher.dispatch('allowed', {}, { engine, sourceId: 'source-a' });
    expect(unpack(success)).toEqual({ ok: true, calls: 1 });
    expect(allowedCalls).toBe(1);
    expect(hiddenCalls).toBe(0);

    const denied = await dispatcher.dispatch('hidden', {}, { engine, sourceId: 'source-a' });
    expect(denied.isError).toBe(true);
    expect(unpack(denied).error).toBe('unknown_tool');
    expect(hiddenCalls).toBe(0);
  });

  test('reuses native validation and builds a frozen explicit context without ambient defaults', async () => {
    let receivedContext: OperationContext | undefined;
    const inspect = op(
      'inspect',
      async (ctx, params) => {
        receivedContext = ctx;
        return {
          value: params.value,
          config_model: ctx.config.embedding_model,
          source_id: ctx.sourceId,
          remote: ctx.remote,
          dry_run: ctx.dryRun,
          auth_client: ctx.auth?.clientId,
          context_frozen: Object.isFrozen(ctx),
          config_frozen: Object.isFrozen(ctx.config),
          nested_config_frozen: Object.isFrozen(ctx.config.provider_base_urls),
          auth_frozen: Object.isFrozen(ctx.auth),
          scopes_frozen: Object.isFrozen(ctx.auth?.scopes),
          holder_list_frozen: Object.isFrozen(ctx.takesHoldersAllowList),
        };
      },
      { value: { type: 'string', required: true } },
    );
    const dispatcher = createGovernedMcpDispatcher({ operations: [inspect], config: explicitConfig, logger });

    const invalid = await dispatcher.dispatch('inspect', { value: 42 }, { engine, sourceId: 'source-a' });
    expect(invalid.isError).toBe(true);
    expect(unpack(invalid)).toEqual({
      error: 'invalid_params',
      message: 'Parameter "value" must be a string',
    });

    const result = await dispatcher.dispatch(
      'inspect',
      { value: 'ok', dry_run: true },
      {
        engine,
        sourceId: 'source-explicit',
        auth: {
          token: 'test-token',
          clientId: 'client-a',
          scopes: ['read'],
          allowedSources: ['source-explicit'],
        },
        takesHoldersAllowList: ['world'],
      },
    );
    expect(unpack(result)).toEqual({
      value: 'ok',
      config_model: 'example:configured-once',
      source_id: 'source-explicit',
      remote: true,
      dry_run: true,
      auth_client: 'client-a',
      context_frozen: true,
      config_frozen: true,
      nested_config_frozen: true,
      auth_frozen: true,
      scopes_frozen: true,
      holder_list_frozen: true,
    });
    expect(receivedContext?.engine).toBe(engine);
  });

  test('preserves OperationError envelopes and scrubs every unexpected error detail', async () => {
    const warnings: string[] = [];
    const capturingLogger = {
      ...logger,
      warn: (message: string) => warnings.push(message),
    };
    const expected = op('expected', async () => {
      throw new OperationError('permission_denied', 'safe public reason', 'safe suggestion', 'https://docs.invalid/safe');
    });
    const unexpected = op('unexpected', async () => {
      throw new Error('SECRET_DATABASE_URL=postgres://private-host/internal');
    });
    const dispatcher = createGovernedMcpDispatcher({
      operations: [expected, unexpected],
      config: explicitConfig,
      logger: capturingLogger,
    });

    const expectedResult = await dispatcher.dispatch('expected', {}, { engine, sourceId: 'source-a' });
    expect(unpack(expectedResult)).toEqual({
      error: 'permission_denied',
      message: 'safe public reason',
      suggestion: 'safe suggestion',
      docs: 'https://docs.invalid/safe',
    });

    const unexpectedResult = await dispatcher.dispatch('unexpected', {}, { engine, sourceId: 'source-a' });
    const serialized = JSON.stringify(unexpectedResult);
    expect(unpack(unexpectedResult)).toEqual({
      error: 'internal_error',
      message: GOVERNED_INTERNAL_ERROR_MESSAGE,
    });
    expect(serialized).not.toContain('SECRET_DATABASE_URL');
    expect(serialized).not.toContain('private-host');

    // Meta-hook failures are best-effort, but their unexpected details are
    // scrubbed from the caller-owned logger too.
    const success = op('success', async () => ({ ok: true }));
    const metaDispatcher = createGovernedMcpDispatcher({
      operations: [success],
      config: explicitConfig,
      logger: capturingLogger,
    });
    await metaDispatcher.dispatch('success', {}, {
      engine,
      sourceId: 'source-a',
      metaHook: async () => {
        throw new Error('SECRET_META_HOOK_DETAIL');
      },
    });
    expect(warnings.join('\n')).toContain(GOVERNED_INTERNAL_ERROR_MESSAGE);
    expect(warnings.join('\n')).not.toContain('SECRET_META_HOOK_DETAIL');
  });

  test('resolver may narrow but cannot swap in an unadvertised handler', async () => {
    const advertised = op('dynamic', async () => ({ handler: 'advertised' }));
    const replacement = op('dynamic', async () => ({ handler: 'replacement' }));
    let mode: 'allow' | 'deny' | 'replace' | 'throw' = 'allow';
    const resolver: GovernedOperationResolver = {
      listOperations: () => [advertised],
      resolveOperation: () => {
        if (mode === 'throw') throw new Error('resolver secret');
        if (mode === 'deny') return undefined;
        if (mode === 'replace') return replacement;
        return advertised;
      },
    };
    const dispatcher = createGovernedMcpDispatcher({ operations: resolver, config: explicitConfig, logger });

    expect(unpack(await dispatcher.dispatch('dynamic', {}, { engine, sourceId: 'source-a' })))
      .toEqual({ handler: 'advertised' });

    mode = 'deny';
    expect(unpack(await dispatcher.dispatch('dynamic', {}, { engine, sourceId: 'source-a' })).error)
      .toBe('unknown_tool');

    mode = 'replace';
    expect(unpack(await dispatcher.dispatch('dynamic', {}, { engine, sourceId: 'source-a' })).error)
      .toBe('unknown_tool');

    mode = 'throw';
    expect(unpack(await dispatcher.dispatch('dynamic', {}, { engine, sourceId: 'source-a' })))
      .toEqual({ error: 'internal_error', message: GOVERNED_INTERNAL_ERROR_MESSAGE });
  });

  test('rejects duplicate names and missing explicit source authority', async () => {
    const duplicateA = op('duplicate', async () => ({}));
    const duplicateB = op('duplicate', async () => ({}));
    expect(() => createGovernedMcpDispatcher({
      operations: [duplicateA, duplicateB],
      config: explicitConfig,
      logger,
    })).toThrow('duplicate governed MCP operation name: duplicate');

    const dispatcher = createGovernedMcpDispatcher({ operations: [duplicateA], config: explicitConfig, logger });
    expect(dispatcher.dispatch('duplicate', {}, { engine, sourceId: '' })).rejects
      .toThrow('governed MCP dispatch requires a non-empty explicit sourceId');
  });
});
