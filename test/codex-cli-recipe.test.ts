/**
 * Tests for the codex-cli LanguageModelV2 implementation that the
 * `codex-cli` recipe instantiates.
 *
 * Strategy: a POSIX shell stub at GBRAIN_CODEX_CLI_BIN emits a scripted
 * final message into the `-o <file>` argument, mirroring `codex exec`'s
 * output channel. Tests exercise the LanguageModelV2 doGenerate surface:
 * text round trip, tool-call extraction (single + multiple parallel),
 * abort semantics, context-isolation flags. No Codex CLI installation or
 * subscription required.
 *
 * Recipe registration is also smoke-tested: getRecipe('codex-cli')
 * returns a chat-only Recipe with the right model list.
 *
 * Env isolation: GBRAIN_CODEX_CLI_BIN is set per-test via withEnv(),
 * NOT in beforeAll. The provider reads the env var at spawn time so
 * withEnv's save/restore in try/finally is sufficient; no leakage to
 * sibling test files in the same bun-test process.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { withEnv } from './helpers/with-env.ts';

const stubDir = join(tmpdir(), `codex-cli-recipe-stub-${process.pid}`);
const stubBin = join(stubDir, 'codex');
const stubResponsePath = join(stubDir, 'codex_response.txt');

/**
 * Default stub: consume stdin, require the `exec` subcommand, find the
 * argument after `-o`, and copy the staged response there — the same
 * channel `codex exec -o <file>` uses for the final agent message.
 */
function fastStubScript(): string {
  return [
    '#!/bin/sh',
    'cat > /dev/null',
    'case " $* " in',
    '  *" exec "*|"exec "*) ;;',
    '  *) echo "missing exec subcommand in argv: $*" >&2; exit 64 ;;',
    'esac',
    'out=""',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "-o" ]; then out="$a"; fi',
    '  prev="$a"',
    'done',
    'if [ -z "$out" ]; then echo "missing -o <file> in argv: $*" >&2; exit 65; fi',
    `cat "${stubResponsePath}" > "$out"`,
  ].join('\n');
}

beforeAll(() => {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(stubBin, fastStubScript());
  chmodSync(stubBin, 0o755);
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

function withStubEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_CODEX_CLI_BIN: stubBin }, fn);
}

function stageResponse(text: string): void {
  writeFileSync(stubResponsePath, text);
}

function restoreFastStub(): void {
  writeFileSync(stubBin, fastStubScript());
  chmodSync(stubBin, 0o755);
}

function userMessage(text: string): LanguageModelV2CallOptions['prompt'][number] {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('codex-cli recipe registration', () => {
  test('getRecipe returns chat-only Recipe with the documented models', async () => {
    const { getRecipe } = await import('../src/core/ai/recipes/index.ts');
    const recipe = getRecipe('codex-cli');
    expect(recipe).toBeDefined();
    expect(recipe!.id).toBe('codex-cli');
    expect(recipe!.implementation).toBe('codex-cli');
    expect(recipe!.touchpoints.chat).toBeDefined();
    expect(recipe!.touchpoints.chat!.supports_tools).toBe(true);
    expect(recipe!.touchpoints.chat!.supports_subagent_loop).toBe(true);
    expect(recipe!.touchpoints.chat!.models).toContain('gpt-5.6-terra');
    expect(recipe!.touchpoints.embedding).toBeUndefined();
    expect(recipe!.touchpoints.expansion).toBeUndefined();
  });

  test('recipe aliases map short names to canonical model ids', async () => {
    const { getRecipe } = await import('../src/core/ai/recipes/index.ts');
    const recipe = getRecipe('codex-cli');
    expect(recipe!.aliases!['terra']).toBe('gpt-5.6-terra');
    expect(recipe!.aliases!['sol']).toBe('gpt-5.6-sol');
  });
});

describe('codex-cli LanguageModel — text-only round trip', () => {
  test('returns a single text content block with stop finish reason and undefined usage', async () => {
    await withStubEnv(async () => {
      stageResponse('hello world');
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const model = new CodexCliLanguageModel('gpt-5.6-terra');
      const result = await model.doGenerate({
        prompt: [userMessage('hi')],
      } as LanguageModelV2CallOptions);

      expect(result.finishReason).toBe('stop');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: 'text', text: 'hello world' });
      // The -o channel carries no token accounting; usage is honest-undefined.
      expect(result.usage.inputTokens).toBeUndefined();
      expect(result.usage.outputTokens).toBeUndefined();
    });
  });

  test('strips provider prefixes from the model id', async () => {
    const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    const model = new CodexCliLanguageModel('codex-cli:gpt-5.6-terra');
    expect(model.modelId).toBe('gpt-5.6-terra');
  });
});

