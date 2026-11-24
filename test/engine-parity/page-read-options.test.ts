/**
 * BrainEngine parity — page reads under the option sets operations pass: getPage under `readPolicyOpts` (the
 * get_write_attribution read), readPageSnapshot under get_page's alias-resolving remote read, and getTags under
 * get_tags' `excludePrivate`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `readPolicyOpts` adds `requireSafeChunks` and `takesHoldersAllowList`, which the SQL page read does not
 *    read, so getPage answers as it does without them; get_page's read (`excludePrivate` and `resolveAlias`) and
 *    get_tags' read (`excludePrivate`, `liveOnly`) hide every page the caller's page policy
 *    (`privatePagesFilterForCaller`) hides, whoever the caller is, and show the rest.
 *  - Regression: an engine that refuses one of these option sets (the Rust engine refused getPage with
 *    `requireSafeChunks` and getTags with `excludePrivate`), or that serves it and still leaks a private or
 *    reader-named page's body or tags.
 *  - Why existing coverage misses it: pages.test.ts reads snapshots with no caller identity and never passes
 *    `readPolicyOpts`; no parity file reads getTags with `excludePrivate`.
 *  - Caller policy: each read runs with no caller, as a member a page's readers name, and with a private-readable
 *    grant on the source; the Rust store reads both from the policy the TypeScript member sends.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const PAGES: Array<[string, Record<string, unknown>]> = [
  ['notes/open', {}],
  ['notes/private', { visibility: 'private' }],
  ['notes/readers', { readable_by: ['alice-example'] }],
  ['notes/pinned', { pinned_question: true, visibility: 'world' }],
];

async function seed(engine: BrainEngine) {
  for (const [slug, frontmatter] of PAGES) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '', frontmatter });
    await engine.addTag(slug, `tag-${slug.split('/')[1]}`);
  }
}

/** The three callers each read runs as: none, a member the readers name, and a private-readable grant on `default`. */
async function asEachCaller<T>(read: () => Promise<T>): Promise<Record<string, T>> {
  return {
    none: await read(),
    member: await withCallerAccess({ identity: ['member:alice-example'], hidePrivate: true }, read),
    granted: await withCallerAccess({ identity: ['member:bob-example'], privateReadableSources: ['default'], hidePrivate: true }, read),
  };
}

describe('engine parity: page reads under operation option sets', () => {
  parityTest(
    "getPage under readPolicyOpts (get_write_attribution's read) answers as without the safe-chunk and holder options",
    { methods: ['getPage'] },
    async (engine) => {
      await seed(engine);
      const read = (excludePrivate: boolean) => async () => {
        const out: Record<string, string | null> = {};
        for (const [slug] of PAGES) {
          const page = await engine.getPage(slug, {
            sourceId: 'default', excludePrivate, requireSafeChunks: true, takesHoldersAllowList: ['world'],
          } as Parameters<BrainEngine['getPage']>[1]);
          out[slug] = page ? page.compiled_truth : null;
        }
        return out;
      };
      const local = await read(false)();
      const remote = await asEachCaller(read(true));
      expect(Object.values(local).every((body) => body !== null)).toBe(true);
      expect(remote.none).toEqual({ 'notes/open': 'notes/open body', 'notes/private': null, 'notes/readers': null, 'notes/pinned': null });
      expect(remote.member['notes/readers']).toBe('notes/readers body');
      expect(remote.granted['notes/private']).toBe('notes/private body');
      return { local, remote };
    },
  );

  parityTest(
    "readPageSnapshot under get_page's remote read follows an alias to a page the caller may read, and hides the rest",
    { methods: ['readPageSnapshot', 'updateSlug'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'alt');
      const renamed = async (from: string, to: string, frontmatter: Record<string, unknown>) => {
        await engine.putPage(from, { type: 'note', title: from, compiled_truth: `${from} body`, timeline: '', frontmatter });
        expect(await engine.updateSlug(from, to)).toBe(1);
      };
      await renamed('notes/open-old', 'notes/open-new', {});
      await renamed('notes/private-old', 'notes/private-new', { visibility: 'private' });
      await renamed('notes/readers-old', 'notes/readers-new', { readable_by: ['alice-example'] });
      const read = async () => {
        const out: Record<string, string | null> = {};
        for (const slug of ['notes/open-old', 'notes/private-old', 'notes/readers-old', 'notes/readers-new']) {
          const snapshot = await engine.readPageSnapshot(slug, { includeDeleted: false, excludePrivate: true, sourceIds: ['default', 'alt'], resolveAlias: true });
          out[slug] = snapshot ? `${snapshot.page.source_id}:${snapshot.page.slug}` : null;
        }
        return out;
      };
      const view = await asEachCaller(read);
      expect(view.none).toEqual({ 'notes/open-old': 'default:notes/open-new', 'notes/private-old': null, 'notes/readers-old': null, 'notes/readers-new': null });
      expect(view.member['notes/readers-old']).toBe('default:notes/readers-new');
      expect(view.granted['notes/private-old']).toBe('default:notes/private-new');
      return view;
    },
  );

  parityTest(
    "getTags under get_tags' excludePrivate hides a hidden page's tags, live or not, and shows a readable page's",
    { methods: ['getTags', 'addTag', 'softDeletePage'] },
    async (engine) => {
      await seed(engine);
      await engine.putPage('notes/gone-private', { type: 'note', title: 'gone', compiled_truth: 'gone body', timeline: '', frontmatter: { visibility: 'private' } });
      await engine.addTag('notes/gone-private', 'tag-gone-private');
      await engine.softDeletePage('notes/gone-private');
      const slugs = [...PAGES.map(([slug]) => slug), 'notes/gone-private'];
      const read = (liveOnly: boolean) => async () => {
        const out: Record<string, string[]> = {};
        for (const slug of slugs) out[slug] = await engine.getTags(slug, { sourceId: 'default', excludePrivate: true, liveOnly });
        return out;
      };
      const local: Record<string, string[]> = {};
      for (const slug of slugs) local[slug] = await engine.getTags(slug, { sourceId: 'default' });
      const live = await asEachCaller(read(true));
      const any = await asEachCaller(read(false));
      expect(local['notes/private']).toEqual(['tag-private']);
      expect(live.none).toEqual({ 'notes/open': ['tag-open'], 'notes/private': [], 'notes/readers': [], 'notes/pinned': [], 'notes/gone-private': [] });
      expect(live.member['notes/readers']).toEqual(['tag-readers']);
      expect(live.granted['notes/private']).toEqual(['tag-private']);
      expect(any.none['notes/gone-private']).toEqual([]);
      expect(any.granted['notes/gone-private']).toEqual(['tag-gone-private']);
      return { local, live, any };
    },
  );
});
