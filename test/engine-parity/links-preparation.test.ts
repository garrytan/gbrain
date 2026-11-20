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

/**
 * A put on the Rust engine returns, then the persistence consumer's projection pass (page-state/projections.ts selectWindowJobs,
 * reached from persistence/consumer.ts runResidentProjectionInvocation) refuses on raw_sql; the consumer catches it and writes
 * `[persistence] ... reason=engine_capability_missing` to stderr. That refusal is not link preparation's and has nothing to do
 * with wikilinks, but the case did reach it, so on the Rust arm the case ends on it (the harness wants a typed refusal as the
 * end of a case that reached one). Once the pass is served the line never appears and the case returns its value to compare.
 */
async function observingConsumerRefusal<T>(backend: string, run: () => Promise<T>): Promise<T> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (String(chunk).includes('[persistence]')) lines.push(String(chunk));
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const value = await run();
    if (backend === 'rust') {
      const deadline = Date.now() + 5000;
      while (!lines.some((l) => l.includes('reason=engine_capability_missing')) && Date.now() < deadline) await Bun.sleep(25);
    }
    const refusal = lines.find((l) => l.includes('reason=engine_capability_missing'));
    if (refusal !== undefined) {
      throw Object.assign(new Error(`the persistence consumer stopped on a typed refusal: ${refusal.trim()}`), { code: 'engine_capability_missing', reason: 'raw_sql' });
    }
    return value;
  } finally {
    process.stderr.write = write as typeof process.stderr.write;
  }
}

const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
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

async function putOne(engine: BrainEngine, path: Path, slug: string, body: string) {
  const ctx = await contextFor(engine, path, putPage);
  const answer = await putPage.handler(ctx, { slug, content: page(slug, body), request_id: REQUEST }) as Record<string, unknown>;
  return { status: answer.status, slug: answer.slug };
}

/**
 * Label, link target, slug written, links the written page ends with. The MCP path builds its links in an asynchronous effect
 * that keeps a link to a live page but not one to an alias slug (the same on PGLite and Postgres), so its alias case and the
 * alias link of its batch are expected to have no link; the CLI path resolves the alias.
 */
const CASES: Array<[string, string, string, number]> = [
  ['an existing page', 'people/alice-example', 'notes/links-existing', 1],
  ['an alias slug', 'people/bob-old', 'notes/links-alias', 1],
  ['a missing page', 'people/nobody-example', 'notes/links-missing', 0],
];

describe('engine parity: put with a wikilink', () => {
  for (const path of ['cli', 'mcp'] as const) {
    for (const [label, target, slug, expected] of CASES) {
      parityTest(`${path}: put_page with a [[wikilink]] to ${label}`, {
        methods: ['putPage', 'updateSlug', 'getLinks'], requires: 'raw_sql', timeout: 120_000,
      }, (engine, backend) => inFreshHome(() => observingConsumerRefusal(backend, async () => {
        await seed(engine);
        const answer = await putOne(engine, path, slug, `See [[${target}]] for context.`);
        return { answer, links: await linksOf(engine, slug, path === 'mcp' && label === 'an alias slug' ? 0 : expected) };
      })));
    }

    parityTest(`${path}: put_pages with a [[wikilink]]`, {
      methods: ['putPage', 'updateSlug', 'getLinks'], requires: 'raw_sql', timeout: 120_000,
    }, (engine, backend) => inFreshHome(() => observingConsumerRefusal(backend, async () => {
      await seed(engine);
      const ctx = await contextFor(engine, path, putPages);
      const answer = await putPages.handler(ctx, { request_id: REQUEST, pages: [
        { slug: 'notes/batch-a', content: page('Batch A', 'See [[people/alice-example]] and [[people/bob-old]].') },
        { slug: 'notes/batch-b', content: page('Batch B', 'See [[people/nobody-example]].') },
      ] }) as Record<string, unknown>;
      const pages = answer.pages as Array<{ slug: string; state: string; status: string }>;
      return { state: answer.state, counts: answer.counts, pages: pages.map((p) => ({ slug: p.slug, state: p.state, status: p.status })), links: [await linksOf(engine, 'notes/batch-a', path === 'cli' ? 2 : 1), await linksOf(engine, 'notes/batch-b', 0)] };
    })));
  }
});
