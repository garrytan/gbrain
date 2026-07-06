// Regression test for the nightly-quality-probe config-plane split-brain.
//
// The doctor check prints a paste-ready enable hint — `gbrain config set
// autopilot.nightly_quality_probe.enabled true` — which writes the DB config
// plane. But both the autopilot gate and the doctor check used to read ONLY
// the file plane (~/.gbrain/config.json via loadConfig), so following the
// hint was a silent no-op: the probe never ran and doctor kept reporting
// "disabled (opt-in)".
//
// resolveProbeEnabled / resolveProbeMaxUsd pin the dual-plane rule (same
// precedent as `mcp.publish_skills` in serve-http.ts): DB row wins when
// present, file plane is the fallback.
import { describe, expect, test } from 'bun:test';

import {
  resolveProbeEnabled,
  resolveProbeMaxUsd,
} from '../src/core/cycle/nightly-quality-probe.ts';

describe('resolveProbeEnabled — dual-plane flag resolution', () => {
  test('DB plane "true" enables regardless of file plane (the doctor hint path)', () => {
    expect(resolveProbeEnabled('true', undefined)).toBe(true);
    expect(resolveProbeEnabled('true', false)).toBe(true);
  });

  test('explicit DB "false" wins over file-plane true (config set off sticks)', () => {
    expect(resolveProbeEnabled('false', true)).toBe(false);
  });

  test('file plane is the fallback when no DB row exists', () => {
    expect(resolveProbeEnabled(null, true)).toBe(true);
    expect(resolveProbeEnabled(undefined, true)).toBe(true);
    expect(resolveProbeEnabled(null, undefined)).toBe(false);
    expect(resolveProbeEnabled(null, false)).toBe(false);
  });

  test('file plane stays strict boolean — string "true" in config.json does not enable', () => {
    // Matches the pre-fix autopilot gate (`=== true`); the doctor check used
    // Boolean(...) and could disagree with autopilot on a string value.
    // Both call sites now share this helper, so they can no longer diverge.
    expect(resolveProbeEnabled(null, 'true')).toBe(false);
    expect(resolveProbeEnabled(null, 1)).toBe(false);
  });

  test('non-"true" DB strings are off (mcp.publish_skills semantics)', () => {
    expect(resolveProbeEnabled('1', true)).toBe(false);
    expect(resolveProbeEnabled('yes', true)).toBe(false);
    expect(resolveProbeEnabled('', true)).toBe(false);
  });
});

describe('resolveProbeMaxUsd — dual-plane cost cap resolution', () => {
  test('DB plane wins when parseable', () => {
    expect(resolveProbeMaxUsd('2.5', 10)).toBe(2.5);
    expect(resolveProbeMaxUsd('0', 10)).toBe(0);
  });

  test('malformed or negative DB value falls through to file plane', () => {
    expect(resolveProbeMaxUsd('banana', 3)).toBe(3);
    expect(resolveProbeMaxUsd('-1', 3)).toBe(3);
  });

  test('file plane used when no DB row; default when both absent/invalid', () => {
    expect(resolveProbeMaxUsd(null, 7)).toBe(7);
    expect(resolveProbeMaxUsd(null, '4')).toBe(4);
    expect(resolveProbeMaxUsd(null, undefined)).toBe(5);
    expect(resolveProbeMaxUsd(null, 'banana')).toBe(5);
    expect(resolveProbeMaxUsd(undefined, -2)).toBe(5);
  });

  test('explicit fallback override is honored', () => {
    expect(resolveProbeMaxUsd(null, undefined, 12)).toBe(12);
  });
});
