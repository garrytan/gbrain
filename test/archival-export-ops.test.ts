import { describe, expect, test } from 'bun:test';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { Page } from '../src/core/types.ts';

const getPageOp = operations.find(o => o.name === 'get_page');
const listPagesOp = operations.find(o => o.name === 'list_pages');
if (!getPageOp || !listPagesOp) throw new Error('page operations missing');

function page(slug: string): Page {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    source_id: 'default',
    slug,
    type: 'note',
    title: slug,
    compiled_truth: 'body',
    timeline: '',
    frontmatter: {},
    content_hash: `hash-${slug}`,
    created_at: new Date('2026-07-14T00:00:00Z'),
    updated_at: new Date('2026-07-14T00:00:00Z'),
    effective_date: null,
    deleted_at: null,
  };
}

function ctxWithPages(pages: Page[]): { ctx: OperationContext; getPageCalls: () => number } {
  let getPageCalls = 0;
  const engine = {
    getPage: async (slug: string) => {
      getPageCalls++;
      return pages.find(p => p.slug === slug) ?? null;
    },
    listPages: async () => pages,
    getTags: async () => [],
    resolveSlugs: async () => [],
  } as unknown as BrainEngine;

  return {
    getPageCalls: () => getPageCalls,
    ctx: {
      engine,
      config: { engine: 'pglite' } as unknown as GBrainConfig,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    },
  };
}

describe('archival export snapshot operation visibility', () => {
  test('get_page hides root and _uninstalled export snapshots before engine lookup', async () => {
    const { ctx, getPageCalls } = ctxWithPages([
      page('export/report'),
      page('_uninstalled/export-1783954174436/report'),
      page('export/_uninstalled/export-1783954174436/report'),
    ]);

    for (const slug of [
      'export/report',
      '_uninstalled/export-1783954174436/report',
      'export/_uninstalled/export-1783954174436/report',
    ]) {
      await expect(getPageOp.handler(ctx, { slug })).rejects.toBeInstanceOf(OperationError);
    }
    expect(getPageCalls()).toBe(0);
  });

  test('list_pages omits archival export snapshots from returned rows', async () => {
    const { ctx } = ctxWithPages([
      page('notes/live'),
      page('export/report'),
      page('_uninstalled/export-1783954174436/report'),
      page('export/_uninstalled/export-1783954174436/report'),
    ]);

    const rows = await listPagesOp.handler(ctx, { limit: 10 }) as Array<{ slug: string }>;
    expect(rows.map(r => r.slug)).toEqual(['notes/live']);
  });
});
