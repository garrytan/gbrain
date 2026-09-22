/**
 * Tests for the codex-cli LanguageModelV2 implementation that the
 * `codex-cli` recipe instantiates.
 *
 * Strategy (same as claude-cli-recipe.test.ts): a POSIX shell stub at
 * GBRAIN_CODEX_CLI_BIN plays `codex exec`: it records argv/cwd/stdin/env,
 * writes the `--output-last-message` file, and emits scripted `--json`
 * JSONL events. Tests exercise doGenerate: text round trip, tool-call
 * extraction, `@effort` suffix, isolation argv, env scrub, the informational
 * skills-budget notice, usage-limit → 429 and login → 401 mapping, abort.
 * No Codex installation, login or plan quota required.
 *
 * Pure functions (parseCodexModelId, parseExecEvents, summarizeExec,
 * inferApiErrorStatus) are covered directly as well.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { withEnv } from './helpers/with-env.ts';

const stubDir = join(tmpdir(), `codex-cli-recipe-stub-${process.pid}`);
const stubBin = join(stubDir, 'codex');
const eventsPath = join(stubDir, 'events.jsonl');
const lastMessagePath = join(stubDir, 'last-message.txt');
const argvLog = join(stubDir, 'argv.log');
const stdinLog = join(stubDir, 'stdin.log');
const cwdLog = join(stubDir, 'cwd.log');
const envLog = join(stubDir, 'env.log');
const exitCodePath = join(stubDir, 'exit-code');

/**
 * The stub: record everything, write the -o file (if staged) to whatever path
 * the adapter asked for, print the staged events, exit with the staged code.
 */
function installStub(): void {
  const stub = [
    '#!/bin/sh',
    `printf "%s\\n" "$@" > "${argvLog}"`,
    `pwd > "${cwdLog}"`,
    `env | grep -E "^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY)=" > "${envLog}" || true`,
    `cat > "${stdinLog}"`,
    // find the -o path in argv
    'OUT=""; PREV="";',
    'for a in "$@"; do if [ "$PREV" = "--output-last-message" ]; then OUT="$a"; fi; PREV="$a"; done',
    `if [ -n "$OUT" ] && [ -f "${lastMessagePath}" ]; then cp "${lastMessagePath}" "$OUT"; fi`,
    `cat "${eventsPath}"`,
    `if [ -f "${exitCodePath}" ]; then exit "$(cat "${exitCodePath}")"; fi`,
    'exit 0',
  ].join('\n');
  writeFileSync(stubBin, stub);
  chmodSync(stubBin, 0o755);
}

beforeAll(() => {
  mkdirSync(stubDir, { recursive: true });
  installStub();
});
afterAll(() => { rmSync(stubDir, { recursive: true, force: true }); });

function withStubEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_CODEX_CLI_BIN: stubBin, GBRAIN_CODEX_CLI_REASONING_EFFORT: undefined }, fn);
}

/** Stage a normal successful turn whose final message is `text`. */
function stageSuccess(text: string, opts: { usage?: Record<string, number>; withFile?: boolean; extraEvents?: unknown[] } = {}): void {
  const events: unknown[] = [
    { type: 'thread.started', thread_id: 'thr_test' },
    { type: 'turn.started' },
    ...(opts.extraEvents ?? []),
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } },
    { type: 'turn.completed', usage: opts.usage ?? { input_tokens: 120, cached_input_tokens: 40, output_tokens: 33 } },
  ];
  writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  if (opts.withFile === false) { if (existsSync(lastMessagePath)) rmSync(lastMessagePath); }
  else writeFileSync(lastMessagePath, text);
  if (existsSync(exitCodePath)) rmSync(exitCodePath);
}

function stageFailure(message: string, exitCode = 1): void {
  const events = [
    { type: 'thread.started', thread_id: 'thr_test' },
    { type: 'turn.started' },
    { type: 'error', message },
    { type: 'turn.failed', error: { message } },
  ];
  writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  if (existsSync(lastMessagePath)) rmSync(lastMessagePath);
  writeFileSync(exitCodePath, String(exitCode));
}

