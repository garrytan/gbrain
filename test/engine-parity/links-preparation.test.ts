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
 * Three Rust-engine stops that are not link preparation's. A case may end on one only when the engine's own refusal is observed at
 * that site: the test wraps `engine.executeRaw` and records, for each call the Rust engine refuses (`engine_capability_missing`),
 * the function and file of the frame that made the call (the call-time stack). It matches on that function and file, never on the
 * consumer's stderr text (which names a phase and a message, not a site, and is the same for every refusal).
 *  - PROJECTION_PASS: a refused call from `selectWindowJobs` in page-state/projections.ts, the projection pass the persistence
 *    consumer runs after any put (a put with no wikilink hits it too).
 *  - LINK_EFFECT: a refused call from `runLinksEffect` in persistence/effect-links.ts, the post-commit `links` effect the MCP path
 *    builds its links in; a Rust brain never builds them and the page keeps no link.
 *  - PUT_PAGES: the error the put_pages handler throws, whose stack runs through `readBatch` in persistence/page-batch.ts and whose
 *    detail names `member=executeRaw`; the batch cannot start, so there is nothing to compare.
 * A refusal at any other site, or a thrown refusal that is not PUT_PAGES, fails the case as an ordinary error. The put result is
 * compared with the expected one before any stop is accepted.
 */
type Site = { fn: string; file: string };
const PROJECTION_PASS: Site = { fn: 'selectWindowJobs', file: 'page-state/projections.ts' };
const LINK_EFFECT: Site = { fn: 'runLinksEffect', file: 'persistence/effect-links.ts' };
const PUT_PAGES: Site = { fn: 'readBatch', file: 'persistence/page-batch.ts' };
const siteName = (site: Site) => `${site.file} ${site.fn}`;

