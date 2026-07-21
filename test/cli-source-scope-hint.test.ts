/**
 * #1484 — invisible-miss hint. A bare `gbrain query` resolves to a single
 * source (usually 'default'); on a multi-source brain a zero-hit run gave no
 * signal that the answer might live in another source. sourceScopeHint
 * returns the stderr hint exactly when: query/search op + zero results +
 * no explicit scoping param + >1 registered source.
 */

import { describe, expect, test } from 'bun:test';
import { sourceScopeHint } from '../src/cli.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function fakeEngine(sourceCount: number, fail = false): BrainEngine {
  return {
    executeRaw: async () => {
      if (fail) throw new Error('sources table missing');
      return [{ n: sourceCount }];
    },
  } as unknown as BrainEngine;
}

describe('sourceScopeHint (#1484)', () => {
  test('fires on a bare zero-hit query against a multi-source brain', async () => {
    const hint = await sourceScopeHint('query', {}, 'default', fakeEngine(3), []);
    expect(hint).toContain('3 sources');
    expect(hint).toContain('"default"');
    expect(hint).toContain('--source-id __all__');
  });

  test('fires for search too', async () => {
    const hint = await sourceScopeHint('search', {}, 'wiki', fakeEngine(2), []);
    expect(hint).toContain('"wiki"');
  });

  test('silent when results were found', async () => {
    expect(await sourceScopeHint('query', {}, 'default', fakeEngine(3), [{ slug: 'a' }])).toBeNull();
  });

  test('silent when the caller scoped explicitly', async () => {
    expect(await sourceScopeHint('query', { source_id: 'wiki' }, 'wiki', fakeEngine(3), [])).toBeNull();
    expect(await sourceScopeHint('query', { source: 'wiki' }, 'wiki', fakeEngine(3), [])).toBeNull();
    expect(await sourceScopeHint('query', { all_sources: true }, '__all__', fakeEngine(3), [])).toBeNull();
  });

  test('silent when the resolved scope is already __all__', async () => {
    expect(await sourceScopeHint('query', {}, '__all__', fakeEngine(3), [])).toBeNull();
  });

  test('silent on a single-source brain', async () => {
    expect(await sourceScopeHint('query', {}, 'default', fakeEngine(1), [])).toBeNull();
  });

  test('silent for non-search ops and non-array results', async () => {
    expect(await sourceScopeHint('get_stats', {}, 'default', fakeEngine(3), [])).toBeNull();
    expect(await sourceScopeHint('query', {}, 'default', fakeEngine(3), { rows: [] })).toBeNull();
  });

  test('best-effort: sources lookup failure returns null, never throws', async () => {
    expect(await sourceScopeHint('query', {}, 'default', fakeEngine(3, true), [])).toBeNull();
  });
});
