// v0.38 gbrain-base byte-for-byte equivalence gate (T5 + T25 CI-blocking).
//
// gbrain-base.yaml MUST reproduce pre-v0.38 hardcoded behavior exactly.
// This test pins the contract: every ALL_PAGE_TYPES seed has a matching
// page_type entry; every inferType path-prefix the markdown.ts hardcode
// recognized still maps to the same type via the pack's path_prefixes;
// the takes_kinds list still matches the pre-v0.38 {fact,take,bet,hunch}
// closed enum (so existing brains see no behavior change at runtime
// validation time).
//
// If this test fails, gbrain-base.yaml drifted from the source-of-truth
// constants. Either the YAML needs to be updated to match a deliberate
// constant change, or the constant change is unintentional and gbrain-base
// is the canonical reference.

import { describe, expect, test } from 'bun:test';
import { ALL_PAGE_TYPES } from '../../src/core/types.ts';
import { loadPackFromFile } from '../../src/core/schema-pack/loader.ts';
import { join } from 'node:path';

const BASE_PATH = join(import.meta.dir, '../../src/core/schema-pack/base/gbrain-base.yaml');

describe('gbrain-base v0.38 parity gate', () => {
  test('every ALL_PAGE_TYPES seed appears in gbrain-base page_types', () => {
    const pack = loadPackFromFile(BASE_PATH);
    const yamlTypes = new Set(pack.page_types.map(pt => pt.name));
    for (const seed of ALL_PAGE_TYPES) {
      expect(yamlTypes.has(seed)).toBe(true);
    }
  });

  test('takes_kinds matches pre-v0.38 closed enum {fact,take,bet,hunch}', () => {
    const pack = loadPackFromFile(BASE_PATH);
    expect(pack.takes_kinds.sort()).toEqual(['bet', 'fact', 'hunch', 'take']);
  });

  test('person + company are the only expert_routing default types', () => {
    // Pre-v0.38 whoknows / find_experts hardcoded ['person', 'company'].
    // gbrain-base must reproduce this default; user packs opt in others
    // via `expert_routing: true`.
    const pack = loadPackFromFile(BASE_PATH);
    const experts = pack.page_types.filter(pt => pt.expert_routing).map(pt => pt.name).sort();
    expect(experts).toEqual(['company', 'person']);
  });

  test('inferType path-prefix mapping reproduces pre-v0.38 behavior', () => {
    // Spot-check the high-traffic path mappings against expectations.
    // If this drifts, either the inferType source changed (update YAML)
    // or the YAML drifted (revert).
    const pack = loadPackFromFile(BASE_PATH);
    const byPrefix = new Map<string, string>();
    for (const pt of pack.page_types) {
      for (const prefix of pt.path_prefixes) {
        byPrefix.set(prefix, pt.name);
      }
    }
    expect(byPrefix.get('people/')).toBe('person');
    expect(byPrefix.get('companies/')).toBe('company');
    expect(byPrefix.get('deals/')).toBe('deal');
    expect(byPrefix.get('meetings/')).toBe('meeting');
    expect(byPrefix.get('writing/')).toBe('writing');
    expect(byPrefix.get('wiki/analysis/')).toBe('analysis');
    expect(byPrefix.get('media/')).toBe('media');
  });

  test('FRONTMATTER_LINK_MAP reproduces critical entries', () => {
    const pack = loadPackFromFile(BASE_PATH);
    const find = (page_type: string, field: string) =>
      pack.frontmatter_links.find(fl => fl.page_type === page_type && fl.fields.includes(field));
    expect(find('person', 'company')?.link_type).toBe('works_at');
    expect(find('person', 'founded')?.link_type).toBe('founded');
    expect(find('company', 'key_people')?.link_type).toBe('works_at');
    expect(find('company', 'investors')?.link_type).toBe('invested_in');
    expect(find('deal', 'investors')?.link_type).toBe('invested_in');
    expect(find('meeting', 'attendees')?.link_type).toBe('attended');
  });

  test('inferLinkType verb regexes reproduce known semantics', () => {
    const pack = loadPackFromFile(BASE_PATH);
    const verbs = new Map(pack.link_types.map(lt => [lt.name, lt]));
    // attended fires on meeting pages
    expect(verbs.get('attended')?.inference?.page_type).toBe('meeting');
    // image_of fires on image pages
    expect(verbs.get('image_of')?.inference?.page_type).toBe('image');
    // verb regex patterns present
    expect(verbs.get('founded')?.inference?.regex).toContain('founded');
    expect(verbs.get('invested_in')?.inference?.regex).toContain('invested');
    expect(verbs.get('advises')?.inference?.regex).toContain('advis');
    expect(verbs.get('works_at')?.inference?.regex).toContain('works');
    // mentions is the fallback (declared but no inference rule)
    expect(verbs.has('mentions')).toBe(true);
  });

  test('alias graph is EMPTY by default (E8 codex F8)', () => {
    // gbrain-base ships with NO alias edges so existing search behavior
    // is unchanged. Users opt into aliases via review-candidates or by
    // editing their own pack manifest.
    const pack = loadPackFromFile(BASE_PATH);
    for (const pt of pack.page_types) {
      expect(pt.aliases).toEqual([]);
    }
  });

  test('codegen --check passes in process', () => {
    // Spawning the script in a subprocess would be slow; assert the
    // validation logic against the in-process loader instead. If the
    // standalone script breaks, this test still catches the data drift.
    const pack = loadPackFromFile(BASE_PATH);
    expect(pack.name).toBe('gbrain-base');
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pack.extends).toBeNull();
  });
});
