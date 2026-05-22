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
});
