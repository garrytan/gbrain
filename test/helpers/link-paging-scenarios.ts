/**
 * #6876 — get_links / get_backlinks row paging scenarios, shared by the PGLite
 * unit test (test/link-read-paging.test.ts) and its Postgres twin
 * (test/e2e/link-read-paging-postgres.test.ts): the keyset SQL (link_type,
 * keyset bounds and the temporal policy before LIMIT, bounded context) must
 * behave the same on both engines.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { LinkBatchInput } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { ENTITY_IDENTITY_UNION_CONFIG_KEY, linkEntityIdentity } from '../../src/core/entity-identity.ts';
import { LINK_READ_CONTEXT_MAX_CHARS, LINK_READ_DEFAULT_LIMIT } from '../../src/core/engine-constants.ts';

type Row = Record<string, unknown>;
const config = { engine: 'pglite' } as never;
const LOCAL = { remote: false, sourceId: 'default', config };
const REMOTE = { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config };
const FEDERATED = { ...LOCAL, localFederatedSourceIds: ['default', 'second'] };
const GRANTED = { ...REMOTE, auth: { allowedSources: ['default', 'second'] } };
const TARGETS = Array.from({ length: 12 }, (_, i) => `targets/t${String(i).padStart(2, '0')}`);

/** N edges from `from` spread over the 12 targets (distinct link types keep each row unique). */
function fan(from: string, n: number, opts: { reverse?: boolean; prefix?: string } = {}): LinkBatchInput[] {
  return Array.from({ length: n }, (_, i) => {
    const other = TARGETS[i % TARGETS.length];
    const link_type = `${opts.prefix ?? 'k'}${String(Math.floor(i / TARGETS.length)).padStart(3, '0')}`;
    return { from_slug: opts.reverse ? other : from, to_slug: opts.reverse ? from : other, link_type, context: `edge ${i}`, link_source: 'manual',
      from_source_id: 'default', to_source_id: 'default' };
  });
}

async function put(engine: BrainEngine, slug: string, sourceId = 'default', type = 'note') {
  await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `${slug} body`, frontmatter: {} }, { sourceId });
}

