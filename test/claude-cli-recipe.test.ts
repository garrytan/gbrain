/**
 * Tests for the claude-cli LanguageModelV2 implementation that the
 * `claude-cli` recipe instantiates.
 *
 * Strategy: a POSIX shell stub at GBRAIN_CLAUDE_CLI_BIN emits scripted
 * --output-format json envelopes. Tests exercise the LanguageModelV2
 * doGenerate surface: text round trip, tool-call extraction (single +
 * multiple parallel), abort semantics, context-isolation flags. No
 * claude-cli installation or API credits required.
 *
 * Recipe registration is also smoke-tested: getRecipe('claude-cli')
 * returns a chat-only Recipe with the right model list.
 *
 * Env isolation: GBRAIN_CLAUDE_CLI_BIN is set per-test via withEnv(),
 * NOT in beforeAll. The provider reads the env var at spawn time so
 * withEnv's save/restore in try/finally is sufficient; no leakage to
 * sibling test files in the same bun-test process.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { withEnv } from './helpers/with-env.ts';

const stubDir = join(tmpdir(), `claude-cli-recipe-stub-${process.pid}`);
const stubBin = join(stubDir, 'claude');
const stubResponsePath = join(stubDir, 'claude_response.json');

beforeAll(() => {
  mkdirSync(stubDir, { recursive: true });
  const stub = [
    '#!/bin/sh',
    'cat > /dev/null',
    'case " $* " in',
    '  *" --print "*) ;;',
    '  *) echo "missing --print in argv: $*" >&2; exit 64 ;;',
    'esac',
    `cat "${stubResponsePath}"`,
  ].join('\n');
  writeFileSync(stubBin, stub);
  chmodSync(stubBin, 0o755);
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

function withStubEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_CLAUDE_CLI_BIN: stubBin }, fn);
}

function stageResponse(envelope: Record<string, unknown>): void {
  writeFileSync(stubResponsePath, JSON.stringify(envelope));
}

function baseEnvelope(result: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    stop_reason: 'end_turn',
    session_id: 'test-session',
    num_turns: 1,
    usage: {
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  };
}

function userMessage(text: string): LanguageModelV2CallOptions['prompt'][number] {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('claude-cli recipe registration', () => {
  test('getRecipe returns chat-only Recipe with the documented models', async () => {
    const { getRecipe } = await import('../src/core/ai/recipes/index.ts');
    const recipe = getRecipe('claude-cli');
    expect(recipe).toBeDefined();
    expect(recipe!.id).toBe('claude-cli');
    expect(recipe!.implementation).toBe('claude-cli');
    expect(recipe!.touchpoints.chat).toBeDefined();
    expect(recipe!.touchpoints.chat!.supports_tools).toBe(true);
    expect(recipe!.touchpoints.chat!.supports_subagent_loop).toBe(true);
    expect(recipe!.touchpoints.chat!.models).toContain('claude-sonnet-4-6');
    // Wave rider for #3976: pin the Claude 5 family the CLI already serves.
    expect(recipe!.touchpoints.chat!.models).toContain('claude-fable-5');
    expect(recipe!.touchpoints.chat!.models).toContain('claude-opus-5');
    expect(recipe!.touchpoints.chat!.models).toContain('claude-opus-4-8');
    expect(recipe!.touchpoints.chat!.models).toContain('claude-sonnet-5');
    expect(recipe!.touchpoints.embedding).toBeUndefined();
    expect(recipe!.touchpoints.expansion).toBeUndefined();
  });

  test('recipe aliases map short names to canonical model ids', async () => {
    const { getRecipe } = await import('../src/core/ai/recipes/index.ts');
    const recipe = getRecipe('claude-cli');
    expect(recipe!.aliases!['sonnet']).toBe('claude-sonnet-4-6');
    expect(recipe!.aliases!['haiku']).toBe('claude-haiku-4-5-20251001');
  });
});

describe('claude-cli LanguageModel — text-only round trip', () => {
  test('returns a single text content block with usage + stop finish reason', async () => {
    await withStubEnv(async () => {
      stageResponse(baseEnvelope('hello world'));
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const result = await model.doGenerate({
        prompt: [userMessage('hi')],
      } as LanguageModelV2CallOptions);

      expect(result.finishReason).toBe('stop');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: 'text', text: 'hello world' });
      expect(result.usage.inputTokens).toBe(12);
      expect(result.usage.outputTokens).toBe(34);
      // baseEnvelope's default cache_read_input_tokens is 0 (present, not
      // omitted) — pins "present zero" as distinct from the omitted/undefined
      // case covered below.
      expect(result.usage.cachedInputTokens).toBe(0);
    });
  });

  test('maps cache_read_input_tokens onto usage.cachedInputTokens', async () => {
    await withStubEnv(async () => {
      stageResponse(
        baseEnvelope('hello world', {
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            cache_read_input_tokens: 9001,
            cache_creation_input_tokens: 0,
          },
        }),
      );
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const result = await model.doGenerate({
        prompt: [userMessage('hi')],
      } as LanguageModelV2CallOptions);

      expect(result.usage.cachedInputTokens).toBe(9001);
    });
  });

  test('leaves usage.cachedInputTokens undefined when the CLI omits cache_read_input_tokens', async () => {
    await withStubEnv(async () => {
      stageResponse({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'hello world',
        stop_reason: 'end_turn',
        session_id: 'test-session',
        num_turns: 1,
        usage: { input_tokens: 12, output_tokens: 34 },
      });
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const result = await model.doGenerate({
        prompt: [userMessage('hi')],
      } as LanguageModelV2CallOptions);

      expect(result.usage.cachedInputTokens).toBeUndefined();
    });
  });

  test('strips provider prefixes from the model id', async () => {
    const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
    const model = new ClaudeCliLanguageModel('anthropic:claude-sonnet-4-6');
    expect(model.modelId).toBe('claude-sonnet-4-6');
  });
});

describe('claude-cli LanguageModel — tool use', () => {
  test('parses <use_tools> block into LanguageModelV2 tool-call content', async () => {
    await withStubEnv(async () => {
      stageResponse(
        baseEnvelope(
          [
            'I will look up the pattern first.',
            '<use_tools>',
            '[{"id": "toolu_01ABC", "name": "search", "input": {"query": "n+1 query"}}]',
            '</use_tools>',
          ].join('\n'),
        ),
      );
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const result = await model.doGenerate({
        prompt: [userMessage('find n+1 queries')],
        tools: [
          {
            type: 'function',
            name: 'search',
            description: 'Search the brain',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      } as LanguageModelV2CallOptions);

      expect(result.finishReason).toBe('tool-calls');
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toMatchObject({ type: 'text', text: 'I will look up the pattern first.' });
      // #4155: the model-supplied id is NEVER trusted for uniqueness — gbrain
      // mints its own (the subprocess has no cross-turn memory and repeats
      // short ids like toolu_01, violating uniq_subagent_tools_use_id).
      expect(result.content[1]).toMatchObject({
        type: 'tool-call',
        toolName: 'search',
        input: '{"query":"n+1 query"}',
      });
      // #4155: a stray model-supplied id (older cached behavior — the prompt
      // no longer asks for one) is tolerated but IGNORED; the id is minted.
      const call = result.content[1] as { toolCallId: string };
      expect(call.toolCallId).toMatch(/^toolu_claude_cli_/);
      expect(call.toolCallId).not.toBe('toolu_01ABC');
    });
  });

  test('repeated model-supplied ids across turns mint DISTINCT ids (#4155)', async () => {
    // Two doGenerate calls (fresh subprocess each) both emit `toolu_01` —
    // exactly the production collision that dead-lettered dream patterns jobs.
    await withStubEnv(async () => {
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const block = [
        '<use_tools>',
        '[{"id": "toolu_01", "name": "search", "input": {"q": "a"}}]',
        '</use_tools>',
      ].join('\n');
      const tools = [{ type: 'function', name: 'search', description: '', inputSchema: { type: 'object', properties: {} } }];

      stageResponse(baseEnvelope(block));
      const r1 = await new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate({
        prompt: [userMessage('turn 1')], tools,
      } as LanguageModelV2CallOptions);
      stageResponse(baseEnvelope(block));
      const r2 = await new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate({
        prompt: [userMessage('turn 2')], tools,
      } as LanguageModelV2CallOptions);

      const id1 = (r1.content.find(c => c.type === 'tool-call') as { toolCallId: string }).toolCallId;
      const id2 = (r2.content.find(c => c.type === 'tool-call') as { toolCallId: string }).toolCallId;
      expect(id1).not.toBe(id2);
    });
  });

  test('duplicate ids WITHIN one <use_tools> block mint distinct ids (#4155)', async () => {
    await withStubEnv(async () => {
      stageResponse(
        baseEnvelope(
          [
            '<use_tools>',
            '[',
            '  {"id": "toolu_01", "name": "search", "input": {"q": "a"}},',
            '  {"id": "toolu_01", "name": "get_page", "input": {"slug": "x"}}',
            ']',
            '</use_tools>',
          ].join('\n'),
        ),
      );
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const result = await model.doGenerate({
        prompt: [userMessage('dup ids')],
        tools: [
          { type: 'function', name: 'search', description: '', inputSchema: { type: 'object', properties: {} } },
          { type: 'function', name: 'get_page', description: '', inputSchema: { type: 'object', properties: {} } },
        ],
      } as LanguageModelV2CallOptions);
      const ids = result.content
        .filter(c => c.type === 'tool-call')
        .map(c => (c as { toolCallId: string }).toolCallId);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    });
  });

  test('#4155: mints a fresh id per call — two identical envelopes yield distinct ids', async () => {
    await withStubEnv(async () => {
      const envelope = baseEnvelope(
        [
          '<use_tools>',
          '[{"id": "toolu_01", "name": "search", "input": {"query": "same"}}]',
          '</use_tools>',
        ].join('\n'),
      );
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const opts = {
        prompt: [userMessage('turn one')],
        tools: [
          {
            type: 'function',
            name: 'search',
            description: 'Search the brain',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      } as LanguageModelV2CallOptions;

      stageResponse(envelope);
      const first = await model.doGenerate(opts);
      stageResponse(envelope);
      const second = await model.doGenerate(opts);

      const id1 = (first.content.find(c => c.type === 'tool-call') as { toolCallId: string }).toolCallId;
      const id2 = (second.content.find(c => c.type === 'tool-call') as { toolCallId: string }).toolCallId;
      // The model repeated toolu_01 both turns (it structurally cannot avoid
      // repeating: fresh subprocess + id-stripped replay). The adapter must
      // still produce unique ids — this repetition is what dead-lettered
      // dream patterns jobs pre-fix.
      expect(id1).toMatch(/^toolu_claude_cli_/);
      expect(id2).toMatch(/^toolu_claude_cli_/);
      expect(id1).not.toBe(id2);
    });
  });

  test('#4155: prompt protocol no longer asks the model to invent an id (source-shape pin)', () => {
    // The stub harness cannot capture argv, so pin the protocol template at
    // the source level (same style as the repo's other source-shape guards):
    // asking the model for "a unique id" is structurally unsatisfiable — a
    // fresh subprocess replayed from an id-stripped transcript cannot avoid
    // repeats, which is exactly what collided real dream jobs to death.
    const src = readFileSync(
      new URL('../src/core/ai/providers/claude-cli-language-model.ts', import.meta.url).pathname,
      'utf-8',
    );
    expect(src).toContain('{"name": "<tool name>", "input":');
    expect(src).not.toContain('unique tool call id');
    expect(src).not.toContain('toolu_01ABC');
    // The unconditional mint is present and model ids are never trusted.
    expect(src).toMatch(/const id = `toolu_claude_cli_\$\{randomUUIDv7\(\)\}`/);
  });

  test('parses multiple parallel tool calls in a single block', async () => {
    await withStubEnv(async () => {
      stageResponse(
        baseEnvelope(
          [
            '<use_tools>',
            '[',
            '  {"id": "toolu_A", "name": "search", "input": {"query": "foo"}},',
            '  {"id": "toolu_B", "name": "get_page", "input": {"slug": "areas/x"}}',
            ']',
            '</use_tools>',
          ].join('\n'),
        ),
      );
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const result = await model.doGenerate({
        prompt: [userMessage('multi')],
        tools: [
          { type: 'function', name: 'search', description: 's', inputSchema: { type: 'object', properties: {} } },
          { type: 'function', name: 'get_page', description: 'g', inputSchema: { type: 'object', properties: {} } },
        ],
      } as LanguageModelV2CallOptions);

      const calls = result.content.filter(c => c.type === 'tool-call');
      expect(calls).toHaveLength(2);
      expect(calls.map(c => (c as { toolName: string }).toolName)).toEqual(['search', 'get_page']);
      expect(result.finishReason).toBe('tool-calls');
    });
  });

  test('tolerates fenced JSON inside <use_tools>', async () => {
    await withStubEnv(async () => {
      stageResponse(
        baseEnvelope(
          [
            '<use_tools>',
            '```json',
            '[{"id": "toolu_F", "name": "search", "input": {"q": "x"}}]',
            '```',
            '</use_tools>',
          ].join('\n'),
        ),
      );
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const result = await model.doGenerate({
        prompt: [userMessage('fenced')],
        tools: [{ type: 'function', name: 'search', description: '', inputSchema: { type: 'object', properties: {} } }],
      } as LanguageModelV2CallOptions);

      const calls = result.content.filter(c => c.type === 'tool-call');
      expect(calls).toHaveLength(1);
    });
  });

  test('synthesizes an id when the model omits it', async () => {
    await withStubEnv(async () => {
      stageResponse(
        baseEnvelope(
          [
            '<use_tools>',
            '[{"name": "search", "input": {"q": "x"}}]',
            '</use_tools>',
          ].join('\n'),
        ),
      );
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const result = await model.doGenerate({
        prompt: [userMessage('no id')],
        tools: [{ type: 'function', name: 'search', description: '', inputSchema: { type: 'object', properties: {} } }],
      } as LanguageModelV2CallOptions);

      const call = result.content.find(c => c.type === 'tool-call') as { toolCallId: string } | undefined;
      expect(call).toBeDefined();
      expect(call!.toolCallId).toMatch(/^toolu_claude_cli_/);
    });
  });

  test('falls back to text on malformed JSON', async () => {
    await withStubEnv(async () => {
      stageResponse(
        baseEnvelope(
          [
            '<use_tools>',
            'not valid json',
            '</use_tools>',
          ].join('\n'),
        ),
      );
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const result = await model.doGenerate({
        prompt: [userMessage('malformed')],
        tools: [{ type: 'function', name: 'search', description: '', inputSchema: { type: 'object', properties: {} } }],
      } as LanguageModelV2CallOptions);

      expect(result.content.filter(c => c.type === 'tool-call')).toHaveLength(0);
      expect(result.finishReason).toBe('stop');
    });
  });

  test('returns text-only stop when tools are offered but model declines to call any', async () => {
    // Real-world case: the model decides the user's request does not require
    // a tool call, ignores the use_tools protocol, and answers directly.
    // The recipe still must return clean LanguageModelV2 output so the
    // caller (gateway.toolLoop) can treat the text as the final answer
    // rather than wedge waiting for tool calls that never come.
    await withStubEnv(async () => {
      stageResponse(
        baseEnvelope(
          'I do not actually need to call any tools for this. The answer is 42.',
          { stop_reason: 'end_turn' },
        ),
      );
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const result = await model.doGenerate({
        prompt: [userMessage('what is the meaning of life? you may use tools but do not need to')],
        tools: [{ type: 'function', name: 'compute', description: 'Compute things', inputSchema: { type: 'object', properties: {} } }],
      } as LanguageModelV2CallOptions);

      // No tool-call content blocks; caller treats this as a final answer.
      expect(result.content.filter(c => c.type === 'tool-call')).toHaveLength(0);
      // Text block present with the full model reply.
      const textBlocks = result.content.filter(c => c.type === 'text');
      expect(textBlocks).toHaveLength(1);
      expect((textBlocks[0] as { text: string }).text).toContain('42');
      // finishReason 'stop' tells the gateway-loop this is terminal output,
      // not a partial mid-tool-loop state.
      expect(result.finishReason).toBe('stop');
    });
  });

  test('drops the block when the close tag is missing', async () => {
    await withStubEnv(async () => {
      stageResponse(
        baseEnvelope(
          [
            '<use_tools>',
            '[{"id": "toolu_X", "name": "search", "input": {}}',
          ].join('\n'),
        ),
      );
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const result = await model.doGenerate({
        prompt: [userMessage('unterminated')],
        tools: [{ type: 'function', name: 'search', description: '', inputSchema: { type: 'object', properties: {} } }],
      } as LanguageModelV2CallOptions);

      expect(result.content.filter(c => c.type === 'tool-call')).toHaveLength(0);
      expect(result.finishReason).toBe('stop');
    });
  });
});

describe('claude-cli LanguageModel — context isolation', () => {
  test('argv includes --disable-slash-commands + --system-prompt and cwd is the dedicated tmpdir', async () => {
    await withStubEnv(async () => {
      const argvLog = join(stubDir, 'argv.log');
      const cwdLog = join(stubDir, 'cwd.log');
      const recordStub = [
        '#!/bin/sh',
        `printf "%s\\n" "$@" > "${argvLog}"`,
        `pwd > "${cwdLog}"`,
        'cat > /dev/null',
        `cat "${stubResponsePath}"`,
      ].join('\n');
      writeFileSync(stubBin, recordStub);
      chmodSync(stubBin, 0o755);
      stageResponse(baseEnvelope('ok'));

      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      await model.doGenerate({
        prompt: [
          { role: 'system', content: 'You are gbrain subagent.' },
          userMessage('hi'),
        ],
      } as LanguageModelV2CallOptions);

      const fs = require('node:fs');
      const argv = fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
      const cwd = fs.readFileSync(cwdLog, 'utf8').trim();

      expect(argv).toContain('--print');
      expect(argv).toContain('--output-format');
      expect(argv).toContain('json');
      expect(argv).toContain('--disable-slash-commands');
      // Agent-isolation hardening: no built-in tools, no inherited MCP servers.
      expect(argv).toContain('--tools');
      expect(argv).toContain('--strict-mcp-config');
      expect(argv).toContain('--system-prompt');
      expect(argv).toContain('You are gbrain subagent.');
      expect(cwd).toMatch(/gbrain-claude-cli-cwd-\d+$/);

      const fastStub = [
        '#!/bin/sh',
        'cat > /dev/null',
        `cat "${stubResponsePath}"`,
      ].join('\n');
      writeFileSync(stubBin, fastStub);
      chmodSync(stubBin, 0o755);
    });
  });

  test('scrubs ANTHROPIC_* credentials and cloud-auth backend switches from the child env (subscription-only auth)', async () => {
    await withStubEnv(async () => {
      await withEnv(
        {
          ANTHROPIC_API_KEY: 'sk-should-never-leak',
          ANTHROPIC_AUTH_TOKEN: 'tok-should-never-leak',
          ANTHROPIC_BASE_URL: 'https://proxy.should.never.leak',
          CLAUDE_CODE_USE_BEDROCK: '1',
          CLAUDE_CODE_USE_VERTEX: '1',
          CLAUDE_CODE_USE_MANTLE: '1',
          CLAUDE_CODE_USE_FOUNDRY: '1',
          CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
        },
        async () => {
          const envLog = join(stubDir, 'env.log');
          const envStub = [
            '#!/bin/sh',
            `printf "key=%s\\ntoken=%s\\nbase=%s\\nbedrock=%s\\nvertex=%s\\nmantle=%s\\nfoundry=%s\\nanthropicAws=%s\\n" "\${ANTHROPIC_API_KEY:-UNSET}" "\${ANTHROPIC_AUTH_TOKEN:-UNSET}" "\${ANTHROPIC_BASE_URL:-UNSET}" "\${CLAUDE_CODE_USE_BEDROCK:-UNSET}" "\${CLAUDE_CODE_USE_VERTEX:-UNSET}" "\${CLAUDE_CODE_USE_MANTLE:-UNSET}" "\${CLAUDE_CODE_USE_FOUNDRY:-UNSET}" "\${CLAUDE_CODE_USE_ANTHROPIC_AWS:-UNSET}" > "${envLog}"`,
            'cat > /dev/null',
            `cat "${stubResponsePath}"`,
          ].join('\n');
          writeFileSync(stubBin, envStub);
          chmodSync(stubBin, 0o755);
          stageResponse(baseEnvelope('ok'));

          try {
            const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
            const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
            await model.doGenerate({
              prompt: [userMessage('hi')],
            } as LanguageModelV2CallOptions);

            const fs = require('node:fs');
            const seen = fs.readFileSync(envLog, 'utf8');
            expect(seen).toContain('key=UNSET');
            expect(seen).toContain('token=UNSET');
            expect(seen).toContain('base=UNSET');
            expect(seen).toContain('bedrock=UNSET');
            expect(seen).toContain('vertex=UNSET');
            expect(seen).toContain('mantle=UNSET');
            expect(seen).toContain('foundry=UNSET');
            expect(seen).toContain('anthropicAws=UNSET');
          } finally {
            const fastStub = [
              '#!/bin/sh',
              'cat > /dev/null',
              `cat "${stubResponsePath}"`,
            ].join('\n');
            writeFileSync(stubBin, fastStub);
            chmodSync(stubBin, 0o755);
          }
        },
      );
    });
  });
});

describe('claude-cli LanguageModel — abort + error envelopes', () => {
  test('SIGTERMs the child on AbortSignal', async () => {
    await withStubEnv(async () => {
      const slowStub = [
        '#!/bin/sh',
        'cat > /dev/null',
        'sleep 30',
        'echo "{}"',
      ].join('\n');
      writeFileSync(stubBin, slowStub);
      chmodSync(stubBin, 0o755);
      try {
        const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
        const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
        const ac = new AbortController();
        const promise = model.doGenerate({
          prompt: [userMessage('slow')],
          abortSignal: ac.signal,
        } as LanguageModelV2CallOptions);
        setTimeout(() => ac.abort(), 30);
        await expect(promise).rejects.toThrow(/aborted/);
      } finally {
        const fastStub = [
          '#!/bin/sh',
          'cat > /dev/null',
          `cat "${stubResponsePath}"`,
        ].join('\n');
        writeFileSync(stubBin, fastStub);
        chmodSync(stubBin, 0o755);
      }
    });
  });

  test('non-zero exit with a result envelope on stdout surfaces a typed API error', async () => {
    // Real-world shape: on an API 429 (spend/rate limit) the CLI exits 1 but
    // still writes the formatted result envelope to stdout. The provider must
    // surface the status + human-readable message, not a raw blob.
    await withStubEnv(async () => {
      stageResponse(baseEnvelope(
        "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
        { is_error: true, api_error_status: 429 },
      ));
      const failStub = [
        '#!/bin/sh',
        'cat > /dev/null',
        `cat "${stubResponsePath}"`,
        'exit 1',
      ].join('\n');
      writeFileSync(stubBin, failStub);
      chmodSync(stubBin, 0o755);
      try {
        const { ClaudeCliLanguageModel, ClaudeCliProcessError } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
        const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
        let caught: unknown;
        try {
          await model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ClaudeCliProcessError);
        const err = caught as InstanceType<typeof ClaudeCliProcessError>;
        expect(err.message).toMatch(/claude-cli API error 429/);
        expect(err.message).toContain('monthly spend limit');
        expect(err.apiErrorStatus).toBe(429);
        expect(err.exitCode).toBe(1);
      } finally {
        const fastStub = [
          '#!/bin/sh',
          'cat > /dev/null',
          `cat "${stubResponsePath}"`,
        ].join('\n');
        writeFileSync(stubBin, fastStub);
        chmodSync(stubBin, 0o755);
      }
    });
  });

  test('non-zero exit with non-JSON stdout falls back to the raw blob message', async () => {
    await withStubEnv(async () => {
      writeFileSync(stubResponsePath, 'segfault-ish garbage output');
      const failStub = [
        '#!/bin/sh',
        'cat > /dev/null',
        `cat "${stubResponsePath}"`,
        'exit 1',
      ].join('\n');
      writeFileSync(stubBin, failStub);
      chmodSync(stubBin, 0o755);
      try {
        const { ClaudeCliLanguageModel, ClaudeCliProcessError } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
        const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
        let caught: unknown;
        try {
          await model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ClaudeCliProcessError);
        const err = caught as InstanceType<typeof ClaudeCliProcessError>;
        expect(err.message).toMatch(/claude-cli exited 1/);
        expect(err.message).toContain('segfault-ish garbage output');
        expect(err.apiErrorStatus).toBeUndefined();
        expect(err.exitCode).toBe(1);
      } finally {
        const fastStub = [
          '#!/bin/sh',
          'cat > /dev/null',
          `cat "${stubResponsePath}"`,
        ].join('\n');
        writeFileSync(stubBin, fastStub);
        chmodSync(stubBin, 0o755);
      }
    });
  });

  test('non-zero exit with a SUCCESS envelope falls back to the blob message with stderr', async () => {
    // A crash after a successful API turn (envelope written, then the CLI
    // dies) is a process failure, not an API error: the envelope path must
    // require is_error, and the blob fallback must keep stderr (where the
    // crash reason lives) instead of reporting a misleading API success.
    await withStubEnv(async () => {
      stageResponse(baseEnvelope('the model answered fine'));
      const failStub = [
        '#!/bin/sh',
        'cat > /dev/null',
        `cat "${stubResponsePath}"`,
        'echo "boom-from-stderr" >&2',
        'exit 1',
      ].join('\n');
      writeFileSync(stubBin, failStub);
      chmodSync(stubBin, 0o755);
      try {
        const { ClaudeCliLanguageModel, ClaudeCliProcessError } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
        const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
        let caught: unknown;
        try {
          await model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ClaudeCliProcessError);
        const err = caught as InstanceType<typeof ClaudeCliProcessError>;
        expect(err.message).toMatch(/claude-cli exited 1/);
        expect(err.message).toContain('boom-from-stderr');
        expect(err.apiErrorStatus).toBeUndefined();
        expect(err.exitCode).toBe(1);
      } finally {
        const fastStub = [
          '#!/bin/sh',
          'cat > /dev/null',
          `cat "${stubResponsePath}"`,
        ].join('\n');
        writeFileSync(stubBin, fastStub);
        chmodSync(stubBin, 0o755);
      }
    });
  });

  test('non-zero exit keeps the raw blob behind a --- raw --- marker (auth-looking stdout never classifies)', async () => {
    // The blob can carry model/page-derived text; classifyGlobalLlmError's
    // phrase regexes only scan text before the marker, so an essay
    // mentioning api keys in stdout must not read as a whole-run auth
    // outage.
    await withStubEnv(async () => {
      writeFileSync(stubResponsePath, 'essay draft: invalid x-api-key handling and rate limit tips');
      const failStub = [
        '#!/bin/sh',
        'cat > /dev/null',
        `cat "${stubResponsePath}"`,
        'exit 1',
      ].join('\n');
      writeFileSync(stubBin, failStub);
      chmodSync(stubBin, 0o755);
      try {
        const { ClaudeCliLanguageModel, ClaudeCliProcessError } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
        const { classifyGlobalLlmError } = await import('../src/core/ai/errors.ts');
        const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
        let caught: unknown;
        try {
          await model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ClaudeCliProcessError);
        const err = caught as InstanceType<typeof ClaudeCliProcessError>;
        expect(err.message).toMatch(/claude-cli exited 1/);
        expect(err.message).toContain('--- raw ---');
        // The blob sits AFTER the marker, so the phrase never classifies.
        expect(err.message.indexOf('--- raw ---')).toBeLessThan(err.message.indexOf('invalid x-api-key'));
        expect(classifyGlobalLlmError(err)).toBeNull();
      } finally {
        const fastStub = [
          '#!/bin/sh',
          'cat > /dev/null',
          `cat "${stubResponsePath}"`,
        ].join('\n');
        writeFileSync(stubBin, fastStub);
        chmodSync(stubBin, 0o755);
      }
    });
  });

  test('exit 0 with a JSON primitive on stdout rejects instead of crashing', async () => {
    // JSON.parse accepts bare primitives (null / numbers / strings); none of
    // them is a result envelope. Each must reject through the promise, never
    // throw inside the close callback.
    await withStubEnv(async () => {
      for (const raw of ['null', '42', '"str"']) {
        writeFileSync(stubResponsePath, raw);
        const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
        const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
        await expect(
          model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions),
        ).rejects.toThrow(/claude-cli output not JSON/);
      }
    });
  });

  test('exit 0 + is_error + api_error_status surfaces the same typed API error', async () => {
    await withStubEnv(async () => {
      stageResponse({
        ...baseEnvelope('overloaded, please retry'),
        is_error: true,
        api_error_status: 529,
      });
      const { ClaudeCliLanguageModel, ClaudeCliProcessError } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      let caught: unknown;
      try {
        await model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ClaudeCliProcessError);
      const err = caught as InstanceType<typeof ClaudeCliProcessError>;
      expect(err.message).toMatch(/claude-cli API error 529/);
      expect(err.message).toContain('overloaded');
      expect(err.apiErrorStatus).toBe(529);
      expect(err.exitCode).toBe(0);
    });
  });

  test('rejects when stub reports is_error: true', async () => {
    await withStubEnv(async () => {
      stageResponse({ ...baseEnvelope('boom'), is_error: true });
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      await expect(
        model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions),
      ).rejects.toThrow(/claude-cli reported error/);
    });
  });

  test('rejects on non-JSON output', async () => {
    await withStubEnv(async () => {
      writeFileSync(stubResponsePath, 'this is not json');
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      await expect(
        model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions),
      ).rejects.toThrow(/claude-cli output not JSON/);
    });
  });

  test('accepts a verbose-mode JSON event array and picks the result event', async () => {
    // With `"verbose": true` in ~/.claude/settings.json the CLI emits an array
    // of events instead of the bare result object (no CLI flag disables it).
    await withStubEnv(async () => {
      writeFileSync(
        stubResponsePath,
        JSON.stringify([
          { type: 'system', subtype: 'init', session_id: 'test-session', tools: [], mcp_servers: [] },
          baseEnvelope('hello from array'),
        ]),
      );
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      const result = await model.doGenerate({
        prompt: [userMessage('hi')],
      } as LanguageModelV2CallOptions);
      expect(result.finishReason).toBe('stop');
      expect(result.content[0]).toEqual({ type: 'text', text: 'hello from array' });
    });
  });

  test('rejects a verbose-mode event array that lacks a result event', async () => {
    // Verbose mode emits an event array; a truncated stream (or one carrying
    // only init/system events) has no result event to unwrap.
    await withStubEnv(async () => {
      writeFileSync(
        stubResponsePath,
        JSON.stringify([
          { type: 'system', subtype: 'init', session_id: 'test-session', tools: [], mcp_servers: [] },
          { type: 'assistant', message: { role: 'assistant', content: [] } },
        ]),
      );
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      await expect(
        model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions),
      ).rejects.toThrow(/had no "result" event/);
    });
  });

  test('rejects cleanly when the claude binary is missing (no worker crash)', async () => {
    // A missing binary must surface as a rejected promise via the spawn 'error'
    // handler; the child stdin 'error' (EPIPE) handler swallows the pipe failure
    // so it never escalates to an unhandled rejection that would down the worker.
    await withEnv({ GBRAIN_CLAUDE_CLI_BIN: join(stubDir, 'nonexistent-claude') }, async () => {
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
      await expect(
        model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions),
      ).rejects.toThrow(/claude-cli spawn failed/);
    });
  });

  test('doStream throws not-supported', async () => {
    const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
    const model = new ClaudeCliLanguageModel('claude-sonnet-4-6');
    await expect(model.doStream()).rejects.toThrow(/does not support streaming/);
  });
});
