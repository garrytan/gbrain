/**
 * Unit tests for the claude-cli MessagesClient adapter — focused on the
 * pure transformation surface (system-prompt construction, tool-call
 * extraction, content-block assembly). Subprocess invocation is covered
 * via dependency injection of a fake CLAUDE_BIN that emits a known
 * --output-format json envelope, so these tests run without claude-cli
 * installed and without API credits.
 *
 * The integration test (e2e/claude-cli-tool-loop.test.ts) drives a real
 * subagent loop through the adapter with a stubbed claude-cli; it lives
 * separately because it touches PGLite + the queue.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';

// Stub claude binary that echoes a scripted `--output-format json` envelope.
// Each test stages a `claude_response.json` file the stub reads on every call.
const stubDir = join(tmpdir(), `claude-cli-stub-${process.pid}`);
const stubBin = join(stubDir, 'claude');
const stubResponsePath = join(stubDir, 'claude_response.json');

beforeAll(() => {
  mkdirSync(stubDir, { recursive: true });
  // POSIX shell stub. Reads stdin (the prompt) to /dev/null and emits the
  // canned JSON response. Validates --print --output-format json --model
  // are passed so a contract regression in the adapter is caught here too.
  const stub = [
    '#!/bin/sh',
    'cat > /dev/null',
    '# Sanity: we expect --print --output-format json --model in argv.',
    'case " $* " in',
    '  *" --print "*) ;;',
    '  *) echo "missing --print in argv: $*" >&2; exit 64 ;;',
    'esac',
    `cat "${stubResponsePath}"`,
  ].join('\n');
  writeFileSync(stubBin, stub);
  chmodSync(stubBin, 0o755);
  process.env.GBRAIN_CLAUDE_CLI_BIN = stubBin;
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
  delete process.env.GBRAIN_CLAUDE_CLI_BIN;
});

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
    session_id: 'test-session-' + Math.random().toString(36).slice(2, 8),
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

describe('claude-cli adapter — text-only round trip', () => {
  test('returns a single text block with usage + end_turn stop reason', async () => {
    stageResponse(baseEnvelope('hello world'));

    const { makeClaudeCliClient } = await import('../src/core/minions/handlers/claude-cli-adapter.ts');
    const client = makeClaudeCliClient();
    const message = await client.create({
      model: 'sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    expect(message.role).toBe('assistant');
    expect(message.type).toBe('message');
    expect(message.stop_reason).toBe('end_turn');
    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toEqual({ type: 'text', text: 'hello world' });
    expect(message.usage.input_tokens).toBe(12);
    expect(message.usage.output_tokens).toBe(34);
  });

  test('strips provider prefixes from the model id', async () => {
    stageResponse(baseEnvelope('ok'));
    const { makeClaudeCliClient } = await import('../src/core/minions/handlers/claude-cli-adapter.ts');
    const client = makeClaudeCliClient();
    const message = await client.create({
      model: 'anthropic:claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    // Adapter records the normalized model id on the returned message so
    // downstream cost/audit consumers see the cleaned form.
    expect(message.model).toBe('claude-sonnet-4-6');
  });
});

describe('claude-cli adapter — tool use', () => {
  test('parses <use_tools> block into tool_use content blocks', async () => {
    stageResponse(
      baseEnvelope(
        [
          'I need to look up the pattern first.',
          '<use_tools>',
          '[',
          '  {"id": "toolu_01ABCDEF", "name": "search", "input": {"query": "n+1 query"}}',
          ']',
          '</use_tools>',
        ].join('\n'),
        { stop_reason: 'tool_use' },
      ),
    );

    const { makeClaudeCliClient } = await import('../src/core/minions/handlers/claude-cli-adapter.ts');
    const client = makeClaudeCliClient();
    const message = await client.create({
      model: 'sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'find n+1 queries' }],
      tools: [
        {
          name: 'search',
          description: 'Search the brain',
          input_schema: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming);

    expect(message.stop_reason).toBe('tool_use');
    // Expect a text block followed by a tool_use block.
    expect(message.content).toHaveLength(2);
    expect(message.content[0]).toMatchObject({ type: 'text', text: 'I need to look up the pattern first.' });
    expect(message.content[1]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_01ABCDEF',
      name: 'search',
      input: { query: 'n+1 query' },
    });
  });

  test('parses multiple parallel tool calls from one block', async () => {
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
        { stop_reason: 'tool_use' },
      ),
    );
    const { makeClaudeCliClient } = await import('../src/core/minions/handlers/claude-cli-adapter.ts');
    const client = makeClaudeCliClient();
    const message = await client.create({
      model: 'sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'multi' }],
      tools: [
        { name: 'search', description: 's', input_schema: { type: 'object', properties: {} } },
        { name: 'get_page', description: 'g', input_schema: { type: 'object', properties: {} } },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const toolUses = message.content.filter(b => b.type === 'tool_use');
    expect(toolUses).toHaveLength(2);
    expect(toolUses.map(b => (b as Anthropic.ToolUseBlock).name)).toEqual(['search', 'get_page']);
    expect(message.stop_reason).toBe('tool_use');
  });

  test('tolerates fenced JSON inside <use_tools>', async () => {
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
    const { makeClaudeCliClient } = await import('../src/core/minions/handlers/claude-cli-adapter.ts');
    const client = makeClaudeCliClient();
    const message = await client.create({
      model: 'sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'fenced' }],
      tools: [{ name: 'search', description: '', input_schema: { type: 'object', properties: {} } }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const toolUses = message.content.filter(b => b.type === 'tool_use');
    expect(toolUses).toHaveLength(1);
    expect((toolUses[0] as Anthropic.ToolUseBlock).name).toBe('search');
  });

  test('synthesizes an id when the model omits it', async () => {
    stageResponse(
      baseEnvelope(
        [
          '<use_tools>',
          '[{"name": "search", "input": {"q": "x"}}]',
          '</use_tools>',
        ].join('\n'),
      ),
    );
    const { makeClaudeCliClient } = await import('../src/core/minions/handlers/claude-cli-adapter.ts');
    const client = makeClaudeCliClient();
    const message = await client.create({
      model: 'sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'no id' }],
      tools: [{ name: 'search', description: '', input_schema: { type: 'object', properties: {} } }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const toolUses = message.content.filter(b => b.type === 'tool_use');
    expect(toolUses).toHaveLength(1);
    const synthId = (toolUses[0] as Anthropic.ToolUseBlock).id;
    expect(synthId).toMatch(/^toolu_claude_cli_/);
  });

  test('falls back to text when block is malformed JSON', async () => {
    stageResponse(
      baseEnvelope(
        [
          '<use_tools>',
          'not valid json at all',
          '</use_tools>',
        ].join('\n'),
      ),
    );
    const { makeClaudeCliClient } = await import('../src/core/minions/handlers/claude-cli-adapter.ts');
    const client = makeClaudeCliClient();
    const message = await client.create({
      model: 'sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'malformed' }],
      tools: [{ name: 'search', description: '', input_schema: { type: 'object', properties: {} } }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    // No tool_use blocks because parse failed; the raw body lands as text.
    expect(message.content.filter(b => b.type === 'tool_use')).toHaveLength(0);
    expect(message.stop_reason).toBe('end_turn');
  });

  test('drops the use_tools block when the close tag is missing', async () => {
    // Unterminated <use_tools> — adapter should treat as plain text and let
    // the subagent loop terminate gracefully rather than throw.
    stageResponse(
      baseEnvelope(
        [
          '<use_tools>',
          '[{"id": "toolu_X", "name": "search", "input": {}}',
          '(eof — no close tag)',
        ].join('\n'),
      ),
    );
    const { makeClaudeCliClient } = await import('../src/core/minions/handlers/claude-cli-adapter.ts');
    const client = makeClaudeCliClient();
    const message = await client.create({
      model: 'sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'unterminated' }],
      tools: [{ name: 'search', description: '', input_schema: { type: 'object', properties: {} } }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    expect(message.content.filter(b => b.type === 'tool_use')).toHaveLength(0);
    expect(message.stop_reason).toBe('end_turn');
  });
});

describe('claude-cli adapter — abort semantics', () => {
  test('SIGTERMs the child on AbortSignal', async () => {
    // A stub that sleeps long enough that we can abort it. We replace the
    // shared stub for this test, then restore it.
    const slowStub = [
      '#!/bin/sh',
      'cat > /dev/null',
      'sleep 30',
      'echo "{}"',
    ].join('\n');
    writeFileSync(stubBin, slowStub);
    chmodSync(stubBin, 0o755);
    try {
      const { makeClaudeCliClient } = await import('../src/core/minions/handlers/claude-cli-adapter.ts');
      const client = makeClaudeCliClient();
      const ac = new AbortController();
      const promise = client.create(
        {
          model: 'sonnet',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'slow' }],
        } as Anthropic.MessageCreateParamsNonStreaming,
        { signal: ac.signal },
      );
      setTimeout(() => ac.abort(), 30);
      await expect(promise).rejects.toThrow(/aborted/);
    } finally {
      // Restore the fast stub for any subsequent test ordering.
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

describe('claude-cli adapter — context isolation', () => {
  test('passes --disable-slash-commands and --system-prompt to suppress CLAUDE.md contamination', async () => {
    // Replace the stub with one that records argv and cwd for inspection.
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

    const { makeClaudeCliClient } = await import('../src/core/minions/handlers/claude-cli-adapter.ts');
    const client = makeClaudeCliClient();
    await client.create({
      model: 'sonnet',
      max_tokens: 1024,
      system: 'You are gbrain subagent.',
      messages: [{ role: 'user', content: 'hi' }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const argv = require('node:fs').readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
    const cwd = require('node:fs').readFileSync(cwdLog, 'utf8').trim();

    expect(argv).toContain('--print');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('json');
    expect(argv).toContain('--disable-slash-commands');
    expect(argv).toContain('--system-prompt');
    expect(argv).toContain('You are gbrain subagent.');
    // cwd must NOT be a directory containing CLAUDE.md — the adapter
    // spawns from a dedicated tmpdir for context isolation.
    expect(cwd).toMatch(/gbrain-claude-cli-cwd-\d+$/);

    // Restore the standard stub for any subsequent test ordering.
    const fastStub = [
      '#!/bin/sh',
      'cat > /dev/null',
      `cat "${stubResponsePath}"`,
    ].join('\n');
    writeFileSync(stubBin, fastStub);
    chmodSync(stubBin, 0o755);
  });
});

describe('claude-cli adapter — error envelopes', () => {
  test('rejects when the stub reports is_error: true', async () => {
    stageResponse({ ...baseEnvelope('boom'), is_error: true });
    const { makeClaudeCliClient } = await import('../src/core/minions/handlers/claude-cli-adapter.ts');
    const client = makeClaudeCliClient();
    await expect(
      client.create(
        { model: 'sonnet', max_tokens: 1024, messages: [{ role: 'user', content: 'x' }] } as Anthropic.MessageCreateParamsNonStreaming,
      ),
    ).rejects.toThrow(/claude-cli reported error/);
  });

  test('rejects when the stub emits non-JSON', async () => {
    writeFileSync(stubResponsePath, 'this is not json');
    const { makeClaudeCliClient } = await import('../src/core/minions/handlers/claude-cli-adapter.ts');
    const client = makeClaudeCliClient();
    await expect(
      client.create(
        { model: 'sonnet', max_tokens: 1024, messages: [{ role: 'user', content: 'x' }] } as Anthropic.MessageCreateParamsNonStreaming,
      ),
    ).rejects.toThrow(/claude-cli output not JSON/);
  });
});