export async function seedLinkPagingFixture(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('second', 'second', '/tmp/gbrain-6876-second', '{"federated": true}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`);
  await engine.executeRaw(`UPDATE sources SET config = '{"federated": true}'::jsonb WHERE id = 'default'`);
  for (const slug of [...TARGETS, 'hubs/at-cap', 'hubs/over-cap', 'hubs/many', 'hubs/typed', 'hubs/wide', 'hubs/backlinked',
    'hubs/temporal', 'people/alice-example', 'companies/acme-example', 'fed/hub', 'idn/a', 'idn/b', 'hubs/people']) await put(engine, slug);
  await put(engine, 'people/bob-example', 'default', 'person');
  for (const slug of ['fed/hub', ...TARGETS]) await put(engine, slug, 'second');
  await engine.addLinksBatch([
    ...fan('hubs/at-cap', LINK_READ_DEFAULT_LIMIT),
    ...fan('hubs/over-cap', LINK_READ_DEFAULT_LIMIT + 1),
    ...fan('hubs/many', 1203),
    ...fan('hubs/typed', 700),
    ...fan('hubs/backlinked', LINK_READ_DEFAULT_LIMIT + 1, { reverse: true }),
    ...fan('hubs/people', LINK_READ_DEFAULT_LIMIT + 1, { reverse: true }),
  ]);
  // One person backlink after 501 note backlinks: get_backlinks' type filter runs before the cap.
  await engine.addLink('people/bob-example', 'hubs/people', 'bob', 'k000', 'manual');
  // Three 'cites' edges after 700 others: the link_type filter runs before the cap.
  await engine.addLinksBatch(TARGETS.slice(0, 3).map(t => ({ from_slug: 'hubs/typed', to_slug: t, link_type: 'cites', link_source: 'manual', from_source_id: 'default', to_source_id: 'default' })));
  await engine.addLink('hubs/wide', TARGETS[0], 'w'.repeat(10_000), 'k000', 'manual');
  // Federation: the same slug in two federated sources, 4 edges each.
  await engine.addLinksBatch([
    ...TARGETS.slice(0, 4).map(t => ({ from_slug: 'fed/hub', to_slug: t, link_type: 'f', link_source: 'manual', from_source_id: 'default', to_source_id: 'default' })),
    ...TARGETS.slice(4, 8).map(t => ({ from_slug: 'fed/hub', to_slug: t, link_type: 'f', link_source: 'manual', from_source_id: 'second', to_source_id: 'second' })),
  ]);
  // Identity: idn/a and idn/b are one entity (a scalar read unions same-source members), 5 edges each.
  await engine.addLinksBatch([
    ...TARGETS.slice(0, 5).map(t => ({ from_slug: 'idn/a', to_slug: t, link_type: 'i', link_source: 'manual', from_source_id: 'default', to_source_id: 'default' })),
    ...TARGETS.slice(5, 10).map(t => ({ from_slug: 'idn/b', to_slug: t, link_type: 'i', link_source: 'manual', from_source_id: 'default', to_source_id: 'default' })),
  ]);
  // Identity across sources: default:idx/hub and second:idx/alias are one
  // entity; default:idx/alias is a same-slug non-member. links.id order:
  // 3 non-member edges, the hub's first edge, 3 more non-member edges, the
  // hub's last two, the member's edge.
  await put(engine, 'idx/hub');
  await put(engine, 'idx/alias');
  await put(engine, 'idx/alias', 'second');
  const edge = (from: string, sourceId: string, to: string) => ({ from_slug: from, to_slug: to, link_type: 'x', link_source: 'manual', from_source_id: sourceId, to_source_id: sourceId });
  await engine.addLinksBatch(TARGETS.slice(1, 4).map(t => edge('idx/alias', 'default', t)));
  await engine.addLinksBatch([edge('idx/hub', 'default', TARGETS[0])]);
  await engine.addLinksBatch(TARGETS.slice(7, 10).map(t => edge('idx/alias', 'default', t)));
  await engine.addLinksBatch(TARGETS.slice(4, 6).map(t => edge('idx/hub', 'default', t)));
  await engine.addLinksBatch([edge('idx/alias', 'second', TARGETS[6])]);
  await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
  await linkEntityIdentity(engine, { entityId: 'thing/idx', slug: 'idx/hub', sourceId: 'default' });
  await linkEntityIdentity(engine, { entityId: 'thing/idx', slug: 'idx/alias', sourceId: 'second' });
  await linkEntityIdentity(engine, { entityId: 'thing/idn', slug: 'idn/a', sourceId: 'default' });
  await linkEntityIdentity(engine, { entityId: 'thing/idn', slug: 'idn/b', sourceId: 'default' });
  // Temporal: a live reference edge, then an ENDED works_at (hidden by the
  // default live read), then two more live edges, in links.id order.
  await engine.addLink('hubs/temporal', TARGETS[0], 'one', 'k000', 'manual');
  await engine.addLink('people/alice-example', 'companies/acme-example', 'cto', 'k000', 'manual');
  const ended = await dispatchToolCall(engine, 'add_link', { from: 'hubs/temporal', to: 'companies/acme-example', link_type: 'works_at', valid_from: '2019-01-01', valid_until: '2020-01-01' }, LOCAL as never);
  if (ended.isError) throw new Error(`seed add_link failed: ${ended.content[0].text}`);
  await engine.addLink('hubs/temporal', TARGETS[1], 'two', 'k000', 'manual');
  await engine.addLink('hubs/temporal', TARGETS[2], 'three', 'k000', 'manual');
}

async function call(engine: BrainEngine, op: string, args: Record<string, unknown>, opts: Record<string, unknown> = LOCAL) {
  const r = await dispatchToolCall(engine, op, args, opts as never);
  return { isError: r.isError === true, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) as Row[], notices: r.content.slice(1).map(c => c.text),
    pagination: (r as { _meta?: { pagination?: Row } })._meta?.pagination };
}

const key = (r: Row) => `${r.from_source_id}:${r.from_slug}->${r.to_source_id}:${r.to_slug}:${r.link_type}:${r.origin_slug ?? ''}`;

/** Every page of a listing, following next_cursor from the last row. */
async function pages(engine: BrainEngine, op: string, args: Record<string, unknown>, opts?: Record<string, unknown>): Promise<Row[][]> {
  const out: Row[][] = [];
  let cursor: unknown;
  for (let i = 0; i < 50; i++) {
    const { json, text, isError } = await call(engine, op, { ...args, ...(cursor ? { cursor } : {}) }, opts);
    if (isError) throw new Error(text);
    out.push(json!);
    const last = json![json!.length - 1];
    cursor = last?.next_cursor;
    if (!cursor) return out;
    expect(last.truncated).toBe(true);
  }
  throw new Error('listing did not end');
}

