/**
 * Regression — put_page with a MIXED-CASE slug + frontmatter tags.
 *
 * Bug: `validateSlug` (utils.ts) lowercases, and `putPage` calls it — so the
 * page row is stored under the lowercased slug. But `addTag` (and addLink /
 * addTimelineEntry) query the RAW slug. A put_page with a capitalized slug
 * (e.g. 'Projects/Team-Wiki/Quarterly-Roadmap') therefore stored the page as
 * 'projects/team-wiki/quarterly-roadmap', then the tag-reconciliation loop
 * called addTag('Projects/Team-Wiki/Quarterly-Roadmap', …) whose existence
 * check found no row and threw `addTag failed: page "…" not found`, rolling
 * back the ENTIRE write — so the page never persisted under either casing.
 * A capital letter in a slug arriving over the HTTP MCP server (where slugs
 * are passed verbatim) plus a frontmatter tag was enough to trigger it.
 *
 * Fix: the put_page handler canonicalizes the slug once at the boundary
 * (validateSlug), so the subagent allow-list check, putPage, and the
 * tag/link/timeline reconciliation all agree on the lowercased slug.
 *
 * Runs against in-memory PGLite (hermetic, no DATABASE_URL), mirroring the
 * isolation discipline of put-page-provenance.test.ts.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const putPageOp = operations.find((o) => o.name === 'put_page')!;

let engine: PGLiteEngine;

beforeAll(async () => {
  // Same gateway-hermeticity guard as put-page-provenance.test.ts: pin the
  // embed model + stub the transport so put_page's embed never hits the net.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-stub' },
  });
  __setEmbedTransportForTests(async ({ values }: any) => ({
    embeddings: values.map(() => new Array(1536).fill(0)),
    usage: { tokens: 0 },
  }) as any);

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages', []);
});

function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: {
      info: () => { /* noop */ },
      warn: () => { /* noop */ },
      error: () => { /* noop */ },
    },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...opts,
  };
}

async function pageExists(slug: string): Promise<boolean> {
  const rows = await engine.executeRaw('SELECT id FROM pages WHERE slug = $1', [slug]) as unknown[];
  return rows.length === 1;
}

async function tagsFor(slug: string): Promise<string[]> {
  const rows = await engine.executeRaw(
    'SELECT t.tag FROM tags t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 ORDER BY t.tag',
    [slug],
  ) as Array<{ tag: string }>;
  return rows.map((r) => r.tag);
}

describe('put_page — mixed-case slug + frontmatter tags', () => {
  test('capitalized slug with tags succeeds and lands under the canonical lowercased slug', async () => {
    const ctx = makeCtx({ remote: true });

    // Pre-fix this threw `addTag failed: page "Projects/Team-Wiki/Quarterly-Roadmap" not found`.
    await putPageOp.handler(ctx, {
      slug: 'Projects/Team-Wiki/Quarterly-Roadmap',
      content: '---\ntype: note\ntitle: Quarterly Roadmap\ntags: [planning, draft]\n---\n\nMixed-case slug plus frontmatter tags.',
    });

    // Page persisted under the lowercased canonical slug …
    expect(await pageExists('projects/team-wiki/quarterly-roadmap')).toBe(true);
    // … and NOT under the original mixed casing.
    expect(await pageExists('Projects/Team-Wiki/Quarterly-Roadmap')).toBe(false);
    // Tags reconciled onto the same canonical row (the step that used to throw).
    expect(await tagsFor('projects/team-wiki/quarterly-roadmap')).toEqual(['draft', 'planning']);
  });

  test('lowercase slug with tags still works (no regression)', async () => {
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'projects/team-wiki/release-checklist',
      content: '---\ntype: note\ntitle: Release Checklist\ntags: [planning]\n---\n\nLowercase control case.',
    });
    expect(await pageExists('projects/team-wiki/release-checklist')).toBe(true);
    expect(await tagsFor('projects/team-wiki/release-checklist')).toEqual(['planning']);
  });
});
