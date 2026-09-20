/**
 * put_page shrink guard tests.
 *
 * Class guard: put_page REPLACES a page; it does not merge. An agent told to
 * "add today's entry" performs a read-modify-write, and when the read is
 * missing, stale, or aimed at the wrong slug it writes back only the new
 * fragment — silently destroying everything else on the page. The empty
 * guard does not catch it, because the body is not empty.
 *
 * expected_revision (v0.51.0.0) closes the BLIND overwrite: a caller that
 * never read the page cannot replace it. It does not close this one. The
 * agent here did read the page and holds a valid revision; what it wrote back
 * was incomplete. Every case below supplies the correct revision.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
}, 60_000);

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

/** Always supplies the current revision, so nothing here is a blind overwrite. */
const putPage = {
  handler: async (ctx: OperationContext, params: Record<string, unknown>) => {
    const snapshot = await ctx.engine.readPageSnapshot(String(params.slug), {
      sourceId: ctx.sourceId,
      includeDeleted: true,
    });
    return operations
      .find((o) => o.name === 'put_page')!
      .handler(ctx, { ...params, ...(snapshot ? { expected_revision: snapshot.revision } : {}) });
  },
};

/** Comfortably over the 500-character floor. */
const SUBSTANTIAL = `---\ntitle: Muse\n---\n\n# Muse\n\n${'Real content that must survive a careless rewrite. '.repeat(20)}`;
/** The fragment a read-modify-write with a missed read writes back. */
const FRAGMENT = '---\ntitle: Muse\n---\n\n# Muse\n\nToday: one new line.';

async function seed(slug: string, content = SUBSTANTIAL): Promise<void> {
  await putPage.handler(makeCtx(), { slug, content });
}

describe('put_page shrink guard', () => {
  test('refuses a remote write that drops a substantial page below half its length', async () => {
    await seed('projects/muse');

    await expect(
      putPage.handler(makeCtx({ remote: true }), { slug: 'projects/muse', content: FRAGMENT }),
    ).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining("Refusing to shrink 'projects/muse'"),
    });

    const page = await engine.getPage('projects/muse', { sourceId: 'default' });
    expect(page?.compiled_truth).toContain('Real content that must survive');
  });

  test('allow_shrink lets a caller that means it through', async () => {
    await seed('projects/muse');

    await putPage.handler(makeCtx({ remote: true }), {
      slug: 'projects/muse',
      content: FRAGMENT,
      allow_shrink: true,
    });

    const page = await engine.getPage('projects/muse', { sourceId: 'default' });
    expect(page?.compiled_truth).toContain('Today: one new line.');
  });

  test('trusted local writers are unaffected (import, export, dream cycle rewrite wholesale)', async () => {
    await seed('projects/muse');

    await putPage.handler(makeCtx({ remote: false }), { slug: 'projects/muse', content: FRAGMENT });

    const page = await engine.getPage('projects/muse', { sourceId: 'default' });
    expect(page?.compiled_truth).toContain('Today: one new line.');
  });

  test('short pages are below the floor and never guarded', async () => {
    await seed('notes/stub', '---\ntitle: Stub\n---\n\nA one-line capture.');

    await putPage.handler(makeCtx({ remote: true }), {
      slug: 'notes/stub',
      content: '---\ntitle: Stub\n---\n\nShorter.',
    });

    const page = await engine.getPage('notes/stub', { sourceId: 'default' });
    expect(page?.compiled_truth).toContain('Shorter.');
  });

  test('a modest edit that keeps more than half the page is allowed', async () => {
    await seed('projects/muse');
    const trimmed = `---\ntitle: Muse\n---\n\n# Muse\n\n${'Real content that must survive a careless rewrite. '.repeat(15)}`;

    await putPage.handler(makeCtx({ remote: true }), { slug: 'projects/muse', content: trimmed });

    const page = await engine.getPage('projects/muse', { sourceId: 'default' });
    expect(page?.compiled_truth).toContain('Real content that must survive');
  });

  test('creating a new page is never a shrink', async () => {
    await putPage.handler(makeCtx({ remote: true }), { slug: 'notes/brand-new', content: FRAGMENT });

    const page = await engine.getPage('notes/brand-new', { sourceId: 'default' });
    expect(page?.compiled_truth).toContain('Today: one new line.');
  });
});