describe('codex-cli LanguageModel — tool use', () => {
  test('parses <use_tools> block into LanguageModelV2 tool-call content', async () => {
    await withStubEnv(async () => {
      stageResponse(
        [
          'I will look up the pattern first.',
          '<use_tools>',
          '[{"id": "toolu_01ABC", "name": "search", "input": {"query": "n+1 query"}}]',
          '</use_tools>',
        ].join('\n'),
      );
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const model = new CodexCliLanguageModel('gpt-5.6-terra');
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
      expect(result.content[1]).toMatchObject({
        type: 'tool-call',
        toolCallId: 'toolu_01ABC',
        toolName: 'search',
        input: '{"query":"n+1 query"}',
      });
    });
  });

  test('parses multiple parallel tool calls in a single block', async () => {
    await withStubEnv(async () => {
      stageResponse(
        [
          '<use_tools>',
          '[',
          '  {"id": "toolu_A", "name": "search", "input": {"query": "foo"}},',
          '  {"id": "toolu_B", "name": "get_page", "input": {"slug": "areas/x"}}',
          ']',
          '</use_tools>',
        ].join('\n'),
      );
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const model = new CodexCliLanguageModel('gpt-5.6-terra');
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
        [
          '<use_tools>',
          '```json',
          '[{"id": "toolu_F", "name": "search", "input": {"q": "x"}}]',
          '```',
          '</use_tools>',
        ].join('\n'),
      );
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const model = new CodexCliLanguageModel('gpt-5.6-terra');
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
        [
          '<use_tools>',
          '[{"name": "search", "input": {"q": "x"}}]',
          '</use_tools>',
        ].join('\n'),
      );
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const model = new CodexCliLanguageModel('gpt-5.6-terra');
      const result = await model.doGenerate({
        prompt: [userMessage('no id')],
        tools: [{ type: 'function', name: 'search', description: '', inputSchema: { type: 'object', properties: {} } }],
      } as LanguageModelV2CallOptions);

      const call = result.content.find(c => c.type === 'tool-call') as { toolCallId: string } | undefined;
      expect(call).toBeDefined();
      expect(call!.toolCallId).toMatch(/^toolu_codex_cli_/);
    });
  });

  test('falls back to text on malformed JSON', async () => {
    await withStubEnv(async () => {
      stageResponse(
        [
          '<use_tools>',
          'not valid json',
          '</use_tools>',
        ].join('\n'),
      );
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const model = new CodexCliLanguageModel('gpt-5.6-terra');
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
      stageResponse('I do not actually need to call any tools for this. The answer is 42.');
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const model = new CodexCliLanguageModel('gpt-5.6-terra');
      const result = await model.doGenerate({
        prompt: [userMessage('what is the meaning of life? you may use tools but do not need to')],
        tools: [{ type: 'function', name: 'compute', description: 'Compute things', inputSchema: { type: 'object', properties: {} } }],
      } as LanguageModelV2CallOptions);

      expect(result.content.filter(c => c.type === 'tool-call')).toHaveLength(0);
      const textBlocks = result.content.filter(c => c.type === 'text');
      expect(textBlocks).toHaveLength(1);
      expect((textBlocks[0] as { text: string }).text).toContain('42');
      expect(result.finishReason).toBe('stop');
    });
  });

  test('drops the block when the close tag is missing', async () => {
    await withStubEnv(async () => {
      stageResponse(
        [
          '<use_tools>',
          '[{"id": "toolu_X", "name": "search", "input": {}}',
        ].join('\n'),
      );
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const model = new CodexCliLanguageModel('gpt-5.6-terra');
      const result = await model.doGenerate({
        prompt: [userMessage('unterminated')],
        tools: [{ type: 'function', name: 'search', description: '', inputSchema: { type: 'object', properties: {} } }],
      } as LanguageModelV2CallOptions);

      expect(result.content.filter(c => c.type === 'tool-call')).toHaveLength(0);
      expect(result.finishReason).toBe('stop');
    });
  });
});

