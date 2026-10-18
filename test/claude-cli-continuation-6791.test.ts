/**
 * #6791: when a response hits its output cap, Claude Code continues it on its
 * own (a meta "Output token limit hit. Resume directly" nudge, then a second
 * API response) and its print-mode `result` holds only the text after that
 * nudge, with the final `stop_reason` (`end_turn`). The adapter returned that
 * tail as a complete answer: chronicle parsed the nested `who` array of the
 * tail as the event list and failed `malformed_proposal`.
 *
 * Contract pinned here: the adapter runs the CLI with `--verbose`, so stdout is
 * the session's event array, and rebuilds the full answer from the assistant
 * segments of this call. When a continuation happened but the segments cannot
 * be proven to make up the answer, it returns no text and no tool calls,
 * finishes `length` (callers escalate or retry, #6523) and names the cause in
 * `providerMetadata['claude-cli']`.
 *
 * Authoring gate: (1) protects the full text of a continued answer and the
 * refusal to dispatch a tail; (2) fails when the adapter returns the envelope
 * `result` again or drops `--verbose`; (3) the stop-reason and output-cap suites
 * only cover single-response envelopes; (4) no seam: a POSIX shell stub at
 * GBRAIN_CLAUDE_CLI_BIN plays the CLI and prints the event array only when
 * handed `--verbose`, as the real CLI does. No provider is called.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { ClaudeCliLanguageModel } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { chat, configureGateway, resetGateway, toolLoop } from '../src/core/ai/gateway.ts';
import { isValidProposal, parseJudgeJson } from '../src/core/chronicle/extract-events.ts';
import { defaultExtractor } from '../src/core/cycle/propose-takes.ts';
import { generatePerChunkSynopsis } from '../src/core/page-summary.ts';
import { withEnv } from './helpers/with-env.ts';

// The issue's minimized reconstruction of the cut (content values replaced).
const PREFIX = '[{"when":"2026-10-13","who":["person-a"],"what":"Reviewed a project","kind":';
const CONTINUATION = '"event"},{"when":"2026-10-13","who":["person-a","person-c"],"what":"Agreed a next step","kind":"decision"}]';
const RESUME_NUDGE = 'Output token limit hit. Resume directly \u2014 no apology, no recap of what you were doing. '
  + 'Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.';
const ISSUE_USAGE = { input_tokens: 9047, output_tokens: 4386 };

type Block = { type: 'text'; text: string } | { type: 'thinking'; thinking: string; signature: string };

function assistant(id: string, content: Block[], stopReason: string | null = null): Record<string, unknown> {
  return {
    type: 'assistant', parent_tool_use_id: null, session_id: 'synthetic-session', uuid: `uuid-${id}-${content.length}`,
    message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content, stop_reason: stopReason, usage: { output_tokens: 1 } },
  };
}

function nudge(text: string): Record<string, unknown> {
  return { type: 'user', parent_tool_use_id: null, session_id: 'synthetic-session', message: { role: 'user', content: [{ type: 'text', text }] } };
}

function envelope(result: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result', subtype: 'success', is_error: false, result, stop_reason: 'end_turn',
    session_id: 'synthetic-session', num_turns: 2, usage: ISSUE_USAGE, ...extra,
  };
}

const init = { type: 'system', subtype: 'init', session_id: 'synthetic-session', tools: [] };

/** The two-segment turn from the issue: max_tokens inside an object, then the automatic continuation. */
function continuedTurn(opts: { withNudge?: boolean; stopReasons?: boolean } = {}): unknown[] {
  const { withNudge = true, stopReasons = true } = opts;
  return [
    init,
    assistant('msg_first', [{ type: 'thinking', thinking: '', signature: 'sig' }]),
    assistant('msg_first', [{ type: 'text', text: PREFIX }], stopReasons ? 'max_tokens' : null),
    ...(withNudge ? [nudge(RESUME_NUDGE)] : []),
    assistant('msg_second', [{ type: 'text', text: CONTINUATION }], stopReasons ? 'end_turn' : null),
    envelope(CONTINUATION),
  ];
}

interface Stub { argv: () => string[]; configDir: () => string }

