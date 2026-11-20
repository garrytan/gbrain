/**
 * BrainEngine parity: a put_page / put_pages whose body holds a [[wikilink]], through the CLI path (`gbrain put`: the
 * context makeContext builds, `remote: false`) and the MCP path (`remote: true`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a page written with a wikilink to an existing page, to an alias slug (which resolves to its canonical page)
 *    or to a missing page ends with the same links on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts), and the put answers the same status; a put_pages batch with a
 *    wikilink ends the same way.
 *  - Regression: link preparation (persistence/links-preparation.ts) read the slug aliases and the source's slug
 *    fingerprint with raw SQL (`executeRaw`), so on a Rust brain every put with a wikilink stopped on the raw_sql refusal;
 *    an engine whose alias read or slug index differs would resolve a link to a different page or drop it.
 *  - Why existing coverage misses it: the put cases of the parity suite call typed members, never the put operation, and
 *    test/auto-link-targeted-probe-2544.test.ts runs on PGLite only.
 *  - Seam: GBRAIN_HOME through withEnv (the registration files live under it). Typed members and the real operations only
 *    (no executeRaw: D18). Generated values (revisions, request ids, timestamps) are left out of the returned values.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { makeContext } from '../../src/cli/main.ts';
import { registerServeLocalWriters } from '../../src/core/persistence/provider.ts';

const { parityTest } = parityArms(testBackends());

const putPage = operations.find((o) => o.name === 'put_page')!;
const putPages = operations.find((o) => o.name === 'put_pages')!;
const getPageOp = operations.find((o) => o.name === 'get_page')!;

type Path = 'cli' | 'mcp';

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-links-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

/** The context a `gbrain put` builds for the CLI path; the MCP path is a remote stdio caller. */
async function contextFor(engine: BrainEngine, path: Path, op: typeof putPage): Promise<OperationContext> {
  if (path === 'cli') return makeContext(engine, {}, op);
  await registerServeLocalWriters(engine);
  return { engine, config: { engine: engine.kind }, remote: true, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}

/**
 * Two Rust-engine stops that are not link preparation's, named so a case can end on them without hiding a wrong put result:
 *  - PROJECTION_PASS: after any put returns, the persistence consumer's projection pass refuses on raw_sql (page-state/projections.ts
 *    selectWindowJobs, the `probed` statement at :665, reached from persistence/consumer.ts runResidentProjectionInvocation); the
 *    consumer catches it and writes `[persistence] ... reason=engine_capability_missing` to stderr. A put with no wikilink hits it too.
 *  - LINK_EFFECT: the MCP path builds its links in the post-commit `links` effect (persistence/effects.ts runLinksEffect, whose first
 *    statement is `engine.executeRaw` at persistence/effect-links.ts:110, a read of persistence_requests), so a Rust brain never builds
 *    them and the page keeps no link.
 * The harness wants a case that reached a typed refusal to END on one. `endOnNamedStop` runs after the case compared its put result
 * with the expected one (`expectPut`), so a wrong answer, page or link fails as itself and never becomes an accepted refusal.
 */
const PROJECTION_PASS = 'page-state/projections.ts:665 selectWindowJobs (projection pass, persistence/consumer.ts runResidentProjectionInvocation)';
const LINK_EFFECT = 'persistence/effect-links.ts:110 runLinksEffect (executeRaw of persistence_requests, post-commit links effect)';

/** Collects the persistence consumer's stderr lines while `run` and its effects settle. */
async function withConsumerLog<T>(run: () => Promise<T>): Promise<{ value: T; refusedByConsumer: (bounded: boolean) => Promise<boolean> }> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (String(chunk).includes('[persistence]')) lines.push(String(chunk));
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  const refused = () => lines.some((l) => l.includes('reason=engine_capability_missing'));
  try {
    const value = await run();
    return { value, refusedByConsumer: async (bounded) => {
      // Bounded wait: the consumer's refusal is written by a background pass, so give it up to 5 s to appear.
      for (const deadline = Date.now() + 5000; bounded && !refused() && Date.now() < deadline;) await Bun.sleep(25);
      process.stderr.write = write as typeof process.stderr.write;
      return refused();
    } };
  } catch (error) {
    process.stderr.write = write as typeof process.stderr.write;
    throw error;
  }
}

