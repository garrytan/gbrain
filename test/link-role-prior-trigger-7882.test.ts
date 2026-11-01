/**
 * #7882: the page-role prior reads its trigger phrase only from text outside the machine-written sections
 * (rolePriorSuppressedRanges), the same sections whose links #4977 keeps away from the prior.
 *
 * 1. Protects: a "portfolio" written only in ## Facts or ## Timeline leaves a person page's bare company link a
 *    \`mentions\`; the same word in a prose section still types it \`invested_in\`. The segmented full pass, its role text
 *    and the incremental session agree with the inline answer, including a Facts section that spans a segment cut.
 * 2. Fails when: the prior tests the whole page text (inline) or every block's text (segmented) again.
 * 3. Why existing coverage misses it: the #4977 tests put the link inside the machine section, not the trigger.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractPageLinks, makeResolver, type SlugResolver } from '../src/core/link-extraction.ts';
import { extractSegmentedPageLinks, openSegmentedLinkSession, segmentedRoleText } from '../src/core/page-body/segment-links.ts';
import { SEGMENT_MAX_BYTES } from '../src/core/page-body/limits.ts';
import { createSegmentedPage } from './helpers/segmented-page.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const SLUG = 'people/alice-example';
const TARGET = 'companies/acme-cafe';
const resolver: SlugResolver = { resolve: async () => null } as never;
const targetType = (s: string) => (s.startsWith('companies/') ? 'company' : 'concept');
const dining = '# Alice Example\n\n## Dining\n\n- Alice likes the pasta at [[companies/acme-cafe]].\n';
const variants: Record<string, [string, string]> = {
  A: [dining, 'mentions'],
  B: [dining + '\n## Facts\n\n- Alice reviews her portfolio every Sunday.\n', 'mentions'],
  C: [dining + '\n## Timeline\n\n- **2026-01-02** | Portfolio review completed.\n', 'mentions'],
  D: [dining + '\n## Money\n\n- Alice keeps a small index-fund portfolio.\n', 'invested_in'],
};

const typesOf = (candidates: Array<{ targetSlug: string; linkType: string }>) =>
  candidates.filter(c => c.targetSlug === TARGET).map(c => c.linkType).join(',');

describe('#7882 role-prior trigger outside machine sections (inline)', () => {
  for (const [name, [body, expected]] of Object.entries(variants)) {
    test('variant ' + name + ' types the company link ' + expected, async () => {
      const r = await extractPageLinks(SLUG, body, {}, 'person', resolver, { targetType });
      expect(typesOf(r.candidates)).toBe(expected);
    });
  }

  test('a heading nested under ## Facts stays suppressed; the next prose section reads again', async () => {
    const nested = dining + '\n## Facts\n\n### Money\n\n- Alice reviews her portfolio.\n';
    expect(typesOf((await extractPageLinks(SLUG, nested, {}, 'person', resolver, { targetType })).candidates)).toBe('mentions');
    const after = dining + '\n## Facts\n\n- n/a\n\n## Work\n\n- Alice is a seed investor.\n';
    expect(typesOf((await extractPageLinks(SLUG, after, {}, 'person', resolver, { targetType })).candidates)).toBe('invested_in');
  });
});

describe('#7882 role-prior trigger outside machine sections (segmented)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  // The Facts section opens in the first segment and its trigger sits past the cut, in the second.
  const filler = Array.from({ length: Math.ceil(SEGMENT_MAX_BYTES / 36) }, (_, i) => '- fact row ' + i + ' about weekly routines\n').join('');
  const pages: Record<string, [string, string]> = {
    facts: [dining + '\n## Facts\n\n' + filler + '- Alice reviews her portfolio every Sunday.\n', 'mentions'],
    prose: [dining + '\n## Facts\n\n' + filler + '\n## Money\n\n- Alice keeps a small index-fund portfolio.\n', 'invested_in'],
  };

  for (const [name, [truth, expected]] of Object.entries(pages)) {
    test('a ' + name + ' trigger past a segment cut types the link ' + expected + ', as inline', async () => {
      const { id } = await createSegmentedPage(engine, { slug: SLUG, truth, meta: { type: 'person' } });
      const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id=$1', [id]);
      expect(row!.n).toBeGreaterThan(1);
      const page = { id, slug: SLUG, source_id: 'default', type: 'person' as const, frontmatter: {} };
      const live = makeResolver(engine, { mode: 'live', sourceId: 'default' });
      const inline = await extractPageLinks(SLUG, truth + '\n', {}, 'person', live, { targetType });
      expect(typesOf(inline.candidates)).toBe(expected);
      const roleText = await segmentedRoleText(engine, page);
      expect(/portfolio/i.test(roleText)).toBe(expected === 'invested_in');
      expect(typesOf((await extractSegmentedPageLinks(engine, page, live, { targetType })).candidates)).toBe(expected);
      const session = await openSegmentedLinkSession(engine, page, live, {});
      expect(session).not.toBeNull();
      await session!.targets({});
      expect(typesOf((await session!.finish({ temporal: true, targetType } as never)).candidates)).toBe(expected);
    });
  }
});
