/**
 * Source-shape regression tests for the autopilot wiring of
 * `runConversationParserNightlyProbe` (step 4.6).
 *
 * Same rationale as autopilot-nightly-probe-wiring.test.ts: the loop is
 * hard to drive end-to-end, so these pin the structural protections —
 * the dual-plane flag read, the D10 tokenmax mode-gate, the package-root
 * fixture resolution, the audit-flood guard, and the try/catch posture.
 *
 * The probe's own gate/scoring logic is pinned by the module's unit
 * tests; the audit trail by audit-parser-probe.serial.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AUTOPILOT_SRC = resolve('src/commands/autopilot.ts');
const SOURCE = readFileSync(AUTOPILOT_SRC, 'utf-8');

describe('autopilot wiring: conversation-parser probe', () => {
  test('invokes the phase module and the audit trail', () => {
    expect(SOURCE).toContain(`runConversationParserNightlyProbe`);
    expect(SOURCE).toContain(`conversation-parser/nightly-probe`);
    expect(SOURCE).toContain(`logParserProbeEvent`);
    expect(SOURCE).toContain(`audit-parser-probe`);
  });

  test('flag reads dual-plane: DB row (gbrain config set) wins, file plane fallback', () => {
    expect(SOURCE).toContain(`getConfig('autopilot.conversation_parser_probe.enabled')`);
    expect(SOURCE).toContain(`cfg?.autopilot?.conversation_parser_probe?.enabled === true`);
  });

  test('D10 mode-gate present: tokenmax brains run the probe by default', () => {
    expect(SOURCE).toMatch(/parserEnabled \|\| searchMode === 'tokenmax'/);
  });

  test('fixtures resolve from the gbrain package root, NOT the brain repoPath', () => {
    // The committed fixtures live in the gbrain source tree; resolving
    // them against sync.repo_path would point into the user's brain repo.
    expect(SOURCE).toMatch(/fileURLToPath\(new URL\('\.\.\/\.\.', import\.meta\.url\)\)/);
    expect(SOURCE).toContain(`'conversation-formats', 'all.jsonl'`);
    expect(SOURCE).toContain(`'conversation-formats', 'adversarial.jsonl'`);
  });

  test('missing fixtures skip quietly (no audit row, once-per-process stderr note)', () => {
    // Compiled-binary installs carry no source tree; writing failure rows
    // would flip doctor to WARN on every binary install.
    expect(SOURCE).toContain(`parserProbeFixtureWarned`);
  });

  test('rate_limited outcomes are NOT audit-logged (flood guard)', () => {
    expect(SOURCE).toMatch(/outcome !== 'rate_limited'\) logParserProbeEvent\(result\)/);
  });

  test('rate-limit gate delegates to the audit module, not inline event reads', () => {
    expect(SOURCE).toContain(`parserProbeRanWithin(24 * 60 * 60 * 1000)`);
  });

  test('LLM-key gate reads gateway.isAvailable("chat") in-process', () => {
    expect(SOURCE).toContain(`isAvailable('chat')`);
  });

  test('probe call wrapped in try/catch that does NOT bump consecutiveErrors', () => {
    expect(SOURCE).toMatch(/catch[\s\S]*?autopilot\.parser_probe[\s\S]*?do NOT bump consecutiveErrors/);
  });

  test('DI shape: the exact 7 fields of the parser probe NightlyProbeDeps', () => {
    expect(SOURCE).toContain(`isEnabled:`);
    expect(SOURCE).toContain(`searchMode:`);
    expect(SOURCE).toContain(`hasLlmKey:`);
    expect(SOURCE).toContain(`resolveFixturePath:`);
    expect(SOURCE).toContain(`resolveAdversarialPath:`);
    expect(SOURCE).toContain(`shouldSkipForRateLimit:`);
    expect(SOURCE).toContain(`now:`);
  });
});
