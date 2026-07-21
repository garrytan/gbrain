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

  // issue #1678 — --drain bounded backlog drain wiring (structural).
  describe('--drain wiring', () => {
    test('declares --drain and --window flags', () => {
      expect(dreamSrc).toContain("'--drain'");
      expect(dreamSrc).toContain("'--window'");
      expect(dreamSrc).toContain('windowSeconds');
    });

    test('--drain defaults to extract_atoms and rejects other phases', () => {
      expect(dreamSrc).toContain("phase = 'extract_atoms'");
      expect(dreamSrc).toContain('--drain currently supports only --phase extract_atoms');
    });

    test('drain routes through the shared helper with the resolved source (5A)', () => {
      // v0.42.10.0 (#1685 GAP D / 5A): the lock+batch+count wiring moved into
      // runExtractAtomsDrainForSource so the CLI, the Minion handler, and
      // autopilot share ONE drain path. dream threads resolvedSourceId so the
      // helper picks cycleLockIdFor(resolvedSourceId) — the same lock the routine
      // cycle holds for that source. The lock-id contract is now pinned in
      // test/extract-atoms-drain.test.ts ("shared wiring helper holds the cycle lock").
      expect(dreamSrc).toContain('runExtractAtomsDrainForSource');
      expect(dreamSrc).toContain('sourceId: resolvedSourceId');
    });

    test('drain reports remaining + exits non-zero when incomplete', () => {
      expect(dreamSrc).toContain('EXIT_DRAIN_INCOMPLETE');
      expect(dreamSrc).toContain('cycle_already_running');
    });
  });

  // issue #2860 — --once one-shot phase-enabled-gate bypass (structural).
  // Behavioral coverage: test/e2e/dream-patterns-pglite.test.ts (bypass +
  // config-untouched) and test/core/cycle.serial.test.ts (non-leak across
  // phases via CycleOpts.onceForPhase).
  describe('--once wiring (issue #2860)', () => {
    test('declares --once flag', () => {
      expect(dreamSrc).toContain("'--once'");
    });

    test('rejects bare --once with no --phase (exit 2)', () => {
      expect(dreamSrc).toContain('--once requires an explicit --phase <name>');
      // --help must short-circuit this validation (Codex review finding) —
      // see the "--help --once" test in test/dream.test.ts for the
      // behavioral pin of this exact ordering.
      expect(dreamSrc).toContain('if (once && !phaseWasExplicit && !wantsHelp)');
    });

    // Codex P3 finding: the derived `phase` value gets populated by
    // --input/--drain BEFORE this validation used to run, so those two
    // silently slipped past an `!phase`-based check. The fix validates
    // against `phaseWasExplicit` (captured at `phaseIdx !== -1`, before
    // any implicit defaulting) instead. Behavioral pins live in
    // test/dream.test.ts.
    test('validates against phaseWasExplicit, captured before --input/--drain defaulting', () => {
      expect(dreamSrc).toContain('const phaseWasExplicit = phaseIdx !== -1;');
      // Must be declared before the --input-implies-synthesize and
      // --drain-implies-extract_atoms defaulting blocks so it captures
      // presence prior to any implicit phase assignment.
      const explicitIdx = dreamSrc.indexOf('const phaseWasExplicit = phaseIdx !== -1;');
      const inputImpliesIdx = dreamSrc.indexOf("phase = 'synthesize'");
      const drainImpliesIdx = dreamSrc.indexOf("phase = 'extract_atoms'");
      expect(explicitIdx).toBeGreaterThan(-1);
      expect(explicitIdx).toBeLessThan(inputImpliesIdx);
      expect(explicitIdx).toBeLessThan(drainImpliesIdx);
    });

    test('threads onceForPhase to runCycle, gated on opts.once', () => {
      expect(dreamSrc).toMatch(/onceForPhase:\s*opts\.once\s*\?\s*opts\.phase!\s*:\s*undefined/);
    });

    test('documents --once in --help output', () => {
      expect(dreamSrc).toContain('--once');
      expect(dreamSrc).toContain('Never reads or writes config');
    });
  });
});
