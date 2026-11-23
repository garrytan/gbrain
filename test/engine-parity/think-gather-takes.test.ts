/**
 * BrainEngine parity — the takes keyword stream of think's evidence gather (`runGather`, src/core/think/gather.ts)
 * under a remote caller's read policy.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a remote think call gathers takes through `engine.searchTakes` with the page scope gather builds
 *    (`excludePrivate`, `requireSafeChunks`, the holder allow-list, the source scope, an empty eligibility policy).
 *    On every engine arm the gather returns the takes on pages the page policy keeps, never a take on a private
 *    page or a page whose readers the caller is not, and raises no stream warning.
 *  - Regression: an engine that refuses one of those options makes the stream fail quietly (gather catches it and
 *    adds GATHER_TAKES_KEYWORD_FAILED), so think answers without the takes; an engine that drops the private-page
 *    filter puts a private take into the synthesis prompt. The private takes match the question better than the
 *    open ones, so a dropped filter shows them.
 *  - Why existing coverage misses it: private-page-reads.test.ts calls searchTakes with `excludePrivate` alone;
 *    the think tests stub the engine or run one engine.
 *  - Caller policy: the last read runs as a member whose identity one page's readers name.
 *  - Seam: none. Real engines; gather runs as think runs it, keyless (no embedding, so no vector stream).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runGather } from '../../src/core/think/gather.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/**
 * The question has more words than the alias hop reads (alias-hop.ts reads at most 14), so the hybrid page stream
 * makes no alias lookup and the case reaches the takes stream alone; every claim contains the whole question.
 */
const QUESTION = 'which probe claim about the quarterly widget launch plan should the whole team trust the most right now';

/** Pages with one take each; the hidden ones weigh more, so they would rank first if shown. */
const PAGES: Array<[slug: string, frontmatter: Record<string, unknown>, claim: string, weight: number]> = [
  ['notes/open', {}, `${QUESTION}: open`, 0.6],
  ['notes/world', { visibility: 'world' }, `${QUESTION}: world`, 0.6],
  ['notes/private', { visibility: 'private' }, `${QUESTION}: private`, 0.95],
  ['notes/readers', { readable_by: ['alice-example'] }, `${QUESTION}: readers`, 0.9],
];

async function fixture(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  await createSource(engine, backend, 'other');
  const slugOf = new Map<number, string>();
  for (const [slug, frontmatter, claim, weight] of PAGES) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `About ${slug}.`, timeline: '', frontmatter });
    const id = Number((await engine.getPage(slug))!.id);
    slugOf.set(id, slug);
    await engine.addTakesBatch([{ page_id: id, row_num: 1, claim, kind: 'take', holder: 'garry', weight }]);
  }
  await engine.putPage('notes/elsewhere', { type: 'note', title: 'Other open', compiled_truth: 'Other.', timeline: '' }, { sourceId: 'other' });
  const other = Number((await engine.getPage('notes/elsewhere', { sourceId: 'other' }))!.id);
  slugOf.set(other, 'other:notes/elsewhere');
  await engine.addTakesBatch([{ page_id: other, row_num: 1, claim: `${QUESTION}: other`, kind: 'take', holder: 'garry', weight: 0.6 }]);
  return slugOf;
}

describe('engine parity: think gather reads takes under a remote read policy', () => {
  parityTest(
    'runGather\'s takes stream under excludePrivate returns only takes on pages the page policy keeps, with no stream warning',
    { methods: ['putPage', 'getPage', 'addTakesBatch', 'searchTakes'] },
    async (engine, backend) => {
      const slugOf = await fixture(engine, backend);
      const gather = async (scope: { sourceId?: string; takesHoldersAllowList?: string[] }) => {
        const result = await runGather(engine, { question: QUESTION, remote: true, excludePrivate: true, ...scope });
        return {
          takes: sorted(result.takes.map((t) => slugOf.get(t.page_id)!)),
          fromKeyword: result.diagnostics.takesFromKeyword,
          takesWarnings: result.warnings.filter((w) => w.startsWith('GATHER_TAKES')),
        };
      };
      const remote = await gather({ takesHoldersAllowList: ['garry'] });
      const scoped = await gather({ sourceId: 'default', takesHoldersAllowList: ['garry'] });
      const nobody = await gather({ takesHoldersAllowList: ['nobody'] });
      // A member whose identity the page's readers name also reads that page's take; the private one stays hidden.
      const member = await withCallerAccess({ identity: ['member:alice-example'], hidePrivate: true }, () => gather({ takesHoldersAllowList: ['garry'] }));
      expect(remote).toEqual({ takes: ['notes/open', 'notes/world', 'other:notes/elsewhere'], fromKeyword: 3, takesWarnings: [] });
      expect(scoped).toEqual({ takes: ['notes/open', 'notes/world'], fromKeyword: 2, takesWarnings: [] });
      expect(nobody).toEqual({ takes: [], fromKeyword: 0, takesWarnings: [] });
      expect(member).toEqual({ takes: ['notes/open', 'notes/readers', 'notes/world', 'other:notes/elsewhere'], fromKeyword: 4, takesWarnings: [] });
      return { remote, scoped, nobody, member };
    },
  );
});
