import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { PageInput } from '../src/core/types.ts';

const listPagesOp = operations.find((op) => op.name === 'list_pages');

if (!listPagesOp) {
  throw new Error('list_pages operation missing');
}

const pageInput: PageInput = {
  type: 'concept',
  title: 'Offset Test Page',
  compiled_truth: 'Offset pagination test content.',
};

type ListedPage = {
  slug: string;
  type: string;
  title: string;
  updated_at: unknown;
};

function makeConfig(): GBrainConfig {
  return { engine: 'pglite' };
}

function makeCtx(engine: PGLiteEngine): OperationContext {
  return {
    engine,
    config: makeConfig(),
    logger: console,
    dryRun: false,
    remote: true,
  };
}

describe('list_pages operation offset pagination', () => {
  let engine: PGLiteEngine;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    for (const slug of ['wiki/c', 'wiki/a', 'wiki/e', 'wiki/b', 'wiki/d']) {
      await engine.putPage(slug, { ...pageInput, title: slug });
    }
    await engine.addTag('wiki/b', 'offset-tag');
    await engine.addTag('wiki/d', 'offset-tag');
  });

  afterEach(async () => {
    await engine.disconnect();
  });

  test('schema documents offset and stable pagination semantics', () => {
    expect(listPagesOp.params.offset).toEqual({
      type: 'number',
      description: 'Skip first N results (default 0)',
    });
    expect(listPagesOp.description).toContain('stable ascending by slug ASC');
    expect(listPagesOp.description).toContain('concurrent writes during pagination may produce skip/duplicate');
  });

  test('offset=0 matches omitted offset', async () => {
    const ctx = makeCtx(engine);
    const noOffset = await listPagesOp.handler(ctx, { limit: 3 }) as ListedPage[];
    const zeroOffset = await listPagesOp.handler(ctx, { limit: 3, offset: 0 }) as ListedPage[];

    expect(zeroOffset).toEqual(noOffset);
    expect(zeroOffset.map((page) => page.slug)).toEqual(['wiki/a', 'wiki/b', 'wiki/c']);
  });

  test('offset=N skips N stable slug-ordered rows', async () => {
    const ctx = makeCtx(engine);
    const page = await listPagesOp.handler(ctx, { limit: 1, offset: 2 }) as ListedPage[];

    expect(page.map((item) => item.slug)).toEqual(['wiki/c']);
  });

  test('offset plus limit returns the requested window', async () => {
    const ctx = makeCtx(engine);
    const page = await listPagesOp.handler(ctx, { limit: 2, offset: 1 }) as ListedPage[];

    expect(page.map((item) => item.slug)).toEqual(['wiki/b', 'wiki/c']);
  });

  test('windowed pagination has no duplicates within a snapshot', async () => {
    const ctx = makeCtx(engine);
    const first = await listPagesOp.handler(ctx, { limit: 2, offset: 0 }) as ListedPage[];
    const second = await listPagesOp.handler(ctx, { limit: 2, offset: 2 }) as ListedPage[];
    const third = await listPagesOp.handler(ctx, { limit: 2, offset: 4 }) as ListedPage[];
    const slugs = [...first, ...second, ...third].map((item) => item.slug);

    expect(slugs).toEqual(['wiki/a', 'wiki/b', 'wiki/c', 'wiki/d', 'wiki/e']);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('tag-filtered windows honor offset', async () => {
    const ctx = makeCtx(engine);
    const page = await listPagesOp.handler(ctx, { tag: 'offset-tag', limit: 1, offset: 1 }) as ListedPage[];

    expect(page.map((item) => item.slug)).toEqual(['wiki/d']);
  });
});