describe('codex-cli LanguageModel — context isolation', () => {
  test('argv carries the isolation flags, stdin marker, and system section; cwd is the dedicated tmpdir', async () => {
    await withStubEnv(async () => {
      const argvLog = join(stubDir, 'argv.log');
      const cwdLog = join(stubDir, 'cwd.log');
      const stdinLog = join(stubDir, 'stdin.log');
      const recordStub = [
        '#!/bin/sh',
        `printf "%s\\n" "$@" > "${argvLog}"`,
        `pwd > "${cwdLog}"`,
        `cat > "${stdinLog}"`,
        'out=""',
        'prev=""',
        'for a in "$@"; do',
        '  if [ "$prev" = "-o" ]; then out="$a"; fi',
        '  prev="$a"',
        'done',
        `cat "${stubResponsePath}" > "$out"`,
      ].join('\n');
      writeFileSync(stubBin, recordStub);
      chmodSync(stubBin, 0o755);
      stageResponse('ok');

      try {
        const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
        const model = new CodexCliLanguageModel('gpt-5.6-terra');
        await model.doGenerate({
          prompt: [
            { role: 'system', content: 'You are gbrain subagent.' },
            userMessage('hi'),
          ],
        } as LanguageModelV2CallOptions);

        const fs = require('node:fs');
        const argv = fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
        const cwd = fs.readFileSync(cwdLog, 'utf8').trim();
        const stdin = fs.readFileSync(stdinLog, 'utf8');

        expect(argv[0]).toBe('exec');
        // Agent-isolation hardening: no user config (MCP servers, model
        // defaults), read-only sandbox, clean cwd, no repo probe.
        expect(argv).toContain('--ignore-user-config');
        expect(argv).toContain('--sandbox');
        expect(argv).toContain('read-only');
        expect(argv).toContain('--skip-git-repo-check');
        expect(argv).toContain('-m');
        expect(argv).toContain('gpt-5.6-terra');
        // Prompt arrives on stdin (argv has a hard size ceiling).
        expect(argv[argv.length - 1]).toBe('-');
        expect(cwd).toMatch(/gbrain-codex-cli-cwd-\d+$/);
        // No --system-prompt flag on codex: system text leads the stdin prompt.
        expect(stdin).toContain('## System');
        expect(stdin).toContain('You are gbrain subagent.');
        expect(stdin).toContain('User: hi');
      } finally {
        restoreFastStub();
      }
    });
  });

  test('scrubs OPENAI_* credentials from the child env (subscription-only auth)', async () => {
    await withStubEnv(async () => {
      await withEnv(
        {
          OPENAI_API_KEY: 'sk-should-never-leak',
          OPENAI_BASE_URL: 'https://proxy.should.never.leak',
        },
        async () => {
          const envLog = join(stubDir, 'env.log');
          const envStub = [
            '#!/bin/sh',
            `printf "key=%s\\nbase=%s\\n" "\${OPENAI_API_KEY:-UNSET}" "\${OPENAI_BASE_URL:-UNSET}" > "${envLog}"`,
            'cat > /dev/null',
            'out=""',
            'prev=""',
            'for a in "$@"; do',
            '  if [ "$prev" = "-o" ]; then out="$a"; fi',
            '  prev="$a"',
            'done',
            `cat "${stubResponsePath}" > "$out"`,
          ].join('\n');
          writeFileSync(stubBin, envStub);
          chmodSync(stubBin, 0o755);
          stageResponse('ok');

          try {
            const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
            const model = new CodexCliLanguageModel('gpt-5.6-terra');
            await model.doGenerate({
              prompt: [userMessage('hi')],
            } as LanguageModelV2CallOptions);

            const fs = require('node:fs');
            const seen = fs.readFileSync(envLog, 'utf8');
            expect(seen).toContain('key=UNSET');
            expect(seen).toContain('base=UNSET');
          } finally {
            restoreFastStub();
          }
        },
      );
    });
  });
});

