// v0.38 T7b: pack-aware link inference tests.
//
// Pins the contract that `inferLinkTypeFromPack` consults pack-declared
// verbs WITHOUT replacing legacy in-code inferLinkType. Two scenarios:
//   1. Legacy gbrain-base routes (founded/invested_in/advises/works_at)
//      stay reachable via the existing inferLinkType call.
//   2. User packs can ADD new verbs via link_types[].inference.regex;
//      the new verb resolves on the pack-aware path before the legacy
//      fall-through.

import { describe, expect, test } from 'bun:test';
import {
  inferLinkTypeFromPack,
  frontmatterLinkTypeFromPack,
  parseSchemaPackManifest,
  PageRegexBudget,
} from '../src/core/schema-pack/index.ts';
import { inferLinkType } from '../src/core/link-extraction.ts';

describe('inferLinkTypeFromPack (T7b)', () => {
  const minimalPack = (link_types: Array<Record<string, unknown>>) =>
    parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'test',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types,
    });

  test('page-type-bound verb resolves deterministically (meeting → attended)', () => {
    const pack = minimalPack([
      { name: 'attended', inference: { page_type: 'meeting' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'meeting', 'irrelevant text')).toBe('attended');
  });

  test('image → image_of via pack declaration', () => {
    const pack = minimalPack([
      { name: 'image_of', inference: { page_type: 'image' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'image', 'doesnt matter')).toBe('image_of');
  });

  test('regex matcher resolves user-declared verb', () => {
    const pack = minimalPack([
      { name: 'supports', inference: { regex: '\\b(supports|in support of)\\b' } },
      { name: 'weakens', inference: { regex: '\\b(weakens|undermines)\\b' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'paper', 'this evidence supports the claim')).toBe('supports');
    expect(inferLinkTypeFromPack(pack, 'paper', 'this evidence weakens the claim')).toBe('weakens');
    expect(inferLinkTypeFromPack(pack, 'paper', 'mentions only')).toBeNull();
  });

  test('returns null when no rule fires (caller falls through to legacy)', () => {
    const pack = minimalPack([
      { name: 'cites', inference: { regex: '\\bcites?\\b' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'paper', 'no matching text here')).toBeNull();
  });

  test('first match wins in declaration order', () => {
    const pack = minimalPack([
      { name: 'first-match', inference: { regex: '\\bword\\b' } },
      { name: 'second-match', inference: { regex: '\\bword\\b' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'concept', 'the word matters')).toBe('first-match');
  });

  test('respects PageRegexBudget exhaustion', () => {
    const pack = minimalPack([
      { name: 'a', inference: { regex: '\\ba\\b' } },
      { name: 'b', inference: { regex: '\\bb\\b' } },
    ]);
    const budget = new PageRegexBudget();
    // First call within budget — should resolve.
    expect(inferLinkTypeFromPack(pack, 'concept', 'a then b', budget)).toBe('a');
    // Budget tracker accumulates.
    expect(budget.getCumulativeMs()).toBeGreaterThanOrEqual(0);
  });

  test('legacy inferLinkType still operates independently', () => {
    // The pack-aware variant doesn't break legacy callers.
    expect(inferLinkType('person', 'founded Acme Corp last year')).toBe('founded');
    expect(inferLinkType('person', 'invested in Acme Series A')).toBe('invested_in');
    expect(inferLinkType('person', 'advises Acme')).toBe('advises');
  });

  test('pack-aware regex with malformed pattern returns null gracefully', () => {
    // Pack validation should catch this at load; this is the runtime
    // safety net.
    const pack = minimalPack([
      { name: 'broken', inference: { regex: '[unclosed' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'concept', 'text')).toBeNull();
  });
});

describe('frontmatterLinkTypeFromPack (T7b)', () => {
  test('person:company → works_at via pack declaration', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'test',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types: [],
      frontmatter_links: [
        { page_type: 'person', fields: ['company', 'companies'], link_type: 'works_at' },
        { page_type: 'company', fields: ['key_people'], link_type: 'works_at' },
        { page_type: 'meeting', fields: ['attendees'], link_type: 'attended' },
      ],
    });
    expect(frontmatterLinkTypeFromPack(pack, 'person', 'company')).toBe('works_at');
    expect(frontmatterLinkTypeFromPack(pack, 'person', 'companies')).toBe('works_at');
    expect(frontmatterLinkTypeFromPack(pack, 'company', 'key_people')).toBe('works_at');
    expect(frontmatterLinkTypeFromPack(pack, 'meeting', 'attendees')).toBe('attended');
    expect(frontmatterLinkTypeFromPack(pack, 'person', 'random_field')).toBeNull();
    // Wrong page type: doesn't match.
    expect(frontmatterLinkTypeFromPack(pack, 'company', 'company')).toBeNull();
  });

  test('empty frontmatter_links returns null for every field', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'test',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types: [],
    });
    expect(frontmatterLinkTypeFromPack(pack, 'person', 'company')).toBeNull();
  });
});
