/**
 * Structural tests for `gbrain dream` argv parsing (v0.21).
 *
 * Verifies the help text + parser source contains the new flags
 * (--input, --date, --from, --to) and that conflict detection is wired.
 * The actual parseArgs is internal; we exercise it via the source file
 * structure to avoid spinning up a process per test.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

const dreamSrc = readFileSync(new URL('../src/commands/dream.ts', import.meta.url), 'utf-8');

describe('dream CLI flag wiring', () => {
  test('declares --input flag with file argument', () => {
    expect(dreamSrc).toContain("'--input'");
    expect(dreamSrc).toContain('inputFile');
  });

  test('declares --date / --from / --to flags', () => {
    expect(dreamSrc).toContain("'--date'");
    expect(dreamSrc).toContain("'--from'");
    expect(dreamSrc).toContain("'--to'");
  });

  test('validates ISO date format', () => {
    expect(dreamSrc).toMatch(/ISO_DATE_RE/);
    expect(dreamSrc).toContain('YYYY-MM-DD');
  });

  test('--input + --date conflict detection', () => {
    expect(dreamSrc).toContain('--input cannot be combined with --date');
  });

  test('--input implies --phase synthesize', () => {
    expect(dreamSrc).toContain("phase = 'synthesize'");
  });

  test('--from > --to range validation', () => {
    expect(dreamSrc).toContain('empty range');
  });

  test('forwards synth fields to runCycle', () => {
    expect(dreamSrc).toContain('synthInputFile');
    expect(dreamSrc).toContain('synthDate');
    expect(dreamSrc).toContain('synthFrom');
    expect(dreamSrc).toContain('synthTo');
  });

  test('totals line includes synth + patterns counters', () => {
    expect(dreamSrc).toContain('synth_transcripts');
    expect(dreamSrc).toContain('synth_pages');
    expect(dreamSrc).toContain('patterns=');
  });

  test('help text documents dry-run synthesis semantics (Codex finding #8)', () => {
    expect(dreamSrc).toContain('skips the Sonnet');
    expect(dreamSrc.toLowerCase()).toContain('zero llm calls');
  });

  // v0.41.13: --source / --source-id flag wiring (supersedes PR #1559).
  // Structural-only tests; behavioral tests live in test/dream.test.ts.
  describe('--source / --source-id wiring (v0.41.13)', () => {
    test('declares --source flag in argv parsing', () => {
      expect(dreamSrc).toContain("'--source'");
    });

    test('declares --source-id alias in argv parsing', () => {
      expect(dreamSrc).toContain("'--source-id'");
    });

    test('forwards resolved sourceId to runCycle', () => {
      // The runCycle call must pass sourceId; gate name "sourceId"
      // not "source" because CycleOpts.sourceId is the contract.
      expect(dreamSrc).toMatch(/sourceId:\s*resolvedSourceId/);
    });

    test('imports resolveSourceId from canonical source-resolver helper', () => {
      expect(dreamSrc).toContain("from '../core/source-resolver.ts'");
      expect(dreamSrc).toContain('resolveSourceId');
    });

    test('declares isResolverUserError predicate for typed-error catch (T3 from eng review)', () => {
      expect(dreamSrc).toContain('function isResolverUserError');
    });

    test('documents --source in --help output', () => {
      expect(dreamSrc).toContain('--source <id>');
      expect(dreamSrc).toContain('--source-id <id>');
    });

    test('preserves --help short-circuit ordering comment (IRON RULE)', () => {
      // The comment lives in runDream BEFORE the engine-null gate.
      // Future refactors that reorder these blocks will trip this guard.
      expect(dreamSrc).toContain('IRON RULE: --help short-circuits BEFORE');
    });

    test('declares engine-null guard for --source', () => {
      expect(dreamSrc).toContain('requires a connected brain');
    });

    test('declares archived-source guard', () => {
      expect(dreamSrc).toMatch(/source.*is archived/);
      expect(dreamSrc).toContain('gbrain sources restore');
    });
  });
});
