/**
 * #6523: Claude Code reports an output cap as an error envelope, not a successful
 * max_tokens response. It must reach callers as length without publishing the
 * diagnostic as model output. Existing stop-reason tests only stage successes;
 * mocked loops tests never exercise this transport failure. Real subprocess +
 * gateway + PGLite tests need no new production seam or live provider account.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { ClaudeCliLanguageModel, ClaudeCliProcessError } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LoopsExtractRetryableError, runLoopsExtract } from '../src/core/google/loops-extract.ts';
import { withEnv } from './helpers/with-env.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

afterEach(resetGateway);

const capMessage = (cap: number) => `API Error: Claude's response exceeded the ${cap} output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`;
function envelope(result: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result', subtype: 'error_during_execution', is_error: true,
    result, stop_reason: null, session_id: 'synthetic-session', num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 2048, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    ...extra,
  };
}

async function withCli<T>(response: unknown, exit: number, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-output-cap-'));
  const bin = join(dir, 'claude');
  writeFileSync(join(dir, 'response.json'), JSON.stringify(response));
  // Stage no user or provider state: the stub reads only these synthetic files.
  writeFileSync(bin, [
    '#!/bin/sh', 'cat > /dev/null',
    `printf '%s\\n' "$CLAUDE_CODE_MAX_OUTPUT_TOKENS" >> "${join(dir, 'caps')}"`,
    `cat "${join(dir, 'response.json')}"`, `exit ${exit}`,
  ].join('\n'));
  chmodSync(bin, 0o755);
  try {
    return await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin }, () => run(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const options: LanguageModelV2CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic thread' }] }],
  maxOutputTokens: 2048,
};

describe('claude-cli output-cap envelopes', () => {
  for (const exit of [0, 1]) {
    for (const verbose of [false, true]) {
      test(`length with empty content and honest usage (exit ${exit}, verbose ${verbose})`, async () => {
        const error = envelope(capMessage(2048));
        await withCli(verbose ? [{ type: 'system' }, error] : error, exit, async () => {
          const out = await new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate(options);
          expect(out.finishReason).toBe('length');
          expect(out.content).toEqual([{ type: 'text', text: '' }]);
          expect(out.usage).toEqual({ inputTokens: 15, outputTokens: 2048, totalTokens: 2063, cachedInputTokens: 3 });
        });
      });
    }
  }

  test('does not invent usage if the CLI omits it', async () => {
    await withCli(envelope(capMessage(2048), { usage: undefined }), 1, async () => {
      const out = await new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate(options);
      expect(out.finishReason).toBe('length');
      expect(out.usage.inputTokens).toBeUndefined();
      expect(out.usage.outputTokens).toBeUndefined();
      expect(out.usage.totalTokens).toBeUndefined();
    });
  });

  test('API errors, embedded cap quotes, wrong caps and unrelated errors remain typed failures', async () => {
    for (const error of [
      envelope(capMessage(2048), { api_error_status: 429 }),
      envelope(`Authentication failed. ${capMessage(2048)}`, { api_error_status: 401 }),
      envelope(`Quoted provider documentation: ${capMessage(2048)}`),
      envelope(capMessage(8192)),
      envelope('API Error: insufficient credits', { api_error_status: 402 }),
      envelope('API Error: transient server error', { stop_reason: 'max_tokens', api_error_status: 500 }),
    ]) {
      for (const exit of [0, 1]) {
        await withCli(error, exit, async () => {
          try {
            await new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate(options);
            throw new Error('expected a provider failure');
          } catch (errorThrown) {
            expect(errorThrown).toBeInstanceOf(ClaudeCliProcessError);
            expect((errorThrown as ClaudeCliProcessError).apiErrorStatus).toBe(error.api_error_status as number | undefined);
            expect((errorThrown as ClaudeCliProcessError).exitCode).toBe(exit);
          }
        });
      }
    }
  });

  test('a crashed process and a success envelope with nonzero exit are not length', async () => {
    for (const [response, exit] of [
      [envelope(capMessage(2048)), 137],
      [envelope(capMessage(2048), { is_error: false, subtype: 'success' }), 1],
    ] as const) {
      await withCli(response, exit, async () => {
        await expect(new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate(options)).rejects.toBeInstanceOf(ClaudeCliProcessError);
      });
    }
  });
});

let engine: PGLiteEngine;
async function withThread(run: (engine: PGLiteEngine) => Promise<void>) {
  try {
    await resetPgliteState(engine);
    await engine.putPage('emails/output-cap', {
      type: 'email', title: 'Synthetic decision',
      compiled_truth: 'Which week works for the kickoff?',
      frontmatter: { thread_id: 'synthetic-thread' },
    }, { sourceId: 'default' });
    configureGateway({ chat_model: 'claude-cli:claude-sonnet-4-6', env: {} });
    await run(engine);
  } finally {
    resetGateway();
  }
}

describe('real gateway open-loop escalation', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => {
    await engine.disconnect();
  });

  test('2048 cap error escalates once to 8192 and publishes the complete decision', async () => {
    await withCli(envelope(capMessage(2048)), 1, async (dir) => {
      const bin = join(dir, 'claude');
      writeFileSync(join(dir, 'complete.json'), JSON.stringify(envelope(JSON.stringify({
        commitments: [], decisions_pending: [{ text: 'Pick a kickoff week', quote: 'Which week works for the kickoff?' }],
      }), { is_error: false, subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 30 } })));
      writeFileSync(bin, [
        '#!/bin/sh', 'cat > /dev/null',
        `printf '%s\\n' "$CLAUDE_CODE_MAX_OUTPUT_TOKENS" >> "${join(dir, 'caps')}"`,
        'if [ "$CLAUDE_CODE_MAX_OUTPUT_TOKENS" = 2048 ]; then',
        `  cat "${join(dir, 'response.json')}"; exit 1`,
        'fi', `cat "${join(dir, 'complete.json')}"`,
      ].join('\n'));
      await withThread(async (engine) => {
        const result = await runLoopsExtract(engine, { slug: 'emails/output-cap', sourceId: 'default' });
        expect(result.status).toBe('extracted');
        expect(result.decisions).toBe(1);
        expect(readFileSync(join(dir, 'caps'), 'utf8').trim().split('\n')).toEqual(['2048', '8192']);
        const rows = await engine.executeRaw<{ summary: string }>('SELECT summary FROM open_loops');
        expect(rows.map(row => row.summary)).toEqual(['Pick a kickoff week']);
      });
    });
  }, 120_000);

  test('two cap failures stop at the ceiling without writing or a third model call', async () => {
    await withCli(null, 1, async (dir) => {
      writeFileSync(join(dir, 'cap-2048.json'), JSON.stringify(envelope(capMessage(2048))));
      writeFileSync(join(dir, 'cap-8192.json'), JSON.stringify(envelope(capMessage(8192))));
      writeFileSync(join(dir, 'claude'), [
        '#!/bin/sh', 'cat > /dev/null',
        `printf '%s\\n' "$CLAUDE_CODE_MAX_OUTPUT_TOKENS" >> "${join(dir, 'caps')}"`,
        `cat "${dir}/cap-$CLAUDE_CODE_MAX_OUTPUT_TOKENS.json"`, 'exit 1',
      ].join('\n'));
      await withThread(async (engine) => {
        try {
          await runLoopsExtract(engine, { slug: 'emails/output-cap', sourceId: 'default' });
          throw new Error('expected bounded truncation failure');
        } catch (error) {
          expect(error).toBeInstanceOf(LoopsExtractRetryableError);
          expect((error as LoopsExtractRetryableError).reason).toBe('truncated');
          expect((error as Error).message).toContain('8192-token');
        }
        expect(readFileSync(join(dir, 'caps'), 'utf8').trim().split('\n')).toEqual(['2048', '8192']);
        expect(await engine.executeRaw('SELECT id FROM open_loops')).toHaveLength(0);
        expect(await engine.executeRaw('SELECT id FROM facts')).toHaveLength(0);
      });
    });
  }, 120_000);
});
