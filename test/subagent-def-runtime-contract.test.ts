/**
 * Subagent def-as-runtime-contract tests.
 *
 * Verifies the resolution path added so that when a job specifies
 * `data.subagent_def`, the plugin-registered def's body becomes the
 * default system prompt and the def's allowed_tools become the default
 * allowed set — both overridable by explicit data fields. Backward-
 * compatible: when subagent_def is absent OR names an unknown def, the
 * handler falls through to current behavior (data.system or
 * DEFAULT_SYSTEM; data.allowed_tools or full registry).
 *
 * Inspection strategy: FakeMessagesClient captures the params handed to
 * Anthropic.Messages.create; tests assert client.calls[0].system and
 * client.calls[0].tools matches the expected resolution.
 *
 * Registry seeding goes through plugin-loader's __testing surface so we
 * don't need on-disk plugin fixtures to verify the in-process lookup.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  makeSubagentHandler,
  type MessagesClient,
} from '../src/core/minions/handlers/subagent.ts';
import { __testing as pluginLoaderTesting } from '../src/core/minions/plugin-loader.ts';
import type { ToolDef, MinionJobContext } from '../src/core/minions/types.ts';
import type Anthropic from '@anthropic-ai/sdk';

const DEFAULT_SYSTEM = 'You are a helpful assistant running as a gbrain subagent.';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM subagent_tool_executions');
  await engine.executeRaw('DELETE FROM subagent_messages');
  await engine.executeRaw('DELETE FROM subagent_rate_leases');
  await engine.executeRaw('DELETE FROM minion_jobs');
  pluginLoaderTesting._clearSubagentRegistry();
});

// ── Helpers ────────────────────────────────────────────────

type FakeResponse = Partial<Anthropic.Message> & { content: Anthropic.Message['content'] };

class FakeMessagesClient implements MessagesClient {
  public calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  constructor(private responses: FakeResponse[]) {}
  async create(
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> {
    this.calls.push(params);
    if (this.responses.length === 0) throw new Error('FakeMessagesClient: out of scripted responses');
    const r = this.responses.shift()!;
    return {
      id: `msg_${this.calls.length}`,
      type: 'message',
      role: 'assistant',
      model: params.model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any,
      ...r,
    } as Anthropic.Message;
  }
}

async function makeCtx(input: unknown): Promise<MinionJobContext> {
  const job = await queue.add(
    'subagent',
    input as Record<string, unknown>,
    {},
    { allowProtectedSubmit: true },
  );
  return {
    id: job.id,
    name: job.name,
    data: (input as Record<string, unknown>) ?? {},
    attempts_made: 0,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    async updateProgress() {},
    async updateTokens() {},
    async log() {},
    async isActive() { return true; },
    async readInbox() { return []; },
  };
}

function makeNoopTool(name: string): ToolDef {
  return {
    name,
    description: `noop ${name}`,
    input_schema: { type: 'object', properties: {}, required: [] },
    idempotent: true,
    async execute() { return {}; },
  };
}

// One canonical "OK" response — every test that doesn't care about tool flow uses this
function makeOkClient(): FakeMessagesClient {
  return new FakeMessagesClient([
    { content: [{ type: 'text', text: 'OK' }] as any, stop_reason: 'end_turn' },
  ]);
}

// Pull the system-prompt string out of params.system (may be string or
// content-block array depending on cache markers).
function systemText(params: Anthropic.MessageCreateParamsNonStreaming): string {
  if (typeof params.system === 'string') return params.system;
  if (Array.isArray(params.system)) {
    return params.system.map(b => (typeof b === 'string' ? b : (b as any).text ?? '')).join('');
  }
  return '';
}

function toolNames(params: Anthropic.MessageCreateParamsNonStreaming): string[] {
  return (params.tools ?? []).map(t => (t as any).name);
}

// ── Tests ───────────────────────────────────────────────────

describe('subagent def-as-runtime-contract — resolution paths', () => {

  test('def.body becomes system prompt when subagent_def set and no data.system override', async () => {
    pluginLoaderTesting._seedSubagentDef({
      plugin_name: 'test-plugin',
      name: 'test-def-1',
      source_path: '/tmp/test-def-1.md',
      frontmatter: {},
      body: 'CUSTOM SYSTEM PROMPT FROM DEF',
      allowed_tools: undefined,
    });
    const client = makeOkClient();
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [] });
    const ctx = await makeCtx({ prompt: 'hi', subagent_def: 'test-def-1' });

    await handler(ctx);

    expect(client.calls.length).toBe(1);
    expect(systemText(client.calls[0]!)).toBe('CUSTOM SYSTEM PROMPT FROM DEF');
    expect(systemText(client.calls[0]!)).not.toBe(DEFAULT_SYSTEM);
  });

  test('data.system overrides def.body when both provided (data wins)', async () => {
    pluginLoaderTesting._seedSubagentDef({
      plugin_name: 'test-plugin',
      name: 'test-def-2',
      source_path: '/tmp/test-def-2.md',
      frontmatter: {},
      body: 'DEF BODY SHOULD BE IGNORED',
      allowed_tools: undefined,
    });
    const client = makeOkClient();
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [] });
    const ctx = await makeCtx({
      prompt: 'hi',
      subagent_def: 'test-def-2',
      system: 'EXPLICIT DATA OVERRIDE',
    });

    await handler(ctx);

    expect(systemText(client.calls[0]!)).toBe('EXPLICIT DATA OVERRIDE');
  });

  test('def.allowed_tools used when data.allowed_tools absent', async () => {
    pluginLoaderTesting._seedSubagentDef({
      plugin_name: 'test-plugin',
      name: 'test-def-3',
      source_path: '/tmp/test-def-3.md',
      frontmatter: {},
      body: 'sys',
      allowed_tools: ['alpha'],
    });
    const client = makeOkClient();
    const registry = [makeNoopTool('alpha'), makeNoopTool('beta'), makeNoopTool('gamma')];
    const handler = makeSubagentHandler({ engine, client, toolRegistry: registry });
    const ctx = await makeCtx({ prompt: 'hi', subagent_def: 'test-def-3' });

    await handler(ctx);

    expect(toolNames(client.calls[0]!)).toEqual(['alpha']);
  });

  test('data.allowed_tools fully overrides def.allowed_tools (data wins)', async () => {
    pluginLoaderTesting._seedSubagentDef({
      plugin_name: 'test-plugin',
      name: 'test-def-4',
      source_path: '/tmp/test-def-4.md',
      frontmatter: {},
      body: 'sys',
      allowed_tools: ['alpha'],
    });
    const client = makeOkClient();
    const registry = [makeNoopTool('alpha'), makeNoopTool('beta'), makeNoopTool('gamma')];
    const handler = makeSubagentHandler({ engine, client, toolRegistry: registry });
    const ctx = await makeCtx({
      prompt: 'hi',
      subagent_def: 'test-def-4',
      allowed_tools: ['beta'],
    });

    await handler(ctx);

    // Data wins fully: only beta (NOT alpha from def, NOT gamma from registry)
    expect(toolNames(client.calls[0]!)).toEqual(['beta']);
  });

  test('subagent_def names unknown def → warn + fall through to DEFAULT_SYSTEM + full registry', async () => {
    // Capture console.warn output
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));

    try {
      const client = makeOkClient();
      const registry = [makeNoopTool('alpha'), makeNoopTool('beta')];
      const handler = makeSubagentHandler({ engine, client, toolRegistry: registry });
      const ctx = await makeCtx({ prompt: 'hi', subagent_def: 'nonexistent-def' });

      // Must NOT throw — fail open
      const result = await handler(ctx);

      expect(result.stop_reason).toBe('end_turn');
      expect(systemText(client.calls[0]!)).toBe(DEFAULT_SYSTEM);
      expect(toolNames(client.calls[0]!).sort()).toEqual(['alpha', 'beta']);
      expect(warnings.some(w => /subagent_def 'nonexistent-def' not found/.test(w))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test('subagent_def absent → existing behavior unchanged (backward compat)', async () => {
    const client = makeOkClient();
    const registry = [makeNoopTool('alpha'), makeNoopTool('beta')];
    const handler = makeSubagentHandler({ engine, client, toolRegistry: registry });
    const ctx = await makeCtx({ prompt: 'hi' });

    await handler(ctx);

    expect(systemText(client.calls[0]!)).toBe(DEFAULT_SYSTEM);
    expect(toolNames(client.calls[0]!).sort()).toEqual(['alpha', 'beta']);
  });

  test('def.body empty/whitespace-only → treated as no body, falls to DEFAULT_SYSTEM', async () => {
    pluginLoaderTesting._seedSubagentDef({
      plugin_name: 'test-plugin',
      name: 'test-def-7',
      source_path: '/tmp/test-def-7.md',
      frontmatter: {},
      body: '   \n  \n',
      allowed_tools: undefined,
    });
    const client = makeOkClient();
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [] });
    const ctx = await makeCtx({ prompt: 'hi', subagent_def: 'test-def-7' });

    await handler(ctx);

    expect(systemText(client.calls[0]!)).toBe(DEFAULT_SYSTEM);
  });
});
