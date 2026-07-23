import { describe, expect, test } from 'bun:test';
import { buildEntityMentionArm, extractEntityAnchors } from '../src/core/search/entity-mention-recall.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('entity mention recall', () => {
  test('extracts bounded name-like anchors without generic business terms', () => {
    expect(extractEntityAnchors('Agy sales operations partnerships proposals GFW responsibilities'))
      .toEqual(['Agy', 'GFW']);
    expect(extractEntityAnchors('what are the sales responsibilities')).toEqual([]);
    expect(extractEntityAnchors('agy role')).toEqual(['agy']);
  });

  test('hydrates inbound pages for an exact entity title', async () => {
    const calls: Array<{ slug: string; sourceId?: string }> = [];
    const engine = {
      async searchTitles(query: string, opts?: { sourceId?: string }) {
        if (query.toLowerCase() !== 'agy') return [];
        if (opts?.sourceId !== 'chronicle-meetings') return [];
        return [{
          slug: 'people/agy', page_id: 1, title: 'Agy', type: 'person',
          chunk_text: 'Agy', chunk_id: 1, chunk_index: 0, score: 1,
          stale: false, source_id: 'chronicle-meetings',
        }];
      },
      async getBacklinks(slug: string, opts?: { sourceId?: string; sourceIds?: string[] }) {
        calls.push({ slug, sourceId: opts?.sourceId });
        return [{
          from_slug: 'meetings/2026-07-16-agy-on-gfw-process-fyurwg',
          to_slug: 'people/agy',
          link_type: 'attended',
          context: 'Agy discussed GFW proposals and sales operations',
        }];
      },
      async executeRaw() {
        return [{
          page_id: 42,
          source_id: 'chronicle-meetings',
          slug: 'meetings/2026-07-16-agy-on-gfw-process-fyurwg',
          title: 'Agy on gfw process',
          type: 'meeting',
          synopsis: 'GFW proposal process',
          effective_date: '2026-07-16T00:00:00Z',
        }];
      },
    } as unknown as BrainEngine;

    const rows = await buildEntityMentionArm(
      engine,
      'Agy GFW responsibilities',
      { sourceIds: ['default', 'chronicle-meetings'] },
    );
    expect(calls).toEqual([{ slug: 'people/agy', sourceId: undefined }]);
    expect(rows.map((r) => r.slug))
      .toEqual(['meetings/2026-07-16-agy-on-gfw-process-fyurwg']);
  });
});