/**
 * Stage a stub `claude`: prints `verbose` when handed `--verbose` and `bare`
 * otherwise (the real CLI's json shapes), recording its argv and CLAUDE_CONFIG_DIR.
 */
async function withCli<T>(output: { verbose: unknown; bare?: unknown }, run: (stub: Stub) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-continuation-'));
  const verbosePath = join(dir, 'verbose.json');
  const barePath = join(dir, 'bare.json');
  const argvPath = join(dir, 'argv');
  const configPath = join(dir, 'config-dir');
  const verbose = output.verbose;
  const bare = output.bare ?? (Array.isArray(verbose) ? verbose.at(-1) : verbose);
  writeFileSync(verbosePath, JSON.stringify(verbose));
  writeFileSync(barePath, JSON.stringify(bare));
  const bin = join(dir, 'claude');
  writeFileSync(bin, [
    '#!/bin/sh',
    'cat > /dev/null',
    `printf '%s\\n' "$CLAUDE_CONFIG_DIR" > "${configPath}"`,
    'verbose=',
    `for a in "$@"; do printf '%s\\n' "$a" >> "${argvPath}"; if [ "$a" = "--verbose" ]; then verbose=1; fi; done`,
    `if [ -n "$verbose" ]; then cat "${verbosePath}"; else cat "${barePath}"; fi`,
  ].join('\n') + '\n');
  chmodSync(bin, 0o755);
  const stub: Stub = {
    argv: () => readFileSync(argvPath, 'utf8').trimEnd().split('\n'),
    configDir: () => readFileSync(configPath, 'utf8').trimEnd(),
  };
  try {
    return await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin, GBRAIN_CLAUDE_CLI_HERMETIC_CONFIG: undefined }, () => run(stub));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function options(maxOutputTokens?: number): LanguageModelV2CallOptions {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Extract the events.' }] }],
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  } as LanguageModelV2CallOptions;
}

const generate = (maxOutputTokens?: number) => new ClaudeCliLanguageModel('claude-sonnet-5').doGenerate(options(maxOutputTokens));

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
}

function unproven(reason: string) {
  return { 'claude-cli': { code: 'continuation_unproven', reason } };
}

describe('a continued answer is rebuilt from the call\'s own event stream (#6791)', () => {
  test('the issue\'s reconstruction: prefix + continuation, and chronicle\'s parser accepts every proposal', async () => {
    await withCli({ verbose: continuedTurn() }, async (stub) => {
      const out = await generate(4000);
      expect(stub.argv()).toContain('--verbose');
      expect(out.finishReason).toBe('stop');
      expect(textOf(out.content)).toBe(PREFIX + CONTINUATION);
      const proposals = parseJudgeJson(textOf(out.content));
      expect(proposals).toHaveLength(2);
      expect(proposals!.every(isValidProposal)).toBe(true);
      expect(out.usage.outputTokens).toBe(4386);
    });
  });

  test('the tail alone is what the envelope reports and what chronicle rejects', () => {
    const tail = parseJudgeJson(CONTINUATION);
    expect(tail).toEqual(['person-a', 'person-c'] as unknown as typeof tail);
    expect(tail!.every(isValidProposal)).toBe(false);
  });

  test('segments without per-segment stop reasons or a visible nudge still rebuild', async () => {
    await withCli({ verbose: continuedTurn({ withNudge: false, stopReasons: false }) }, async () => {
      const out = await generate(4000);
      expect(out.finishReason).toBe('stop');
      expect(textOf(out.content)).toBe(PREFIX + CONTINUATION);
    });
  });

  test('a hermetic config dir does not matter: nothing is read from it', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'claude-continuation-config-'));
    try {
      await withCli({ verbose: continuedTurn() }, async (stub) => {
        await withEnv({ GBRAIN_CLAUDE_CLI_HERMETIC_CONFIG: configDir }, async () => {
          const out = await generate(4000);
          expect(stub.configDir()).toBe(configDir);
          expect(out.finishReason).toBe('stop');
          expect(textOf(out.content)).toBe(PREFIX + CONTINUATION);
        });
      });
      expect(readdirSync(configDir)).toEqual([]);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('no requested cap: two segments rebuild; the CLI default cap bounds a lone envelope', async () => {
    await withCli({ verbose: continuedTurn() }, async () => {
      const out = await generate();
      expect(out.finishReason).toBe('stop');
      expect(textOf(out.content)).toBe(PREFIX + CONTINUATION);
    });
    const over = envelope(CONTINUATION, { usage: { input_tokens: 10, output_tokens: 32_001 } });
    await withCli({ verbose: over, bare: over }, async () => {
      const out = await generate();
      expect(out.finishReason).toBe('length');
      expect(out.content).toEqual([{ type: 'text', text: '' }]);
      expect(out.providerMetadata).toEqual(unproven('events_missing'));
    });
    const under = envelope(CONTINUATION, { num_turns: 1, usage: { input_tokens: 10, output_tokens: 32_000 } });
    await withCli({ verbose: under, bare: under }, async () => {
      const out = await generate();
      expect(out.finishReason).toBe('stop');
      expect(textOf(out.content)).toBe(CONTINUATION);
    });
  });

  test('a single-segment answer is unchanged', async () => {
    const single = [init, assistant('msg_only', [{ type: 'text', text: PREFIX + CONTINUATION }], 'end_turn'),
      envelope(PREFIX + CONTINUATION, { num_turns: 1, usage: { input_tokens: 10, output_tokens: 300 } })];
    await withCli({ verbose: single }, async () => {
      const out = await generate(4000);
      expect(out.finishReason).toBe('stop');
      expect(out.content).toEqual([{ type: 'text', text: PREFIX + CONTINUATION }]);
      expect(out.providerMetadata).toBeUndefined();
    });
  });
});

