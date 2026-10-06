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
import { surfaceFileSource, surfaceSource } from './helpers/source-surface.ts';

// W4 autopilot: containment reads the autopilot surface; positional spans name the module that holds the probe steps.
const SOURCE = surfaceSource('autopilot');
const PROBES_SOURCE = surfaceFileSource('autopilot', 'src/commands/autopilot-probes.ts');

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

  test('fixtures are the embedded package assets, NOT the brain repoPath (C-N6)', () => {
    // A compiled binary carries no source tree; the embedded assets are
    // readable there and in a source checkout alike.
    expect(SOURCE).toContain(`resolveFixturePath: () => NIGHTLY_PROBE_FIXTURES.parserFormats`);
    expect(SOURCE).toContain(`resolveAdversarialPath: () => NIGHTLY_PROBE_FIXTURES.parserAdversarial`);
  });

  test('no quiet skip: an unreadable fixture becomes an audited skipped row (C-N6)', () => {
    // The once-per-process stderr note left doctor reporting ok on binary
    // installs; the phase now returns `skipped`, which the wiring logs.
    expect(SOURCE).not.toContain(`parserProbeFixtureWarned`);
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
    expect(PROBES_SOURCE).toMatch(/catch[\s\S]*?autopilot\.parser_probe[\s\S]*?do NOT bump consecutiveErrors/);
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
