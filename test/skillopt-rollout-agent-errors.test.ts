/**
 * GST-1054: a SkillOpt rollout's tool loop hands the model a thrown error's message. That message is the error text
 * an MCP caller reads for the same call (code, message, suggestion, fix), so rollouts optimize skills against the
 * error surface real callers get.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { asAgentToolError, dispatchToolCall } from '../src/mcp/dispatch.ts';
import { invokeAI, isAIInvocationPolicyError, withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';
import { runRollout } from '../src/core/skillopt/rollout.ts';
import { buildWriteCaptureRegistry } from '../src/core/skillopt/write-capture.ts';
import type { ToolHandler } from '../src/core/ai/gateway.ts';
import type { BenchmarkTask } from '../src/core/skillopt/types.ts';
import type { OperationContext } from '../src/core/operations.ts';

const SLUG = 'notes/alpha-example';
let engine: PGLiteEngine;
let rollout: Map<string, ToolHandler>;
let writeCapture: Map<string, ToolHandler>;

async function rolloutHandlers(operationContext?: OperationContext): Promise<Map<string, ToolHandler>> {
  let captured: Map<string, ToolHandler> | undefined;
  const task: BenchmarkTask = { task_id: 'errors', task: 'read a page', judge: { kind: 'rule', checks: [] } };
  await runRollout({
    engine, operationContext, skillText: 'skill', task, targetModel: 'openai:gpt-6.1-sol', allowedTools: new Set(['get_page']),
    toolLoopFn: (async (o: { toolHandlers: Map<string, ToolHandler> }) => {
      captured = o.toolHandlers;
      return { messages: [], totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, totalTurns: 1, stopReason: 'end' };
    }) as never,
  });
  return captured!;
}

async function mcpText(args: Record<string, unknown>): Promise<string> {
  const r = await dispatchToolCall(engine, 'get_page', args, { remote: true, transport: 'http', sourceId: 'default', auth: { token: '', clientId: '', scopes: ['read'] } });
  expect(r.isError).toBe(true);
  return (r.content as Array<{ text: string }>)[0]!.text;
}

async function thrownMessage(handlers: Map<string, ToolHandler>, args: Record<string, unknown>): Promise<string> {
  try {
    await handlers.get('brain_get_page')!.execute(args, new AbortController().signal);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected the tool call to refuse');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const put = await dispatchToolCall(engine, 'put_page', { slug: SLUG, content: '---\ntitle: Alpha Example\n---\n# Alpha Example\n\nline one\nline two\n' }, { remote: false, sourceId: 'default' });
  expect(put.isError).toBeFalsy();
  rollout = await rolloutHandlers();
  writeCapture = buildWriteCaptureRegistry(engine).handlers;
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('GST-1054: SkillOpt rollout tool errors carry the MCP error text', () => {
  const asOfWindow = { slug: SLUG, known_as_of: '2026-10-01T12:00:00Z', body: 'window' };
  const missing = { slug: 'notes/missing-example' };

  for (const [name, handlers] of [['rollout', () => rollout], ['write-capture', () => writeCapture]] as const) {
    test(name + ': a refusal reaches the model with its code, suggestion and runnable fix, as MCP returns it', async () => {
      const message = await thrownMessage(handlers(), asOfWindow);
      expect(message).toBe(await mcpText(asOfWindow));
      const body = JSON.parse(message) as { code: string; suggestion?: string; fix?: { argv?: string[]; next?: string; mcp?: { tool: string } } };
      expect(body.code).toBe('invalid_params');
      expect(body.suggestion).toContain('Drop `body` to read the page as recorded');
      expect(body.fix?.argv).toEqual(['gbrain', 'get', '--known-as-of', '2026-10-01T12:00:00Z', '--source', 'default', '--', SLUG]);
      expect(body.fix?.next).toBe('run');
      expect(body.fix?.mcp?.tool).toBe('get_page');
    });

    test(name + ': a handler error reads the same as the MCP error', async () => {
      expect(await thrownMessage(handlers(), missing)).toBe(await mcpText(missing));
    });
  }

  test('an AI invocation policy stop passes through unchanged, so the tool loop still aborts the run', async () => {
    const stop = new Error('synthetic spend cap reached');
    await expect(withAIInvocationGuard(async () => { throw stop; }, () =>
      invokeAI({ operation: 'synthetic.expand', kind: 'embedding', model: 'synthetic:model', maxInputTokens: 8 }, async () => 'unreached', () => null))).rejects.toBe(stop);
    expect(isAIInvocationPolicyError(stop)).toBe(true);
    expect(asAgentToolError(stop, 'get_page', { sourceId: 'default' }, new Set(['get_page']))).toBe(stop);
  });

  test('a remote rollout whose grant was revoked reads the permission_denied error with its fix', async () => {
    const remote: OperationContext = { engine, config: { engine: 'pglite' }, remote: true, sourceId: 'default', dryRun: false,
      logger: { info() {}, warn() {}, error() {} },
      auth: { token: 'fixture', clientId: 'revoked-example', principal: { kind: 'oauth_client', id: 'revoked-example' }, scopes: ['read'], allowedOperations: ['get_page'] } } as OperationContext;
    const body = JSON.parse(await thrownMessage(await rolloutHandlers(remote), { slug: SLUG })) as { code: string; fix?: { argv?: string[] } };
    expect(body.code).toBe('permission_denied');
    expect(body.fix?.argv?.[0]).toBe('gbrain');
  });
});
