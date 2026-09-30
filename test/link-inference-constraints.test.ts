import { describe, expect, test } from 'bun:test';
import { inferLinkTypeFromPack } from '../src/core/schema-pack/link-inference.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { extractPageLinks, inferLinkType } from '../src/core/link-extraction.ts';
import { extractLinksFromFile, resolveCandidateSources } from '../src/commands/extract.ts';

const pack = parseSchemaPackManifest({
  api_version: 'gbrain-schema-pack-v1', name: 'synthetic-graph', version: '1.0.0', extends: null,
  page_types: [
    { name: 'competitor', primitive: 'entity', path_prefixes: ['rivals/'] },
    { name: 'company', primitive: 'entity', path_prefixes: ['organizations/'] },
    { name: 'decision', primitive: 'entity', path_prefixes: ['choices/'] },
    { name: 'meeting', primitive: 'temporal', path_prefixes: ['sessions/'] },
    { name: 'person', primitive: 'entity', path_prefixes: ['members/'] },
  ],
  link_types: [
    { name: 'competes_with', inference: { page_type: 'competitor', target_type: 'company', regex: 'competes with' } },
    { name: 'decided_in', inference: { page_type: 'decision', target_type: 'meeting', regex: 'decided in' } },
    { name: 'champion', inference: { page_type: 'customer', target_type: 'person', regex: 'champion' } },
    { name: 'attended', inference: { page_type: 'meeting', target_type: 'person' } },
    { name: 'works_at', inference: { page_type: 'person', target_type: 'company', regex: 'works at' } },
  ],
  frontmatter_links: [{ page_type: 'meeting', fields: ['attendees'], link_type: 'attended' }],
});

describe('conjunctive link inference', () => {
  test.each([
    ['competitor', 'company', 'competes with', 'competes_with'],
    ['decision', 'meeting', 'decided in', 'decided_in'],
    ['customer', 'person', 'champion', 'champion'],
  ])('%s requires its page type, target type and phrase together', (page, target, phrase, verb) => {
    expect(inferLinkTypeFromPack(pack, page, phrase, undefined, target)).toBe(verb);
    expect(inferLinkTypeFromPack(pack, 'note', phrase, undefined, target)).toBeNull();
    expect(inferLinkTypeFromPack(pack, page, phrase, undefined, 'note')).toBeNull();
    expect(inferLinkTypeFromPack(pack, page, phrase)).toBeNull();
    expect(inferLinkTypeFromPack(pack, page, 'unrelated text', undefined, target)).toBeNull();
  });

  test('target-only rules fire only when the target is known and matches', () => {
    const targetOnly = { link_types: [{ name: 'about_company', inference: { target_type: 'company' } }] };
    expect(inferLinkTypeFromPack(targetOnly, 'note', '', undefined, 'company')).toBe('about_company');
    expect(inferLinkTypeFromPack(targetOnly, 'note', '', undefined, 'person')).toBeNull();
    expect(inferLinkTypeFromPack(targetOnly, 'note', '')).toBeNull();
  });

  test('legacy meeting inference does not label decision or unknown links attended', async () => {
    expect(inferLinkType('meeting', 'Attendees', undefined, 'decisions/choice')).toBe('mentions');
    for (const active of [null, pack, { ...pack, link_types: [{ name: 'attended', inference: { page_type: 'meeting' } }] }]) {
      const result = await extractPageLinks('sessions/weekly', 'Attendees: [[choices/choice]], [[members/alice-example]]', {}, 'meeting',
        { resolve: async () => null }, { pack: active, targetType: slug => slug.startsWith('members/') ? 'person' : 'decision' });
      expect(result.candidates.find(c => c.targetSlug === 'choices/choice')?.linkType).toBe('mentions');
      expect(result.candidates.find(c => c.targetSlug === 'members/alice-example')?.linkType).toBe('attended');
      const withoutEvidence = await extractPageLinks('sessions/weekly', 'See [[choices/choice]] and [[members/alice-example]].', {}, 'meeting',
        { resolve: async () => null }, { pack: active, targetType: slug => slug.startsWith('members/') ? 'person' : 'decision' });
      expect(withoutEvidence.candidates.find(c => c.targetSlug === 'choices/choice')?.linkType).toBe('mentions');
      expect(withoutEvidence.candidates.find(c => c.targetSlug === 'members/alice-example')?.linkType).toBe(active ? 'attended' : 'mentions');
    }
  });

  test('legacy fallback cannot bypass a mismatched constrained rule', async () => {
    const result = await extractPageLinks('members/alice-example', 'Works at [Company Example](organizations/company-example).', {}, 'person',
      { resolve: async () => null }, { pack, targetType: () => 'decision' });
    expect(result.candidates[0].linkType).toBe('mentions');
  });

  test('qualified duplicate slugs retain their source and get the correct target type', async () => {
    const result = await extractPageLinks('rivals/rival-example', 'competes with [[alpha:organizations/shared]] and [[beta:organizations/shared]].', {}, 'competitor',
      { resolve: async () => null }, { pack, targetType: (_slug, source) => source === 'alpha' ? 'company' : 'person' });
    expect(result.candidates.map(c => [c.targetSourceId, c.linkType])).toEqual([['alpha', 'competes_with'], ['beta', 'mentions']]);
    const resolved = resolveCandidateSources(result.candidates[1], 'rivals/rival-example', 'alpha',
      new Set(['rivals/rival-example', 'organizations/shared']),
      new Map([['rivals/rival-example', ['alpha']], ['organizations/shared', ['alpha', 'beta']]]), true);
    expect(resolved).toEqual({ ok: true, fromSlug: 'rivals/rival-example', fromSourceId: 'alpha', toSourceId: 'beta' });
  });

  test('pack attendees override the legacy incoming mapping without inverse duplicates', async () => {
    const result = await extractPageLinks('sessions/weekly', '', { attendees: ['members/alice-example'] }, 'meeting',
      { resolve: async name => name }, { pack, targetType: () => 'person' });
    expect(result.candidates.map(c => [c.fromSlug, c.targetSlug, c.linkType])).toEqual([
      ['sessions/weekly', 'members/alice-example', 'attended'],
    ]);
  });

  test('structured attendees reject wrong or unknown target types instead of using the legacy mapping', async () => {
    for (const targetType of [undefined, () => 'decision']) {
      const result = await extractPageLinks('sessions/weekly', '', { attendees: ['choices/choice'] }, 'meeting',
        { resolve: async name => name }, { pack, targetType });
      expect(result.candidates).toEqual([]);
      expect(result.unresolved).toEqual([{ field: 'attendees', name: 'choices/choice', reason: 'target_type_mismatch' }]);
    }
  });

  test('filesystem inference prefers explicit type, then pack prefixes, and reads phrase context', async () => {
    const slugs = new Set(['choices/choice', 'rivals/rival-example', 'organizations/company-example']);
    const body = 'competes with [Company Example](../organizations/company-example.md).';
    const explicit = await extractLinksFromFile(`---\ntype: competitor\n---\n${body}`, 'choices/choice.md', slugs, { pack });
    expect(explicit[0].link_type).toBe('competes_with');
    const prefix = await extractLinksFromFile(body, 'rivals/rival-example.md', slugs, { pack });
    expect(prefix[0].link_type).toBe('competes_with');
    const wrong = await extractLinksFromFile(body, 'rivals/rival-example.md', slugs,
      { pack, pageTypes: new Map([['organizations/company-example', 'decision']]) });
    expect(wrong[0].link_type).toBe('mentions');
  });
});
