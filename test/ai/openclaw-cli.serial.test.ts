/** Native child-process protocol tests; no provider or live brain is used. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatViaOpenClaw } from '../../src/core/ai/openclaw-cli.ts';
import { chat, configureGateway, withBudgetTracker } from '../../src/core/ai/gateway.ts';
import { BudgetTracker, parsePricingOverrides } from '../../src/core/budget/budget-tracker.ts';
import { withAIInvocationGuard } from '../../src/core/ai/invocation-guard.ts';

let root: string;
let previousPath: string | undefined;
const opts = { system: 'Extract explicit facts.', messages: [{ role: 'user' as const, content: 'Synthetic fixture input.' }] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-openclaw-cli-'));
  const binary = join(root, 'openclaw');
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@" > "$GBRAIN_TEST_CLI_CAPTURE"\nprintf "%s" "$GBRAIN_TEST_CLI_STDOUT"\nif [ "$GBRAIN_TEST_CLI_WAIT" = 1 ]; then printf "%s" "SYNTHETIC_PROVIDER_OUTPUT_MARKER" >&2; /bin/sleep 1; fi\nif [ "$GBRAIN_TEST_CLI_FAIL" = 1 ]; then printf "%s" "Synthetic fixture input." >&2; exit 1; fi\n');
  chmodSync(binary, 0o700);
  previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath ?? ''}`;
  process.env.GBRAIN_TEST_CLI_CAPTURE = join(root, 'args');
  process.env.GBRAIN_TEST_CLI_STDOUT = JSON.stringify({ ok: true, provider: 'openai', model: 'fixture-model', outputs: [{ text: 'Fixture answer.' }] });
  delete process.env.GBRAIN_TEST_CLI_FAIL;
  delete process.env.GBRAIN_TEST_CLI_WAIT;
});

afterEach(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  for (const key of ['GBRAIN_TEST_CLI_CAPTURE', 'GBRAIN_TEST_CLI_STDOUT', 'GBRAIN_TEST_CLI_FAIL', 'GBRAIN_TEST_CLI_WAIT']) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

test('uses raw gateway inference, renders roles and reports the answering model', async () => {
  const result = await chatViaOpenClaw('openclaw:default', opts);
  const args = readFileSync(join(root, 'args'), 'utf8');
  expect(args).toStartWith('infer\nmodel\nrun\n--gateway\n--json\n--prompt\n');
  expect(args).toContain('SYSTEM:\nExtract explicit facts.\n\nUSER:\nSynthetic fixture input.');
  expect(args).not.toContain('--model');
  expect(result.text).toBe('Fixture answer.');
  expect(result.model).toBe('openclaw:openai/fixture-model');
  expect(result.providerMetadata?.openclaw.usageReported).toBe(false);
});

test('passes an explicit model without a credential or agent-session override', async () => {
  await chatViaOpenClaw('openclaw:openai/fixture-model', opts);
  const args = readFileSync(join(root, 'args'), 'utf8');
  expect(args).toContain('--model\nopenai/fixture-model\n');
  expect(args).not.toContain('--agent');
  expect(args).not.toContain('--api-key');
});

test('the public chat gateway reaches the raw CLI provider without a direct API key', async () => {
  configureGateway({ chat_model: 'openclaw:default', env: {} });
  const result = await chat({ ...opts, model: 'openclaw:default' });
  expect(result.text).toBe('Fixture answer.');
  expect(result.providerId).toBe('openclaw');
  expect(readFileSync(join(root, 'args'), 'utf8')).toStartWith('infer\nmodel\nrun\n--gateway\n');
});

test('a finite BudgetTracker refuses raw inference before dispatch even with explicit pricing', async () => {
  configureGateway({ chat_model: 'openclaw:default', env: {} });
  const tracker = new BudgetTracker({ maxCostUsd: 1, label: 'fixture', auditPath: join(root, 'audit.jsonl'),
    pricingOverrides: parsePricingOverrides('{"openclaw:default":{"input":1,"output":1}}') });
  await expect(withBudgetTracker(tracker, () => chat({ ...opts, model: 'openclaw:default' })))
    .rejects.toThrow('cannot enforce a finite cost ceiling');
  expect(existsSync(join(root, 'args'))).toBe(false);
  expect(tracker.totalSpent).toBe(0);
  expect(tracker.snapshot().callsRecorded).toBe(0);
});

test('in-flight cancellation keeps abort semantics without child-process data', async () => {
  process.env.GBRAIN_TEST_CLI_WAIT = '1';
  const controller = new AbortController();
  const pending = chatViaOpenClaw('openclaw:default', { ...opts, abortSignal: controller.signal }).catch(error => error);
  try {
    for (let i = 0; i < 200 && !existsSync(join(root, 'args')); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(existsSync(join(root, 'args'))).toBe(true);
    controller.abort();
    const error = await pending;
    expect(error.name).toBe('AbortError');
    const serialized = `${error.message}\n${JSON.stringify(error)}\n${JSON.stringify(error.cause)}`;
    expect(serialized).not.toContain('Synthetic fixture input.');
    expect(serialized).not.toContain('SYNTHETIC_PROVIDER_OUTPUT_MARKER');
    expect(serialized).not.toContain('--prompt');
  } finally { controller.abort(); await pending; }
});

test('subprocess failure never exposes its echoed input', async () => {
  process.env.GBRAIN_TEST_CLI_FAIL = '1';
  try { await chatViaOpenClaw('openclaw:default', opts); throw new Error('unexpected success'); }
  catch (error) {
    expect(String(error)).toContain('OpenClaw raw inference failed');
    expect(String(error)).not.toContain('Synthetic fixture input.');
  }
});

test('malformed JSON never exposes provider output in the parse error', async () => {
  process.env.GBRAIN_TEST_CLI_STDOUT = 'Synthetic fixture input.';
  await expect(chatViaOpenClaw('openclaw:default', opts)).rejects.toThrow('OpenClaw raw inference returned malformed JSON.');
});

test('a failure envelope and empty text cannot become a successful answer', async () => {
  process.env.GBRAIN_TEST_CLI_STDOUT = JSON.stringify({ ok: false, error: 'Synthetic fixture input.' });
  await expect(chatViaOpenClaw('openclaw:default', opts)).rejects.toThrow('OpenClaw raw inference returned a failure envelope.');
  process.env.GBRAIN_TEST_CLI_STDOUT = JSON.stringify({ ok: true, outputs: [{ text: '' }] });
  await expect(chatViaOpenClaw('openclaw:default', opts)).rejects.toThrow('OpenClaw raw inference returned no text.');
});

test('invocation admission can refuse before starting the CLI', async () => {
  await expect(withAIInvocationGuard(async () => { throw new Error('fixture admission refused'); },
    () => chatViaOpenClaw('openclaw:default', opts))).rejects.toThrow('fixture admission refused');
  expect(existsSync(join(root, 'args'))).toBe(false);
});

test('unknown native usage settles as unknown, not fabricated zero-token usage', async () => {
  const settlements: unknown[] = [];
  await withAIInvocationGuard(async call => {
    expect(call.model).toBe('openclaw:default');
    expect(call.maxOutputTokens).toBeUndefined();
    return { settle: async usage => { settlements.push(usage); } };
  }, () => chatViaOpenClaw('openclaw:default', opts));
  expect(settlements).toEqual([null]);
});

test('pre-aborted calls and unsupported tools never start raw inference', async () => {
  await expect(chatViaOpenClaw('openclaw:default', { ...opts, abortSignal: AbortSignal.abort() })).rejects.toThrow();
  await expect(chatViaOpenClaw('openclaw:default', { ...opts, tools: [{ name: 'fixture', description: '', inputSchema: {} }] })).rejects.toThrow('does not expose a tool loop');
  expect(existsSync(join(root, 'args'))).toBe(false);
});
