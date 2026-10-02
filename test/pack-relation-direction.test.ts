/**
 * Schema-pack relation direction (eval wave N9-2, N9-3, N12-7).
 *
 * The bundled packs mirror FRONTMATTER_LINK_MAP and the in-code meeting
 * attendance rule. Pack-declared frontmatter mappings must keep the declared
 * direction (company `investors:` is investor -> company, meeting `attendees:`
 * is person -> meeting), and a pack's `attended` verb on a meeting page must
 * follow canonical, evidence-gated attendance (person -> meeting, only from an
 * explicit attendee list). Pure extraction checks run here; the engine-level
 * checks live in test/pack-relation-direction-engine.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { extractPageLinks, type LinkCandidate, type SlugResolver } from '../src/core/link-extraction.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { bundledPackPath } from '../src/core/schema-pack/bundled-assets.ts';

const types: Record<string, string> = {
  'people/alice-example': 'person', 'people/bob-example': 'person', 'companies/gamma-example': 'company',
  'funds/fund-a': 'fund', 'deals/gamma-seed': 'deal', 'meetings/board-example': 'meeting', 'customers/acme-example': 'customer',
};
const resolver: SlugResolver = {
  async resolve(name) { return types[name] ? name : null; },
  async resolveAttendance(name) { return types[name] === 'person' ? name : null; },
};
const pack = (name: string) => loadPackFromFile(bundledPackPath(name)!);
const edges = (candidates: LinkCandidate[], self: string) => candidates
  .filter(c => c.linkType !== 'mentions')
  .map(c => {
    const from = c.fromSlug ?? self;
    return c.canonicalAttendance ? `${c.targetSlug} -> ${from} (${c.linkType})` : `${from} -> ${c.targetSlug} (${c.linkType})`;
  }).sort();
async function extract(packName: string | null, slug: string, type: string, body: string, frontmatter: Record<string, unknown> = {}) {
  const result = await extractPageLinks(slug, body, frontmatter, type as never, resolver,
    { pack: packName ? pack(packName) : null, targetType: target => types[target] });
  return { ...result, edges: edges(result.candidates, slug) };
}

for (const packName of [null, 'gbrain-base', 'company-brain', 'gbrain-base-v2']) {
  const label = packName ?? 'no pack';
  describe(`frontmatter relation direction (${label})`, () => {
    test('meeting attendees are stored person -> meeting', async () => {
      const r = await extract(packName, 'meetings/board-example', 'meeting', 'The board reviewed the quarter.',
        { attendees: ['people/alice-example', 'people/bob-example'] });
      expect(r.edges).toEqual([
        'people/alice-example -> meetings/board-example (attended)',
        'people/bob-example -> meetings/board-example (attended)',
      ]);
    });
  });
}

for (const packName of [null, 'gbrain-base']) {
  describe(`incoming frontmatter mappings keep their direction (${packName ?? 'no pack'})`, () => {
    test('company investors, key_people and partner point at the company', async () => {
      const r = await extract(packName, 'companies/gamma-example', 'company', 'Gamma Example builds tools.', {
        investors: ['funds/fund-a'], key_people: ['people/alice-example'], partner: 'people/bob-example',
      });
      expect(r.edges).toEqual([
        'funds/fund-a -> companies/gamma-example (invested_in)',
        'people/alice-example -> companies/gamma-example (works_at)',
        'people/bob-example -> companies/gamma-example (yc_partner)',
      ]);
    });
    test('deal investors and lead point at the deal', async () => {
      const r = await extract(packName, 'deals/gamma-seed', 'deal', 'Seed round.', { investors: ['people/bob-example'], lead: 'funds/fund-a' });
      expect(r.edges).toEqual(['funds/fund-a -> deals/gamma-seed (led_round)', 'people/bob-example -> deals/gamma-seed (invested_in)']);
    });
    test('outgoing person mappings stay outgoing', async () => {
      const r = await extract(packName, 'people/alice-example', 'person', 'Alice Example.', { company: 'companies/gamma-example' });
      expect(r.edges).toEqual(['people/alice-example -> companies/gamma-example (works_at)']);
    });
  });
}

test('a pack mapping with no declared incoming counterpart stays outgoing (company-brain owner)', async () => {
  const r = await extract('company-brain', 'customers/acme-example', 'customer', 'A customer.', { owner: 'people/alice-example' });
  expect(r.edges).toEqual(['customers/acme-example -> people/alice-example (owned_by)']);
});

for (const packName of [null, 'gbrain-base', 'company-brain', 'gbrain-base-v2']) {
  describe(`meeting body attendance (${packName ?? 'no pack'})`, () => {
    test('an explicit attendee list is canonical person -> meeting attendance', async () => {
      const r = await extract(packName, 'meetings/board-example', 'meeting',
        'Attendees: [Alice Example](people/alice-example), [Bob Example](people/bob-example).\n\nThe board reviewed the quarter.');
      expect(r.candidates.filter(c => c.linkType === 'attended').every(c => c.canonicalAttendance)).toBe(true);
      expect(r.edges).toEqual([
        'people/alice-example -> meetings/board-example (attended)',
        'people/bob-example -> meetings/board-example (attended)',
      ]);
      expect(r.attendanceComplete).toBe(true);
    });
    test('a person only mentioned in the notes is not an attendee (N12-7)', async () => {
      const r = await extract(packName, 'meetings/board-example', 'meeting',
        '## Attendees\n\n- [[people/alice-example|Alice Example]]\n\n## Notes\n\n[[people/bob-example|Bob Example]] will send the deck.\n');
      expect(r.edges).toEqual(['people/alice-example -> meetings/board-example (attended)']);
      expect(r.candidates.find(c => c.targetSlug === 'people/bob-example')?.linkType).toBe('mentions');
    });
    test('a non-person in the attendee list is a mention', async () => {
      const r = await extract(packName, 'meetings/board-example', 'meeting', 'Attendees: [Gamma](companies/gamma-example)');
      expect(r.edges).toEqual([]);
    });
  });
}
