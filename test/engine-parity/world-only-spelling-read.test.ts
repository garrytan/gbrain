/**
 * BrainEngine parity: a remote caller that reads world pages only, after a put whose [[wikilink]] names a `visibility:
 * private` page or an alias of one, through the CLI path (`gbrain put`, `remote: false`) and the MCP path (`remote: true`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the put answers the same status and the page ends with the same links on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts), and the world-only caller reads the
 *    private page and its alias as `page_not_found` and the public page in full, with no refusal along the way.
 *  - Regression: when no page answers the caller's spelling of a slug (a hidden page), `chooseSpelling`
 *    (src/core/ops/slug-params.ts) scans for other stored spellings of it. That scan was raw SQL, so on a Rust brain it was
 *    refused and caught, and the read answered the normal form without the scan: a page stored under a non-normal
 *    spelling was not found, and two stored spellings were not reported as ambiguous.
 *  - Why existing coverage misses it: the slug-normalize parity cases read as a trusted caller, whose exact spelling
 *    always finds the page, so the scan never runs.
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
import { addMember } from '../../src/core/access/members.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { drainProjections } from '../../src/core/page-state/projections.ts';

const { parityTest } = parityArms(testBackends());

const putPage = operations.find((o) => o.name === 'put_page')!;
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

const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
/** A page a world-only caller must never read. */
const PRIVATE = { type: 'person', title: 'Secret Example', compiled_truth: 'The private body that must not leave.', frontmatter: { visibility: 'private' } };
const HIDDEN = { outcome: 'page_not_found', leaked: false };
const PUBLIC = { outcome: 'read', slug: 'people/alice-example', titled: true, body: true, leaked: false };
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

type Link = { from: string; to: string; type: string };
const link = (from: string, to: string): Link => ({ from, to, type: 'mentions' });

/** The page a put stored, by what a reader sees. */
async function storedPage(engine: BrainEngine, slug: string) {
  const stored = await engine.getPage(slug);
  return stored ? { slug: stored.slug, type: stored.type, title: stored.title } : null;
}

describe('engine parity: a world-only read after a put with a wikilink', () => {
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
      methods: ['putPage', 'updateSlug', 'getLinks', 'getPage'], timeout: 120_000,
    }, (engine) => inFreshHome(() => {
      // The CLI path (a local writer) links the private page, resolving an alias to its canonical page; the MCP effect links the
      // public page only, as it does not link an alias slug and does not link a private target.
      const expectedLinks: Link[] = [link(slug, 'people/alice-example'), ...(path === 'cli' ? [link(slug, 'people/secret-example')] : [])];
      return (async () => {
        // Both cases hold the same pages: a private page renamed from `secret-old`, so `secret-old` is its alias.
        await engine.putPage('people/secret-old', PRIVATE);
        await engine.updateSlug('people/secret-old', 'people/secret-example');
        await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'A person.' });
        const ctx = await worldOnlyContext(engine);
        const putCtx = path === 'cli' ? await contextFor(engine, 'cli', putPage) : ctx;
        const answer = await putPage.handler(putCtx, { slug, content: page(slug, `See [[people/alice-example]] and [[${target}]] for context.`), request_id: REQUEST }) as Record<string, unknown>;
        const links = await linksOf(engine, slug, expectedLinks.length);
        const value = { answer: { status: answer.status, slug: answer.slug }, stored: await storedPage(engine, slug), links,
          read: await readAsCaller(ctx, 'people/secret-example'), readAlias: await readAsCaller(ctx, 'people/secret-old'),
          readPublic: await readAsCaller(ctx, 'people/alice-example') };
        // The Rust arm compares this value with PGLite's, and fails a case that caught a typed refusal on the way.
        expect(value).toEqual({ answer: { status: 'created_or_updated', slug }, stored: { slug, type: 'note', title: slug }, links: expectedLinks,
          read: HIDDEN, readAlias: HIDDEN, readPublic: PUBLIC });
        return value;
      })();
    }));
    }
  }

  // A remote caller bound to an access member (the stdio server started with --stdio-member) asks get_page for a page whose
  // readable_by names another member: no page answers its spelling, so the read runs the stored-spelling scan, then hides
  // the page as page_not_found. The open page reads in full. On the Rust arm the member's page read (readPageSnapshot for a
  // caller with member pages) refuses until rust-engine/remote-access-parity serves it: the case stops there under its row in
  // test/rust-stop-pins/lane-1.tsv, and runs the scan once that read is served.
  parityTest('remote member: get_page on a page another member reads answers page_not_found, with no refusal on the way', {
    methods: ['getPage'], timeout: 120_000,
  }, (engine) => inFreshHome(async () => {
    for (const id of ['bob-example', 'carol-example']) await addMember(engine, id);
    const note = (title: string, fm: string[]) => `---\ntype: note\ntitle: ${title}\n${fm.map(l => `${l}\n`).join('')}---\n\n${title} body.\n`;
    await importFromContent(engine, 'notes/carol-only', note('Carol only', ['readable_by: [carol-example]']), { sourceId: 'default', noEmbed: true } as never);
    await importFromContent(engine, 'notes/open-example', note('Open example', []), { sourceId: 'default', noEmbed: true } as never);
    await drainProjections(engine);
    const asBob = async (slug: string) => {
      const out = await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, transport: 'stdio', sourceId: 'default', stdioMember: 'bob-example' } as never);
      const text = out.content.map(part => (part as { text?: string }).text ?? '').join('');
      // A typed refusal is rethrown as one (rebuilt from its envelope), so the harness classifies it against its stop pin.
      const body = out.isError ? (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } })() : null;
      if (body?.code === 'engine_capability_missing') throw Object.assign(new Error(String(body.message)), body);
      return { error: out.isError ? (/page_not_found/.test(text) ? 'page_not_found' : text.slice(0, 200)) : null, shown: !out.isError && text.includes('body.') };
    };
    const value = { hidden: await asBob('notes/carol-only'), open: await asBob('notes/open-example') };
    expect(value).toEqual({ hidden: { error: 'page_not_found', shown: false }, open: { error: null, shown: true } });
    return value;
  }));
});
