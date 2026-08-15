/**
 * put_page empty-overwrite guard tests.
 *
 * Class guard: empty/whitespace-only content over an existing non-empty page
 * is an input-plumbing failure (e.g. a caller that meant file input — put has
 * no --file flag — so the missing --content fell back to reading an empty
 * non-interactive stdin), not an intentional write. put_page must refuse it
 * loudly unless allow_empty is passed. New-slug creates, same-source scoping,
 * and normal non-empty overwrites are unaffected.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // No embedding provider in tests: isAvailable('embedding') must be false so
  // put_page sets noEmbed and never makes a network call.
  resetGateway();
});

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

const putPage = operations.find((o) => o.name === 'put_page')!;

const PAGE_CONTENT = '---\ntitle: Guarded\n---\n\n# Real body\n\nContent that must survive.';

async function seedPage(slug: string): Promise<void> {
  const result = (await putPage.handler(makeCtx(), { slug, content: PAGE_CONTENT })) as {
    status: string;
  };
  expect(result.status).toBe('created_or_updated');
}

async function expectRejected(params: Record<string, unknown>, ctx = makeCtx()): Promise<OperationError> {
  try {
    await putPage.handler(ctx, params);
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    return e as OperationError;
  }
  throw new Error('expected put_page to reject the empty overwrite, but it succeeded');
}

describe('put_page empty-overwrite guard — rejection', () => {
  test('empty content over an existing non-empty page is rejected; page survives', async () => {
    await seedPage('inbox/guarded');
    const err = await expectRejected({ slug: 'inbox/guarded', content: '' });
    expect(err.code).toBe('invalid_params');
    expect(err.message).toContain('inbox/guarded');
    expect(err.suggestion).toContain('capture --file PATH --slug SLUG');
    expect(err.suggestion).toContain('allow_empty');

    const page = await engine.getPage('inbox/guarded', { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).toContain('Content that must survive.');
  });

  test('whitespace-only content is rejected the same way', async () => {
    await seedPage('inbox/guarded-ws');
    const err = await expectRejected({ slug: 'inbox/guarded-ws', content: '  \n\t \n' });
    expect(err.code).toBe('invalid_params');

    const page = await engine.getPage('inbox/guarded-ws', { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('Content that must survive.');
  });

  test('remote (MCP) callers are guarded too', async () => {
    await seedPage('inbox/guarded-remote');
    const err = await expectRejected(
      { slug: 'inbox/guarded-remote', content: '' },
      makeCtx({ remote: true }),
    );
    expect(err.code).toBe('invalid_params');
  });
});

describe('put_page empty-overwrite guard — allowed paths', () => {
  test('allow_empty: true blanks the page intentionally', async () => {
    await seedPage('inbox/blank-me');
    const result = (await putPage.handler(makeCtx(), {
      slug: 'inbox/blank-me',
      content: '',
      allow_empty: true,
    })) as { status: string };
    expect(result.status).toBe('created_or_updated');
    const page = await engine.getPage('inbox/blank-me', { sourceId: 'default' });
    expect((page!.compiled_truth ?? '').trim()).toBe('');
  });

  test('empty content on a new slug still creates the page', async () => {
    const result = (await putPage.handler(makeCtx(), {
      slug: 'inbox/new-empty',
      content: '',
    })) as { status: string };
    expect(result.status).toBe('created_or_updated');
    expect(await engine.getPage('inbox/new-empty', { sourceId: 'default' })).not.toBeNull();
  });

  test('non-empty overwrite of an existing page is unaffected', async () => {
    await seedPage('inbox/normal-update');
    const result = (await putPage.handler(makeCtx(), {
      slug: 'inbox/normal-update',
      content: '---\ntitle: Guarded\n---\n\n# Real body\n\nUpdated content.',
    })) as { status: string };
    expect(result.status).toBe('created_or_updated');
    const page = await engine.getPage('inbox/normal-update', { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('Updated content.');
  });

  test('guard is scoped to the write-target source — a non-empty page in another source does not block', async () => {
    await seedPage('shared/per-source'); // lands in 'default'
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('team-x', 'team-x')");
    const result = (await putPage.handler(makeCtx({ sourceId: 'team-x' }), {
      slug: 'shared/per-source',
      content: '',
    })) as { status: string };
    expect(result.status).toBe('created_or_updated');
    // The default-source page is untouched.
    const page = await engine.getPage('shared/per-source', { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('Content that must survive.');
  });
});