/** The typed refusal a case ends on, naming the site. */
const stoppedAt = (site: string) => Object.assign(new Error(`stopped on a typed refusal outside link preparation: ${site}`),
  { code: 'engine_capability_missing', reason: 'raw_sql' });

/**
 * Runs a put case: the put's result is compared with `expected` on every arm; only then may the Rust arm end on a named stop.
 * `expected` holds the links the page ends with where the engine builds them. The one allowed difference is the MCP path on
 * Rust, whose links are not built (LINK_EFFECT): its links are then empty, everything else must still be equal to `expected`.
 */
async function putCase<T extends { links: unknown }>(backend: string, path: Path, run: () => Promise<T>, expected: T, wantsLinks: boolean): Promise<T> {
  const { value, refusedByConsumer } = await withConsumerLog(run);
  const linksNotBuilt = backend === 'rust' && path === 'mcp' && wantsLinks && (value.links as unknown[]).flat().length === 0;
  if (linksNotBuilt) expect({ ...value, links: null }).toEqual({ ...expected, links: null });
  else expect(value).toEqual(expected);
  const refused = await refusedByConsumer(backend === 'rust');
  if (backend !== 'rust') return value;
  if (linksNotBuilt) {
    if (!refused) throw new Error('the MCP put to an existing page built no link on Rust and the consumer logged no typed refusal that explains it');
    throw stoppedAt(LINK_EFFECT);
  }
  if (refused) throw stoppedAt(PROJECTION_PASS);
  return value;
}

const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
const BATCH_COUNTS = { committed: 2, failed: 0, pending: 0, total: 2 };
/** A page a world-only caller must never read. */
const PRIVATE = { type: 'person', title: 'Secret Example', compiled_truth: 'The private body that must not leave.', frontmatter: { visibility: 'private' } };
const HIDDEN = { found: false, leaked: false };
// The public page both bodies also link to: its link shows the links effect ran, so a missing link to the private page means something.
const REQUEST = 'b0000000-0000-4000-8000-0000000000d1';

/** The links a written page ends with, in a fixed order, by their endpoints and type. */
async function linksOf(engine: BrainEngine, slug: string, expected: number) {
  // The MCP path builds links after the commit, in an asynchronous persistence effect: wait (bounded) for the links the case
  // expects. An expectation of none cannot be waited for; a missing target resolves to no link on every path.
  let links = await engine.getLinks(slug);
  for (const deadline = Date.now() + 10_000; links.length < expected && Date.now() < deadline;) {
    await Bun.sleep(25);
    links = await engine.getLinks(slug);
  }
  return links.map((l) => ({ from: l.from_slug, to: l.to_slug, type: l.link_type }))
    .sort((a, b) => (`${a.to}${a.type}` < `${b.to}${b.type}` ? -1 : 1));
}

/** Seeds the pages a case links to: a live page, and a renamed page whose old slug is an alias of its new one. */
async function seed(engine: BrainEngine): Promise<void> {
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'A person.' });
  await engine.putPage('people/bob-old', { type: 'person', title: 'Bob Example', compiled_truth: 'Another person.' });
  await engine.updateSlug('people/bob-old', 'people/bob-example');
}

