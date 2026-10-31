import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as rolePriors from '../src/core/link-extraction.ts';
import { createHash } from 'node:crypto';
import { bodyBlocks } from '../src/core/page-body/segment-blocks.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { extractSegmentedPageLinks, openSegmentedLinkSession, segmentedRoleText } from '../src/core/page-body/segment-links.ts';
import { SEGMENT_PIPELINE_VERSIONS } from '../src/core/page-body/segment-derive.ts';
import { extractPageLinks } from '../src/core/link-extraction.ts';

const resolver = { resolve: async () => null } as any;
const opts = {
  pack: null,
  targetType: (slug: string) => slug.startsWith('companies/') ? 'company' : 'concept',
} as any;

async function cafeLinkType(content: string): Promise<string | undefined> {
  const result = await extractPageLinks('people/alice-example', content, {}, 'person', resolver, opts);
  return result.candidates.find(candidate => candidate.targetSlug === 'companies/acme-cafe')?.linkType;
}

describe('page-role investor prior', () => {
  test('ignores machine sections and ordinary portfolio mentions as triggers', async () => {
    const prose = '# Alice Example\n\n## Dining\n\n- Alice likes the pasta at [[companies/acme-cafe]].\n';
    expect(await cafeLinkType(prose + '\n## Facts\n\n- Alice reviews her portfolio every Sunday.\n')).toBe('mentions');
    expect(await cafeLinkType(prose + '\n## Timeline\n\n- **2026-01-02** | Portfolio review completed.\n')).toBe('mentions');
    expect(await cafeLinkType(prose + '\n## Money\n\n- Alice keeps a small index-fund portfolio.\n')).toBe('mentions');
    expect(await cafeLinkType(prose + '\n## Work\n\n- Alice is an investor in early-stage companies.\n')).toBe('invested_in');
  });

  test('explicit investor and advisor phrases confined to machine sections do not set the prior', async () => {
    const prose = '# Alice Example\n\n## Dining\n\n- Alice likes [[companies/acme-cafe]].\n';
    for (const section of ['Facts', 'Timeline']) {
      for (const phrase of ['Alice is an investor in early-stage companies.', 'Alice is a professional advisor.']) {
        expect(await cafeLinkType(prose + `\n## ${section}\n\n- ${phrase}\n`)).toBe('mentions');
      }
    }
    expect(await cafeLinkType(prose + '\n## Work\n\n- Alice is a professional advisor.\n')).toBe('advises');
  });

  test('derives role phrases once for many links and skips derivation for overrides or meetings', async () => {
    const content = '# Alice Example\n\nAlice is an investor in early-stage companies.\n\n'
      + Array.from({ length: 20 }, (_, i) => `- Likes [[companies/cafe-${i}]].`).join('\n');
    const derive = spyOn(rolePriors, 'rolePriorPhrases');
    try {
      const result = await extractPageLinks('people/alice-example', content, {}, 'person', resolver, opts);
      expect(result.candidates).toHaveLength(20);
      expect(derive).toHaveBeenCalledTimes(1);
      derive.mockClear();
      const overridden = await extractPageLinks('people/alice-example', content, {}, 'person', resolver, { ...opts, roleText: '' });
      expect(overridden.candidates.every(candidate => candidate.linkType === 'mentions')).toBe(true);
      expect(derive).not.toHaveBeenCalled();
      await extractPageLinks('meetings/example', content, {}, 'meeting', resolver, opts);
      expect(derive).not.toHaveBeenCalled();
    } finally {
      derive.mockRestore();
    }
  });

  describe('streamed role priors', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      await engine.setConfig('pages.segmented_storage', 'on');
    }, 60_000);
    afterAll(async () => {
      await engine.disconnect();
    });

    test('streamed sections and stale v1 cached roles cannot manufacture an investor prior', async () => {
      const slug = 'people/streamed-prior-example';
      const content = '# Alice Example\n\n## Dining\n\nLikes [[companies/acme-cafe]].\n\n## Facts\n\n'
        + 'A neutral detail stays in this section.\n\n'.repeat(30_000)
        + 'Alice is an investor in early-stage companies.\n';
      const put = async (text: string) => {
        expect(await importFromContent(engine, slug, `---\ntype: person\ntitle: Alice Example\n---\n\n${text}`, { sourceId: 'default', noEmbed: true }))
          .toMatchObject({ status: 'imported' });
        const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
        expect(snapshot.page.body_storage).toBe('segmented');
        return { id: Number(snapshot.page.id), slug, source_id: 'default', type: 'person' as const, frontmatter: {} };
      };
      const page = await put(content);
      const [count] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL', [page.id]);
      expect(count!.n).toBeGreaterThan(1);
      expect(await segmentedRoleText(engine, page)).toBe('');
      const typeOfCafe = (result: Awaited<ReturnType<typeof extractSegmentedPageLinks>>) =>
        result.candidates.find(candidate => candidate.targetSlug === 'companies/acme-cafe')?.linkType;
      expect(typeOfCafe(await extractSegmentedPageLinks(engine, page, resolver, opts))).toBe('mentions');
      const incremental = async () => {
        const session = await openSegmentedLinkSession(engine, page, resolver, opts);
        expect(session).not.toBeNull();
        await session!.targets(opts);
        return session!.finish({ ...opts, targetType: opts.targetType });
      };
      expect(typeOfCafe(await incremental())).toBe('mentions');
      await engine.executeRaw(`UPDATE page_segment_derivations SET pipeline_version=1,
        output=CASE WHEN jsonb_typeof(output)='object' THEN jsonb_set(output, '{roles}', jsonb_build_array('investor in'::text, NULL::text, NULL::text)) ELSE output END
        WHERE page_id=$1 AND pipeline='links'`, [page.id]);
      const stale = await engine.readSegmentDerivations(page.id, { kind: 'links' });
      expect(stale.length).toBeGreaterThan(0);
      expect(stale.every(row => row.version === 1)).toBe(true);
      expect(typeOfCafe(await incremental())).toBe('mentions');
      expect((await engine.readSegmentDerivations(page.id, { kind: 'links' }))
        .every(row => row.version === SEGMENT_PIPELINE_VERSIONS.links)).toBe(true);
      const roleBlockHash = async () => {
        for await (const block of bodyBlocks(engine, page)) {
          if (block.text.includes('Alice is an investor in')) {
            expect(block.text.includes('## Facts')).toBe(false);
            return createHash('sha256').update(block.text).digest('hex');
          }
        }
        throw new Error('fixture lost its role block');
      };
      const unchangedRoleBlock = await roleBlockHash();
      await put(content.replace('## Facts', '## Work'));
      expect(await roleBlockHash()).toBe(unchangedRoleBlock);
      expect(typeOfCafe(await incremental())).toBe('invested_in');
      await put(content);
      expect(typeOfCafe(await incremental())).toBe('mentions');
      await put(content + '\n## Work\n\nAlice is an investor in early-stage companies.\n');
      expect(typeOfCafe(await extractSegmentedPageLinks(engine, page, resolver, opts))).toBe('invested_in');
      expect(typeOfCafe(await incremental())).toBe('invested_in');
    }, 60_000);
  });
});
