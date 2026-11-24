/**
 * BrainEngine parity: saving a page whose links name a page that does not exist yet (gbrain-evals bb9-002, bb9-010),
 * through the local put_page operation and its link preparation (persistence/links-preparation.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), a local put_page whose
 *    body links to a missing page saves, with no edge to the missing page; once the target exists, a page saved after it
 *    exists links it; a link to a renamed page's old slug resolves through its slug alias to the live page. The same answers and
 *    the same edges on every arm.
 *  - Regression: link preparation read the live alias targets (`slug_aliases` joined to `pages`) and the source slug
 *    fingerprint through `executeRaw`, which a Rust brain refuses, so a put_page with such a link failed there.
 *  - Why existing coverage misses it: test/links-preparation*.test.ts run on PGLite only.
 *  - Seam: none. Real engines and the real dispatcher; each case runs under its own GBRAIN_HOME.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

const { parityTest } = parityArms(testBackends());

async function withHome<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-missing-link-'));
  try { return await withEnv({ GBRAIN_HOME: home }, run); } finally { rmSync(home, { recursive: true, force: true }); }
}

/** A local put_page; the answer is its error text (or null) and the saved page's title. */
async function put(engine: BrainEngine, slug: string, title: string, links: string): Promise<{ error: string | null; title: string | null }> {
  const content = `---\ntype: note\ntitle: ${title}\n---\n\n${title} names ${links}.\n`;
  const result = await dispatchToolCall(engine, 'put_page', { slug, content }, { remote: false, sourceId: 'default' } as never);
  const text = result.content.map(part => (part as { text?: string }).text ?? '').join('');
  return { error: result.isError ? text.slice(0, 300) : null, title: (await engine.getPage(slug, { sourceId: 'default' }))?.title ?? null };
}

const targets = async (engine: BrainEngine, slug: string) =>
  [...new Set((await engine.getLinks(slug, { sourceId: 'default' })).map(link => link.to_slug))].sort();

const fixture = (engine: BrainEngine, slug: string, title: string) =>
  engine.putPage(slug, { type: 'person' as never, title, compiled_truth: `${title} fixture.`, timeline: '', frontmatter: {} }, { sourceId: 'default' });

describe('engine parity: a put_page link to a page that does not exist yet', () => {
  parityTest('put_page saves with a link to a missing page, and links it once the page exists', {
    methods: ['readLiveSlugAliases', 'readSourceSlugProbe', 'getLinks'],
    timeout: 90_000,
  }, async (engine) => withHome(async () => {
    const steps: Record<string, unknown> = {};
    steps.missing = { ...(await put(engine, 'notes/plan', 'Plan', '[[people/ghost-example]]')), links: await targets(engine, 'notes/plan') };
    await fixture(engine, 'people/ghost-example', 'Ghost Example');
    steps.appeared = { ...(await put(engine, 'notes/plan-later', 'Plan later', '[[people/ghost-example]]')), links: await targets(engine, 'notes/plan-later') };
    // With global basename resolution on, a bare name resolves through the source's basename index (the slug
    // fingerprint read), first built, then extended by a page added after it.
    await withEnv({ GBRAIN_LINK_RESOLUTION_GLOBAL_BASENAME: '1' }, async () => {
      steps.basename = { ...(await put(engine, 'notes/bare', 'Bare', '[[ghost-example]] and [[later-example]]')), links: await targets(engine, 'notes/bare') };
      await fixture(engine, 'people/later-example', 'Later Example');
      steps.basenameAdded = { ...(await put(engine, 'notes/bare-later', 'Bare later', '[[ghost-example]] and [[later-example]]')), links: await targets(engine, 'notes/bare-later') };
    });
    expect(steps).toEqual({
      missing: { error: null, title: 'Plan', links: [] },
      appeared: { error: null, title: 'Plan later', links: ['people/ghost-example'] },
      basename: { error: null, title: 'Bare', links: ['people/ghost-example'] },
      basenameAdded: { error: null, title: 'Bare later', links: ['people/ghost-example', 'people/later-example'] },
    });
    return steps;
  }));

  parityTest('put_page links an old slug through its slug alias to the renamed page, and saves with a missing alias target', {
    methods: ['readLiveSlugAliases', 'updateSlug', 'getLinks'],
    timeout: 90_000,
  }, async (engine) => withHome(async () => {
    await fixture(engine, 'people/old-name-example', 'Renamed Example');
    await engine.updateSlug('people/old-name-example', 'people/new-name-example', { sourceId: 'default' });
    const steps: Record<string, unknown> = {};
    steps.alias = { ...(await put(engine, 'notes/meeting', 'Meeting', '[[people/old-name-example]] and [[people/nobody-example]]')), links: await targets(engine, 'notes/meeting') };
    expect(steps).toEqual({
      alias: { error: null, title: 'Meeting', links: ['people/new-name-example'] },
    });
    return steps;
  }));
});
