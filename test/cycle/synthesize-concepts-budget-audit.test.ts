// #4907 audit companion to synthesize-concepts-budget-config.test.ts.
//
// That file proves the phase READS `cycle.synthesize_concepts.budget_usd`.
// Nothing pinned that an operator can WRITE it: `gbrain config set` refuses
// any key missing from KNOWN_CONFIG_KEYS (src/commands/config.ts, exit 1 with
// "Unknown config key"), so dropping the row would turn the documented remedy
// in docs/operations/spend-controls.md into a hard error while the phase kept
// quietly honouring the default. Sibling `cycle.extract_atoms.budget_usd` has
// no such pin either; this one is the fix-wave's, so it gets one.
import { test, expect } from 'bun:test';
import { KNOWN_CONFIG_KEYS } from '../../src/core/config.ts';

test('cycle.synthesize_concepts.budget_usd is a known key, so `gbrain config set` accepts it', () => {
  expect(KNOWN_CONFIG_KEYS).toContain('cycle.synthesize_concepts.budget_usd');
});