describe('an unprovable continuation is a length outcome with no text and no tool calls (#6791)', () => {
  const cases: Array<[string, unknown, unknown, string]> = [
    ['the CLI printed only the envelope while usage exceeds the requested cap', envelope(CONTINUATION), envelope(CONTINUATION), 'events_missing'],
    ['the last segment does not match the envelope result',
      [init, assistant('a', [{ type: 'text', text: PREFIX }], 'max_tokens'), assistant('b', [{ type: 'text', text: 'other text' }], 'end_turn'), envelope(CONTINUATION)],
      undefined, 'segments_unmatched'],
    ['an earlier segment ended for a reason other than the cap',
      [init, assistant('a', [{ type: 'text', text: PREFIX }], 'end_turn'), assistant('b', [{ type: 'text', text: CONTINUATION }], 'end_turn'), envelope(CONTINUATION)],
      undefined, 'segments_unmatched'],
    ['the nudge between segments asks for a rewrite, not a resume',
      [init, assistant('a', [{ type: 'text', text: PREFIX }]), nudge('Your response above was cut off mid-stream and only your next message is delivered. Write the complete response again from the start.'),
        assistant('b', [{ type: 'text', text: CONTINUATION }]), envelope(CONTINUATION)],
      undefined, 'segments_unmatched'],
    ['a segment was retracted',
      [init, assistant('a', [{ type: 'text', text: PREFIX }]), { type: 'tombstone', message: { uuid: 'uuid-a-1' } }, assistant('b', [{ type: 'text', text: CONTINUATION }]), envelope(CONTINUATION)],
      undefined, 'segments_unmatched'],
    ['the event array carries no assistant message while usage exceeds the requested cap',
      [init, envelope(CONTINUATION)], undefined, 'no_assistant_events'],
    ['one segment but usage exceeds the requested cap',
      [init, assistant('a', [{ type: 'text', text: CONTINUATION }], 'end_turn'), envelope(CONTINUATION)],
      undefined, 'segments_unmatched'],
  ];
  for (const [label, verbose, bare, reason] of cases) {
    test(`${label} → ${reason}`, async () => {
      await withCli({ verbose, bare }, async () => {
        const out = await generate(4000);
        expect(out.finishReason).toBe('length');
        expect(out.content).toEqual([{ type: 'text', text: '' }]);
        expect(out.providerMetadata).toEqual(unproven(reason));
        expect(out.usage.outputTokens).toBe(4386);
      });
    });
  }

  afterEach(() => resetGateway());

  test('a valid write block in the tail of an unprovable continuation dispatches no tool handler', async () => {
    const block = '<use_tools>\n[{"name": "put_page", "input": {"slug": "notes/tail", "content": "tail only"}}]\n</use_tools>';
    const calls: unknown[] = [];
    await withCli({ verbose: envelope(block), bare: envelope(block) }, async () => {
      configureGateway({ chat_model: 'claude-cli:claude-sonnet-5', env: {} });
      const result = await toolLoop({
        initialMessages: [{ role: 'user', content: 'Write the page.' }],
        tools: [{ name: 'put_page', description: 'Write a page.', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, content: { type: 'string' } } } }],
        toolHandlers: new Map([['put_page', { execute: async (input: unknown) => { calls.push(input); return 'ok'; } }]]),
        maxTurns: 2,
        maxTokens: 4000,
      });
      expect(calls).toEqual([]);
      expect(result.stopReason).toBe('length');
      expect(result.finalText).toBe('');
      const answer = await chat({ messages: [{ role: 'user', content: 'Write the page.' }], maxTokens: 4000 });
      expect(answer.stopReason).toBe('length');
      expect(answer.text).toBe('');
      expect(answer.providerMetadata?.['claude-cli']).toEqual(unproven('events_missing')['claude-cli']);
    });
  }, 30_000);

  test('one stderr notice per process', async () => {
    const modulePath = join(import.meta.dir, '..', 'src', 'core', 'ai', 'providers', 'claude-cli-language-model.ts');
    const script = [
      `const { ClaudeCliLanguageModel } = await import(${JSON.stringify(modulePath)});`,
      'const opts = { prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }], maxOutputTokens: 4000 };',
      'for (let i = 0; i < 2; i++) {',
      '  const out = await new ClaudeCliLanguageModel("claude-sonnet-5").doGenerate(opts);',
      '  if (out.finishReason !== "length") throw new Error("expected length");',
      '}',
    ].join('\n');
    await withCli({ verbose: envelope(CONTINUATION), bare: envelope(CONTINUATION) }, async () => {
      const child = Bun.spawnSync([process.execPath, '-e', script], { env: { ...process.env }, stderr: 'pipe', stdout: 'pipe' });
      const stderr = child.stderr.toString();
      expect(child.exitCode, stderr).toBe(0);
      const notices = stderr.split('\n').filter(line => line.includes('continuation_unproven'));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('events_missing');
      expect(notices[0]).toContain('Remedy: upgrade the claude CLI');
      expect(notices[0]).toContain('gbrain errors continuation_unproven');
    });
  }, 30_000);

  test('one stderr notice per reason per process, naming that reason\'s remedy (segments_unmatched)', async () => {
    const modulePath = join(import.meta.dir, '..', 'src', 'core', 'ai', 'providers', 'claude-cli-language-model.ts');
    const script = [
      `const { ClaudeCliLanguageModel } = await import(${JSON.stringify(modulePath)});`,
      'const opts = { prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }], maxOutputTokens: 4000 };',
      'for (let i = 0; i < 2; i++) {',
      '  const out = await new ClaudeCliLanguageModel("claude-sonnet-5").doGenerate(opts);',
      '  if (out.finishReason !== "length") throw new Error("expected length");',
      '}',
    ].join('\n');
    await withCli({ verbose: [init, assistant('a', [{ type: 'text', text: PREFIX }], 'max_tokens'), assistant('b', [{ type: 'text', text: 'other text' }], 'end_turn'), envelope(CONTINUATION)], bare: envelope(CONTINUATION) }, async () => {
      const child = Bun.spawnSync([process.execPath, '-e', script], { env: { ...process.env }, stderr: 'pipe', stdout: 'pipe' });
      const stderr = child.stderr.toString();
      expect(child.exitCode, stderr).toBe(0);
      const notices = stderr.split('\n').filter(line => line.includes('continuation_unproven'));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('segments_unmatched');
      expect(notices[0]).toContain('Remedy: raise that caller\'s output cap');
      expect(notices[0]).toContain('gbrain errors continuation_unproven');
    });
  }, 30_000);
});

