/**
 * list_pages `updated_before` + `slug_prefix` case table, shared by the PGLite
 * unit test (test/list-pages-window-prefix.test.ts) and the Postgres E2E
 * (test/e2e/list-pages-window-prefix.test.ts) so both engines answer the same
 * calls with the same rows.
 *
 * The corpus pins the edges: a sibling path (`peoplex/`) a slash-less prefix
 * reaches, an underscore slug next to a slug the unescaped `_` wildcard would
 * also match, a private page, a second (non-federated) source, and two rows
 * one microsecond apart so a cursor truncated to milliseconds (a bare
 * `::timestamptz` bind on postgres.js) gives a different answer.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';

export const listPages = operations.find(o => o.name === 'list_pages')!;

const CORPUS: Array<{ source: string; slug: string; type: string; at: string; private?: true }> = [
  { source: 'default', slug: 'people/alice-example', type: 'person', at: '2026-01-10T09:00:00Z' },
  { source: 'default', slug: 'people/bob-example', type: 'person', at: '2026-03-15T09:00:00Z' },
  { source: 'default', slug: 'people/dana-example', type: 'person', at: '2026-02-10T09:00:00Z', private: true },
  { source: 'default', slug: 'peoplex/sibling', type: 'note', at: '2026-02-12T09:00:00Z' },
  { source: 'default', slug: 'projects/widget-co', type: 'project', at: '2026-02-01T09:00:00Z' },
  { source: 'default', slug: 'notes/a_b', type: 'note', at: '2026-02-20T09:00:00.000001Z' },
  { source: 'default', slug: 'notes/axb', type: 'note', at: '2026-02-20T09:00:00Z' },
  { source: 'team', slug: 'people/erin-example', type: 'person', at: '2026-02-05T09:00:00Z' },
  { source: 'team', slug: 'projects/gadget-co', type: 'project', at: '2026-02-06T09:00:00Z' },
];

export async function seedListPagesFilterCorpus(engine: BrainEngine): Promise<void> {
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('team', 'team') ON CONFLICT (id) DO NOTHING");
  for (const page of CORPUS) {
    await engine.putPage(page.slug, {
      type: page.type as never,
      title: page.slug,
      compiled_truth: `Synthetic page ${page.slug}.`,
      timeline: '',
      frontmatter: page.private ? { visibility: 'private' } : {},
    }, { sourceId: page.source });
    await engine.executeRaw('UPDATE pages SET updated_at = $1::text::timestamptz WHERE source_id = $2 AND slug = $3', [page.at, page.source, page.slug]);
  }
}

export function filterCtx(engine: BrainEngine, remote: boolean, overrides: Partial<OperationContext> = {}): OperationContext {
  return { engine, config: {} as never, logger: console as never, dryRun: false, remote, sourceId: 'default', ...overrides };
}

/** `source:slug` of every row, sorted, so a case states the exact row set. */
export async function listKeys(engine: BrainEngine, remote: boolean, params: Record<string, unknown>): Promise<string[]> {
  const rows = await listPages.handler(filterCtx(engine, remote), { limit: 100, ...params }) as Array<{ source_id: string; slug: string }>;
  return rows.map(r => `${r.source_id}:${r.slug}`).sort();
}

export const LIST_PAGES_FILTER_CASES: Array<{ name: string; remote: boolean; params: Record<string, unknown>; expected: string[] }> = [
  {
    name: 'updated_before is a strict upper bound',
    remote: false,
    params: { updated_before: '2026-02-10T09:00:00Z' },
    expected: ['default:people/alice-example', 'default:projects/widget-co'],
  },
  {
    name: 'updated_after + updated_before is an open window, exact to the microsecond',
    remote: false,
    params: { updated_after: '2026-02-01T09:00:00Z', updated_before: '2026-02-20T09:00:00.000001Z' },
    expected: ['default:notes/axb', 'default:people/dana-example', 'default:peoplex/sibling'],
  },
  {
    name: 'slug_prefix with a trailing slash lists one path, not its siblings',
    remote: false,
    params: { slug_prefix: 'people/' },
    expected: ['default:people/alice-example', 'default:people/bob-example', 'default:people/dana-example'],
  },
  {
    name: 'slug_prefix is a plain string prefix: without the slash it reaches the sibling path',
    remote: false,
    params: { slug_prefix: 'people' },
    expected: ['default:people/alice-example', 'default:people/bob-example', 'default:people/dana-example', 'default:peoplex/sibling'],
  },
  {
    name: 'LIKE metacharacters in slug_prefix match themselves',
    remote: false,
    params: { slug_prefix: 'notes/a_' },
    expected: ['default:notes/a_b'],
  },
  {
    name: 'slug_prefix matches the canonical lowercase slug',
    remote: false,
    params: { slug_prefix: 'People/' },
    expected: ['default:people/alice-example', 'default:people/bob-example', 'default:people/dana-example'],
  },
  {
    name: 'slug_prefix composes with an explicit source_id',
    remote: false,
    params: { slug_prefix: 'people/', source_id: 'team' },
    expected: ['team:people/erin-example'],
  },
  {
    name: "slug_prefix composes with source_id '__all__'",
    remote: false,
    params: { slug_prefix: 'people/', source_id: '__all__' },
    expected: ['default:people/alice-example', 'default:people/bob-example', 'default:people/dana-example', 'team:people/erin-example'],
  },
  {
    name: 'a remote caller still never sees private pages or another source under a prefix',
    remote: true,
    params: { slug_prefix: 'people/' },
    expected: ['default:people/alice-example', 'default:people/bob-example'],
  },
  {
    name: 'slug_prefix, updated_before and type compose',
    remote: false,
    params: { slug_prefix: 'people/', updated_before: '2026-03-01', type: 'person' },
    expected: ['default:people/alice-example', 'default:people/dana-example'],
  },
  {
    name: 'updated_before bounds a keyset page',
    remote: false,
    params: { updated_after: '2026-02-12T09:00:00Z', updated_after_slug: 'peoplex/sibling', updated_before: '2026-02-20T09:00:00.000001Z' },
    expected: ['default:notes/axb'],
  },
];

/** Timestamps Postgres cannot parse (22007 syntax, 22008 out of range): invalid_params naming the param. */
export const LIST_PAGES_TIMESTAMP_ERROR_CASES: Array<{ params: Record<string, unknown>; param: string }> = [
  { params: { updated_before: 'yesterday-ish' }, param: 'updated_before' },
  { params: { updated_after: 'not-a-date', updated_after_slug: 'notes/a_b' }, param: 'updated_after' },
  { params: { updated_after: '2026-01-01', updated_before: '2026-13-45' }, param: 'updated_before' },
];

export async function listError(engine: BrainEngine, params: Record<string, unknown>): Promise<{ code?: string; message?: string } | null> {
  return listPages.handler(filterCtx(engine, true), params).then(() => null, (e: { code?: string; message?: string }) => e);
}
