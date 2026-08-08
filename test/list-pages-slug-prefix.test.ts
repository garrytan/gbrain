/**
 * list_pages slug_prefix — op-level coverage.
 *
 * Pins (upstream draft "list_pages cannot enumerate slug-path collections"):
 *   - `slug_prefix` threads from the op params to PageFilters.slugPrefix,
 *     which both engines have implemented all along (the op layer never
 *     passed it — same shape as the v0.29 `updated_after` surfacing and the
 *     `offset` threading fix).
 *   - Plain string-prefix semantics are the engine contract: 'media/x'
 *     (no trailing '/') also matches 'media/xerox'.
 *   - LIKE metacharacters in the prefix stay literal through the op
 *     boundary: 'media/_' must not wildcard-match 'media/x/…'.
 *   - Composes with the existing `type` filter; omitted/empty/non-string
 *     `slug_prefix` leaves pre-existing behavior untouched.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  // 5-page corpus: two path collections, a path-segment trap sharing the
  // 'media/x' character prefix, a LIKE-metacharacter slug, and an outsider.
  const body = { type: 'note', title: 'Page', compiled_truth: 'body' };
  await engine.putPage('media/x/tweet-001', body);
  await engine.putPage('media/x/tweet-002', body);
  await engine.putPage('media/xerox/doc-001', { ...body, type: 'concept' });
  await engine.putPage('media/_docs/readme', body);
  await engine.putPage('people/alice', body);
});

function mkCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as any,
    dryRun: false,
    remote: false,
    ...overrides,
  } as OperationContext;
}

const op = () => operationsByName['list_pages'];
const slugsOf = (rows: unknown) => (rows as Array<{ slug: string }>).map((r) => r.slug).sort();

describe('list_pages — slug_prefix threads through to the engine filter', () => {
  test('trailing-/ prefix returns exactly the collection', async () => {
    const rows = await op().handler(mkCtx(), { slug_prefix: 'media/x/' });
    expect(slugsOf(rows)).toEqual(['media/x/tweet-001', 'media/x/tweet-002']);
  });

  test("plain string-prefix semantics: 'media/x' also matches 'media/xerox' (engine contract)", async () => {
    const rows = await op().handler(mkCtx(), { slug_prefix: 'media/x' });
    expect(slugsOf(rows)).toEqual([
      'media/x/tweet-001',
      'media/x/tweet-002',
      'media/xerox/doc-001',
    ]);
  });

  test("LIKE metacharacters stay literal: 'media/_' must not match 'media/x/…'", async () => {
    const rows = await op().handler(mkCtx(), { slug_prefix: 'media/_' });
    expect(slugsOf(rows)).toEqual(['media/_docs/readme']);
  });

  test('composes with the type filter', async () => {
    const rows = await op().handler(mkCtx(), { slug_prefix: 'media/', type: 'concept' });
    expect(slugsOf(rows)).toEqual(['media/xerox/doc-001']);
  });

  test('no match returns an empty list, not an error', async () => {
    const rows = await op().handler(mkCtx(), { slug_prefix: 'nothing/here/' });
    expect(rows).toEqual([]);
  });
});

describe('list_pages — omitted or invalid slug_prefix leaves behavior unchanged', () => {
  test('omitted: full corpus (pre-existing shape)', async () => {
    const rows = await op().handler(mkCtx(), {});
    expect(slugsOf(rows).length).toBe(5);
  });

  test('empty string: treated as unset', async () => {
    const rows = await op().handler(mkCtx(), { slug_prefix: '' });
    expect(slugsOf(rows).length).toBe(5);
  });

  test('non-string: ignored, no throw', async () => {
    const rows = await op().handler(mkCtx(), { slug_prefix: 42 as unknown as string });
    expect(slugsOf(rows).length).toBe(5);
  });
});
