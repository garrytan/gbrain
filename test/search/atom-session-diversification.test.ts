import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { applyGraphSignals, SESSION_DEMOTE, sessionPrefix } from '../../src/core/search/graph-signals.ts';

describe('atoms retain independent retrieval scores', () => {
  test.each([
    'atoms/2030-04-30/first-lesson',
    'atoms/2030-04-30/chat-discussion',
    'atoms/2030-04-30/sessions/summary',
    'atoms/transcripts/chat/lesson',
  ])('%s is not a transcript session', slug => {
    expect(sessionPrefix(slug)).toBeNull();
  });

  test('same-date atoms keep scores while meeting and daily siblings still diversify', async () => {
    const slugs = [
      'atoms/2030-04-30/first-lesson',
      'atoms/2030-04-30/second-lesson',
      'atoms/2030-04-30/third-lesson',
      'meetings/2030-04-30/notes',
      'meetings/2030-04-30/actions',
      'daily/2030-04-30/morning',
      'daily/2030-04-30/evening',
    ];
    const rows: SearchResult[] = slugs.map((slug, index) => ({
      slug, title: slug, page_id: index + 1, chunk_id: index + 1,
      chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic example',
      type: 'note', source_id: 'default', score: 20 - index, stale: false,
    }));
    let demotions: number | undefined;
    await applyGraphSignals(rows, {} as BrainEngine, {
      enabled: true,
      adjacencyFn: async () => new Map(),
      onMeta: meta => { demotions = meta.session_demotions; },
    });
    for (let index = 0; index < 3; index++) {
      expect(rows[index].score).toBe(20 - index);
      expect(rows[index].graph_session_demoted).toBeUndefined();
      expect(rows[index].graph_session_prefix).toBeUndefined();
    }
    expect(rows[3].score).toBe(17);
    expect(rows[4].score).toBeCloseTo(16 * SESSION_DEMOTE);
    expect(rows[5].score).toBe(15);
    expect(rows[6].score).toBeCloseTo(14 * SESSION_DEMOTE);
    expect(demotions).toBe(2);
  });
});