describe('codex-cli LanguageModel — abort + error surfaces', () => {
  test('SIGTERMs the child on AbortSignal', async () => {
    await withStubEnv(async () => {
      const slowStub = [
        '#!/bin/sh',
        'cat > /dev/null',
        'sleep 30',
      ].join('\n');
      writeFileSync(stubBin, slowStub);
      chmodSync(stubBin, 0o755);
      try {
        const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
        const model = new CodexCliLanguageModel('gpt-5.6-terra');
        const ac = new AbortController();
        const promise = model.doGenerate({
          prompt: [userMessage('slow')],
          abortSignal: ac.signal,
        } as LanguageModelV2CallOptions);
        setTimeout(() => ac.abort(), 30);
        await expect(promise).rejects.toThrow(/aborted/);
      } finally {
        restoreFastStub();
      }
    });
  });

  test('rejects when the CLI exits non-zero', async () => {
    await withStubEnv(async () => {
      const failStub = [
        '#!/bin/sh',
        'cat > /dev/null',
        'echo "usage limit reached" >&2',
        'exit 1',
      ].join('\n');
      writeFileSync(stubBin, failStub);
      chmodSync(stubBin, 0o755);
      try {
        const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
        const model = new CodexCliLanguageModel('gpt-5.6-terra');
        await expect(
          model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions),
        ).rejects.toThrow(/codex-cli exited 1.*usage limit reached/s);
      } finally {
        restoreFastStub();
      }
    });
  });

  test('rejects when the CLI exits 0 without writing the -o file', async () => {
    await withStubEnv(async () => {
      const silentStub = [
        '#!/bin/sh',
        'cat > /dev/null',
        'exit 0',
      ].join('\n');
      writeFileSync(stubBin, silentStub);
      chmodSync(stubBin, 0o755);
      try {
        const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
        const model = new CodexCliLanguageModel('gpt-5.6-terra');
        await expect(
          model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions),
        ).rejects.toThrow(/wrote no final message/);
      } finally {
        restoreFastStub();
      }
    });
  });

  test('rejects cleanly when the codex binary is missing (no worker crash)', async () => {
    // A missing binary must surface as a rejected promise via the spawn 'error'
    // handler; the child stdin 'error' (EPIPE) handler swallows the pipe failure
    // so it never escalates to an unhandled rejection that would down the worker.
    await withEnv({ GBRAIN_CODEX_CLI_BIN: join(stubDir, 'nonexistent-codex') }, async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const model = new CodexCliLanguageModel('gpt-5.6-terra');
      await expect(
        model.doGenerate({ prompt: [userMessage('x')] } as LanguageModelV2CallOptions),
      ).rejects.toThrow(/codex-cli spawn failed/);
    });
  });

  test('doStream throws not-supported', async () => {
    const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    const model = new CodexCliLanguageModel('gpt-5.6-terra');
    await expect(model.doStream()).rejects.toThrow(/does not support streaming/);
  });
});
