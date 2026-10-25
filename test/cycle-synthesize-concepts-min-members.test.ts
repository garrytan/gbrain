// synthesize_concepts reads `cycle.synthesize_concepts.min_members`.
//
// Protects: groups below the configured member count get no concept page, the
// unset key keeps the historical floor of 2, an invalid stored value keeps the
// default with a named-key warning, and `config set` refuses a value the phase
// would not apply.
// Fails when: the phase goes back to a hard-coded floor, or the key is dropped
// from the registry or the phase-config specs.
//
// The real phase runs through its `_atoms` seam under `dryRun`: nothing is
// written and no provider is called (every group here is T3 or below).
import { describe, test, expect } from 'bun:test';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { parsePhaseConfigValue, SYNTHESIZE_CONCEPTS_MIN_MEMBERS_KEY } from '../src/core/cycle/phase-config-values.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

const KEY = SYNTHESIZE_CONCEPTS_MIN_MEMBERS_KEY;

/** One group per entry in `sizes`; group g has sizes[g] member atoms. */
function atoms(sizes: number[]) {
  return sizes.flatMap((per, g) => Array.from({ length: per }, (_, i) => ({
    slug: `atoms/2026-09-05/g${g}-a${i}`, concept_refs: [`concept-${g}`], title: `atom ${g}.${i}`, body: `body of atom ${g}.${i}`,
  })));
}

async function run(configured: string | null, sizes = [1, 2, 3, 4]) {
  const engine = {
    getConfig: async (k: string) => (k === KEY ? configured : null),
    readPageSnapshot: async () => null,
  } as never;
  const original = console.error;
  console.error = () => {};
  try {
    const r = await runPhaseSynthesizeConcepts(engine, { dryRun: true, _atoms: atoms(sizes), _chat: (async () => { throw new Error('no LLM for T3'); }) as never } as never);
    return { r, details: r.details as Record<string, unknown> };
  } finally {
    console.error = original;
  }
}

describe('synthesize_concepts member floor comes from cycle.synthesize_concepts.min_members', () => {
  test('unset keeps the floor of 2: every group with 2 or more atoms gets a page', async () => {
    const { details } = await run(null);
    expect(details.groups_found).toBe(3);
    expect(details.min_members).toBe(2);
  });

  test('a configured floor drops smaller groups before any page is written', async () => {
    const { details } = await run('4');
    expect(details.groups_found).toBe(1);
    expect(details.min_members).toBe(4);
    expect(details.tier_counts).toMatchObject({ T3: 1 });
  });

  test('a floor above every group skips the phase and names the floor', async () => {
    const { r, details } = await run('10');
    expect(r.status).toBe('skipped');
    expect(r.summary).toContain('≥10 atoms');
    expect(details.reason).toBe('no_groups_above_threshold');
  });

  test('a stored invalid value keeps the default and names the key', async () => {
    const { details } = await run('1');
    expect(details.groups_found).toBe(3);
    const warning = (details.warnings as string[]).find((w) => w.includes('invalid value'));
    expect(warning).toContain(KEY);
    expect(warning).toContain(`gbrain config set ${KEY}`);
  });

  test('the key is registered and config set accepts only whole numbers from 2 to 10000', () => {
    expect(KNOWN_CONFIG_KEYS).toContain(KEY);
    expect(parsePhaseConfigValue(KEY, '5')).toBe(5);
    expect(parsePhaseConfigValue(KEY, '10000')).toBe(10000);
    for (const bad of ['0', '1', '2.5', '-3', '10001', 'five', ' ']) {
      expect(() => parsePhaseConfigValue(KEY, bad)).toThrow(KEY);
    }
  });
});