export function registerLinkPagingTests(getEngine: () => BrainEngine): void {
  describe('#6876 get_links / get_backlinks paging', () => {
    test('exactly at the cap: every row, no truncation marker', async () => {
      const { json } = await call(getEngine(), 'get_links', { slug: 'hubs/at-cap' });
      expect(json!.length).toBe(LINK_READ_DEFAULT_LIMIT);
      expect(json!.some(r => 'truncated' in r || 'next_cursor' in r || 'link_id' in r)).toBe(false);
    });

    test('one over the cap: the cap, a marked last row, and one row on the next page', async () => {
      const [first, second, ...rest] = await pages(getEngine(), 'get_links', { slug: 'hubs/over-cap' });
      expect(first.length).toBe(LINK_READ_DEFAULT_LIMIT);
      expect(first.slice(0, -1).some(r => 'truncated' in r)).toBe(false);
      expect(second.length).toBe(1);
      expect(rest).toEqual([]);
      expect(new Set([...first, ...second].map(key)).size).toBe(LINK_READ_DEFAULT_LIMIT + 1);
    });

    test('a 1203-edge traversal pages 500/500/203 and returns the complete set once', async () => {
      const all = await pages(getEngine(), 'get_links', { slug: 'hubs/many' });
      expect(all.map(p => p.length)).toEqual([500, 500, 203]);
      const engineRows = await getEngine().getLinks('hubs/many', { sourceId: 'default' });
      expect(engineRows.length).toBe(1203);
      expect(all.flat().map(key).sort()).toEqual(engineRows.map(r => key(r as unknown as Row)).sort());
    });

    test('get_backlinks pages the same way', async () => {
      const all = await pages(getEngine(), 'get_backlinks', { slug: 'hubs/backlinked' });
      expect(all.map(p => p.length)).toEqual([500, 1]);
      expect(new Set(all.flat().map(key)).size).toBe(501);
    });

    test('an explicit limit pages, and --all (local) returns every row without a marker', async () => {
      const small = await pages(getEngine(), 'get_links', { slug: 'hubs/many', limit: 400 });
      expect(small.map(p => p.length)).toEqual([400, 400, 400, 3]);
      const { json } = await call(getEngine(), 'get_links', { slug: 'hubs/many', all: true, limit: 250 });
      expect(json!.length).toBe(1203);
      expect(json!.some(r => 'truncated' in r)).toBe(false);
      const remote = await call(getEngine(), 'get_links', { slug: 'hubs/many', all: true }, REMOTE);
      expect(remote.isError).toBe(true);
    });

    test('link_type filters in SQL before the cap', async () => {
      const { json } = await call(getEngine(), 'get_links', { slug: 'hubs/typed', link_type: 'cites' });
      expect(json!.map(r => r.to_slug).sort()).toEqual(TARGETS.slice(0, 3));
      expect(json!.some(r => 'truncated' in r)).toBe(false);
      const paged = await pages(getEngine(), 'get_links', { slug: 'hubs/typed', link_type: 'cites', limit: 2 });
      expect(paged.map(p => p.length)).toEqual([2, 1]);
      expect(paged.flat().map(r => r.to_slug).sort()).toEqual(TARGETS.slice(0, 3));
    });

    test('get_backlinks type filters in SQL before the cap: a hub\'s one person backlink is on the first page', async () => {
      for (const opts of [LOCAL, REMOTE]) {
        const first = await call(getEngine(), 'get_backlinks', { slug: 'hubs/people', type: 'person' }, opts);
        expect(first.json!.map(r => r.from_slug)).toEqual(['people/bob-example']);
        expect(first.json!.some(r => 'truncated' in r)).toBe(false);
        expect(first.pagination).toEqual({ limit: LINK_READ_DEFAULT_LIMIT, returned: 1, truncated: false });
      }
      const notes = await pages(getEngine(), 'get_backlinks', { slug: 'hubs/people', type: 'note', limit: 200 });
      expect(notes.map(p => p.length)).toEqual([200, 200, 101]);
      expect(new Set(notes.flat().map(key)).size).toBe(LINK_READ_DEFAULT_LIMIT + 1);
      expect(notes.flat().some(r => r.from_slug === 'people/bob-example')).toBe(false);
      const cut = await call(getEngine(), 'get_backlinks', { slug: 'hubs/people', type: 'note', limit: 200 });
      expect(cut.pagination).toEqual(expect.objectContaining({ returned: 200, truncated: true }));
    });

    test('a wide context is bounded in the op; the engine read stays complete', async () => {
      const { json } = await call(getEngine(), 'get_links', { slug: 'hubs/wide' });
      const context = String(json![0].context);
      expect(context.length).toBe(LINK_READ_CONTEXT_MAX_CHARS);
      expect(context.endsWith('…')).toBe(true);
      expect((await getEngine().getLinks('hubs/wide', { sourceId: 'default' }))[0].context.length).toBe(10_000);
    });

    test('a hidden former relationship never takes a slot at the page boundary and is counted', async () => {
      const first = await call(getEngine(), 'get_links', { slug: 'hubs/temporal', limit: 2 }, REMOTE);
      expect(first.json!.map(r => r.context)).toEqual(['one', 'two']);
      expect(first.json![1].truncated).toBe(true);
      expect(first.notices.join('\n')).toContain('former_relationships_hidden');
      expect(first.notices.join('\n')).toContain('listing_truncated');
      const second = await call(getEngine(), 'get_links', { slug: 'hubs/temporal', limit: 2, cursor: first.json![1].next_cursor }, REMOTE);
      expect(second.json!.map(r => r.context)).toEqual(['three']);
      expect(second.notices.join('\n')).not.toContain('former_relationships_hidden');
      const history = await call(getEngine(), 'get_links', { slug: 'hubs/temporal', status: 'all' });
      expect(history.json!.length).toBe(4);
    });

    test('a local federated read merges the sources by link id and pages without gaps', async () => {
      const all = await pages(getEngine(), 'get_links', { slug: 'fed/hub', limit: 3 }, FEDERATED);
      expect(all.map(p => p.length)).toEqual([3, 3, 2]);
      const rows = all.flat();
      expect(new Set(rows.map(key)).size).toBe(8);
      expect(rows.filter(r => r.from_source_id === 'second').length).toBe(4);
    });

    test('identity union rows join the merged stream; the cap applies after the union', async () => {
      const all = await pages(getEngine(), 'get_links', { slug: 'idn/a', source_id: 'default', limit: 3 });
      expect(all.map(p => p.length)).toEqual([3, 3, 3, 1]);
      const rows = all.flat();
      expect(new Set(rows.map(key)).size).toBe(10);
      expect(rows.filter(r => r.from_slug === 'idn/b').length).toBe(5);
    });

    test('a page the identity union filters empty never ends the listing', async () => {
      const first = await call(getEngine(), 'get_links', { slug: 'idx/hub', all_sources: true, limit: 2 }, GRANTED);
      expect(first.json!.length).toBeGreaterThan(0);
      expect(first.json![0]).toEqual(expect.objectContaining({ from_slug: 'idx/hub', to_slug: TARGETS[0] }));
    });

    test('an identity member read pins its source in SQL: a same-slug non-member never shortens a page', async () => {
      const first = await call(getEngine(), 'get_links', { slug: 'idx/hub', all_sources: true, limit: 2 }, GRANTED);
      expect(first.json!.map(r => r.to_slug)).toEqual([TARGETS[0], TARGETS[4]]);
      expect(first.pagination).toEqual(expect.objectContaining({ returned: first.json!.length, truncated: true }));
      const all = (await pages(getEngine(), 'get_links', { slug: 'idx/hub', all_sources: true, limit: 2 }, GRANTED)).flat();
      expect(all.map(r => `${r.from_source_id}:${r.from_slug}->${r.to_slug}`)).toEqual([
        `default:idx/hub->${TARGETS[0]}`, `default:idx/hub->${TARGETS[4]}`, `default:idx/hub->${TARGETS[5]}`, `second:idx/alias->${TARGETS[6]}`]);
    });

    test('a legacy call without limit keeps its plain array', async () => {
      const { json } = await call(getEngine(), 'get_links', { slug: 'people/alice-example' });
      expect(json).toEqual([expect.objectContaining({ from_slug: 'people/alice-example', to_slug: 'companies/acme-example', context: 'cto' })]);
      expect(Object.keys(json![0])).not.toContain('link_id');
      expect(Object.keys(json![0])).not.toContain('truncated');
    });

    test('a foreign or malformed cursor is link_cursor_invalid with a restart fix', async () => {
      const first = await call(getEngine(), 'get_links', { slug: 'hubs/over-cap' }, REMOTE);
      const cursor = first.json![first.json!.length - 1].next_cursor as string;
      for (const args of [
        { slug: 'hubs/over-cap', cursor: 'not-a-cursor' },
        { slug: 'hubs/at-cap', cursor },
        { slug: 'hubs/over-cap', cursor, link_type: 'k000' },
      ]) {
        const r = await call(getEngine(), 'get_links', args, REMOTE);
        expect(r.isError).toBe(true);
        expect(r.text).toContain('link_cursor_invalid');
        expect(r.text).toContain('invalid_params');
      }
      const backlinks = await call(getEngine(), 'get_backlinks', { slug: 'hubs/over-cap', cursor }, REMOTE);
      expect(backlinks.text).toContain('link_cursor_invalid');
    });
  });
}
