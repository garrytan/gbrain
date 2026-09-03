/**
 * put_page optimistic concurrency guard.
 *
 * Whole-page writers must not silently overwrite a mutation committed after
 * their read. The caller supplies get_page.content_hash and retries the whole
 * read -> modify -> put sequence when it receives write_conflict.
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
  resetGateway();
});

function ctx(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

const putPage = operations.find((o) => o.name === 'put_page')!;

function page(title: string, body: string): string {
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}`;
}

describe('put_page expected_content_hash', () => {
  test('accepts the current hash and writes the replacement', async () => {
    await putPage.handler(ctx(), { slug: 'ops/tasks', content: page('Tasks', 'one') });
    const observed = await engine.getPage('ops/tasks', { sourceId: 'default' });

    const result = await putPage.handler(ctx(), {
      slug: 'ops/tasks',
      content: page('Tasks', 'two'),
      expected_content_hash: observed!.content_hash,
    }) as { status: string };

    expect(result.status).toBe('created_or_updated');
    expect((await engine.getPage('ops/tasks', { sourceId: 'default' }))!.compiled_truth).toContain('two');
  });

  test('rejects a stale hash without changing the page', async () => {
    await putPage.handler(ctx(), { slug: 'ops/tasks', content: page('Tasks', 'one') });
    const stale = (await engine.getPage('ops/tasks', { sourceId: 'default' }))!.content_hash;
    await putPage.handler(ctx(), { slug: 'ops/tasks', content: page('Tasks', 'newer') });

    let error: unknown;
    try {
      await putPage.handler(ctx(), {
        slug: 'ops/tasks',
        content: page('Tasks', 'stale overwrite'),
        expected_content_hash: stale,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('write_conflict');
    expect((await engine.getPage('ops/tasks', { sourceId: 'default' }))!.compiled_truth).toContain('newer');
    expect((await engine.getPage('ops/tasks', { sourceId: 'default' }))!.compiled_truth).not.toContain('stale overwrite');
  });

  test('rejects malformed hashes before writing', async () => {
    await expect(putPage.handler(ctx(), {
      slug: 'ops/tasks',
      content: page('Tasks', 'one'),
      expected_content_hash: 'not-a-hash',
    })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('supports create-if-missing and rejects a second creator', async () => {
    const first = await putPage.handler(ctx(), {
      slug: 'ops/new-tasks',
      content: page('Tasks', 'first'),
      expected_content_hash: 'absent',
    }) as { status: string };
    expect(first.status).toBe('created_or_updated');

    await expect(putPage.handler(ctx(), {
      slug: 'ops/new-tasks',
      content: page('Tasks', 'second'),
      expected_content_hash: 'absent',
    })).rejects.toMatchObject({ code: 'write_conflict' });
    expect((await engine.getPage('ops/new-tasks', { sourceId: 'default' }))!.compiled_truth).toContain('first');
  });
});
