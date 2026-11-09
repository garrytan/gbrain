/**
 * #6523: since #6424 forwarded a call's `maxTokens` as
 * CLAUDE_CODE_MAX_OUTPUT_TOKENS, Claude Code reports a response that hits
 * that cap as an `is_error: true` result envelope ("API Error: Claude's
 * response exceeded the N output token maximum. ..."), not as a success with
 * `stop_reason: 'max_tokens'`. `runClaude` rejected on `is_error`, so no
 * caller ever saw `finishReason: 'length'` and the escalation ladders
 * (loops_extract 2048 → 8192, facts/extract 1× → 2×) never fired: the minion
 * queue retried the same capped call three times and the job died.
 *
 * The provider now maps that envelope (anchored prefix, `is_error: true`, no
 * `api_error_status`, any cap, any exit code) to `length` with empty text and
 * the usage as reported. Every other error envelope stays a typed failure.
 *
 * A POSIX shell stub at GBRAIN_CLAUDE_CLI_BIN plays the CLI; it records the
 * cap it was handed so the ladder cases can assert the sequence of calls.
 * "Real gateway" below means the gateway code path with the stub transport;
 * no live provider account is used.
 *
 * Supersedes PR #6525 (@javieraldape), whose full-sentence match and exit-code
 * gate missed the discriminator cases below (R16).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { ClaudeCliLanguageModel, ClaudeCliProcessError } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LoopsExtractRetryableError, runLoopsExtract } from '../src/core/google/loops-extract.ts';
import { extractFactsFromTurnWithOutcome } from '../src/core/facts/extract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const capMessage = (cap: number) =>
  `API Error: Claude's response exceeded the ${cap} output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`;
const USAGE = { input_tokens: 10, output_tokens: 2048, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };

function envelope(result: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result', subtype: 'error_during_execution', is_error: true,
    result, stop_reason: null, session_id: 'synthetic-session', num_turns: 1, usage: USAGE,
    ...extra,
  };
}

interface Stub { dir: string; caps: () => string[] }

/**
 * Stage a stub `claude`. `responses` maps the forwarded cap (the env value,
 * '' when none was forwarded) to the stdout it prints and its exit code; `'*'`
 * is the fallback. Raw strings are printed verbatim (malformed stdout).
 */
async function withCli<T>(
  responses: Record<string, { body: unknown; exit: number }>,
  run: (stub: Stub) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-output-cap-'));
  const capsPath = join(dir, 'caps');
  const lines = ['#!/bin/sh', 'cat > /dev/null', `printf '%s\\n' "$CLAUDE_CODE_MAX_OUTPUT_TOKENS" >> "${capsPath}"`];
  for (const [cap, { body, exit }] of Object.entries(responses)) {
    const file = join(dir, `response-${cap === '*' ? 'default' : cap}.txt`);
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    if (cap !== '*') lines.push(`if [ "$CLAUDE_CODE_MAX_OUTPUT_TOKENS" = "${cap}" ]; then cat "${file}"; exit ${exit}; fi`);
    else lines.push(`cat "${file}"; exit ${exit}`);
  }
  if (!responses['*']) lines.push('echo "unexpected cap $CLAUDE_CODE_MAX_OUTPUT_TOKENS" >&2; exit 99');
  const bin = join(dir, 'claude');
  writeFileSync(bin, lines.join('\n') + '\n');
  chmodSync(bin, 0o755);
  const stub: Stub = { dir, caps: () => (existsSync(capsPath) ? readFileSync(capsPath, 'utf8').trimEnd().split('\n') : []) };
  try {
    return await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin, CLAUDE_CODE_MAX_OUTPUT_TOKENS: undefined }, () => run(stub));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function options(maxOutputTokens?: number): LanguageModelV2CallOptions {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic thread' }] }],
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  } as LanguageModelV2CallOptions;
}

