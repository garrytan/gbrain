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
const REQUEST = 'b0000000-0000-4000-8000-0000000000d1';

/** The links a written page ends with, in a fixed order, by their endpoints and type. */
async function linksOf(engine: BrainEngine, slug: string) {
  const links = await engine.getLinks(slug);
  return links.map((l) => ({ from: l.from_slug, to: l.to_slug, type: l.link_type }))
    .sort((a, b) => (`${a.to}${a.type}` < `${b.to}${b.type}` ? -1 : 1));
}

/** Seeds the pages a case links to: a live page, and a renamed page whose old slug is an alias of its new one. */
async function seed(engine: BrainEngine): Promise<void> {
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'A person.' });
  await engine.putPage('people/bob-old', { type: 'person', title: 'Bob Example', compiled_truth: 'Another person.' });
  await engine.updateSlug('people/bob-old', 'people/bob-example');
}

async function putOne(engine: BrainEngine, path: Path, slug: string, body: string) {
  const ctx = await contextFor(engine, path, putPage);
  const answer = await putPage.handler(ctx, { slug, content: page(slug, body), request_id: REQUEST }) as Record<string, unknown>;
  return { status: answer.status, slug: answer.slug };
}

const CASES: Array<[string, string, string]> = [
  ['an existing page', 'people/alice-example', 'notes/links-existing'],
  ['an alias slug', 'people/bob-old', 'notes/links-alias'],
  ['a missing page', 'people/nobody-example', 'notes/links-missing'],
];

describe('engine parity: put with a wikilink', () => {
  for (const path of ['cli', 'mcp'] as const) {
    for (const [label, target, slug] of CASES) {
      parityTest(`${path}: put_page with a [[wikilink]] to ${label}`, {
        methods: ['putPage', 'updateSlug', 'getLinks'], timeout: 120_000,
      }, (engine) => inFreshHome(async () => {
        await seed(engine);
        const answer = await putOne(engine, path, slug, `See [[${target}]] for context.`);
        return { answer, links: await linksOf(engine, slug) };
      }));
    }

    parityTest(`${path}: put_pages with a [[wikilink]]`, {
      methods: ['putPage', 'updateSlug', 'getLinks'], timeout: 120_000,
    }, (engine) => inFreshHome(async () => {
      await seed(engine);
      const ctx = await contextFor(engine, path, putPages);
      const answer = await putPages.handler(ctx, { request_id: REQUEST, pages: [
        { slug: 'notes/batch-a', content: page('Batch A', 'See [[people/alice-example]] and [[people/bob-old]].') },
        { slug: 'notes/batch-b', content: page('Batch B', 'See [[people/nobody-example]].') },
      ] }) as Record<string, unknown>;
      const pages = answer.pages as Array<{ slug: string; state: string; status: string }>;
      return { state: answer.state, counts: answer.counts, receiptLinks: answer.links, pages: pages.map((p) => ({ slug: p.slug, state: p.state, status: p.status })), links: [await linksOf(engine, 'notes/batch-a'), await linksOf(engine, 'notes/batch-b')] };
    }));
  }
});
