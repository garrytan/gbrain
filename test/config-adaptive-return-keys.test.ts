/**
 * 2026-08 fix wave (E5a) — the adaptive-return / autocut / CRAG search knobs
 * are read by the search path (return-policy.ts, mode.ts, ops/search.ts) but
 * were never registered in KNOWN_CONFIG_KEYS, so `gbrain config set` rejected
 * them and the documented config plane was a silent no-op. This pin makes a
 * future registry refactor unable to drop them silently — the exact
 * regression class the wave repaired.
 */
import { describe, expect, test } from 'bun:test';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

const E5A_KEYS = [
  'search.adaptive_return',
  'search.adaptive_return_entity_max',
  'search.adaptive_return_other_max',
  'search.adaptive_return_min_keep',
  'search.autocut',
  'search.autocut_jump',
  'search.autocut_min_keep',
  'search.autocut_min_top',
  'search.crag_escalation',
  'search.crag_think',
] as const;

describe('E5a — adaptive-return/autocut/CRAG keys are registered (config plane is not a no-op)', () => {
  test.each(E5A_KEYS.map((k) => [k]))('%s is in KNOWN_CONFIG_KEYS', (key) => {
    expect(KNOWN_CONFIG_KEYS).toContain(key);
  });
});

describe('GBRAIN_RETRIEVAL_REFLEX_VOLUNTEER loadConfig env fold (ship review)', () => {
  // volunteerEnabled() reads env directly (config-less-environment escape
  // hatch, tested in reflex-volunteer.test.ts); this pins the SEPARATE
  // loadConfig() fold consumed by anything reading cfg.retrieval_reflex_volunteer.
  // A real config file is required: loadConfig() returns null when there is
  // no config file AND no DATABASE_URL, dropping every env mapping (the
  // documented windowTurnCount bug class) — hence the tmp GBRAIN_HOME fixture.
  test('negative values fold to false; positives to true; unset stays absent', async () => {
    const { withEnv } = await import('./helpers/with-env.ts');
    const { loadConfig } = await import('../src/core/config.ts');
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    // GBRAIN_HOME is a PARENT dir: configDir() === `$GBRAIN_HOME/.gbrain`.
    const home = mkdtempSync(join(tmpdir(), 'gbrain-envfold-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_RETRIEVAL_REFLEX_VOLUNTEER: 'off' }, async () => {
        expect(loadConfig()?.retrieval_reflex_volunteer).toBe(false);
      });
      await withEnv({ GBRAIN_HOME: home, GBRAIN_RETRIEVAL_REFLEX_VOLUNTEER: 'true' }, async () => {
        expect(loadConfig()?.retrieval_reflex_volunteer).toBe(true);
      });
      await withEnv({ GBRAIN_HOME: home, GBRAIN_RETRIEVAL_REFLEX_VOLUNTEER: undefined }, async () => {
        expect(loadConfig()?.retrieval_reflex_volunteer).toBeUndefined();
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('isVolunteerProbeShaped (ship security review — wire-field bound)', () => {
  test('honors only volunteer-shaped probes; evasion attempts keep logging', async () => {
    const { isVolunteerProbeShaped } = await import('../src/mcp/resolve-ipc-binding.ts');
    const { VOLUNTEER_MAX_PAGES_CAP } = await import('../src/core/context/volunteer.ts');
    const shaped = { probe: 'volunteer', suppression: 'slug-only', maxPointers: VOLUNTEER_MAX_PAGES_CAP * 2 };
    expect(isVolunteerProbeShaped(shaped)).toBe(true);
    // A normal 3-pointer resolve claiming probe must NOT be honored.
    expect(isVolunteerProbeShaped({ probe: 'volunteer', suppression: 'slug-only', maxPointers: 3 })).toBe(false);
    expect(isVolunteerProbeShaped({ probe: 'volunteer', suppression: 'slug-and-title', maxPointers: VOLUNTEER_MAX_PAGES_CAP * 2 })).toBe(false);
    expect(isVolunteerProbeShaped({ suppression: 'slug-only', maxPointers: VOLUNTEER_MAX_PAGES_CAP * 2 })).toBe(false);
    expect(isVolunteerProbeShaped(undefined)).toBe(false);
  });
});
