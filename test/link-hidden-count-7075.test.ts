/**
 * #7075 — get_links / get_backlinks count the former relationships a page's
 * temporal policy hides with a count(*) in SQL. Regression: the last page of
 * a listing fetched every hidden edge (context included) only to count them.
 * The count reported in `gbrain.temporal.hidden` stays the same; no hidden
 * edge row leaves the database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { ENTITY_IDENTITY_UNION_CONFIG_KEY, linkEntityIdentity } from '../src/core/entity-identity.ts';
import type { LinkReadScope } from '../src/core/link-validity.ts';
import type { Link } from '../src/core/types.ts';

const config = { engine: 'pglite' } as never;
const LOCAL = { remote: false, sourceId: 'default', config };
const REMOTE = { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config };
const COMPANIES = ['companies/c0', 'companies/c1', 'companies/c2', 'companies/c3'];

let engine: PGLiteEngine;
const reads: Array<{ opts?: LinkReadScope; rows: number }> = [];

async function put(slug: string, type = 'note') {
  await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `${slug} body`, frontmatter: {} }, { sourceId: 'default' });
}

async function ended(from: string, to: string) {
  const r = await dispatchToolCall(engine, 'add_link', { from, to, link_type: 'works_at', valid_from: '2019-01-01', valid_until: '2020-01-01' }, LOCAL as never);
  if (r.isError) throw new Error(`seed add_link failed: ${r.content[0].text}`);
}

async function call(op: string, args: Record<string, unknown>, opts: Record<string, unknown>) {
  reads.length = 0;
  const r = await dispatchToolCall(engine, op, args, opts as never);
  if (r.isError) throw new Error(r.content[0].text);
  const meta = (r as { _meta?: Record<string, unknown> })._meta ?? {};
  return { rows: JSON.parse(r.content[0].text) as Array<Record<string, unknown>>, hidden: (meta['gbrain.temporal'] as { hidden?: number } | undefined)?.hidden };
}

const hiddenReads = () => reads.filter(r => r.opts?.page?.relationship?.keep === 'hidden');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const slug of ['hubs/alpha', 'hubs/beta', 'idn/a', 'idn/b', 'targets/t0', 'targets/t1', 'targets/t2']) await put(slug);
  for (const slug of COMPANIES) await put(slug, 'company');
  // hubs/alpha: two live edges, then three ended works_at (all on the last page).
  await engine.addLink('hubs/alpha', 'targets/t0', 'one', 'k000', 'manual');
  await engine.addLink('hubs/alpha', 'targets/t1', 'two', 'k000', 'manual');
  for (const c of COMPANIES.slice(0, 3)) await ended('hubs/alpha', c);
  // hubs/beta: hidden edges between and after live edges, for a paged read.
  await engine.addLink('hubs/beta', 'targets/t0', 'one', 'k000', 'manual');
  await ended('hubs/beta', COMPANIES[0]);
  await engine.addLink('hubs/beta', 'targets/t1', 'two', 'k000', 'manual');
  await ended('hubs/beta', COMPANIES[1]);
  await engine.addLink('hubs/beta', 'targets/t2', 'three', 'k000', 'manual');
  await ended('hubs/beta', COMPANIES[2]);
  await ended('hubs/beta', COMPANIES[3]);
  // Identity union: idn/a and idn/b are one entity; each carries hidden edges
  // (two of them into companies/c0, which the backlinks case also counts).
  await ended('idn/a', COMPANIES[0]);
  await ended('idn/b', COMPANIES[0]);
  await ended('idn/a', COMPANIES[1]);
  await ended('idn/b', COMPANIES[2]);
  await engine.addLink('idn/a', 'targets/t0', 'a live', 'k000', 'manual');
  await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
  await linkEntityIdentity(engine, { entityId: 'thing/idn', slug: 'idn/a', sourceId: 'default' });
  await linkEntityIdentity(engine, { entityId: 'thing/idn', slug: 'idn/b', sourceId: 'default' });

  const getLinks = engine.getLinks.bind(engine);
  const getBacklinks = engine.getBacklinks.bind(engine);
  engine.getLinks = async (slug: string, opts?: LinkReadScope): Promise<Link[]> => {
    const rows = await getLinks(slug, opts);
    reads.push({ opts, rows: rows.length });
    return rows;
  };
  engine.getBacklinks = async (slug: string, opts?: LinkReadScope): Promise<Link[]> => {
    const rows = await getBacklinks(slug, opts);
    reads.push({ opts, rows: rows.length });
    return rows;
  };
}, 120_000);

afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

describe('#7075 hidden-relationship count', () => {
  test('the last page counts its hidden edges in SQL and reports the same count', async () => {
    for (const opts of [LOCAL, REMOTE]) {
      const { rows, hidden } = await call('get_links', { slug: 'hubs/alpha' }, opts);
      expect(rows.map(r => r.context)).toEqual(['one', 'two']);
      expect(hidden).toBe(3);
      expect(hiddenReads().length).toBeGreaterThan(0);
      for (const r of hiddenReads()) {
        expect(r.opts?.page?.count).toBe(true);
        expect(r.rows).toBe(1);
      }
    }
  });

  test('a paged listing counts each page\'s hidden edges once, in SQL', async () => {
    const first = await call('get_links', { slug: 'hubs/beta', limit: 2 }, REMOTE);
    expect(first.rows.map(r => r.context)).toEqual(['one', 'two']);
    expect(first.hidden).toBe(1);
    expect(hiddenReads().every(r => r.opts?.page?.count === true && r.rows === 1)).toBe(true);
    const second = await call('get_links', { slug: 'hubs/beta', limit: 2, cursor: first.rows[1].next_cursor }, REMOTE);
    expect(second.rows.map(r => r.context)).toEqual(['three']);
    expect(second.hidden).toBe(3);
    expect(hiddenReads().every(r => r.opts?.page?.count === true && r.rows === 1)).toBe(true);
  });

  test('get_backlinks counts the same way', async () => {
    const { rows, hidden } = await call('get_backlinks', { slug: COMPANIES[0] }, REMOTE);
    expect(rows).toEqual([]);
    expect(hidden).toBe(4);
    expect(hiddenReads().every(r => r.opts?.page?.count === true && r.rows === 1)).toBe(true);
  });

  test('identity union members\' hidden edges are counted, without fetching them', async () => {
    const { rows, hidden } = await call('get_links', { slug: 'idn/a', source_id: 'default' }, LOCAL);
    expect(rows.map(r => r.context)).toEqual(['a live']);
    expect(hidden).toBe(4);
    expect(hiddenReads().length).toBe(2);
    expect(hiddenReads().every(r => r.opts?.page?.count === true && r.rows === 1)).toBe(true);
  });

  test('status ended counts the live edges it hides without fetching them', async () => {
    const { rows, hidden } = await call('get_links', { slug: 'hubs/alpha', status: 'ended' }, REMOTE);
    expect(rows.map(r => r.to_slug)).toEqual(COMPANIES.slice(0, 3));
    expect(hidden).toBe(2);
    expect(hiddenReads().every(r => r.opts?.page?.count === true && r.rows === 1)).toBe(true);
  });

  test('status all hides nothing and runs no count', async () => {
    const { rows, hidden } = await call('get_links', { slug: 'hubs/alpha', status: 'all' }, LOCAL);
    expect(rows.length).toBe(5);
    expect(hidden).toBe(0);
    expect(hiddenReads()).toEqual([]);
  });
});
