/**
 * Read-only loaders for the hermetic synthetic brain corpus vendored at
 * test/fixtures/bootstrap-corpus/. Consumed by the agent-bootstrap end-to-end
 * tests so they exercise real recall/graph behavior against a small, 100%
 * synthetic, privacy-safe world instead of depending on the sibling
 * gbrain-evals checkout (which may be absent in CI).
 *
 * Design notes for consumers:
 *   - loadCorpusPages writes through the REAL `put_page` operation handler
 *     with a trusted-local OperationContext (remote: false). That is what
 *     fires auto-link (wikilink → graph edge), chunking, and search-vector
 *     population — bare engine.putPage would skip those post-hooks. Pages are
 *     loaded in TWO passes: pass 1 creates every row; pass 2 re-runs the
 *     idempotent auto-link reconciler now that every wikilink target exists
 *     (runAutoLink filters candidates to slugs present in getAllSlugs, so a
 *     forward reference in a cyclic graph only resolves once its target row
 *     is present). Returns the loaded slugs.
 *   - loadCorpusBeliefs inserts each belief via engine.insertFact honoring its
 *     declared visibility ('world' | 'private') so a visibility-fence recall
 *     test can assert the private ones never surface. Returns the count.
 *   - loadCorpusQueries returns the parsed gold cases (no engine needed).
 *
 * The loaders never mutate process.env; env sandboxing (GBRAIN_HOME /
 * DATABASE_URL stripping) is the caller's responsibility.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../../src/core/operations.ts';
import type { OperationContext, Operation } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

/** Absolute path to the vendored fixture directory. */
export const CORPUS_DIR = join(import.meta.dir, '..', 'fixtures', 'bootstrap-corpus');
const PAGES_DIR = join(CORPUS_DIR, 'pages');

/** A belief/fact object as stored in beliefs.json. */
export interface CorpusBelief {
  text: string;
  entity_slug: string;
  visibility: 'world' | 'private';
  confidence: number;
}

/** A gold recall case as stored in queries.json. */
export interface CorpusQuery {
  id: string;
  kind: 'page' | 'belief' | 'fence';
  query: string;
  expect_slug?: string;
  expect_substring?: string;
  must_not_substring?: string;
}

const put_page = operations.find((o) => o.name === 'put_page') as Operation | undefined;
if (!put_page) throw new Error('bootstrap-corpus loader: put_page op not registered');

/**
 * Build a trusted-local OperationContext (remote: false) so the put_page
 * handler honors auto-link / auto-timeline post-hooks. Mirrors the makeCtx
 * pattern in test/source-id-tx-regression.test.ts.
 */
function trustedCtx(engine: BrainEngine, sourceId: string): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
  };
}

/** Filename `people__alice-example.md` → slug `people/alice-example`. */
function fileToSlug(filename: string): string {
  return filename.replace(/\.md$/, '').replace(/__/g, '/');
}

/**
 * Read the corpus markdown pages and write them through the put_page op
 * handler (remote: false) so auto-link, chunking, and search-vector fire.
 * Two passes: pass 1 seeds all rows, pass 2 lets the auto-link reconciler
 * resolve every [[wikilink]] now that all targets exist. Returns the slugs.
 */
export async function loadCorpusPages(
  engine: BrainEngine,
  opts: { sourceId?: string } = {},
): Promise<string[]> {
  const sourceId = opts.sourceId ?? 'default';
  const ctx = trustedCtx(engine, sourceId);
  const files = readdirSync(PAGES_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();
  const docs = files.map((f) => ({
    slug: fileToSlug(f),
    content: readFileSync(join(PAGES_DIR, f), 'utf8'),
  }));

  // Pass 1: create every page row (some wikilink targets may not exist yet).
  // Pass 2: re-run — auto-link reconciles now that every target row exists.
  for (let pass = 0; pass < 2; pass++) {
    for (const doc of docs) {
      await put_page!.handler(ctx, { slug: doc.slug, content: doc.content });
    }
  }
  return docs.map((d) => d.slug);
}

/**
 * Insert the corpus beliefs via engine.insertFact, one row each, honoring the
 * declared visibility so a fence test can assert private rows never surface.
 * Returns the number of rows inserted.
 */
export async function loadCorpusBeliefs(
  engine: BrainEngine,
  opts: { sourceId?: string } = {},
): Promise<number> {
  const sourceId = opts.sourceId ?? 'default';
  const beliefs = loadCorpusBeliefData();
  let inserted = 0;
  for (const b of beliefs) {
    await engine.insertFact(
      {
        fact: b.text,
        kind: 'fact',
        entity_slug: b.entity_slug,
        visibility: b.visibility,
        confidence: b.confidence,
        source: 'test:bootstrap-corpus',
        embedding: null,
      },
      { source_id: sourceId },
    );
    inserted++;
  }
  return inserted;
}

/** Parse and return the raw belief objects (no engine needed). */
export function loadCorpusBeliefData(): CorpusBelief[] {
  return JSON.parse(readFileSync(join(CORPUS_DIR, 'beliefs.json'), 'utf8')) as CorpusBelief[];
}

/** Parse and return the gold recall cases (no engine needed). */
export function loadCorpusQueries(): CorpusQuery[] {
  return JSON.parse(readFileSync(join(CORPUS_DIR, 'queries.json'), 'utf8')) as CorpusQuery[];
}
