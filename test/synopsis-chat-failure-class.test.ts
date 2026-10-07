/**
 * #5964: a thrown chat() error is classified for the per-chunk synopsis by the
 * status, name and code on ANY layer of the gateway's normalized error.
 *
 * 1. Protects the D27 P1-2 dispatch: rate limits, auth failures, provider
 *    outages, timeouts and network faults must not land in `malformed`, the
 *    class that re-embeds the whole page at the title tier and reports success.
 * 2. Fails when the classifier reads only the outermost error: chat() keeps
 *    the provider's error on `cause` (claude-cli `apiErrorStatus`, AI SDK
 *    `statusCode`, RetryError `lastError`, a DOMException `TimeoutError`).
 * 3. Existing synopsis tests stub chat() whole, so no error ever went through
 *    normalizeAIError on its way to the classifier.
 * 4. No new seam: the real chat() runs behind the existing generateText
 *    transport seam; the bounded-walk cases call the exported reader directly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { APICallError, RetryError } from 'ai';
import { ClaudeCliProcessError } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { readProviderFailureSignals } from '../src/core/ai/errors.ts';
import { __setGenerateTextTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { SynopsisFailureKind } from '../src/core/audit-synopsis.ts';
import { generatePerChunkSynopsis } from '../src/core/page-summary.ts';

const CLI_ROUTE = 'claude-cli:claude-haiku-4-5';
const API_ROUTE = 'anthropic:claude-haiku-4-5';

const cliFailure = (apiErrorStatus: number | undefined, text: string) =>
  new ClaudeCliProcessError(apiErrorStatus === undefined ? text : `claude-cli API error ${apiErrorStatus}: ${text}`,
    { apiErrorStatus, exitCode: 1 });

const httpFailure = (statusCode: number) => new APICallError({
  message: `provider answered ${statusCode}`, url: 'https://llm.example.invalid/v1/messages', requestBodyValues: {},
  statusCode, isRetryable: statusCode >= 500 || statusCode === 429,
});

const afterRetries = (statusCode: number) => new RetryError({
  message: `Failed after 2 attempts. Last error: provider answered ${statusCode}`,
  reason: 'maxRetriesExceeded',
  errors: [httpFailure(statusCode), httpFailure(statusCode)],
});

async function classify(model: string, thrown: () => unknown): Promise<string> {
  __setGenerateTextTransportForTests((async () => { throw thrown(); }) as never);
  const result = await generatePerChunkSynopsis({
    documentText: 'Notes on the acme-example rollout.',
    chunkText: 'The rollout slipped a week.',
    pageTitle: 'Acme Example',
    pageSlug: 'companies/acme-example',
    sourceId: 'default',
    chunkIndex: 0,
    model,
  });
  return result.kind;
}

beforeEach(() => {
  configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-placeholder' } });
});

afterEach(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
});

describe('synopsis chat failures are classified through the wrapped error (#5964)', () => {
  const rows: Array<[label: string, model: string, thrown: () => unknown, expected: SynopsisFailureKind]> = [
    ['claude-cli usage limit 429', CLI_ROUTE, () => cliFailure(429, 'usage limit reached'), 'rate_limit'],
    ['claude-cli 401', CLI_ROUTE, () => cliFailure(401, 'invalid credentials'), 'auth_failure'],
    ['claude-cli 503', CLI_ROUTE, () => cliFailure(503, 'service unavailable'), 'provider_5xx'],
    ['claude-cli adapter abort (timeout or cancel)', CLI_ROUTE, () => new Error('claude-cli adapter aborted'), 'timeout'],
    ['SDK 403, not retried', API_ROUTE, () => httpFailure(403), 'auth_failure'],
    ['SDK 429 after retries', API_ROUTE, () => afterRetries(429), 'rate_limit'],
    ['SDK 502 after retries', API_ROUTE, () => afterRetries(502), 'provider_5xx'],
    ['SDK default chat timeout', API_ROUTE, () => new DOMException('The operation timed out.', 'TimeoutError'), 'timeout'],
    ['wrapped ETIMEDOUT', API_ROUTE, () => new Error('request failed', { cause: Object.assign(new Error('socket'), { code: 'ETIMEDOUT' }) }), 'timeout'],
    ['wrapped ECONNREFUSED', API_ROUTE, () => new Error('request failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }), 'network'],
    // Controls: request-shaped or statusless failures stay malformed.
    ['control: claude-cli without a status', CLI_ROUTE, () => cliFailure(undefined, 'claude-cli returned no result'), 'malformed'],
    ['control: claude-cli 400', CLI_ROUTE, () => cliFailure(400, 'prompt is too long'), 'malformed'],
    ['control: SDK 404', API_ROUTE, () => httpFailure(404), 'malformed'],
    ['control: "aborted" in an unrelated message', API_ROUTE, () => new Error('upstream reply aborted mid-stream by policy'), 'malformed'],
    ['control: a status given as a string', API_ROUTE, () => Object.assign(new Error('odd provider'), { cause: { statusCode: '429' } }), 'malformed'],
    ['control: a NaN status', API_ROUTE, () => Object.assign(new Error('odd provider'), { cause: { status: Number.NaN } }), 'malformed'],
  ];

  for (const [label, model, thrown, expected] of rows) {
    test(`${label} -> ${expected}`, async () => {
      expect(await classify(model, thrown)).toBe(expected);
    });
  }
});

describe('readProviderFailureSignals walks a bounded chain', () => {
  test('outermost status wins over a deeper one', () => {
    const err = Object.assign(new Error('outer'), { status: 503, cause: { statusCode: 429 } });
    expect(readProviderFailureSignals(err).status).toBe(503);
  });

  test('a self-referencing cause terminates and reads each layer once', () => {
    const err = Object.assign(new Error('loop'), { code: 'ECONNRESET' }) as Error & { cause?: unknown };
    err.cause = err;
    expect(readProviderFailureSignals(err)).toEqual({ status: undefined, names: ['Error'], codes: ['ECONNRESET'] });
  });

  test('a status beyond five layers is not read', () => {
    let err: unknown = { statusCode: 429 };
    for (let i = 0; i < 5; i++) err = { cause: err };
    expect(readProviderFailureSignals(err).status).toBeUndefined();
  });

  test('a throwing getter ends the walk without throwing and keeps what was read', () => {
    const hostile = { status: 429, get cause(): unknown { throw new Error('getter trap'); } };
    expect(readProviderFailureSignals(hostile).status).toBe(429);
  });

  test('primitives and null carry no signals', () => {
    for (const value of [null, undefined, 'rate limited', 429]) {
      expect(readProviderFailureSignals(value)).toEqual({ status: undefined, names: [], codes: [] });
    }
  });
});
