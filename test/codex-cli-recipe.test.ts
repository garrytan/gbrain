/**
 * Hermetic contract tests for the local `codex exec` LanguageModelV2 adapter.
 *
 * A POSIX stub stands in for the installed Codex CLI. The unit suite never
 * needs a ChatGPT subscription, OPENAI_API_KEY, network access, or the user's
 * Codex auth files.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { withEnv } from './helpers/with-env.ts';

const stubDir = join(tmpdir(), `codex-cli-recipe-stub-${process.pid}`);
const stubBin = join(stubDir, 'codex');
const stagedFinal = join(stubDir, 'final.txt');
const stagedEvents = join(stubDir, 'events.jsonl');
const argvLog = join(stubDir, 'argv.log');
const cwdLog = join(stubDir, 'cwd.log');
const envLog = join(stubDir, 'env.log');
const promptLog = join(stubDir, 'prompt.log');
const schemaLog = join(stubDir, 'schema.json');
const childPidLog = join(stubDir, 'child.pid');
const modeFile = join(stubDir, 'mode');
const exitFile = join(stubDir, 'exit-code');
const stderrFile = join(stubDir, 'stderr');

function installStub(): void {
  const stub = [
    '#!/bin/sh',
    `printf "%s" "$$" > "${childPidLog}"`,
    `printf "%s\\n" "$@" > "${argvLog}"`,
    `pwd > "${cwdLog}"`,
    `printf "openai_key=%s\\nopenai_base=%s\\ncodex_home=%s\\nsentinel=%s\\n" ` +
      '"${OPENAI_API_KEY:-UNSET}" "${OPENAI_BASE_URL:-UNSET}" "${CODEX_HOME:-UNSET}" ' +
      '"${UNRELATED_SECRET_SENTINEL:-UNSET}" ' +
      `> "${envLog}"`,
    `cat > "${promptLog}"`,
    'last=""',
    'schema=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o|--output-last-message) last="$2"; shift 2 ;;',
    '    --output-schema) schema="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    `if [ -n "$schema" ]; then cp "$schema" "${schemaLog}"; fi`,
    `mode=$(cat "${modeFile}" 2>/dev/null || printf normal)`,
    'if [ "$mode" = "overflow" ]; then head -c 2097152 /dev/zero | tr "\\000" x; fi',
    `if [ "$mode" = "slow" ]; then trap 'sleep 0.2; exit 143' TERM; sleep 30; fi`,
    'if [ "$mode" != "no-final" ] && [ -n "$last" ]; then',
    `  cp "${stagedFinal}" "$last"`,
    'fi',
    `cat "${stagedEvents}"`,
    `stderr_text=$(cat "${stderrFile}" 2>/dev/null || true)`,
    'if [ -n "$stderr_text" ]; then printf "%s\\n" "$stderr_text" >&2; fi',
    `exit_code=$(cat "${exitFile}" 2>/dev/null || printf 0)`,
    'exit "$exit_code"',
  ].join('\n');
  writeFileSync(stubBin, stub);
  chmodSync(stubBin, 0o755);
}

beforeAll(() => {
  mkdirSync(stubDir, { recursive: true });
  installStub();
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

function stage(final: string, events?: string): void {
  writeFileSync(stagedFinal, final);
  writeFileSync(
    stagedEvents,
    events ??
      [
        '{"type":"thread.started","thread_id":"test-thread"}',
        '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":2,"output_tokens":34,"reasoning_output_tokens":3}}',
      ].join('\n'),
  );
}

function withStub<T>(
  fn: () => T | Promise<T>,
  extra: Record<string, string | undefined> = {},
): Promise<T> {
  writeFileSync(modeFile, 'normal');
  writeFileSync(exitFile, '0');
  writeFileSync(stderrFile, '');
  return withEnv(
    {
      GBRAIN_CODEX_CLI_BIN: stubBin,
      ...extra,
    },
    fn,
  );
}

function userMessage(text: string): LanguageModelV2CallOptions['prompt'][number] {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('codex-cli recipe registration', () => {
  test('registers a chat-only, keyless, tool-loop-capable recipe', async () => {
    const { getRecipe } = await import('../src/core/ai/recipes/index.ts');
    const recipe = getRecipe('codex-cli');

    expect(recipe).toBeDefined();
    expect(recipe!.implementation).toBe('codex-cli');
    expect(recipe!.auth_env?.required).toEqual([]);
    expect(recipe!.touchpoints.chat?.models).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
    ]);
    expect(recipe!.touchpoints.chat?.supports_tools).toBe(true);
    expect(recipe!.touchpoints.chat?.supports_subagent_loop).toBe(true);
    expect(recipe!.touchpoints.embedding).toBeUndefined();
    expect(recipe!.touchpoints.expansion).toBeUndefined();
  });

  test('is available without OPENAI_API_KEY and advertises subagent capability', async () => {
    const { classifyCapabilities } = await import('../src/core/ai/capabilities.ts');
    const { configureGateway, isAvailable, resetGateway } = await import('../src/core/ai/gateway.ts');
    resetGateway();
    configureGateway({ chat_model: 'codex-cli:gpt-5.6-sol', env: {} });
    expect(isAvailable('chat')).toBe(true);
    expect(classifyCapabilities('codex-cli:gpt-5.6-sol')).toBe('degraded:no_caching');
    resetGateway();
  });
});

describe('CodexCliLanguageModel text and structured tool output', () => {
  test('returns text and usage from output-last-message plus JSONL usage', async () => {
    await withStub(async () => {
      stage('{"text":"hello world","tool_calls":[]}');
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      const result = await new CodexCliLanguageModel('codex-cli:gpt-5.6-sol').doGenerate({
        prompt: [userMessage('hello')],
      } as LanguageModelV2CallOptions);

      expect(result.finishReason).toBe('stop');
      expect(result.content).toEqual([{ type: 'text', text: 'hello world' }]);
      expect(result.usage).toEqual({
        inputTokens: 12,
        outputTokens: 34,
        totalTokens: 46,
      });
    });
  });

  test('returns multiple same-turn tool calls with JSON-string inputs', async () => {
    await withStub(async () => {
      stage(JSON.stringify({
        text: '',
        tool_calls: [
          { id: 'call-a', name: 'search', input: { query: 'alpha' } },
          { id: 'call-b', name: 'get_page', input: { slug: 'areas/example' } },
        ],
      }));
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      const result = await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
        prompt: [userMessage('look up both')],
        tools: [
          {
            type: 'function',
            name: 'search',
            description: 'Search the brain',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
          {
            type: 'function',
            name: 'get_page',
            description: 'Read a page',
            inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
          },
        ],
      } as LanguageModelV2CallOptions);

      expect(result.finishReason).toBe('tool-calls');
      expect(result.content).toEqual([
        {
          type: 'tool-call',
          toolCallId: 'call-a',
          toolName: 'search',
          input: '{"query":"alpha"}',
        },
        {
          type: 'tool-call',
          toolCallId: 'call-b',
          toolName: 'get_page',
          input: '{"slug":"areas/example"}',
        },
      ]);

      const schema = JSON.parse(readFileSync(schemaLog, 'utf8')) as any;
      expect(schema.properties.tool_calls.items.properties.name.enum).toEqual([
        'search',
        'get_page',
      ]);
    });
  });

  test('falls back to the last agent_message JSON in the event stream', async () => {
    await withStub(async () => {
      stage(
        'unused',
        [
          '{"type":"thread.started","thread_id":"test-thread"}',
          '{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"{\\"text\\":\\"from jsonl\\",\\"tool_calls\\":[]}"}}',
          '{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":5}}',
        ].join('\n'),
      );
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      writeFileSync(modeFile, 'no-final');
      const result = await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
        prompt: [userMessage('fallback')],
      } as LanguageModelV2CallOptions);
      expect(result.content).toEqual([{ type: 'text', text: 'from jsonl' }]);
      expect(result.usage.totalTokens).toBe(9);
    });
  });

  test('renders second-turn tool ids, object inputs, and unwrapped results faithfully', async () => {
    await withStub(async () => {
      stage('{"text":"done","tool_calls":[]}');
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
        prompt: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'search-a',
                toolName: 'search',
                input: { query: 'alpha' },
              },
              {
                type: 'tool-call',
                toolCallId: 'search-b',
                toolName: 'search',
                input: { query: 'beta' },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'search-a',
                toolName: 'search',
                output: { type: 'json', value: { hits: ['alpha-result'] } },
              },
              {
                type: 'tool-result',
                toolCallId: 'search-b',
                toolName: 'search',
                output: { type: 'text', value: 'beta-result' },
              },
            ],
          },
        ],
      } as LanguageModelV2CallOptions);

      const prompt = readFileSync(promptLog, 'utf8');
      expect(prompt).toContain(
        '[tool_call id=search-a name=search input={"query":"alpha"}]',
      );
      expect(prompt).toContain(
        '[tool_call id=search-b name=search input={"query":"beta"}]',
      );
      expect(prompt).toContain(
        '[tool_result id=search-a name=search output={"hits":["alpha-result"]}]',
      );
      expect(prompt).toContain(
        '[tool_result id=search-b name=search output=beta-result]',
      );
      expect(prompt).not.toContain('[object Object]');
      expect(prompt).not.toContain('"type":"json"');
    });
  });
});

describe('CodexCliLanguageModel isolation, model, and reasoning configuration', () => {
  test('uses ephemeral isolated read-only exec and scrubs API-key auth', async () => {
    await withStub(async () => {
      await withEnv(
        {
          OPENAI_API_KEY: 'sk-must-not-leak',
          OPENAI_BASE_URL: 'https://proxy.must.not.leak',
          CODEX_HOME: '/tmp/codex-auth-home-preserved',
          UNRELATED_SECRET_SENTINEL: 'must-not-reach-codex',
        },
        async () => {
          stage('{"text":"ok","tool_calls":[]}');
          const { CodexCliLanguageModel } = await import(
            '../src/core/ai/providers/codex-cli-language-model.ts'
          );
          await new CodexCliLanguageModel('codex-cli:gpt-5.6-sol').doGenerate({
            prompt: [
              { role: 'system', content: 'GBrain system prompt' },
              userMessage('GBrain user prompt'),
            ],
          } as LanguageModelV2CallOptions);

          const argv = readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
          expect(argv[0]).toBe('exec');
          expect(argv).toContain('--ephemeral');
          expect(argv).toContain('--ignore-user-config');
          expect(argv).toContain('--ignore-rules');
          expect(argv).toContain('--strict-config');
          expect(argv).toContain('--skip-git-repo-check');
          expect(argv).toContain('--sandbox');
          expect(argv).toContain('read-only');
          expect(argv).toContain('--json');
          expect(argv).toContain('--output-schema');
          expect(argv).toContain('--output-last-message');
          expect(argv).toContain('--model');
          expect(argv).toContain('gpt-5.6-sol');
          expect(argv).toContain('model_reasoning_effort="low"');
          expect(argv.at(-1)).toBe('-');
          const disabledFeatures = argv.flatMap((arg, index) =>
            arg === '--disable' && argv[index + 1] ? [argv[index + 1]] : [],
          );
          expect(disabledFeatures).toEqual([
            'shell_tool',
            'unified_exec',
            'code_mode_host',
            'browser_use',
            'browser_use_external',
            'browser_use_full_cdp_access',
            'in_app_browser',
            'standalone_web_search',
            'search_tool',
            'image_generation',
            'view_image',
            'artifact',
            'chronicle',
            'shell_snapshot',
            'tool_suggest',
            'skill_search',
            'request_permissions_tool',
            'computer_use',
            'apps',
            'multi_agent',
            'multi_agent_v2',
            'deferred_executor',
            'unavailable_dummy_tools',
          ]);

          const cwd = readFileSync(cwdLog, 'utf8').trim();
          expect(cwd).toMatch(/gbrain-codex-cli-/);
          expect(existsSync(cwd)).toBe(false);

          const env = readFileSync(envLog, 'utf8');
          expect(env).toContain('openai_key=UNSET');
          expect(env).toContain('openai_base=UNSET');
          expect(env).toContain('codex_home=/tmp/codex-auth-home-preserved');
          expect(env).toContain('sentinel=UNSET');

          const prompt = readFileSync(promptLog, 'utf8');
          expect(prompt).toContain('GBrain system prompt');
          expect(prompt).toContain('GBrain user prompt');
        },
      );
    });
  });

  test('honors provider_chat_options reasoningEffort', async () => {
    await withStub(async () => {
      stage('{"text":"ok","tool_calls":[]}');
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
        prompt: [userMessage('reason')],
        providerOptions: {
          'codex-cli': { reasoningEffort: 'medium' },
        },
      } as LanguageModelV2CallOptions);

      const argv = readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
      expect(argv).toContain('model_reasoning_effort="medium"');
      expect(argv).not.toContain('model_reasoning_effort="low"');
    });
  });

  test('threads a normal maxOutputTokens budget into schema and prompt', async () => {
    await withStub(async () => {
      stage('{"text":"bounded","tool_calls":[]}');
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      const result = await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
        prompt: [userMessage('bounded')],
        maxOutputTokens: 64,
      } as LanguageModelV2CallOptions);

      expect(result.content).toEqual([{ type: 'text', text: 'bounded' }]);
      const schema = JSON.parse(readFileSync(schemaLog, 'utf8')) as any;
      expect(schema.properties.text.maxLength).toBe(256);
      expect(readFileSync(promptLog, 'utf8')).toContain(
        'at most 64 output tokens',
      );
    });
  });

  test('rejects a reported over-budget completion after the Codex call', async () => {
    await withStub(async () => {
      stage(
        '{"text":"this answer is far over the requested output budget","tool_calls":[]}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":52}}',
      );
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      await expect(
        new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
          prompt: [userMessage('one token only')],
          maxOutputTokens: 1,
        } as LanguageModelV2CallOptions),
      ).rejects.toThrow(/reported 52 output tokens.*maxOutputTokens 1/);
    });
  });

  test('enforces none, required, and specific toolChoice in the output schema', async () => {
    await withStub(async () => {
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      const model = new CodexCliLanguageModel('gpt-5.6-sol');
      const tools = [
        {
          type: 'function' as const,
          name: 'search',
          description: 'Search',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        },
        {
          type: 'function' as const,
          name: 'get_page',
          description: 'Read',
          inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
        },
      ];

      stage('{"text":"no tools","tool_calls":[]}');
      await model.doGenerate({
        prompt: [userMessage('none')],
        tools,
        toolChoice: { type: 'none' },
      } as LanguageModelV2CallOptions);
      let schema = JSON.parse(readFileSync(schemaLog, 'utf8')) as any;
      expect(schema.properties.tool_calls.maxItems).toBe(0);

      stage('{"text":"","tool_calls":[{"id":"a","name":"search","input":{"q":"x"}}]}');
      await model.doGenerate({
        prompt: [userMessage('required')],
        tools,
        toolChoice: { type: 'required' },
      } as LanguageModelV2CallOptions);
      schema = JSON.parse(readFileSync(schemaLog, 'utf8')) as any;
      expect(schema.properties.tool_calls.minItems).toBe(1);
      expect(schema.properties.tool_calls.items.properties.name.enum).toEqual([
        'search',
        'get_page',
      ]);

      stage('{"text":"answer without tool","tool_calls":[]}');
      await expect(model.doGenerate({
        prompt: [userMessage('required but omitted')],
        tools,
        toolChoice: { type: 'required' },
      } as LanguageModelV2CallOptions)).rejects.toThrow(/toolChoice required/);

      stage('{"text":"","tool_calls":[{"id":"b","name":"get_page","input":{"slug":"x"}}]}');
      await model.doGenerate({
        prompt: [userMessage('specific')],
        tools,
        toolChoice: { type: 'tool', toolName: 'get_page' },
      } as LanguageModelV2CallOptions);
      schema = JSON.parse(readFileSync(schemaLog, 'utf8')) as any;
      expect(schema.properties.tool_calls.minItems).toBe(1);
      expect(schema.properties.tool_calls.items.properties.name.enum).toEqual([
        'get_page',
      ]);
    });
  });
});

describe('codex-cli gateway tool-loop contract', () => {
  test('executes multiple same-turn GBrain tool calls and completes on the next turn', async () => {
    await withStub(async () => {
      const countFile = join(stubDir, 'tool-loop-count');
      const toolLoopStub = [
        '#!/bin/sh',
        'last=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -o|--output-last-message) last="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'cat > /dev/null',
        `count=$(cat "${countFile}" 2>/dev/null || printf 0)`,
        'count=$((count + 1))',
        `printf "%s" "$count" > "${countFile}"`,
        'if [ "$count" -eq 1 ]; then',
        `  printf '%s' '{"text":"","tool_calls":[{"id":"a","name":"search","input":{"q":"a"}},{"id":"b","name":"search","input":{"q":"b"}}]}' > "$last"`,
        'else',
        `  printf '%s' '{"text":"done","tool_calls":[]}' > "$last"`,
        'fi',
        `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'`,
      ].join('\n');
      writeFileSync(countFile, '0');
      writeFileSync(stubBin, toolLoopStub);
      chmodSync(stubBin, 0o755);

      const {
        configureGateway,
        resetGateway,
        toolLoop,
      } = await import('../src/core/ai/gateway.ts');
      try {
        resetGateway();
        configureGateway({
          chat_model: 'codex-cli:gpt-5.6-sol',
          provider_chat_options: {
            'codex-cli': { reasoningEffort: 'low' },
          },
          env: {},
        });
        const seen: string[] = [];
        const result = await toolLoop({
          model: 'codex-cli:gpt-5.6-sol',
          initialMessages: [{ role: 'user', content: 'search twice' }],
          tools: [
            {
              name: 'search',
              description: 'Search',
              inputSchema: {
                type: 'object',
                properties: { q: { type: 'string' } },
                required: ['q'],
              },
            },
          ],
          toolHandlers: new Map([
            ['search', {
              idempotent: true,
              async execute(input) {
                seen.push((input as { q: string }).q);
                return { ok: true };
              },
            }],
          ]),
        });

        expect(seen).toEqual(['a', 'b']);
        expect(result.finalText).toBe('done');
        expect(result.stopReason).toBe('end');
      } finally {
        resetGateway();
        installStub();
      }
    });
  });
});

describe('CodexCliLanguageModel abort and failures', () => {
  test('aborts the child cleanly', async () => {
    await withStub(async () => {
      stage('{"text":"late","tool_calls":[]}');
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      const controller = new AbortController();
      writeFileSync(modeFile, 'slow');
      const promise = new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
        prompt: [userMessage('slow')],
        abortSignal: controller.signal,
      } as LanguageModelV2CallOptions);
      setTimeout(() => controller.abort(), 30);
      await expect(promise).rejects.toThrow(/aborted/);
      const childPid = Number(readFileSync(childPidLog, 'utf8'));
      expect(() => process.kill(childPid, 0)).toThrow();
    });
  });

  test('bounds subprocess output and terminates on overflow', async () => {
    await withStub(async () => {
      stage('{"text":"must not return","tool_calls":[]}');
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      writeFileSync(modeFile, 'overflow');
      await expect(
        new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
          prompt: [userMessage('overflow')],
        } as LanguageModelV2CallOptions),
      ).rejects.toThrow(/output exceeded/);
    });
  });

  test('bounds output-last-message files before reading them', async () => {
    await withStub(async () => {
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      const model = new CodexCliLanguageModel('gpt-5.6-sol');

      stage('x'.repeat(2 * 1024 * 1024));
      await expect(
        model.doGenerate({
          prompt: [userMessage('oversized final file')],
        } as LanguageModelV2CallOptions),
      ).rejects.toThrow(/final message.*exceeded/);

      stage('{"text":"bounded","tool_calls":[]}');
      const result = await model.doGenerate({
        prompt: [userMessage('bounded final file')],
      } as LanguageModelV2CallOptions);
      expect(result.content).toEqual([{ type: 'text', text: 'bounded' }]);
    });
  });

  test('rejects malformed final output and malformed JSONL', async () => {
    await withStub(async () => {
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      const model = new CodexCliLanguageModel('gpt-5.6-sol');

      stage('not-json', '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}');
      await expect(model.doGenerate({
        prompt: [userMessage('bad final')],
      } as LanguageModelV2CallOptions)).rejects.toThrow(/codex-cli output/);

      stage('{"text":"must not pass","tool_calls":[]}', 'not-jsonl');
      await expect(model.doGenerate({
        prompt: [userMessage('bad jsonl')],
      } as LanguageModelV2CallOptions)).rejects.toThrow(/malformed JSONL/);
    });
  });

  test('rejects unknown top-level JSONL events and malformed item envelopes', async () => {
    await withStub(async () => {
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      const model = new CodexCliLanguageModel('gpt-5.6-sol');
      const final = '{"text":"must not pass","tool_calls":[]}';

      stage(final, '{"type":"future.execution","payload":{"command":"env"}}');
      await expect(model.doGenerate({
        prompt: [userMessage('unknown event')],
      } as LanguageModelV2CallOptions)).rejects.toThrow(/unreviewed JSONL event type/);

      stage(final, '{"type":"item.completed"}');
      await expect(model.doGenerate({
        prompt: [userMessage('missing item')],
      } as LanguageModelV2CallOptions)).rejects.toThrow(/malformed item event/);

      stage(final, '{"type":"item.started","item":{}}');
      await expect(model.doGenerate({
        prompt: [userMessage('missing item type')],
      } as LanguageModelV2CallOptions)).rejects.toThrow(/missing item type/);

      stage(final, '{"type":"turn.failed"}');
      await expect(model.doGenerate({
        prompt: [userMessage('missing failure detail')],
      } as LanguageModelV2CallOptions)).rejects.toThrow(/missing error detail/);

      stage(final, '{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":1}}');
      await expect(model.doGenerate({
        prompt: [userMessage('invalid usage')],
      } as LanguageModelV2CallOptions)).rejects.toThrow(/malformed usage/);

      stage(final, '{"type":"turn.completed","usage":{"input_tokens":1.5,"output_tokens":1}}');
      await expect(model.doGenerate({
        prompt: [userMessage('fractional usage')],
      } as LanguageModelV2CallOptions)).rejects.toThrow(/malformed usage/);
    });
  });

  test('surfaces nonzero CLI errors without leaking an API key', async () => {
    await withStub(async () => {
      stage('', '{"type":"turn.failed","error":{"message":"subscription unavailable"}}');
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      writeFileSync(exitFile, '7');
      writeFileSync(stderrFile, 'codex failed safely');
      await expect(
        withEnv(
          {
            OPENAI_API_KEY: 'sk-never-print-this',
          },
          () => new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
            prompt: [userMessage('fail')],
          } as LanguageModelV2CallOptions),
        ),
      ).rejects.toThrow(/codex-cli exited 7.*subscription unavailable/);
    });
  });

  test('tolerates the exact code-mode-host disabled diagnostic emitted by Codex 0.147.0', async () => {
    await withStub(async () => {
      stage(
        '{"text":"safe","tool_calls":[]}',
        [
          '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`."}}',
          '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
        ].join('\n'),
      );
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      const result = await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
        prompt: [userMessage('safe')],
      } as LanguageModelV2CallOptions);
      expect(result.content).toEqual([{ type: 'text', text: 'safe' }]);
    });
  });

  test('rejects any Codex built-in tool event', async () => {
    await withStub(async () => {
      stage(
        '{"text":"unsafe","tool_calls":[]}',
        [
          '{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"env"}}',
          '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
        ].join('\n'),
      );
      const { CodexCliLanguageModel } = await import(
        '../src/core/ai/providers/codex-cli-language-model.ts'
      );
      await expect(
        new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
          prompt: [userMessage('unsafe')],
        } as LanguageModelV2CallOptions),
      ).rejects.toThrow(/built-in tool event/);
    });
  });

  test('rejects cleanly when the codex binary is missing', async () => {
    const { CodexCliLanguageModel } = await import(
      '../src/core/ai/providers/codex-cli-language-model.ts'
    );
    await withEnv(
      { GBRAIN_CODEX_CLI_BIN: join(stubDir, 'missing-codex') },
      async () => {
        await expect(
          new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
            prompt: [userMessage('missing')],
          } as LanguageModelV2CallOptions),
        ).rejects.toThrow(/codex-cli spawn failed/);
      },
    );
  });
});
