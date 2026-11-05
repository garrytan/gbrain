import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const op = operations.find(o => o.name === 'list_pages')!;
const context = (): OperationContext => ({engine, config: {} as any, logger: console, dryRun: false,
  remote: true, sourceId: 'default', auth: {token: 'test', clientId: 'test', scopes: ['read'], allowedSources: ['default']}});
async function call(params: Record<string, unknown>) {
  const meta: Record<string, any> = {};
  const ctx = {...context(), emitResponseMeta: (k: string, v: unknown) => {meta[k] = v;}};
  return {data: await op.handler(ctx, {source_id: 'default', ...params}), meta};
}
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Thousands of made-up records, without paying for thousands of write-path transactions.
  await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth)
    SELECT 'default', 'people/person-' || lpad(n::text, 5, '0'), 'person', 'Person ' || n, ''
    FROM generate_series(1, 3205) n`);
  for (const slug of ['shuttles/alpha', 'shuttles/nested/beta', 'shuttles-extra/no', 'a_b/literal', 'axb/no', 'README']) {
    await engine.putPage(slug, {type: 'note', title: slug, compiled_truth: ''}, {sourceId: 'default'});
  }
  await engine.putPage('hidden/private', {type: 'note', title: 'private', compiled_truth: '', frontmatter: {visibility: 'private'}}, {sourceId: 'default'});
  await engine.putPage('deleted/gone', {type: 'note', title: 'gone', compiled_truth: ''}, {sourceId: 'default'});
  await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'deleted/gone'");
}, 60_000);
afterAll(async () => {await engine.disconnect();});

test('folder summaries count in SQL without downloading the section; private/deleted stay hidden', async () => {
  const {data, meta} = await call({group_by: 'folder', limit: 100});
  expect(data).toEqual({folders: [{name: '', count: 1}, {name: 'a_b', count: 1}, {name: 'axb', count: 1},
    {name: 'people', count: 3205}, {name: 'shuttles', count: 2}, {name: 'shuttles-extra', count: 1}]});
  expect(meta.pagination.truncated).toBe(false);
});
test('folder pagination is bounded and reports more folders', async () => {
  const first = await call({group_by: 'folder', limit: 2});
  expect((first.data as any).folders).toHaveLength(2);
  expect(first.meta.pagination.truncated).toBe(true);
  const second = await call({group_by: 'folder', limit: 2, offset: 2});
  expect((second.data as any).folders.map((r: any) => r.name)).toEqual(['axb', 'people']);
});
test('folder pages filter before paging, including nested slugs and literal metacharacters', async () => {
  const first = await call({folder: 'shuttles', limit: 1, sort: 'slug'});
  expect((first.data as any[]).map(r => r.slug)).toEqual(['shuttles/alpha']);
  expect(first.meta.pagination.truncated).toBe(true);
  const second = await call({folder: 'shuttles', limit: 1, offset: 1, sort: 'slug'});
  expect((second.data as any[]).map(r => r.slug)).toEqual(['shuttles/nested/beta']);
  expect(second.meta.pagination.truncated).toBe(false);
  expect(((await call({folder: 'a_b'})).data as any[]).map(r => r.slug)).toEqual(['a_b/literal']);
  expect(((await call({folder: ''})).data as any[]).map(r => r.slug)).toEqual(['readme']);
});
test('summary and folder reads refuse another source', async () => {
  for (const params of [{group_by: 'folder'}, {folder: 'people'}]) {
    await expect(op.handler(context(), {...params, source_id: 'someone-else'})).rejects.toMatchObject({code: 'permission_denied'});
  }
});
test('invalid folder/group requests fail rather than silently widening', async () => {
  for (const params of [{folder: 3}, {folder: 'a/b'}, {group_by: 'type'}]) {
    await expect(call(params)).rejects.toThrow();
  }
});

test('continuation notices preserve folder filters and summary mode', async () => {
  for (const params of [{folder: 'people'}, {group_by: 'folder'}]) {
    const notices: any[] = [];
    await op.handler({...context(), emitNotice: n => { notices.push(n); }}, {...params, limit: 1});
    const next = notices.find(n => n.code === 'listing_truncated')?.fix?.mcp?.arguments;
    expect(next).toMatchObject({...params, limit: 1, offset: 1});
  }
});
