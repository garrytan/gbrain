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
import type { BrainEngine } from '../src/core/engine.ts';
import { __testing } from '../src/core/cycle/patterns.ts';

const patternsSrc = readFileSync(
  new URL('../src/core/cycle/patterns.ts', import.meta.url),
  'utf-8',
);

describe('patterns phase wiring', () => {
  test('imports queue + waitForCompletion + types', () => {
    expect(patternsSrc).toContain("import { DEFAULT_PRIVATE_QUEUE_LEASE_MS, MinionQueue }");
    // The post-drain wait must be the lease-renewing variant — a plain
    // waitForCompletion would let the private-queue lease lapse mid-wait.
    expect(patternsSrc).toContain('waitForCompletionRenewing');
    // The keepalive must come from the shared throttled factory (T0
    // extraction) — an inline closure here and in synthesize drifts.
    expect(patternsSrc).toContain('makeThrottledLeaseRenewer');
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

  test('gates on gateway provider reachability, not ANTHROPIC_API_KEY (PR #2279)', () => {
    // The gate must probe the RESOLVED patterns model through the gateway
    // (any configured provider can run patterns), not hardcode the Anthropic
    // env var — that misclassified non-Anthropic stacks as "no upstream".
    expect(patternsSrc).toContain('probeChatModel');
    expect(patternsSrc).toContain('normalizeModelId');
    expect(patternsSrc).toContain('no_provider');
    expect(patternsSrc).not.toContain('process.env.ANTHROPIC_API_KEY');
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
  test('reflection excerpts never split a UTF-16 surrogate pair', async () => {
    const rocket = '\uD83D\uDE80';
    const compiledTruth = `${'a'.repeat(599)}${rocket}tail`;
    const engine = {
      executeRaw: async () => [{
        slug: 'wiki/personal/reflections/example',
        title: 'Example',
        compiled_truth: compiledTruth,
      }],
    } as unknown as BrainEngine;

    const [reflection] = await __testing.gatherReflections(engine, 30);

    expect(reflection.excerpt.isWellFormed()).toBe(true);
    expect(reflection.excerpt.endsWith(rocket)).toBe(false);
    expect(reflection.excerpt.length).toBe(599);
  });

  test('filters reflections by slug LIKE <source_slug_prefix>/%', () => {
    // #2415 made the top-level namespace root configurable
    // (dream.synthesize.output_root, default 'wiki'). A later patch made the
    // full `personal/reflections` sub-path configurable too
    // (dream.patterns.source_slug_prefix, defaults to
    // `<output_root>/personal/reflections` so existing behavior is
    // unchanged) — schemas with no `personal/` nesting (e.g. a flat
    // `meetings/` tree) can point the phase at their own compiled_truth
    // source instead.
    expect(patternsSrc).toContain('slug LIKE $2');
    expect(patternsSrc).toContain('${sourceSlugPrefix}/%');
    expect(patternsSrc).toContain('dream.patterns.source_slug_prefix');
  });

  test('orders by updated_at DESC for recency-bias', () => {
    expect(patternsSrc).toContain('ORDER BY updated_at DESC');
  });

  test('caps gather to 100 reflections (cost control)', () => {
    expect(patternsSrc).toContain('LIMIT 100');
  });

  test('output slug prefix is config-driven, defaulting to <output_root>/personal/patterns', () => {
    expect(patternsSrc).toContain('dream.patterns.output_slug_prefix');
    expect(patternsSrc).toContain('${outputRoot}/personal/patterns');
  });

  test('source slug prefix defaults to <output_root>/personal/reflections', () => {
    expect(patternsSrc).toContain('${outputRoot}/personal/reflections');
  });

  test('adds a configured output_slug_prefix to the subagent write allow-list', () => {
    // A custom dream.patterns.output_slug_prefix (e.g. a flat schema with no
    // personal/ nesting) is not covered by the filing-rules globs, which only
    // remap the `wiki/personal/patterns/*` literal by output_root. The phase
    // must add it explicitly so put_page actually grants write access there.
    expect(patternsSrc).toContain('outputGlob');
    expect(patternsSrc).toContain('allowedSlugPrefixes.push(outputGlob)');
  });
});