/** The first frame under src/core in a stack: the function and file that made the call. */
function frameOf(stack: string | undefined): Site | null {
  for (const line of (stack ?? '').split('\n')) {
    const found = /at (?:async )?(?:\S+ )?\(?(?:.*\/)?src\/core\/([^:)]+):\d+/.exec(line);
    if (found) return { fn: /at (?:async )?(\S+) \(/.exec(line)?.[1] ?? '<anonymous>', file: found[1]! };
  }
  return null;
}
const isSite = (found: Site | null, site: Site) => found !== null && found.fn === site.fn && found.file === site.file;

/** Records the sites of every executeRaw call the engine refuses with engine_capability_missing, until `stop`. */
function observeRefusals(engine: BrainEngine) {
  const sites: Site[] = [];
  const target = engine as unknown as { executeRaw: (...args: unknown[]) => unknown };
  const original = target.executeRaw;
  target.executeRaw = function (this: unknown, ...args: unknown[]) {
    const caller = frameOf(new Error().stack);
    const result = original.apply(this ?? engine, args);
    Promise.resolve(result).catch((error: { code?: string }) => {
      if (error?.code === 'engine_capability_missing') sites.push(caller ?? { fn: '<unknown>', file: '<unknown>' });
    });
    return result;
  };
  return {
    sites,
    stop: () => { target.executeRaw = original; },
  };
}

/** The typed refusal a case ends on, naming the site. */
const stoppedAt = (site: Site) => Object.assign(new Error(`stopped on a typed refusal outside link preparation: ${siteName(site)}`),
  { code: 'engine_capability_missing', reason: 'raw_sql' });

/** A refusal no case names: an ordinary failure (it carries no capability code, so the harness cannot take it for a stop). */
const unexpected = (what: string, error?: unknown) => new Error(`unexpected refusal, not a named stop: ${what}${error === undefined ? '' : `: ${(error as Error)?.message ?? String(error)}`}`);

/**
 * Runs a put case: the put's result is compared with `expected` on every arm; only then may the Rust arm end on a named stop,
 * and only on the stop it observed. `expected` holds the links the page ends with where the engine builds them. The one allowed
 * difference is the MCP path on Rust, whose links are not built (LINK_EFFECT, which must then be observed): its links are then
 * empty, everything else must still be equal to `expected`. `batch` marks a put_pages case, which on Rust stops by itself (PUT_PAGES).
 */
async function putCase<T extends { links: unknown }>(engine: BrainEngine, backend: string, path: Path, run: () => Promise<T>, expected: T, wantsLinks: boolean, batch = false): Promise<T> {
  if (backend !== 'rust') return await run().then((value) => { expect(value).toEqual(expected); return value; });
  const observed = observeRefusals(engine);
  try {
    let value: T;
    try { value = await run(); } catch (error) {
      const thrown = error as { code?: string; detail?: unknown; stack?: string };
      const through = (thrown.stack ?? '').split('\n').some((l) => l.includes(`src/core/${PUT_PAGES.file}`) && l.includes(`at ${PUT_PAGES.fn} `));
      if (batch && thrown.code === 'engine_capability_missing' && through && String(thrown.detail).includes('member=executeRaw')) throw stoppedAt(PUT_PAGES);
      throw unexpected('the put threw', error);
    }
    const linksNotBuilt = path === 'mcp' && wantsLinks && (value.links as unknown[]).flat().length === 0;
    if (linksNotBuilt) expect({ ...value, links: null }).toEqual({ ...expected, links: null });
    else expect(value).toEqual(expected);
    // The consumer's refusals arrive from background passes: wait (bounded) for the site this case needs.
    const need = linksNotBuilt ? LINK_EFFECT : PROJECTION_PASS;
    for (const deadline = Date.now() + 5000; !observed.sites.some((s) => isSite(s, need)) && Date.now() < deadline;) await Bun.sleep(25);
    const others = observed.sites.filter((s) => !isSite(s, PROJECTION_PASS) && !isSite(s, LINK_EFFECT));
    if (others.length > 0) throw unexpected(`executeRaw refused at ${others.map(siteName).join(', ')}`);
    if (linksNotBuilt) {
      if (!observed.sites.some((s) => isSite(s, LINK_EFFECT))) throw unexpected('the MCP put built no link on Rust and the links effect was not seen refusing');
      throw stoppedAt(LINK_EFFECT);
    }
    if (observed.sites.some((s) => isSite(s, LINK_EFFECT))) throw unexpected('the links effect refused, but the page has every expected link');
    if (observed.sites.some((s) => isSite(s, PROJECTION_PASS))) throw stoppedAt(PROJECTION_PASS);
    return value;
  } finally { observed.stop(); }
}

const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
const BATCH_COUNTS = { committed: 2, failed: 0, pending: 0, total: 2 };
/** A page a world-only caller must never read. */
const PRIVATE = { type: 'person', title: 'Secret Example', compiled_truth: 'The private body that must not leave.', frontmatter: { visibility: 'private' } };
const HIDDEN = { outcome: 'page_not_found', leaked: false };
const PUBLIC = { outcome: 'read', slug: 'people/alice-example', titled: true, body: true, leaked: false };
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

/**
 * What get_page shows that caller for `slug`. A private page must read as `page_not_found` (the same as a missing one, so no
 * existence oracle); any other failure (a capability refusal, a crash) is rethrown, never taken for hiding. A page the caller
 * may read shows its slug, whether its title and body arrived (a remote reader gets them as a quoted excerpt); `leaked` is whether the private body reached the caller either way.
 */
async function readAsCaller(ctx: OperationContext, slug: string) {
  try {
    const shown = await getPageOp.handler(ctx, { slug }) as Record<string, unknown>;
    return { outcome: 'read', slug: shown.slug, titled: String(shown.title).includes('Alice Example'), body: String(shown.compiled_truth).includes('A person.'), leaked: JSON.stringify(shown).includes('must not leave') };
  } catch (error) {
    if ((error as { code?: string }).code === 'page_not_found') return { outcome: 'page_not_found', leaked: false };
    throw error;
  }
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
      }, (engine, backend) => inFreshHome(() => putCase(engine, backend, path, async () => {
        await seed(engine);
        const answer = await putOne(engine, path, slug, `See [[${target}]] for context.`);
        return { answer, stored: await storedPage(engine, slug), links: await linksOf(engine, slug, links[path].length) };
      }, { answer: { status: 'created_or_updated', slug }, stored: { slug, type: 'note', title: slug }, links: links[path] }, links[path].length > 0)));
    }

    parityTest(`${path}: put_pages with a [[wikilink]]`, {
      methods: ['putPage', 'updateSlug', 'getLinks', 'getPage'], requires: 'raw_sql', timeout: 120_000,
    }, (engine, backend) => inFreshHome(() => {
      const aLinks = path === 'cli' ? [link('notes/batch-a', 'people/alice-example'), link('notes/batch-a', 'people/bob-example')] : [link('notes/batch-a', 'people/alice-example')];
      return putCase(engine, backend, path, async () => {
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
        stored: [{ slug: 'notes/batch-a', type: 'note', title: 'notes/batch-a' }, { slug: 'notes/batch-b', type: 'note', title: 'notes/batch-b' }], links: [aLinks, []] }, true, true);
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
      return putCase(engine, backend, path, async () => {
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
          read: await readAsCaller(ctx, 'people/secret-example'), readAlias: await readAsCaller(ctx, 'people/secret-old'), readPublic: await readAsCaller(ctx, 'people/alice-example'),
          fingerprint: { n: fingerprint.n, slugs: [...fingerprint.slugs].sort() }, aliases: aliases.map((a) => ({ ...a })) };
      }, { answer: { status: 'created_or_updated', slug }, stored: { slug, type: 'note', title: slug }, links: expectedLinks,
        read: HIDDEN, readAlias: HIDDEN, readPublic: PUBLIC,
        fingerprint: { n: 3, slugs: [slug, 'people/alice-example', 'people/secret-example'].sort() },
        aliases: label.includes('alias') ? [{ alias_slug: 'people/secret-old', canonical_slug: 'people/secret-example' }] : [] }, expectedLinks.length > 0);
    }));
    }
  }
});