function userMessage(text: string): LanguageModelV2CallOptions['prompt'][number] {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('codex-cli recipe registration', () => {
  test('getRecipe returns a chat + expansion Recipe, no embedding, tool loop supported', async () => {
    const { getRecipe } = await import('../src/core/ai/recipes/index.ts');
    const recipe = getRecipe('codex-cli');
    expect(recipe).toBeDefined();
    expect(recipe!.id).toBe('codex-cli');
    expect(recipe!.implementation).toBe('codex-cli');
    expect(recipe!.auth_env?.required).toEqual([]);
    expect(recipe!.touchpoints.chat!.supports_tools).toBe(true);
    expect(recipe!.touchpoints.chat!.supports_subagent_loop).toBe(true);
    expect(recipe!.touchpoints.embedding).toBeUndefined();
    expect(recipe!.touchpoints.expansion).toBeDefined();
    // Fast model first so init/providers-explain advertise the cheap default.
    expect(recipe!.touchpoints.chat!.models[0]!).toBe('gpt-5.6-luna');
    for (const m of ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-6-astra']) {
      expect(recipe!.touchpoints.chat!.models).toContain(m);
      expect(recipe!.touchpoints.expansion!.models).toContain(m);
    }
    // Subprocess cold start needs headroom; a flat 5000ms probe false-fails.
    expect(recipe!.touchpoints.chat!.default_timeout_ms).toBeGreaterThanOrEqual(30_000);
    expect(recipe!.aliases!['luna']).toBe('gpt-5.6-luna');
    expect(recipe!.aliases!['astra']).toBe('gpt-6-astra');
  });
});

describe('codex-cli model id parsing', () => {
  test('bare id keeps the CLI default effort; @suffix pins it; env supplies a default', async () => {
    const { parseCodexModelId } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    expect(parseCodexModelId('gpt-5.6-luna', undefined)).toEqual({ model: 'gpt-5.6-luna', effort: undefined });
    expect(parseCodexModelId('codex-cli:gpt-5.6-luna@low', undefined)).toEqual({ model: 'gpt-5.6-luna', effort: 'low' });
    expect(parseCodexModelId('gpt-6-astra@XHIGH', undefined)).toEqual({ model: 'gpt-6-astra', effort: 'xhigh' });
    expect(parseCodexModelId('gpt-5.6-terra', 'medium')).toEqual({ model: 'gpt-5.6-terra', effort: 'medium' });
    // Suffix beats env default.
    expect(parseCodexModelId('gpt-5.6-terra@high', 'low')).toEqual({ model: 'gpt-5.6-terra', effort: 'high' });
    // A trailing or leading @ is not a suffix.
    expect(parseCodexModelId('gpt-5.6-luna@', undefined)).toEqual({ model: 'gpt-5.6-luna@', effort: undefined });
    expect(parseCodexModelId('@low', undefined)).toEqual({ model: '@low', effort: undefined });
  });
});

describe('codex-cli event stream reduction', () => {
  test('parseExecEvents tolerates banners and blank lines around JSONL', async () => {
    const { parseExecEvents } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    const out = ['Reading additional input from stdin...', '', '{"type":"turn.started"}', 'not json', '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'].join('\n');
    const parsed = parseExecEvents(out);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.events.map(e => e.type)).toEqual(['turn.started', 'turn.completed']);
    expect(parseExecEvents('nothing here').ok).toBe(false);
  });

  test('summarizeExec prefers the -o file bytes, falls back to the agent_message event', async () => {
    const { summarizeExec } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    const events = [
      { type: 'item.completed', item: { type: 'agent_message', text: 'from event' } },
      { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 7 } },
    ];
    const file = join(stubDir, 'summ.txt'); writeFileSync(file, 'from file\n');
    const withFile = summarizeExec(events, file, 0);
    expect(withFile).not.toBeInstanceOf(Error);
    if (!(withFile instanceof Error)) {
      expect(withFile.text).toBe('from file\n');
      expect(withFile.usage).toEqual({ input_tokens: 5, cached_input_tokens: 1, output_tokens: 7 });
    }
    const noFile = summarizeExec(events, join(stubDir, 'missing.txt'), 0);
    if (!(noFile instanceof Error)) expect(noFile.text).toBe('from event');
  });

  test('the skills-budget notice is informational, other error items fail the run', async () => {
    const { summarizeExec, CodexCliProcessError } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    const notice = 'Exceeded skills context budget. All skill descriptions were removed and 44 additional skills were not included in the model-visible skills list.';
    const ok = summarizeExec([
      { type: 'item.completed', item: { type: 'error', message: notice } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'fine' } },
    ], undefined, 0);
    expect(ok).not.toBeInstanceOf(Error);
    if (!(ok instanceof Error)) { expect(ok.text).toBe('fine'); expect(ok.notices).toEqual([notice]); }
    const bad = summarizeExec([
      { type: 'item.completed', item: { type: 'error', message: 'model not available on this plan' } },
    ], undefined, 0);
    expect(bad).toBeInstanceOf(CodexCliProcessError);
  });

  test('inferApiErrorStatus maps quota and login failures to 429 / 401', async () => {
    const { inferApiErrorStatus } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    expect(inferApiErrorStatus("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage or try again at Sep 26th")).toBe(429);
    expect(inferApiErrorStatus('Not logged in. Run `codex login`.')).toBe(401);
    expect(inferApiErrorStatus('something else entirely')).toBeUndefined();
  });
});