const generate = (opts = options(2048)) => new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate(opts);

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('claude-cli output-cap envelope finishes as length (#6523)', () => {
  const positives: Array<[string, unknown, number, number | undefined]> = [
    ['exit 0, error_during_execution', envelope(capMessage(2048)), 0, 2048],
    ['exit 1', envelope(capMessage(2048)), 1, 2048],
    ['exit 2', envelope(capMessage(2048)), 2, 2048],
    ['verbose event-array form', [{ type: 'system', subtype: 'init' }, { type: 'assistant' }, envelope(capMessage(2048))], 1, 2048],
    ['subtype success as field-reported', envelope(capMessage(2048), { subtype: 'success' }), 1, 2048],
    ['no forwarded cap (the default cap was hit)', envelope(capMessage(32000)), 1, undefined],
    ['reported cap differs from the forwarded cap', envelope(capMessage(8192)), 1, 2048],
    ['changed trailing wording after the anchored prefix', envelope("API Error: Claude's response exceeded the 2048 output token maximum. Raise the limit in settings."), 1, 2048],
  ];
  for (const [label, body, exit, cap] of positives) {
    test(`${label} → length, empty text, usage as reported`, async () => {
      await withCli({ '*': { body, exit } }, async (stub) => {
        const out = await generate(options(cap));
        expect(out.finishReason).toBe('length');
        expect(out.content).toEqual([{ type: 'text', text: '' }]);
        expect(out.usage).toEqual({ inputTokens: 15, outputTokens: 2048, totalTokens: 2063, cachedInputTokens: 3 });
        expect(stub.caps()).toEqual([cap === undefined ? '' : String(cap)]);
      });
    });
  }

  test('usage absent → length with undefined usage, nothing invented', async () => {
    await withCli({ '*': { body: envelope(capMessage(2048), { usage: undefined }), exit: 1 } }, async () => {
      const out = await generate();
      expect(out.finishReason).toBe('length');
      expect(out.content).toEqual([{ type: 'text', text: '' }]);
      expect(out.usage).toEqual({ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, cachedInputTokens: undefined });
    });
  });

  test('error envelopes that are not the cap stay ClaudeCliProcessError with their status and exit code', async () => {
    const negatives: Array<[string, Record<string, unknown>]> = [
      ['api_error_status on the cap text', envelope(capMessage(2048), { api_error_status: 429 })],
      ['cap text after another sentence', envelope(`Authentication failed. ${capMessage(2048)}`, { api_error_status: 401 })],
      ['cap text quoted mid-answer', envelope(`Quoted provider documentation: ${capMessage(2048)}`)],
      ['insufficient credits', envelope('API Error: insufficient credits', { api_error_status: 402 })],
      ['server error carrying stop_reason max_tokens', envelope('API Error: transient server error', { stop_reason: 'max_tokens', api_error_status: 500 })],
      ['a non-string result', envelope(capMessage(2048), { result: { message: capMessage(2048) } })],
      ['is_error as a string', envelope(capMessage(2048), { is_error: 'true' })],
    ];
    for (const [label, body] of negatives) {
      for (const exit of [0, 1, 2]) {
        await withCli({ '*': { body, exit } }, async () => {
          const error = await rejection(generate);
          expect(error, `${label} (exit ${exit})`).toBeInstanceOf(ClaudeCliProcessError);
          expect((error as ClaudeCliProcessError).apiErrorStatus, label).toBe(body.api_error_status as number | undefined);
          expect((error as ClaudeCliProcessError).exitCode, label).toBe(exit);
        });
      }
    }
  });

  test('a success envelope quoting the prefix is ordinary model text', async () => {
    const quote = `The CLI said: ${capMessage(2048)}`;
    await withCli({ '*': { body: envelope(quote, { is_error: false, subtype: 'success', stop_reason: 'end_turn' }), exit: 0 } }, async () => {
      const out = await generate();
      expect(out.finishReason).toBe('stop');
      expect(out.content).toEqual([{ type: 'text', text: quote }]);
    });
    await withCli({ '*': { body: envelope(capMessage(2048), { is_error: false, subtype: 'success', stop_reason: 'end_turn' }), exit: 0 } }, async () => {
      const out = await generate();
      expect(out.finishReason).toBe('stop');
      expect(out.content).toEqual([{ type: 'text', text: capMessage(2048) }]);
    });
  });

  test('success + non-zero exit, exit 137 without an envelope, malformed stdout and a resultless event array still fail', async () => {
    await withCli({ '*': { body: envelope(capMessage(2048), { is_error: false, subtype: 'success' }), exit: 1 } }, async () => {
      const error = await rejection(generate);
      expect(error).toBeInstanceOf(ClaudeCliProcessError);
      expect((error as ClaudeCliProcessError).exitCode).toBe(1);
    });
    await withCli({ '*': { body: capMessage(2048), exit: 137 } }, async () => {
      const error = await rejection(generate);
      expect(error).toBeInstanceOf(ClaudeCliProcessError);
      expect((error as ClaudeCliProcessError).exitCode).toBe(137);
    });
    for (const body of [capMessage(2048), '"' + capMessage(2048) + '"', 'null', '2048']) {
      await withCli({ '*': { body, exit: 0 } }, async () => {
        const error = await rejection(generate);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('claude-cli output not JSON');
      });
    }
    await withCli({ '*': { body: [{ type: 'system', subtype: 'init' }, { type: 'assistant', message: capMessage(2048) }], exit: 0 } }, async () => {
      const error = await rejection(generate);
      expect((error as Error).message).toContain('had no "result" event');
    });
  });
});

const success = (text: string, usage: Record<string, number> = { input_tokens: 10, output_tokens: 30 }) =>
  envelope(text, { is_error: false, subtype: 'success', stop_reason: 'end_turn', usage });

