/**
 * BrainEngine parity — page reads under `excludePrivate` for a member caller on a brain that never named readers.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a caller record with `restricted: false` and a member identity renders the short member-access form of
 *    the page policy. No page names readers on such a brain (a `readable_by` page sets `access.restrictions_present`),
 *    so the identity reaches no page: getLinks and getBacklinks hide the same private pages from the member as from a
 *    plain caller, its own private member page included, and a private-readable grant shows the private pages of its
 *    source to both.
 *  - Regression: the Rust arm judged a page read with judgeWidenedCaller, which retries only an anonymous caller under
 *    the restricted rendering, so a member caller on such a brain got a typed refusal on every page read under
 *    `excludePrivate` while PGLite answered.
 *  - Why existing coverage misses it: unrestricted-fact-list-reads covers the fact reads; private-page-reads reads its
 *    member on a restricted brain.
 *  - Seam: none. Real engines, typed methods only; the fixture writes no `readable_by` page, as the premise of the
 *    short form requires.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { MEMBER_PAGE_PREFIX } from '../../src/core/access/principals.ts';

const { parityTest } = parityArms(testBackends());

const HUB = 'people/a-example';
const TARGETS: Array<[string, Record<string, unknown>]> = [
  ['notes/open', {}],
  ['notes/private', { visibility: 'private' }],
  [`${MEMBER_PAGE_PREFIX}alice-example`, { visibility: 'private' }],
  [`${MEMBER_PAGE_PREFIX}bob-example`, { visibility: 'private' }],
];

/** A hub page that links to each target and is linked from each one. */
async function fixture(engine: BrainEngine) {
  await engine.putPage(HUB, { type: 'person', title: 'A', compiled_truth: 'A', timeline: '' });
  for (const [slug, frontmatter] of TARGETS) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '', frontmatter });
    await engine.addLink(HUB, slug, '', 'mentions', 'manual');
    await engine.addLink(slug, HUB, '', 'mentions', 'manual');
  }
}

/** The unrestricted callers: plain, a member, and each with a private-readable grant on `default`. */
const CALLERS = {
  plain: { restricted: false, hidePrivate: true },
  member: { restricted: false, identity: ['member:alice-example'], hidePrivate: true },
  granted: { restricted: false, privateReadableSources: ['default'], hidePrivate: true },
  memberGranted: { restricted: false, identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true },
} as const;

describe('engine parity: page reads for a member caller on a brain that never named readers', () => {
  parityTest(
    'getLinks and getBacklinks read a member caller as a plain one under excludePrivate',
    { methods: ['putPage', 'addLink', 'getLinks', 'getBacklinks'] },
    async (engine: BrainEngine) => {
      await fixture(engine);
      const out: Record<string, { links: string[]; backlinks: string[] }> = {};
      for (const [name, access] of Object.entries(CALLERS)) {
        out[name] = await withCallerAccess(access, async () => ({
          links: sorted((await engine.getLinks(HUB, { excludePrivate: true })).map(l => l.to_slug)),
          backlinks: sorted((await engine.getBacklinks(HUB, { excludePrivate: true })).map(l => l.from_slug)),
        }));
      }
      expect(out.plain).toEqual({ links: ['notes/open'], backlinks: ['notes/open'] });
      expect(out.member).toEqual(out.plain);
      expect(out.granted.links).toEqual(sorted(TARGETS.map(([slug]) => slug)));
      expect(out.memberGranted).toEqual(out.granted);
      return out;
    },
  );
});