describe('#6791 an unprovable continuation takes each caller family\'s length path', () => {
  afterEach(() => resetGateway());
  const caps = (argv: string[]) => argv.filter(a => a.includes('CLAUDE_CODE_MAX_OUTPUT_TOKENS'))
    .map(a => Number((JSON.parse(a) as { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: string } }).env.CLAUDE_CODE_MAX_OUTPUT_TOKENS));

  test('propose_takes escalates once to its retry cap, then refuses the page without a tombstone', async () => {
    await withCli({ verbose: envelope(CONTINUATION), bare: envelope(CONTINUATION) }, async stub => {
      configureGateway({ chat_model: 'claude-cli:claude-sonnet-5', env: {} });
      const run = defaultExtractor({ pagePath: 'notes/tail', pageBody: 'Some prose.', existingTakes: [], maxTokens: 2000, retryMaxTokens: 8000 } as Parameters<typeof defaultExtractor>[0]);
      await expect(run).rejects.toThrow('output truncated (stopReason=length) even at maxTokens=8000');
      expect(stub.argv().filter(a => a === '--print')).toHaveLength(2);
      expect(caps(stub.argv())).toEqual([2000, 8000]);
    });
  }, 30_000);

  test('page summary classifies it malformed (title-only fall-back) instead of embedding an empty synopsis', async () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'claude-continuation-audit-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => withCli({ verbose: envelope(CONTINUATION), bare: envelope(CONTINUATION) }, async stub => {
        configureGateway({ chat_model: 'claude-cli:claude-sonnet-5', env: {} });
        const result = await generatePerChunkSynopsis({ documentText: 'Doc.', chunkText: 'Chunk.', pageTitle: 'Tail', pageSlug: 'notes/tail',
          sourceId: 'default', chunkIndex: 0, model: 'claude-cli:claude-sonnet-5', maxTokens: 4000 });
        expect(result.kind).toBe('malformed');
        expect('synopsis' in result).toBe(false);
        expect((result as { detail?: string }).detail).toContain('stop_reason=length');
        expect(stub.argv().filter(a => a === '--print')).toHaveLength(1);
      }));
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('#6791 the gateway keeps an unprovable continuation as a length result', () => {
  afterEach(() => resetGateway());

  test('chat() with a fallback chain returns it once, unretried, with its metadata; toolLoop dispatches nothing', async () => {
    const block = '<use_tools>\n[{"name": "put_page", "input": {"slug": "notes/tail", "content": "tail only"}}]\n</use_tools>';
    const calls: unknown[] = [];
    await withCli({ verbose: envelope(block), bare: envelope(block) }, async stub => {
      configureGateway({ chat_model: 'claude-cli:claude-sonnet-5', chat_fallback_chain: ['claude-cli:claude-haiku-5'], env: {} });
      const answer = await chat({ messages: [{ role: 'user', content: 'Write the page.' }], maxTokens: 4000 });
      expect(stub.argv().filter(a => a === '--print')).toHaveLength(1);
      expect(answer.stopReason).toBe('length');
      expect(answer.text).toBe('');
      expect(answer.fallbackFrom).toBeUndefined();
      expect(answer.blocks.filter(b => b.type === 'tool-call')).toEqual([]);
      expect(answer.providerMetadata?.['claude-cli']).toEqual({ code: 'continuation_unproven', reason: 'events_missing' });

      const result = await toolLoop({
        initialMessages: [{ role: 'user', content: 'Write the page.' }],
        tools: [{ name: 'put_page', description: 'Write a page.', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, content: { type: 'string' } } } }],
        toolHandlers: new Map([['put_page', { execute: async (input: unknown) => { calls.push(input); return 'ok'; } }]]),
        maxTurns: 3,
        maxTokens: 4000,
      });
      expect(calls).toEqual([]);
      expect(result.stopReason).toBe('length');
      expect(stub.argv().filter(a => a === '--print')).toHaveLength(2);
    });
  }, 30_000);
});