describe('codex-cli LanguageModel — text-only round trip', () => {
  test('returns one text block, usage from turn.completed, stop finish reason', async () => {
    await withStubEnv(async () => {
      stageSuccess('hello from codex', { usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 34 } });
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const model = new CodexCliLanguageModel('codex-cli:gpt-5.6-luna');
      expect(model.modelId).toBe('gpt-5.6-luna');
      const result = await model.doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions);
      expect(result.content).toEqual([{ type: 'text', text: 'hello from codex' }]);
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34, totalTokens: 46, cachedInputTokens: 4 });
    });
  });

  test('system text and the user turn arrive on stdin (no argv leak), system fenced', async () => {
    await withStubEnv(async () => {
      stageSuccess('ok');
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      await new CodexCliLanguageModel('gpt-5.6-luna').doGenerate({
        prompt: [{ role: 'system', content: 'You are gbrain subagent.' }, userMessage('what is up')],
      } as LanguageModelV2CallOptions);
      const stdin = readFileSync(stdinLog, 'utf8');
      expect(stdin).toContain('<system>\nYou are gbrain subagent.\n</system>');
      expect(stdin).toContain('User: what is up');
      const argv = readFileSync(argvLog, 'utf8');
      expect(argv).not.toContain('You are gbrain subagent.');
      expect(argv.split('\n').filter(Boolean).at(-1)).toBe('-');
    });
  });
});

describe('codex-cli LanguageModel — tool use', () => {
  test('extracts a <use_tools> block into tool-call parts with gbrain-minted ids', async () => {
    await withStubEnv(async () => {
      stageSuccess([
        'Let me look that up.',
        '<use_tools>',
        '[{"name": "brain_search", "input": {"query": "backup retention"}},',
        ' {"name": "brain_get_page", "input": {"slug": "concepts/gbrain-architecture"}}]',
        '</use_tools>',
      ].join('\n'));
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const result = await new CodexCliLanguageModel('gpt-5.6-luna').doGenerate({
        prompt: [userMessage('find it')],
        tools: [{ type: 'function', name: 'brain_search', description: 's', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
      } as unknown as LanguageModelV2CallOptions);
      expect(result.finishReason).toBe('tool-calls');
      const calls = result.content.filter(c => c.type === 'tool-call') as Array<{ toolCallId: string; toolName: string; input: string }>;
      expect(calls.map(c => c.toolName)).toEqual(['brain_search', 'brain_get_page']);
      expect(JSON.parse(calls[0].input)).toEqual({ query: 'backup retention' });
      for (const c of calls) expect(c.toolCallId).toMatch(/^toolu_codex_cli_/);
      expect(new Set(calls.map(c => c.toolCallId)).size).toBe(2);
      expect(result.content[0]).toEqual({ type: 'text', text: 'Let me look that up.' });
      // The protocol instructions were injected into the system text.
      expect(readFileSync(stdinLog, 'utf8')).toContain('## Tool Use Protocol');
    });
  });
});

describe('codex-cli LanguageModel — isolation', () => {
  test('argv disables every agent surface, pins chatgpt auth, passes @effort, uses an empty scratch cwd', async () => {
    await withStubEnv(async () => {
      stageSuccess('ok');
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      await new CodexCliLanguageModel('codex-cli:gpt-6-astra@high').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions);
      const argv = readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
      const cwd = readFileSync(cwdLog, 'utf8').trim();
      for (const flag of ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--output-last-message']) {
        expect(argv).toContain(flag);
      }
      expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only');
      expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-6-astra');
      const disabled = argv.flatMap((a, i) => (a === '--disable' ? [argv[i + 1]] : []));
      for (const f of ['shell_tool', 'multi_agent', 'apps', 'browser_use', 'computer_use', 'plugins', 'memories']) expect(disabled).toContain(f);
      const configs = argv.flatMap((a, i) => (a === '-c' ? [argv[i + 1]] : []));
      expect(configs).toContain('web_search="disabled"');
      expect(configs).toContain('tools.view_image=false');
      expect(configs).toContain('skills.max_context_tokens=1');
      expect(configs).toContain('preferred_auth_method="chatgpt"');
      expect(configs).toContain('model_reasoning_effort="high"');
      expect(cwd).toMatch(/gbrain-codex-cli-cwd-/);
      // The scratch cwd must hold no AGENTS.md the CLI could pick up.
      expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    });
  });

  test('a bare id emits no effort flag; GBRAIN_CODEX_CLI_REASONING_EFFORT supplies one', async () => {
    await withStubEnv(async () => {
      stageSuccess('ok');
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      await new CodexCliLanguageModel('gpt-5.6-luna').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions);
      expect(readFileSync(argvLog, 'utf8')).not.toContain('model_reasoning_effort');
      await withEnv({ GBRAIN_CODEX_CLI_REASONING_EFFORT: 'low' }, async () => {
        await new CodexCliLanguageModel('gpt-5.6-luna').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions);
        expect(readFileSync(argvLog, 'utf8')).toContain('model_reasoning_effort="low"');
      });
    });
  });

  test('scrubs OPENAI_API_KEY / OPENAI_BASE_URL / CODEX_API_KEY from the child env (subscription-only)', async () => {
    await withStubEnv(async () => {
      await withEnv({ OPENAI_API_KEY: 'sk-should-never-leak', OPENAI_BASE_URL: 'https://proxy.never', CODEX_API_KEY: 'ck-never' }, async () => {
        stageSuccess('ok');
        const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
        await new CodexCliLanguageModel('gpt-5.6-luna').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions);
        expect(readFileSync(envLog, 'utf8').trim()).toBe('');
      });
    });
  });
});

