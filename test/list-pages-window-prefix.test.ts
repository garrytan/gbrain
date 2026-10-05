/**
 * list_pages `updated_before` + `slug_prefix` (PGLite; the Postgres arm is
 * test/e2e/list-pages-window-prefix.test.ts over the same case table).
 *
 * Before these params existed, an MCP caller's `updated_before` / `slug_prefix`
 * came back as an unknown_param notice over the FULL listing, and the CLI
 * refused `--updated-before` / `--slug-prefix` as unknown flags, so a
 * staleness sweep or a one-path listing meant paging the whole brain and
 * filtering client-side.
 *
 * Pins: the window and prefix row sets (case table), slug_prefix validation,
 * a timestamp Postgres cannot parse reported as invalid_params (it surfaced
 * as internal_error for updated_after, sending callers to doctor), that a
 * truncated listing's `listing_truncated` continuation keeps both
 * filters (otherwise page two silently widens to the unfiltered listing),
 * full-surface-only advertising, and the MCP dispatch path.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import { dispatchToolCall, __resetBackupNoticeForTests } from '../src/mcp/dispatch.ts';
import { __resetFactsDrainNoticesForTests } from '../src/core/facts/drain.ts';
import { withEnv } from './helpers/with-env.ts';
import { LIST_PAGES_FILTER_CASES, LIST_PAGES_TIMESTAMP_ERROR_CASES, filterCtx, listError, listKeys, listPages, seedListPagesFilterCorpus } from './helpers/list-pages-filter-cases.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedListPagesFilterCorpus(engine);
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

describe('list_pages updated_before + slug_prefix row sets', () => {
  for (const c of LIST_PAGES_FILTER_CASES) {
    test(c.name, async () => {
      expect(await listKeys(engine, c.remote, c.params)).toEqual(c.expected);
    });
  }
});

describe('slug_prefix validation', () => {
  test.each([
    ['a leading slash', '/people'],
    ['a backslash', 'people\\alice'],
    ['a control character', 'people/\u0000'],
    ['a bidi override', 'people/\u202e'],
    ['the empty string', ''],
    ['more than 255 characters', `people/${'a'.repeat(250)}`],
    ['a non-string', 42],
  ])('%s is refused with invalid_params', async (_label, value) => {
    const err = await listError(engine, { slug_prefix: value });
    expect(err?.code).toBe('invalid_params');
    expect(err?.message).toContain('slug_prefix');
  });
});

describe('a timestamp Postgres cannot parse is invalid_params, not internal_error', () => {
  for (const c of LIST_PAGES_TIMESTAMP_ERROR_CASES) {
    test(JSON.stringify(c.params), async () => {
      const err = await listError(engine, c.params);
      expect(err?.code).toBe('invalid_params');
      expect(err?.message).toContain(`list_pages: ${c.param} `);
    });
  }
});

describe('listing_truncated continuation keeps the filters', () => {
  async function follow(params: Record<string, unknown>): Promise<{ keys: string[]; carried: Array<Record<string, unknown>> }> {
    const keys: string[] = [];
    const carried: Array<Record<string, unknown>> = [];
    let next: Record<string, unknown> = { ...params, limit: 1 };
    for (let guard = 0; guard < 10; guard++) {
      const notices: Array<{ code: string; fix: { mcp: { arguments: Record<string, unknown> } } }> = [];
      const rows = await listPages.handler(filterCtx(engine, true, { emitNotice: n => { notices.push(n as never); } }), next) as Array<{ source_id: string; slug: string }>;
      keys.push(...rows.map(r => `${r.source_id}:${r.slug}`));
      if (notices.length === 0) break;
      expect(notices[0].code).toBe('listing_truncated');
      next = notices[0].fix.mcp.arguments;
      carried.push(next);
    }
    return { keys: keys.sort(), carried };
  }

  for (const sort of ['updated_desc', 'updated_asc'] as const) {
    test(`${sort}: every page of a filtered listing stays filtered`, async () => {
      const { keys, carried } = await follow({ sort, slug_prefix: 'people', updated_before: '2026-03-01' });
      // Remote: the private page is hidden; bob is past the bound; peoplex is in the prefix.
      expect(keys).toEqual(['default:people/alice-example', 'default:peoplex/sibling']);
      expect(carried.length).toBe(1);
      expect(carried[0]).toMatchObject({ slug_prefix: 'people', updated_before: '2026-03-01' });
    });
  }
});

describe('MCP surface', () => {
  const advertised = (surface: 'full' | 'starter') =>
    Object.keys(filterOpsForSurface(operations, surface).find(o => o.name === 'list_pages')!.params);

  test('advertised on the full surface, kept off the size-budgeted starter list', () => {
    expect(advertised('full')).toEqual(expect.arrayContaining(['updated_before', 'slug_prefix']));
    expect(advertised('starter')).not.toContain('updated_before');
    expect(advertised('starter')).not.toContain('slug_prefix');
  });

  test('dispatch applies both filters with no unknown_param notice', async () => {
    __resetBackupNoticeForTests();
    __resetFactsDrainNoticesForTests();
    await withEnv({ GBRAIN_BACKUP_CHECK: 'off', GBRAIN_NO_ONBOARD_NUDGE: '1' }, async () => {
      const res = await dispatchToolCall(engine as never, 'list_pages',
        { slug_prefix: 'people/', updated_before: '2026-03-01' },
        { remote: true, transport: 'stdio', sourceId: 'default' });
      expect(res.isError).toBeUndefined();
      expect((JSON.parse(res.content[0].text) as Array<{ slug: string }>).map(r => r.slug)).toEqual(['people/alice-example']);
      expect(res.content.map(c => c.text).join('\n')).not.toContain('unknown_param');
    });
  });
});
