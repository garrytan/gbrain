/**
 * Query expansion over the `claude-cli` recipe.
 *
 * Two independent defects made expansion a silent no-op for any brain whose
 * expansion model resolves to a `claude-cli:` string (the default when
 * `models.tier.utility` points there). Both are pinned here, because either
 * one alone reproduces the same user-visible symptom — `query` degrading to a
 * single-embedding `search` with no error, no log line, and no `degraded`
 * stamp:
 *
 *   1. The recipe declared no `expansion` touchpoint, so
 *      `isAvailable('expansion')` was false for EVERY claude-cli model and
 *      `expand()` returned `[query]` before any model call.
 *   2. With the touchpoint declared but the transport unchanged, expand()
 *      took the native generateObject path. ClaudeCliLanguageModel.doGenerate
 *      ignores `options.responseFormat`, so the CLI answers with
 *      markdown-fenced JSON as ordinary text, `result.object` is undefined,
 *      and the native branch has no viaText fallback — expansion paid for a
 *      subprocess round trip on every query and discarded the answer.
 *
 * Hermetic: routes through __setGenerateTextTransportForTests /
 * __setGenerateObjectTransportForTests, so no subprocess, network, or env
 * variable is touched.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import {
  expand,
  isAvailable,
  configureGateway,
  resetGateway,
  __setGenerateObjectTransportForTests,
  __setGenerateTextTransportForTests,
} from '../../src/core/ai/gateway.ts';

const CLAUDE_CLI_HAIKU = 'claude-cli:claude-haiku-4-5-20251001';

/** Exactly what `claude --print` emits for the expansion prompt: fenced JSON as text. */
const FENCED_JSON_RESPONSE = [
  '```json',
  '{',
  '  "queries": [',
  '    "knowledge management practices for employee turnover",',
  '    "preserving organizational knowledge during staff transitions"',
  '  ]',
  '}',
  '```',
].join('\n');

beforeEach(() => {
  configureGateway({ expansion_model: CLAUDE_CLI_HAIKU, env: {} });
});

afterEach(() => {
  __setGenerateObjectTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

describe('claude-cli query expansion', () => {
  test('the expansion touchpoint is reachable for a claude-cli model', () => {
    // Defect 1. The touchpoint is resolved from the RECIPE, not the model id,
    // so this is false for haiku, sonnet and opus alike when undeclared —
    // swapping models does not work around it.
    expect(isAvailable('expansion')).toBe(true);
  });

  test('expand() recovers queries from a markdown-fenced JSON text response', async () => {
    // Defect 2. The CLI cannot carry a json_schema, so the transport that
    // must be exercised is generateText. If expand() reaches for
    // generateObject here, the real adapter returns no object and the
    // expansions are silently dropped.
    let objectTransportCalls = 0;
    let textTransportCalls = 0;

    __setGenerateObjectTransportForTests(async () => {
      objectTransportCalls++;
      // Mirrors the real failure: schema request ignored, no object comes back.
      return { object: undefined, usage: { inputTokens: 10, outputTokens: 5 } } as any;
    });
    __setGenerateTextTransportForTests(async () => {
      textTransportCalls++;
      return { text: FENCED_JSON_RESPONSE, usage: { inputTokens: 10, outputTokens: 5 } } as any;
    });

    const result = await expand('how do teams avoid losing expertise when people leave');

    expect(textTransportCalls).toBe(1);
    expect(objectTransportCalls).toBe(0);
    // The original query is always first; the rewrites follow.
    expect(result[0]).toBe('how do teams avoid losing expertise when people leave');
    expect(result).toContain('knowledge management practices for employee turnover');
    expect(result).toContain('preserving organizational knowledge during staff transitions');
  });

  test('a claude-cli expansion failure still degrades to the bare query', async () => {
    // Fail-open posture is unchanged by the fix: a dead CLI must not take the
    // search down with it.
    __setGenerateTextTransportForTests(async () => {
      throw new Error('claude CLI not authenticated');
    });

    const result = await expand('a query that cannot be expanded');
    expect(result).toEqual(['a query that cannot be expanded']);
  });
});