describe('escalation ladders through the gateway with the stub transport', () => {
  const engines: Array<{ backend: string; engine: BrainEngine }> = [];
  const dbDir = mkdtempSync(join(tmpdir(), 'claude-output-cap-db-'));
  let closePostgres: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    for (const backend of testBackends()) {
      if (backend === 'pglite') {
        const engine = new PGLiteEngine();
        await engine.connect({ database_path: dbDir });
        await engine.initSchema();
        engines.push({ backend, engine });
      } else {
        const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engines.push({ backend, engine: isolated.engine });
        closePostgres = isolated.close;
      }
    }
  }, 120_000);
  afterEach(resetGateway);
  afterAll(async () => {
    resetGateway();
    for (const { engine } of engines) await engine.disconnect();
    await closePostgres?.();
    rmSync(dbDir, { recursive: true, force: true });
  });

  async function thread(engine: BrainEngine, slug: string) {
    await engine.executeRaw('DELETE FROM open_loops');
    await engine.putPage(slug, {
      type: 'email', title: 'Synthetic decision',
      compiled_truth: 'Which week works for the kickoff?',
      frontmatter: { thread_id: `thread-${slug}` },
    }, { sourceId: 'default' });
    configureGateway({ chat_model: 'claude-cli:claude-sonnet-4-6', env: {} });
  }

  test('loops_extract: a 2048 cap escalates once to 8192 and publishes the decision', async () => {
    const complete = success(JSON.stringify({
      commitments: [], decisions_pending: [{ text: 'Pick a kickoff week', quote: 'Which week works for the kickoff?' }],
    }));
    for (const { backend, engine } of engines) {
      await withCli({ '2048': { body: envelope(capMessage(2048)), exit: 1 }, '8192': { body: complete, exit: 0 } }, async (stub) => {
        await thread(engine, 'emails/output-cap-escalates');
        const result = await runLoopsExtract(engine, { slug: 'emails/output-cap-escalates', sourceId: 'default' });
        expect(result.status, backend).toBe('extracted');
        expect(result.decisions, backend).toBe(1);
        expect(stub.caps(), backend).toEqual(['2048', '8192']);
        const rows = await engine.executeRaw<{ summary: string }>('SELECT summary FROM open_loops');
        expect(rows.map(row => row.summary), backend).toEqual(['Pick a kickoff week']);
      });
    }
  }, 120_000);

  test('loops_extract: two cap failures stop at the ceiling as a retryable truncation with no rows and no third call', async () => {
    for (const { backend, engine } of engines) {
      await withCli({ '2048': { body: envelope(capMessage(2048)), exit: 1 }, '8192': { body: envelope(capMessage(8192)), exit: 1 } }, async (stub) => {
        await thread(engine, 'emails/output-cap-ceiling');
        const error = await rejection(() => runLoopsExtract(engine, { slug: 'emails/output-cap-ceiling', sourceId: 'default' }));
        expect(error, backend).toBeInstanceOf(LoopsExtractRetryableError);
        expect((error as LoopsExtractRetryableError).reason, backend).toBe('truncated');
        expect((error as Error).message, backend).toContain('8192-token');
        expect(stub.caps(), backend).toEqual(['2048', '8192']);
        expect(await engine.executeRaw('SELECT id FROM open_loops'), backend).toHaveLength(0);
      });
    }
  }, 120_000);

  test('facts/extract: a cap at the configured maximum retries once at twice the cap', async () => {
    const facts = success(JSON.stringify({
      facts: [{ fact: 'Alice-example will confirm the kickoff week in November.', entity: 'people/alice-example', kind: 'fact', confidence: 0.9, notability: 'medium' }],
    }));
    await withCli({ '4000': { body: envelope(capMessage(4000)), exit: 1 }, '8000': { body: facts, exit: 0 } }, async (stub) => {
      configureGateway({ chat_model: 'claude-cli:claude-sonnet-4-6', env: {} });
      const outcome = await extractFactsFromTurnWithOutcome({
        turnText: 'Alice-example said she will confirm the kickoff week in November.', source: 'test:output-cap',
        model: 'claude-cli:claude-sonnet-4-6',
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.facts.map(f => f.fact)).toEqual(['Alice-example will confirm the kickoff week in November.']);
      expect(stub.caps()).toEqual(['4000', '8000']);
    });
  }, 60_000);

  test('facts/extract: caps at both rungs end as truncated_output after exactly two calls', async () => {
    await withCli({ '4000': { body: envelope(capMessage(4000)), exit: 1 }, '8000': { body: envelope(capMessage(8000)), exit: 2 } }, async (stub) => {
      configureGateway({ chat_model: 'claude-cli:claude-sonnet-4-6', env: {} });
      const outcome = await extractFactsFromTurnWithOutcome({
        turnText: 'Alice-example said she will confirm the kickoff week in November.', source: 'test:output-cap',
        model: 'claude-cli:claude-sonnet-4-6',
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe('truncated_output');
      expect(stub.caps()).toEqual(['4000', '8000']);
    });
  }, 60_000);
});
