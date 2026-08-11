/**
 * Deterministic junk gate for extracted fact text (see the 2026-08-02
 * extraction-quality audit): assistant plan narration, provider error strings,
 * and meta-chatter must not survive extraction; durable operational knowledge
 * must pass untouched. The gate is deliberately narrow — these tests pin both
 * directions so pattern edits can't silently widen it.
 */

import { describe, expect, test } from 'bun:test';
import { isJunkFact, JUNK_FACT_PATTERNS } from '../src/core/facts/extract.ts';

describe('isJunkFact — rejects the audited junk classes', () => {
  const junk = [
    // Assistant plan narration.
    'Now let me write an independent oracle that recomputes the totals',
    "Let's check the logs for retry markers",
    "I'll create a cron job to monitor the tokens",
    'I am going to refactor the session handler next',
    'About to restart the gateway service',
    'Offered to create a cron job to automatically monitor RLM REPL tokens',
    'Proceeding to delete the stale lockfile',
    // Meta-narration about the conversation / concurrent state.
    'The user is asking about the deploy status',
    'Another agent is concurrently rewriting src/core/facts/extract.ts',
    // Provider billing / rate-limit error text stored as a "fact".
    "You've hit your org's monthly spend limit.",
    'Extraction stopped because the monthly spend limit was reached',
    'Anthropic rate limit exceeded during the sweep',
  ];
  for (const text of junk) {
    test(`rejects: ${text.slice(0, 60)}`, () => {
      expect(isJunkFact(text)).toBe(true);
    });
  }

  test('rejects empty/whitespace text', () => {
    expect(isJunkFact('')).toBe(true);
    expect(isJunkFact('   ')).toBe(true);
  });
});

describe('isJunkFact — passes durable operational knowledge', () => {
  const durable = [
    'Maestra API rate limit measured at 7 RPS; bottleneck is the API, not CPU',
    'hls.js 1.6.16 fetchSetup does not apply to master playlist requests',
    'Correct model name is xiaomi/mimo-v2-pro, not xiaomi/mimo-2-pro',
    'Bug in gateway/session.py line 812: float unix timestamp compared to datetime',
    'User prefers detached nohup jobs over run_in_background',
    'Ilya decided to migrate hermes to the NUC host',
    // Near-miss phrasings that must NOT trip the narrow patterns.
    'Nowadays the pipeline only uses port 4000 for hive inference',
    'Rate limiting is implemented via a token bucket in middleware.py',
    'The letter template lives in templates/letters/',
  ];
  for (const text of durable) {
    test(`passes: ${text.slice(0, 60)}`, () => {
      expect(isJunkFact(text)).toBe(false);
    });
  }
});

test('pattern list stays narrow (no accidental broad additions)', () => {
  // Widen deliberately, with tests, or not at all.
  expect(JUNK_FACT_PATTERNS.length).toBeLessThanOrEqual(6);
});
