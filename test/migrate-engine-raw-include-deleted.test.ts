/**
 * copyPageToTarget reads raw_data with `includeDeleted: true`. Both engines'
 * getRawData now follow the page soft-delete (`deleted_at IS NULL`), so
 * without the opt-in a migration would silently drop the raw_data of every
 * tombstoned page the page list decided to carry. Fake engines, same shape as
 * migrate-engine-page-copy-failure.serial.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { copyPageToTarget } from '../src/commands/migrate-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';

function fakePage(overrides: Partial<Page> = {}): Page {
  return {
    id: 7,
    slug: 'notes/tombstoned',
    type: 'note',
    title: 't',
    compiled_truth: 'body',
    timeline: '',
    frontmatter: {},
    source_id: 'beta',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('copyPageToTarget — raw_data read opts', () => {
  test('reads raw_data with includeDeleted: true scoped to the page source, and forwards every row', async () => {
    const getRawDataCalls: unknown[] = [];
    const putRawDataCalls: unknown[] = [];
    const rows = [
      { source: 'transcript:claude-code', data: { cwd: '/tmp/x' }, fetched_at: new Date() },
      { source: 'feed', data: { a: 1 }, fetched_at: new Date() },
    ];
    const source = {
      getChunksWithEmbeddings: async () => [],
      getTags: async () => [],
      getTimeline: async () => [],
      getRawData: async (slug: string, rawSource: unknown, opts: unknown) => {
        getRawDataCalls.push({ slug, rawSource, opts });
        return rows;
      },
    } as unknown as BrainEngine;
    const target = {
      putPage: async () => fakePage(),
      executeRaw: async () => [],
      putRawData: async (slug: string, rawSource: string, data: unknown, opts: unknown) => {
        putRawDataCalls.push({ slug, rawSource, data, opts });
      },
    } as unknown as BrainEngine;

    // A tombstoned source row: the page list decided it travels, raw must follow.
    const stats = await copyPageToTarget(source, target, fakePage({ deleted_at: new Date() }));

    expect(getRawDataCalls).toEqual([
      { slug: 'notes/tombstoned', rawSource: undefined, opts: { sourceId: 'beta', includeDeleted: true } },
    ]);
    expect(putRawDataCalls).toEqual([
      { slug: 'notes/tombstoned', rawSource: 'transcript:claude-code', data: { cwd: '/tmp/x' }, opts: { sourceId: 'beta' } },
      { slug: 'notes/tombstoned', rawSource: 'feed', data: { a: 1 }, opts: { sourceId: 'beta' } },
    ]);
    expect(stats.raw_data).toBe(2);
  });
});