describe('codex-cli LanguageModel — failures and abort', () => {
  test('usage-limit turn.failed surfaces as CodexCliProcessError with apiErrorStatus 429', async () => {
    await withStubEnv(async () => {
      stageFailure("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 26th, 2026 1:50 PM.");
      const { CodexCliLanguageModel, CodexCliProcessError } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const p = new CodexCliLanguageModel('gpt-5.6-luna').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions);
      await expect(p).rejects.toBeInstanceOf(CodexCliProcessError);
      await p.catch((e: { apiErrorStatus?: number; message: string }) => {
        expect(e.apiErrorStatus).toBe(429);
        expect(e.message).toContain('usage limit');
      });
    });
  });

  test('not-logged-in maps to 401; non-zero exit with no events keeps the raw blob after the marker', async () => {
    await withStubEnv(async () => {
      stageFailure('Not logged in. Run `codex login` to authenticate.', 2);
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      await new CodexCliLanguageModel('gpt-5.6-luna').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions)
        .catch((e: { apiErrorStatus?: number }) => expect(e.apiErrorStatus).toBe(401));
      // No JSON at all + non-zero exit.
      writeFileSync(eventsPath, 'error: codex binary exploded\n'); writeFileSync(exitCodePath, '3');
      await new CodexCliLanguageModel('gpt-5.6-luna').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions)
        .catch((e: { message: string; exitCode?: number }) => {
          expect(e.exitCode).toBe(3);
          expect(e.message).toContain('--- raw ---');
          expect(e.message.indexOf('exited 3')).toBeLessThan(e.message.indexOf('--- raw ---'));
        });
    });
  });

  test('abort kills the child and rejects', async () => {
    await withStubEnv(async () => {
      // Slow stub: sleep before emitting anything.
      writeFileSync(stubBin, ['#!/bin/sh', 'cat > /dev/null', 'sleep 5', `cat "${eventsPath}"`].join('\n'));
      chmodSync(stubBin, 0o755);
      stageSuccess('too late');
      try {
        const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
        const ac = new AbortController();
        const p = new CodexCliLanguageModel('gpt-5.6-luna').doGenerate({ prompt: [userMessage('hi')], abortSignal: ac.signal } as LanguageModelV2CallOptions);
        setTimeout(() => ac.abort(), 30);
        await expect(p).rejects.toThrow(/aborted/);
      } finally {
        installStub();
      }
    });
  });
});
