/**
 * GST-2714: `gbrain search` on the CLI dropped the saved facts (remember) that the
 * search op matched, so an agent that saved a fact with `gbrain remember` and
 * looked it up later with `gbrain search` saw "No results." (install eval
 * gbrain-install-2026-11, OpenClaw CLI runs). MCP search already printed them.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { formatResult, captureRetrievalMeta, resetRetrievalMetaForTests } from '../src/cli/main.ts';
import { _resetCliOptionsForTest, getCliOptions, setCliOptions } from '../src/core/cli-options.ts';

afterEach(() => { resetRetrievalMetaForTests(); _resetCliOptionsForTest(); });

const savedFact = { id: 1, fact: "The user's sister's new cat is called Zorbloon-example.", entity_slug: 'user', kind: 'fact', valid_from: '2026-11-17', source: 'chat' };

describe('CLI search prints the saved facts the op matched', () => {
  test('empty page result: the saved fact is printed, not a bare No results', () => {
    captureRetrievalMeta('retrieval', { returned_count: 0, retrieved_count: 0, degraded: [], saved_facts: [savedFact] });
    const out = formatResult('search', [], {});
    expect(out).toContain('Saved facts (remember)');
    expect(out).toContain('Zorbloon-example');
  });

  test('page rows and saved facts: both are printed', () => {
    captureRetrievalMeta('retrieval', { returned_count: 1, retrieved_count: 1, saved_facts: [savedFact] });
    const out = formatResult('query', [{ slug: 'notes/cats', title: 'Cats', type: 'note', chunk_text: 'cats', score: 1 }], {});
    expect(out).toContain('notes/cats');
    expect(out).toContain('Zorbloon-example');
  });

  test('--json keeps stdout the row array and prints the saved facts on stderr', () => {
    captureRetrievalMeta('retrieval', { returned_count: 0, retrieved_count: 0, saved_facts: [savedFact] });
    const writes: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { writes.push(String(chunk)); return true; });
    try {
      const out = formatResult('search', [], { json: true });
      expect(JSON.parse(out)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join('')).toContain('Zorbloon-example');
  });

  test('--room prints no saved facts, since the room marks none of them', () => {
    setCliOptions({ ...getCliOptions(), room: 'group:team-a' } as ReturnType<typeof getCliOptions>);
    captureRetrievalMeta('retrieval', { returned_count: 0, retrieved_count: 0, saved_facts: [savedFact] });
    expect(formatResult('search', [], {})).not.toContain('Zorbloon-example');
  });

  test('--explain output keeps the saved facts after the rows', () => {
    setCliOptions({ ...getCliOptions(), explain: true } as ReturnType<typeof getCliOptions>);
    captureRetrievalMeta('retrieval', { returned_count: 1, retrieved_count: 1, saved_facts: [savedFact] });
    expect(formatResult('search', [{ slug: 'notes/cats', title: 'Cats', type: 'note', chunk_text: 'cats', score: 1 }], {})).toContain('Zorbloon-example');
  });

  test('no saved facts: output unchanged', () => {
    captureRetrievalMeta('retrieval', { returned_count: 0, retrieved_count: 0, degraded: [] });
    expect(formatResult('search', [], {})).not.toContain('Saved facts');
  });
});
