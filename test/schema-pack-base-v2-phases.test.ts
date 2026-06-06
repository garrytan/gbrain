// issue #1678 — gbrain-base-v2 must opt into the atom extraction lifecycle.
//
// Regression: after type unification, a brain can run gbrain-base-v2 as the
// active pack while doctor reports pages eligible for atom extraction. Routine
// dream/autopilot then skipped the phase because the pack's `phases:` list was
// empty.

import { describe, expect, test } from 'bun:test';
import { loadActivePack } from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';

describe('gbrain-base-v2 phase declarations', () => {
  test('declares extract_atoms so routine cycles drain atom backlog', async () => {
    _resetPackCacheForTests();
    const resolved = await loadActivePack({
      cfg: null,
      remote: false,
      perCall: 'gbrain-base-v2',
    });

    expect(resolved.manifest.name).toBe('gbrain-base-v2');
    expect(resolved.manifest.phases ?? []).toContain('extract_atoms');
    // Keep concept synthesis opt-in through creator/everything until it has
    // its own backlog doctor signal + cost posture.
    expect(resolved.manifest.phases ?? []).not.toContain('synthesize_concepts');
  });
});
