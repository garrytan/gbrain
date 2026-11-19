/**
 * GBRA-650: `gbrain get a b c` on the CLI.
 *
 * 1. Protects: several positional slugs become `slugs` (one slug stays `slug`); a batch prints pages in request order on
 *    stdout, misses and omitted slugs on stderr, and exits 1 when any slug was not read; the thin client follows every
 *    `omitted.next` and, against a host older than `slugs`, reads each page on its own with misses kept as entries.
 * 2. Fails when: extra positionals are dropped, a miss exits 0 or prints to stdout, a skewed host fails the command,
 *    or an omitted slug is never read.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { parseOpArgs } from '../src/cli/main.ts';
import { operationsByName } from '../src/core/operations.ts';
import { formatGetPageBatch, readBatchRemote } from '../src/cli/page-render.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { RemoteMcpError } from '../src/core/remote-mcp-error.ts';

beforeEach(() => { _resetCliExitVerdictForTests(); });
afterEach(() => { _resetCliExitVerdictForTests(); process.exitCode = 0; });

describe('gbrain get with several slugs', () => {
  test('one slug stays slug; several become slugs, flags kept', () => {
    expect(parseOpArgs(operationsByName.get_page!, ['people/alice-example'])).toEqual({ slug: 'people/alice-example' });
    expect(parseOpArgs(operationsByName.get_page!, ['people/alice-example', 'companies/acme-example', '--include-deleted', 'notes/x']))
      .toEqual({ slugs: ['people/alice-example', 'companies/acme-example', 'notes/x'], include_deleted: true });
  });

  test('pages go to stdout in order, misses and omitted slugs to stderr, and the exit is 1', () => {
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = formatGetPageBatch({
        pages: [
          { requested_slug: 'a', page: { slug: 'a', title: 'A', type: 'note', compiled_truth: 'Alpha body.', timeline: '' } },
          { requested_slug: 'b', error: 'page_not_found', message: 'Page not found: b' },
          { requested_slug: 'c', page: { slug: 'c', title: 'C', type: 'note', compiled_truth: 'Gamma body.', timeline: '' } },
        ],
        omitted: { slugs: ['d'], reason: 'token_budget' },
      });
      expect(out.indexOf('Alpha body.')).toBeLessThan(out.indexOf('Gamma body.'));
      expect(out).not.toContain('Page not found');
      const written = err.mock.calls.map(c => String(c[0])).join('');
      expect(written).toContain('b: Page not found: b');
      expect(written).toContain('Not read (token_budget): d');
      expect(currentExitCode()).toBe(1);
    } finally { err.mockRestore(); }
  });

  test('a batch where every page was read exits 0', () => {
    formatGetPageBatch({ pages: [{ requested_slug: 'a', page: { slug: 'a', title: 'A', type: 'note', compiled_truth: 'x', timeline: '' } }] });
    expect(currentExitCode()).toBe(0);
  });

  test('the thin client follows omitted.next until every slug is read', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const out = await readBatchRemote(async p => {
      calls.push(p);
      const slugs = p.slugs as string[];
      return { pages: [{ requested_slug: slugs[0], page: { slug: slugs[0] } }], ...(slugs.length > 1 ? { omitted: { slugs: slugs.slice(1), reason: 'token_budget', next: { tool: 'get_page', args: { slugs: slugs.slice(1) } } } } : {}) };
    }, { slugs: ['a', 'b', 'c'] });
    expect(out.pages.map((e: { requested_slug: string }) => e.requested_slug)).toEqual(['a', 'b', 'c']);
    expect(out.omitted).toBeUndefined();
    expect(calls.length).toBe(3);
  });

  test('against a host older than slugs, each page is read on its own and a miss stays an entry', async () => {
    const out = await readBatchRemote(async p => {
      if (p.slugs) throw new RemoteMcpError('tool_error', 'Remote tool get_page failed', { code: 'invalid_params', message: 'Missing required parameter: slug' } as never);
      if (p.slug === 'b') throw new RemoteMcpError('tool_error', 'Remote tool get_page failed', { code: 'page_not_found', message: 'Page not found: b' } as never);
      expect(p.token_budget).toBeUndefined();
      return { slug: p.slug, include_deleted: p.include_deleted };
    }, { slugs: ['a', 'b'], include_deleted: true, token_budget: 500 });
    expect(out).toEqual({ pages: [{ requested_slug: 'a', page: { slug: 'a', include_deleted: true } }, { requested_slug: 'b', error: 'page_not_found', message: 'Page not found: b' }] });
  });

  test('a new host refusing the batch itself is not mistaken for an old host', async () => {
    const refusal = new RemoteMcpError('tool_error', 'Remote tool get_page failed', { code: 'invalid_params', message: 'slugs takes at most 50 pages per call (got 51)' } as never);
    await expect(readBatchRemote(async () => { throw refusal; }, { slugs: ['a'] })).rejects.toBe(refusal);
  });
});
