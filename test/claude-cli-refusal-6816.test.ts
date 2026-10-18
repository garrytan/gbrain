/**
 * #6816: Claude Code reports a usage-policy refusal as an error envelope with no API status
 * ("API Error: <model> can't help with this. Start a new session to continue. ... https://www.anthropic.com/legal/aup").
 * `providerContentBlockReason` knew only the OpenAI, Azure, DeepSeek and Gemini shapes, so extract_atoms treated the
 * refusal as a generic error: it counted the item but never took the bounded content-block tombstone, and the same item
 * went back to the model on every run.
 *
 * A POSIX shell stub at GBRAIN_CLAUDE_CLI_BIN plays the CLI; the extract_atoms case runs the real gateway `chat()` with
 * the claude-cli recipe, so the error is built by the real adapter and normalized by the real gateway.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { ClaudeCliLanguageModel, ClaudeCliProcessError } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { chat, configureGateway, resetGateway, type ChatOpts } from '../src/core/ai/gateway.ts';
import { normalizeAIError, providerContentBlockReason } from '../src/core/ai/errors.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { discoverExtractablePages, EXTRACT_ATOMS_MODEL_KEY, MAX_DETERMINISTIC_FAILURES } from '../src/core/cycle/extract-atoms.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from './helpers/extract-atoms-page-fixtures.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const AUP = 'https://www.anthropic.com/legal/aup';
const refusals: Array<[string, string]> = [
  ['current wording (-p)', `API Error: Claude can't help with this. Start a new session to continue.\n\nLearn more: ${AUP}`],
  ['model name, feedback line, details and request id', `API Error: Sonnet 5 can't help with this. Start a new session to continue. Send feedback with /feedback or learn more: ${AUP} Details: \`[bio]\` Request ID: req_000000000000000000000000`],
  ['curly apostrophe', `API Error: Claude can\u2019t help with this. Start a new session to continue.\n\nLearn more: ${AUP}`],
  ['safeguards flagged (a fallback model exists)', `API Error: Sonnet 5's safeguards flagged this message (${AUP}). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Sonnet 5.`],
  ['pre-2.1.219 wording', `API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (${AUP}). Please double press esc to edit your last message or start a new session for Claude Code to assist with a different task.`],
];
const ordinary: Array<[string, Record<string, unknown>]> = [
  ['an API status on the refusal text', { result: refusals[0]![1], api_error_status: 400 }],
  ['insufficient credits', { result: 'API Error: insufficient credits', api_error_status: 402 }],
  ['a connection error', { result: 'API Error: Connection error.' }],
  ['the policy link without a refusal phrase', { result: `API Error: request rejected; see ${AUP}` }],
  ['a refusal phrase without the policy link', { result: "API Error: Claude can't help with this. Start a new session to continue." }],
  ['refusal text quoted after another message', { result: `Tool output: ${refusals[0]![1]}` }],
  ['an execution error with no result', { result: '', subtype: 'error_during_execution' }],
];
const envelope = (extra: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: true, stop_reason: null,
  session_id: 'synthetic-session', num_turns: 1, usage: { input_tokens: 10, output_tokens: 0 }, ...extra });

async function withCli<T>(body: unknown, run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-refusal-'));
  const response = join(dir, 'response.json');
  writeFileSync(response, JSON.stringify(body));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\ncat "${response}"\nexit 1\n`);
  chmodSync(bin, 0o755);
  try { return await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin, CLAUDE_CODE_MAX_OUTPUT_TOKENS: undefined }, run); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

async function cliError(body: unknown): Promise<unknown> {
  return withCli(body, async () => {
    try {
      await new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic page' }] }] } as LanguageModelV2CallOptions);
    } catch (error) { return error; }
    throw new Error('expected the CLI call to reject');
  });
}

describe('providerContentBlockReason: claude-cli usage-policy refusals (#6816)', () => {
  for (const [label, result] of refusals) {
    test(`${label} is a content block, raw and normalized`, async () => {
      const error = await cliError(envelope({ result }));
      expect(error).toBeInstanceOf(ClaudeCliProcessError);
      expect(providerContentBlockReason(error)).toBe('claude_cli_usage_policy');
      expect(providerContentBlockReason(normalizeAIError(error, 'chat(claude-cli:claude-sonnet-4-6)'))).toBe('claude_cli_usage_policy');
    });
  }
  for (const [label, extra] of ordinary) {
    test(`${label} stays an ordinary claude-cli error`, async () => {
      const error = await cliError(envelope(extra));
      expect(error).toBeInstanceOf(ClaudeCliProcessError);
      expect(providerContentBlockReason(error)).toBeUndefined();
      expect(providerContentBlockReason(normalizeAIError(error, 'chat(claude-cli:claude-sonnet-4-6)'))).toBeUndefined();
    });
  }
  test('the same text from anything but the claude-cli adapter is not a claude-cli refusal', () => {
    expect(providerContentBlockReason(new Error(`claude-cli reported error: ${refusals[0]![1]}`))).toBeUndefined();
  });
});

describe('extract_atoms on claude-cli (#6816)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); await engine.setConfig(EXTRACT_ATOMS_MODEL_KEY, 'claude-cli:claude-sonnet-4-6'); resetGateway(); configureGateway({ chat_model: 'claude-cli:claude-sonnet-4-6', env: {} }); });
  afterEach(resetGateway);

  const seed = async (slug: string) => engine.putPage(slug, { title: slug, type: 'note', compiled_truth: 'refused prose '.repeat(40) } as never, { sourceId: 'default' });
  const run = (slug: string) => runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: [],
    _pages: [{ slug, content: 'refused prose '.repeat(40), contentHash: 'c'.repeat(16) }], _chat: (opts: ChatOpts) => chat(opts) });
  const state = async (slug: string) => (await engine.executeRaw<{ fail_count: number; tombstoned: boolean }>(
    'SELECT scan.fail_count, scan.tombstoned FROM extract_atoms_page_state scan JOIN pages p ON p.id=scan.page_id WHERE p.slug=$1', [slug]))[0];

  test('a usage-policy refusal takes the bounded content-block tombstone instead of being retried on every run', async () => {
    await seed('note/refused');
    await withCli(envelope({ result: refusals[0]![1] }), async () => {
      for (let n = 1; n <= MAX_DETERMINISTIC_FAILURES; n++) {
        const result = await run('note/refused');
        expect(result.details.aborted_global_error).toBeUndefined();
        expect((result.details.failures as Array<{ error: string }>)[0]!.error).toContain(`provider blocked content: claude_cli_usage_policy (consecutive failure ${n}`);
        expect((await state('note/refused'))).toMatchObject({ fail_count: n, tombstoned: n === MAX_DETERMINISTIC_FAILURES });
      }
    });
    expect((await discoverExtractablePages(engine, 'default')).map(p => p.slug)).not.toContain('note/refused');
  });

  test('an ordinary claude-cli error is not treated as a content block', async () => {
    await seed('note/ordinary');
    await withCli(envelope({ result: 'API Error: request rejected for an unexpected reason' }), async () => {
      const result = await run('note/ordinary');
      expect(JSON.stringify(result.details.failures)).not.toContain('provider blocked content');
    });
    expect((await state('note/ordinary'))?.tombstoned ?? false).toBe(false);
  });
});
