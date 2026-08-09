import { describe, expect, test } from 'bun:test';
import {
  collectThinClientListPages,
  paginateThinClientListPages,
  publishThinClientListPagesAtomically,
  REMOTE_LIST_PAGE_SIZE,
} from '../src/core/thin-client-list-pagination.ts';

function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({ slug: `notes/${String(i).padStart(3, '0')}` }));
}

describe('collectThinClientListPages', () => {
  test('bare list collects every bounded remote page', async () => {
    const all = rows(230);
    const calls: Array<Record<string, unknown>> = [];
    const result = await collectThinClientListPages({ sort: 'slug' }, async (params) => {
      calls.push(params);
      const offset = params.offset as number;
      const limit = params.limit as number;
      return all.slice(offset, offset + limit);
    });

    expect(result).toEqual(all);
    expect(calls.map(call => [call.offset, call.limit])).toEqual([
      [0, REMOTE_LIST_PAGE_SIZE],
      [100, REMOTE_LIST_PAGE_SIZE],
      [200, REMOTE_LIST_PAGE_SIZE],
    ]);
  });

  test('explicit limit above the remote cap is honored as an aggregate limit', async () => {
    const all = rows(230);
    const calls: Array<Record<string, unknown>> = [];
    const result = await collectThinClientListPages({ limit: 175, type: 'note' }, async (params) => {
      calls.push(params);
      const offset = params.offset as number;
      const limit = params.limit as number;
      return all.slice(offset, offset + limit);
    });

    expect(result).toEqual(all.slice(0, 175));
    expect(calls.map(call => [call.offset, call.limit])).toEqual([[0, 100], [100, 75]]);
    expect(calls.every(call => call.type === 'note')).toBe(true);
  });

  test('explicit large limit starts from the requested offset', async () => {
    const all = rows(230);
    const result = await collectThinClientListPages({ limit: 125, offset: 50 }, async (params) => {
      const offset = params.offset as number;
      const limit = params.limit as number;
      return all.slice(offset, offset + limit);
    });
    expect(result).toEqual(all.slice(50, 175));
  });

  test('explicit small limit or offset preserves a single request', async () => {
    for (const params of [{ limit: 25 }, { offset: 100 }]) {
      const calls: Array<Record<string, unknown>> = [];
      const result = await collectThinClientListPages(params, async (request) => {
        calls.push(request);
        return rows(3);
      });
      expect(result).toEqual(rows(3));
      expect(calls).toEqual([params]);
    }
  });

  test('exact full page probes once more to distinguish complete from truncated', async () => {
    const all = rows(100);
    let calls = 0;
    const result = await collectThinClientListPages({}, async (params) => {
      calls++;
      const offset = params.offset as number;
      const limit = params.limit as number;
      return all.slice(offset, offset + limit);
    });
    expect(result).toEqual(all);
    expect(calls).toBe(2);
  });

  test('streaming iterator does not fetch the next page before the current page is consumed', async () => {
    const all = rows(230);
    let calls = 0;
    const iterator = paginateThinClientListPages({}, async (params) => {
      calls++;
      const offset = params.offset as number;
      const limit = params.limit as number;
      return all.slice(offset, offset + limit);
    });

    const first = await iterator.next();
    expect(first.value).toEqual(all.slice(0, 100));
    expect(calls).toBe(1);

    const second = await iterator.next();
    expect(second.value).toEqual(all.slice(100, 200));
    expect(calls).toBe(2);
  });

  test('fails instead of looping if a server ignores offset', async () => {
    const repeated = rows(100);
    await expect(collectThinClientListPages({}, async () => repeated))
      .rejects.toThrow('repeated a page');
  });

  test('rejects malformed or over-limit page responses', async () => {
    await expect(collectThinClientListPages({}, async () => ({ pages: [] })))
      .rejects.toThrow('was not an array');
    await expect(collectThinClientListPages({}, async () => rows(101)))
      .rejects.toThrow('returned 101 rows for limit 100');
  });

  test('fails within a bounded number of pages even when every response is distinct and full', async () => {
    let call = 0;
    const iterator = paginateThinClientListPages({}, async () => {
      const page = rows(100).map(row => ({ ...row, call }));
      call++;
      return page;
    }, { maxPages: 2 });

    await expect((async () => {
      for await (const _page of iterator) { /* exhaust */ }
    })()).rejects.toThrow('2-page safety limit');
    expect(call).toBe(2);
  });

  test('atomic publisher emits nothing when a later page fails', async () => {
    const published: string[] = [];
    let call = 0;
    await expect(publishThinClientListPagesAtomically(
      {},
      async () => {
        call++;
        if (call === 1) return rows(100);
        throw new Error('page two unavailable');
      },
      page => `${page.map(item => (item as { slug: string }).slug).join('\n')}\n`,
      async chunk => { published.push(chunk); },
    )).rejects.toThrow('page two unavailable');
    expect(published).toEqual([]);
  });

  test('whole-command deadline fails before fetching or publishing', async () => {
    let fetched = false;
    const published: string[] = [];
    await expect(publishThinClientListPagesAtomically(
      {},
      async () => {
        fetched = true;
        return [];
      },
      () => 'No pages found.\n',
      async chunk => { published.push(chunk); },
      { deadlineAt: Date.now() - 1 },
    )).rejects.toThrow('whole-command pagination deadline');

    expect(fetched).toBe(false);
    expect(published).toEqual([]);
  });

  test('atomic publisher verifies a stable second pass before publishing', async () => {
    const all = rows(230);
    const published: string[] = [];
    let calls = 0;
    await publishThinClientListPagesAtomically(
      {},
      async params => {
        calls++;
        const offset = params.offset as number;
        const limit = params.limit as number;
        return all.slice(offset, offset + limit);
      },
      page => page.map(item => (item as { slug: string }).slug).join('\n') + '\n',
      async chunk => { published.push(chunk); },
    );

    expect(calls).toBe(6);
    expect(published.join('')).toBe(all.map(row => row.slug).join('\n') + '\n');
  });

  test('atomic publisher fails closed when the ordered result changes between passes', async () => {
    const all = rows(230);
    const published: string[] = [];
    let calls = 0;
    await expect(publishThinClientListPagesAtomically(
      {},
      async params => {
        const pass = Math.floor(calls / 3);
        calls++;
        const offset = params.offset as number;
        const limit = params.limit as number;
        return all.slice(offset, offset + limit).map(row => ({ ...row, pass }));
      },
      page => `${JSON.stringify(page)}\n`,
      async chunk => { published.push(chunk); },
      { stabilityAttempts: 1 },
    )).rejects.toThrow('changed while paginating');

    expect(calls).toBe(6);
    expect(published).toEqual([]);
  });
});