/** The MCP-style caller that reads world pages only: remote, with the fail-closed `['world']` holder grant. */
async function worldOnlyContext(engine: BrainEngine): Promise<OperationContext> {
  await registerServeLocalWriters(engine);
  return { engine, config: { engine: engine.kind }, remote: true, dryRun: false, sourceId: 'default', takesHoldersAllowList: ['world'],
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}

/** What get_page shows that caller for `slug`: whether it found the page, and whether the private body reached it. */
async function readAsCaller(ctx: OperationContext, slug: string) {
  let shown: unknown;
  try { shown = await getPageOp.handler(ctx, { slug }); } catch (error) { shown = { thrown: (error as { code?: string }).code ?? String(error) }; }
  const text = JSON.stringify(shown);
  return { found: !text.includes('"thrown"') && !text.includes('"error"'), leaked: text.includes('must not leave') };
}

async function putOne(engine: BrainEngine, path: Path, slug: string, body: string) {
  const ctx = await contextFor(engine, path, putPage);
  const answer = await putPage.handler(ctx, { slug, content: page(slug, body), request_id: REQUEST }) as Record<string, unknown>;
  return { status: answer.status, slug: answer.slug };
}

type Link = { from: string; to: string; type: string };
const link = (from: string, to: string): Link => ({ from, to, type: 'mentions' });

/** The page a put stored, by what a reader sees. */
async function storedPage(engine: BrainEngine, slug: string) {
  const stored = await engine.getPage(slug);
  return stored ? { slug: stored.slug, type: stored.type, title: stored.title } : null;
}

/**
 * Label, link target, slug written, the links the written page ends with. The MCP path builds its links in an asynchronous
 * effect that keeps a link to a live page but not one to an alias slug (the same on PGLite and Postgres), so its alias case
 * is expected to have no link; the CLI path resolves the alias to the canonical page.
 */
const CASES: Array<[string, string, string, Record<Path, Link[]>]> = [
  ['an existing page', 'people/alice-example', 'notes/links-existing', { cli: [link('notes/links-existing', 'people/alice-example')], mcp: [link('notes/links-existing', 'people/alice-example')] }],
  ['an alias slug', 'people/bob-old', 'notes/links-alias', { cli: [link('notes/links-alias', 'people/bob-example')], mcp: [] }],
  ['a missing page', 'people/nobody-example', 'notes/links-missing', { cli: [], mcp: [] }],
];

describe('engine parity: put with a wikilink', () => {
  for (const path of ['cli', 'mcp'] as const) {
    for (const [label, target, slug, links] of CASES) {
      parityTest(`${path}: put_page with a [[wikilink]] to ${label}`, {
        methods: ['putPage', 'updateSlug', 'getLinks', 'getPage'], requires: 'raw_sql', timeout: 120_000,
      }, (engine, backend) => inFreshHome(() => putCase(backend, path, async () => {
        await seed(engine);
        const answer = await putOne(engine, path, slug, `See [[${target}]] for context.`);
        return { answer, stored: await storedPage(engine, slug), links: await linksOf(engine, slug, links[path].length) };
      }, { answer: { status: 'created_or_updated', slug }, stored: { slug, type: 'note', title: slug }, links: links[path] }, links[path].length > 0)));
    }

    parityTest(`${path}: put_pages with a [[wikilink]]`, {
      methods: ['putPage', 'updateSlug', 'getLinks', 'getPage'], requires: 'raw_sql', timeout: 120_000,
    }, (engine, backend) => inFreshHome(() => {
      const aLinks = path === 'cli' ? [link('notes/batch-a', 'people/alice-example'), link('notes/batch-a', 'people/bob-example')] : [link('notes/batch-a', 'people/alice-example')];
      return putCase(backend, path, async () => {
        await seed(engine);
        const ctx = await contextFor(engine, path, putPages);
        const answer = await putPages.handler(ctx, { request_id: REQUEST, pages: [
          { slug: 'notes/batch-a', content: page('notes/batch-a', 'See [[people/alice-example]] and [[people/bob-old]].') },
          { slug: 'notes/batch-b', content: page('notes/batch-b', 'See [[people/nobody-example]].') },
        ] }) as Record<string, unknown>;
        const pages = answer.pages as Array<{ slug: string; state: string; status: string }>;
        return { state: answer.state, counts: answer.counts, pages: pages.map((p) => ({ slug: p.slug, state: p.state, status: p.status })),
          stored: [await storedPage(engine, 'notes/batch-a'), await storedPage(engine, 'notes/batch-b')],
          links: [await linksOf(engine, 'notes/batch-a', aLinks.length), await linksOf(engine, 'notes/batch-b', 0)] };
      }, { state: 'committed', counts: BATCH_COUNTS, pages: [{ slug: 'notes/batch-a', state: 'committed', status: 'created_or_updated' }, { slug: 'notes/batch-b', state: 'committed', status: 'created_or_updated' }],
        stored: [{ slug: 'notes/batch-a', type: 'note', title: 'notes/batch-a' }, { slug: 'notes/batch-b', type: 'note', title: 'notes/batch-b' }], links: [aLinks, []] }, true);
    }));
  }

  // A write whose link target is a `visibility: private` page, from a remote caller that may read world pages only. Link
  // preparation is a writer-side, source-scoped read (it has no visibility filter), so the private page is a target like any
  // other; the caller still never reads its content.
  for (const [label, target] of [
    ['a private page', 'people/secret-example'],
    ['an alias slug whose canonical page is private', 'people/secret-old'],
  ] as const) {
    for (const path of ['cli', 'mcp'] as const) {
    const slug = `notes/links-${path}-${label.includes('alias') ? 'private-alias' : 'private'}`;
    parityTest(`${path}${path === 'mcp' ? ', world-only caller' : ', read back by a world-only caller'}: put_page with a [[wikilink]] to ${label}`, {
      methods: ['putPage', 'updateSlug', 'getLinks', 'getPage', 'readLiveSlugAliases', 'readSourceSlugFingerprint'], requires: 'raw_sql', timeout: 120_000,
    }, (engine, backend) => inFreshHome(() => {
      // The CLI path (a local writer) links the private page, resolving an alias to its canonical page; the MCP effect links the
      // public page only, as it does not link an alias slug and does not link a private target.
      const expectedLinks: Link[] = [link(slug, 'people/alice-example'), ...(path === 'cli' ? [link(slug, 'people/secret-example')] : [])];
      return putCase(backend, path, async () => {
        // Both cases hold the same pages: a private page renamed from `secret-old`, so `secret-old` is its alias.
        await engine.putPage('people/secret-old', PRIVATE);
        await engine.updateSlug('people/secret-old', 'people/secret-example');
        await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'A person.' });
        const ctx = await worldOnlyContext(engine);
        const putCtx = path === 'cli' ? await contextFor(engine, 'cli', putPage) : ctx;
        const answer = await putPage.handler(putCtx, { slug, content: page(slug, `See [[people/alice-example]] and [[${target}]] for context.`), request_id: REQUEST }) as Record<string, unknown>;
        const links = await linksOf(engine, slug, expectedLinks.length);
        const fingerprint = await engine.readSourceSlugFingerprint('default');
        const aliases = await engine.readLiveSlugAliases('default', [target]);
        return { answer: { status: answer.status, slug: answer.slug }, stored: await storedPage(engine, slug), links,
          read: await readAsCaller(ctx, 'people/secret-example'), readAlias: await readAsCaller(ctx, 'people/secret-old'),
          fingerprint: { n: fingerprint.n, slugs: [...fingerprint.slugs].sort() }, aliases: aliases.map((a) => ({ ...a })) };
      }, { answer: { status: 'created_or_updated', slug }, stored: { slug, type: 'note', title: slug }, links: expectedLinks,
        read: HIDDEN, readAlias: HIDDEN,
        fingerprint: { n: 3, slugs: [slug, 'people/alice-example', 'people/secret-example'].sort() },
        aliases: label.includes('alias') ? [{ alias_slug: 'people/secret-old', canonical_slug: 'people/secret-example' }] : [] }, expectedLinks.length > 0);
    }));
    }
  }
});
