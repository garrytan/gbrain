/**
 * #4620 — an EXPLICIT per-call `source_id` that names a removed or archived
 * source fails loudly (`unknown_source`) instead of silently scoping the read
 * to a source with no rows and answering `page_not_found` (with a soft-delete
 * hint pointing the wrong way) or `[]`. The #1712 rule (an explicit source
 * that fails to resolve errors loudly), applied to the op path.
 *
 * Reachable in the wild: `oauth_clients.federated_read` has no FK, so a grant
 * (and a client-side `.gbrain-source` dotfile) keeps naming a source after
 * `sources remove`, and the thin client pins that id onto every op's
 * `source_id`. The check runs AFTER resolveRequestedScope's grant check, so
 * it can only name a source the caller was already granted — never a
 * cross-grant existence oracle.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const op = (name: string) => operations.find(o => o.name === name)!;
const DEAD = 'scratch-src';

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['default', DEAD] },
    ...overrides,
  } as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage(
    'notes/example-page',
    { title: 'Example', type: 'note', compiled_truth: '# Example\n\nlives in default\n' },
    { sourceId: 'default' },
  );
  // Register, then remove: the grant above still names the dead id.
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('${DEAD}', 'scratch')`);
  await engine.executeRaw(`DELETE FROM sources WHERE id = '${DEAD}'`);
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('explicit source_id naming a removed source (#4620)', () => {
  test('get_page → unknown_source, not page_not_found with a soft-delete hint', async () => {
    await expect(op('get_page').handler(ctxOf(), { slug: 'notes/example-page', source_id: DEAD }))
      .rejects.toMatchObject({ code: 'unknown_source' });
  });

  test('list_pages → unknown_source, not a silent []', async () => {
    await expect(op('list_pages').handler(ctxOf(), { source_id: DEAD }))
      .rejects.toMatchObject({ code: 'unknown_source' });
  });

  test('search / query → unknown_source, not a silent []', async () => {
    await expect(op('search').handler(ctxOf(), { query: 'example', source_id: DEAD }))
      .rejects.toMatchObject({ code: 'unknown_source' });
    await expect(op('query').handler(ctxOf(), { query: 'example', source_id: DEAD }))
      .rejects.toMatchObject({ code: 'unknown_source' });
  });

  test('an archived source counts as gone (matches the CLI assertSourceExists rule)', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, archived) VALUES ('${DEAD}', 'scratch', true)`);
    try {
      await expect(op('get_page').handler(ctxOf(), { slug: 'notes/example-page', source_id: DEAD }))
        .rejects.toMatchObject({ code: 'unknown_source' });
    } finally {
      await engine.executeRaw(`DELETE FROM sources WHERE id = '${DEAD}'`);
    }
  });

  test('trusted local caller gets the same loud error (#1712 is not a remote-only rule)', async () => {
    await expect(op('get_page').handler(ctxOf({ remote: false, auth: undefined }), { slug: 'notes/example-page', source_id: DEAD }))
      .rejects.toMatchObject({ code: 'unknown_source' });
  });
});

describe('unchanged paths (#4620 guards)', () => {
  test('a live explicit source_id still reads the page', async () => {
    const page = await op('get_page').handler(ctxOf(), { slug: 'notes/example-page', source_id: 'default' }) as { slug: string };
    expect(page.slug).toBe('notes/example-page');
  });

  test("'__all__' still resolves to the grant without an existence check", async () => {
    const page = await op('get_page').handler(ctxOf(), { slug: 'notes/example-page', source_id: '__all__' }) as { slug: string };
    expect(page.slug).toBe('notes/example-page');
  });

  test('an out-of-grant source_id is still permission_denied (grant check runs first)', async () => {
    await expect(op('get_page').handler(ctxOf(), { slug: 'notes/example-page', source_id: 'other' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('a genuinely missing page in a live source keeps page_not_found', async () => {
    await expect(op('get_page').handler(ctxOf(), { slug: 'notes/nope', source_id: 'default' }))
      .rejects.toMatchObject({ code: 'page_not_found' });
  });
});
