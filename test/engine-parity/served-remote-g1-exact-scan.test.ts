/**
 * BrainEngine parity: the one-page-at-a-time step of a remote search_exact scan, over the served wire (nextLivePageAfter).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded or served) a remote search_exact whose
 *    batch statement times out steps through the pages one at a time and answers the same: it names the page the caller may
 *    read in its gap report, and carries no marker of an owner-private page or of a page only a named member may read.
 *  - Regression: the step is a page-id cursor over every live page, so on the served wire the member must hand a remote caller
 *    only pages it may read (the server steps past the others itself, bounded). A page that timed out alone was named in the
 *    gap report before the caller's read scope was checked: a leak on every engine (test/search-exact.test.ts).
 *  - Why existing coverage misses it: search-exact.test.ts runs on the arm's own engine with the in-process guard; nothing
 *    drove the single-page step over the served wire.
 *  - Seam: scanExactBatch is replaced by a statement-timeout error on every arm (the only way to reach the step); pages are
 *    seeded with putPage and sealChunks; the operation is the real one.
 */
import { expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { NoticeLedger } from '../../src/core/notice-ledger.ts';
import { chunk } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const stdio = () => ({ remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default', noticeLedger: new NoticeLedger() }) as never;
const PHRASE = 'scanmark gap text';
const OPEN = 'scanmarkopenpage41c2';
const PRIVATE = 'scanmarkprivatepage7e90';
const READERS = 'scanmarkreaderspage2b58';

async function seed(engine: BrainEngine): Promise<void> {
  const pages: Array<[slug: string, body: string, frontmatter: Record<string, unknown>]> = [
    [`notes/${OPEN}`, `${PHRASE} ${OPEN} open.`, {}],
    [`secrets/${PRIVATE}`, `${PHRASE} ${PRIVATE} private.`, { visibility: 'private' }],
    [`shared/${READERS}`, `${PHRASE} ${READERS} readers.`, { readable_by: ['alice-example'] }],
  ];
  for (const [slug, body, frontmatter] of pages) {
    await engine.putPage(slug, { type: 'note' as never, title: slug.split('/')[1]!, compiled_truth: body, timeline: '', frontmatter });
    await engine.sealChunks(slug, [chunk(0, body)]);
  }
}

/** The engine with every exact batch statement timing out, so the scan steps one page at a time. */
function timingOut(engine: BrainEngine): BrainEngine {
  return new Proxy(engine as never, {
    get(target, prop, receiver) {
      if (prop === 'scanExactBatch') return async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as BrainEngine;
}

parityTest('a remote search_exact whose batch times out names only the readable page in its gap report', { methods: ['putPage', 'sealChunks', 'nextLivePageAfter', 'probeTargetRows'], timeout: 240_000 }, async (engine: BrainEngine) => {
  await seed(engine);
  const out = await dispatchToolCall(timingOut(engine), 'search_exact', { phrase: PHRASE }, stdio());
  const text = out.content.map(c => c.text ?? '').join('\n');
  expect(out.isError === true ? text.slice(0, 400) : false).toBe(false);
  const leaked = [PRIVATE, READERS].filter(m => text.includes(m));
  expect(leaked).toEqual([]);
  const body = JSON.parse(out.content[0]!.text!) as { unreadable?: { sample?: Array<{ slug: string }>; total?: number }; resume_after?: unknown };
  expect(body.unreadable?.sample?.map(s => s.slug)).toEqual([`notes/${OPEN}`]);
  return { slugs: body.unreadable?.sample?.map(s => s.slug), total: body.unreadable?.total, resume: body.resume_after ?? null };
});
