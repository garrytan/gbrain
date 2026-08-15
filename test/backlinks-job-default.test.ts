/**
 * Structural regression for the backlinks Minion handler default.
 *
 * Backlinks jobs submitted with an EMPTY payload (the sync→embed→backlinks
 * chains enqueued after every ingestion) must run as 'check', never 'fix'.
 * The pre-fix handler inverted the default (`=== 'check' ? 'check' : 'fix'`),
 * so every routine post-ingestion job rewrote tracked brain pages with
 * generated "Referenced in" timeline bullets — contradicting the documented
 * intent in src/core/cycle.ts (runPhaseBacklinks): "Maintenance cycles must
 * not rewrite tracked brain pages with generated 'Referenced in' timeline
 * bullets."
 *
 * Source-grep is the right tool here (see fix-wave-structural.test.ts): the
 * handler dynamically imports runBacklinksCore and walks a real repo dir, so
 * a behavioral test would require heavy mocking that hides the regression
 * behind a test seam. The rule is "this specific default must stay 'check'".
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

describe('backlinks Minion handler — empty payload defaults to check, not fix', () => {
  const src = readFileSync('src/commands/jobs.ts', 'utf8');

  // Isolate the backlinks register block so assertions can't accidentally
  // match another handler's action parsing.
  const blockMatch = src.match(
    /worker\.register\('backlinks',[\s\S]*?runBacklinksCore\(\{[\s\S]*?\}\);/
  );

  test('the backlinks handler block exists', () => {
    expect(blockMatch).not.toBeNull();
  });

  test("default action is 'check' (explicit opt-in required for 'fix')", () => {
    const block = blockMatch![0];
    expect(block).toMatch(
      /job\.data\.action\s*===\s*'fix'\s*\?\s*'fix'\s*:\s*'check'/
    );
  });

  test('the inverted (fix-by-default) shape stays absent', () => {
    const block = blockMatch![0];
    expect(block).not.toMatch(
      /job\.data\.action\s*===\s*'check'\s*\?\s*'check'\s*:\s*'fix'/
    );
  });
});
