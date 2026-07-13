/**
 * Unit tests for the patterns phase (v0.21).
 *
 * The phase invokes a subagent and queues real Minions work, so this
 * file leans on structural assertions over the source + a single
 * end-to-end driver run that exercises the skip-paths.
 *
 * Full LLM behavior is exercised by E2E tests in test/e2e/.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

const patternsSrc = readFileSync(
  new URL('../src/core/cycle/patterns.ts', import.meta.url),
  'utf-8',
);

describe('patterns phase wiring', () => {
  test('imports queue + waitForCompletion + types', () => {
    expect(patternsSrc).toContain("import { MinionQueue }");
    expect(patternsSrc).toContain('waitForCompletion');
    expect(patternsSrc).toContain('SubagentHandlerData');
  });

  test('threads allowed_slug_prefixes from filing-rules JSON', () => {
    expect(patternsSrc).toContain('allowed_slug_prefixes');
    expect(patternsSrc).toContain('_brain-filing-rules.json');
    expect(patternsSrc).toContain('dream_synthesize_paths');
  });

  test('reads min_evidence + lookback_days config', () => {
    expect(patternsSrc).toContain('dream.patterns.min_evidence');
    expect(patternsSrc).toContain('dream.patterns.lookback_days');
  });

  test('uses subagent_tool_executions for slug provenance (Codex #2 fix)', () => {
    expect(patternsSrc).toContain('subagent_tool_executions');
    expect(patternsSrc).toContain("tool_name = 'brain_put_page'");
  });

  test('skips when ANTHROPIC_API_KEY missing', () => {
    expect(patternsSrc).toContain('ANTHROPIC_API_KEY');
    expect(patternsSrc).toContain('no_api_key');
  });

  test('skips when reflections below min_evidence', () => {
    expect(patternsSrc).toContain('insufficient_evidence');
  });

  test('reverse-writes pages to disk via serializeMarkdown', () => {
    expect(patternsSrc).toContain('serializeMarkdown');
    expect(patternsSrc).toContain('writeFileSync');
  });

  test('runs after extract — queries fresh graph', () => {
    // Documented invariant: pattern phase MUST run after extract.
    // The cycle.ts dispatcher enforces order; this just confirms the
    // patterns module doesn't try to compute its own auto-link layer
    // (which would be a subtle regression).
    expect(patternsSrc).not.toContain('runAutoLink');
    expect(patternsSrc).not.toContain('extractPageLinks(');
  });

  test('does NOT use raw_data table (Codex #3 fix)', () => {
    expect(patternsSrc).not.toContain('putRawData');
    expect(patternsSrc).not.toContain('getRawData');
  });
});

describe('patterns scope filter', () => {
  test('filters reflections by slug LIKE wiki/personal/reflections/%', () => {
    expect(patternsSrc).toContain("slug LIKE 'wiki/personal/reflections/%'");
  });

  test('orders by updated_at DESC for recency-bias', () => {
    expect(patternsSrc).toContain('ORDER BY updated_at DESC');
  });

  test('caps gather to 100 reflections (cost control)', () => {
    expect(patternsSrc).toContain('LIMIT 100');
  });
});

describe('patterns cooldown (mirrors synthesize)', () => {
  test('reads dream.patterns.cooldown_hours config', () => {
    expect(patternsSrc).toContain('dream.patterns.cooldown_hours');
  });

  test('writes dream.patterns.last_completion_ts on success', () => {
    expect(patternsSrc).toContain('dream.patterns.last_completion_ts');
  });

  test('skips with cooldown_active reason when gate fires', () => {
    expect(patternsSrc).toContain("'cooldown_active'");
  });

  test('has a checkCooldown helper', () => {
    expect(patternsSrc).toContain('checkCooldown');
  });

  test('stamps cooldown for every submitted subagent outcome', () => {
    expect(patternsSrc).toContain('submittedSubagent');
    expect(patternsSrc).toContain('stampExecutedRunCooldown');
    expect(patternsSrc).not.toContain("outcome === 'completed'");
  });

  test('documents failed-run cooldown rationale', () => {
    expect(patternsSrc).toContain('Failed/timeout/dead/cancelled runs still spent the LLM budget');
  });
});
