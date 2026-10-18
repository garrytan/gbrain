/**
 * Large pages (Wave A, eng F10): each version snapshot copies the whole body,
 * so a page over the inline cap keeps only its newest LARGE_PAGE_VERSIONS_KEPT
 * large snapshots. Small pages, and the small snapshots of a page that grew,
 * keep their full history.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { LARGE_PAGE_VERSIONS_KEPT } from '../src/core/page-state/versions.ts';
import { PAGE_INLINE_MAX_BYTES } from '../src/core/page-size-policy.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function versionSizes(slug: string): Promise<number[]> {
  const rows = await engine.executeRaw<{ bytes: number }>(`SELECT octet_length(v.compiled_truth)::int AS bytes FROM page_versions v
    JOIN pages p ON p.id = v.page_id WHERE p.slug = $1 ORDER BY v.id`, [slug]);
  return rows.map(row => Number(row.bytes));
}

describe('page_versions retention for large pages', () => {
  test('a large page keeps its newest large snapshots and every small one', async () => {
    const small = 'early notes about acme-example. ';
    await engine.putPage('chats/growing', { type: 'note', title: 'growing', compiled_truth: small });
    await engine.createVersion('chats/growing');
    await engine.createVersion('chats/growing');
    const large = 'x'.repeat(PAGE_INLINE_MAX_BYTES + 10);
    for (let i = 0; i < LARGE_PAGE_VERSIONS_KEPT + 3; i++) {
      await engine.putPage('chats/growing', { type: 'note', title: 'growing', compiled_truth: `${large}${i}` });
      await engine.createVersion('chats/growing');
    }
    const sizes = await versionSizes('chats/growing');
    expect(sizes.filter(bytes => bytes <= PAGE_INLINE_MAX_BYTES)).toHaveLength(2);
    expect(sizes.filter(bytes => bytes > PAGE_INLINE_MAX_BYTES)).toHaveLength(LARGE_PAGE_VERSIONS_KEPT);
  });

  test('a small page keeps every snapshot', async () => {
    for (let i = 0; i < LARGE_PAGE_VERSIONS_KEPT + 3; i++) {
      await engine.putPage('notes/small', { type: 'note', title: 'small', compiled_truth: `revision ${i}` });
      await engine.createVersion('notes/small');
    }
    expect(await versionSizes('notes/small')).toHaveLength(LARGE_PAGE_VERSIONS_KEPT + 3);
  });
});
