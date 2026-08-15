/**
 * v0.41.16.0 — Nightly probe unit tests.
 *
 * Hermetic via NightlyProbeDeps injection. No real LLM calls.
 *
 * Pins:
 *   - Disabled + mode=conservative → rate_limited (informational)
 *   - Mode=tokenmax overrides disable
 *   - 24h rate limit → rate_limited
 *   - No LLM key → no_embedding_key
 *   - Fixture path missing → fail
 *   - Adversarial false positive → adversarial_false_positive
 *   - All pass → pass
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runConversationParserNightlyProbe,
  type NightlyProbeDeps,
} from '../../src/core/conversation-parser/nightly-probe.ts';

function tmpFixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const path = join(dir, 'fix.jsonl');
  writeFileSync(path, content);
  return path;
}

const POSITIVE = `{"fixture_id":"f1","pattern":"imessage-slack","frontmatter":{"date":"2024-03-15"},"body":"**Alice** (2024-03-15 9:00 AM): hi","expected_messages":1,"expected_participants":["Alice"]}`;
const ADVERSARIAL = `{"fixture_id":"a1","pattern":null,"frontmatter":{"date":"2024-03-15"},"body":"just prose","expected_messages":0,"expected_participants":[]}`;

function baseDeps(overrides: Partial<NightlyProbeDeps> = {}): NightlyProbeDeps {
  return {
    isEnabled: () => true,
    searchMode: () => 'balanced',
    hasLlmKey: () => true,
    resolveFixturePath: () => tmpFixture(POSITIVE),
    resolveAdversarialPath: () => tmpFixture(ADVERSARIAL),
    now: () => new Date('2026-05-26T00:00:00Z'),
    shouldSkipForRateLimit: () => false,
    ...overrides,
  };
}

describe('runConversationParserNightlyProbe', () => {
  test('disabled + balanced mode → rate_limited (informational)', async () => {
    const r = await runConversationParserNightlyProbe(
      baseDeps({ isEnabled: () => false, searchMode: () => 'balanced' }),
    );
    expect(r.outcome).toBe('rate_limited');
    expect(r.reason).toContain('enabled=false');
  });

  test('disabled but mode=tokenmax → proceeds (default-on per D10)', async () => {
    const r = await runConversationParserNightlyProbe(
      baseDeps({ isEnabled: () => false, searchMode: () => 'tokenmax' }),
    );
    expect(r.outcome).toBe('pass');
  });

  test('24h rate limit → rate_limited', async () => {
    const r = await runConversationParserNightlyProbe(
      baseDeps({ shouldSkipForRateLimit: () => true }),
    );
    expect(r.outcome).toBe('rate_limited');
    expect(r.reason).toContain('24h');
  });

  test('no LLM key → no_embedding_key', async () => {
    const r = await runConversationParserNightlyProbe(
      baseDeps({ hasLlmKey: () => false }),
    );
    expect(r.outcome).toBe('no_embedding_key');
  });

  test('happy path: all pass', async () => {
    const r = await runConversationParserNightlyProbe(baseDeps());
    expect(r.outcome).toBe('pass');
    expect(r.fixtures_total).toBe(2);
    expect(r.fixtures_passed).toBe(2);
    expect(r.adversarial_false_positives).toBe(0);
  });

  test('adversarial false positive → adversarial_false_positive', async () => {
    // Adversarial fixture that LOOKS like iMessage; the parser will
    // match it and the eval will flag as fp.
    const adversarialThatMatches = `{"fixture_id":"a-bad","pattern":null,"frontmatter":{"date":"2024-03-15"},"body":"**Alice** (2024-03-15 9:00 AM): I was supposed to be unparseable","expected_messages":0,"expected_participants":[]}`;
    const r = await runConversationParserNightlyProbe(
      baseDeps({
        resolveAdversarialPath: () => tmpFixture(adversarialThatMatches),
      }),
    );
    expect(r.outcome).toBe('adversarial_false_positive');
    expect(r.adversarial_false_positives).toBe(1);
  });

  test('fixture path missing → fail', async () => {
    const r = await runConversationParserNightlyProbe(
      baseDeps({ resolveFixturePath: () => '/nonexistent/path.jsonl' }),
    );
    expect(r.outcome).toBe('fail');
    expect(r.reason).toContain('missing');
  });
});
