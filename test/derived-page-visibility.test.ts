/**
 * #5525 read-side containment: extracted atoms and synthesized concepts with
 * no `visibility` field fail closed for remote readers. An explicit value wins,
 * ordinary pages keep "absent means world", and trusted local readers see all.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { operationsByName } from '../src/core/operations.ts';
import { isPrivatePage, __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { authorizePageVisibility } from '../src/core/persistence/page-visibility.ts';
import type { WriteAuthority } from '../src/core/persistence/model.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const pages = [
  ['atoms/transcript-origin', 'atom', 'quokka transcript atom body', { source_path: '/sessions/example.jsonl' }],
  ['atoms/private-origin', 'atom', 'quokka private page atom body', { source_slug: 'notes/private-origin' }],
  ['atoms/world-origin', 'atom', 'quokka world atom body', { source_slug: 'notes/world-origin', visibility: 'world' }],
  ['concepts/unstamped', 'concept', 'quokka synthesized concept body', { synthesized_by: 'synthesize_concepts-v0.41' }],
  ['concepts/stamped-world', 'concept', 'quokka stamped concept body', { synthesized_by: 'synthesize_concepts-v0.41', visibility: 'world' }],
  ['notes/ordinary-concept', 'concept', 'quokka ordinary concept body', {}],
  ['notes/ordinary-note', 'note', 'quokka ordinary note body', {}],
  ['notes/legacy-private', 'note', 'quokka legacy private body', { sensitivity: 'private' }],
  ['notes/legacy-conflict', 'note', 'quokka legacy conflict body', { sensitivity: 'private', visibility: 'world' }],
  ['notes/legacy-public', 'note', 'quokka legacy public body', { sensitivity: 'public' }],
] as const;
const hidden = ['atoms/transcript-origin', 'atoms/private-origin', 'concepts/unstamped', 'notes/legacy-private', 'notes/legacy-conflict'];
const visible = ['atoms/world-origin', 'concepts/stamped-world', 'notes/ordinary-concept', 'notes/ordinary-note', 'notes/legacy-public'];

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    for (const [slug, type, body, frontmatter] of pages) {
      const result = await importFromContent(engine, slug, serializeMarkdown(frontmatter, body, '', { type, title: slug, tags: [] }),
        { noEmbed: true, forceRechunk: true });
      expect(result.status).toBe('imported');
    }
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

const ctx = (engine: BrainEngine, remote: boolean) => ({ engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} },
  dryRun: false, remote, sourceId: 'default' }) as never;

describe('#5525 derived pages without visibility are private to remote readers', () => {
  test('row-side rule matches the SQL rule', () => {
    for (const [, type, , frontmatter] of pages) {
      const slug = pages.find(p => p[3] === frontmatter)![0];
      expect(isPrivatePage({ type, frontmatter })).toBe(hidden.includes(slug));
    }
    expect(isPrivatePage({ type: 'note', frontmatter: { visibility: 'private' } })).toBe(true);
  });

  test('remote list_pages omits unstamped atoms and concepts; local lists them', async () => {
    for (const engine of engines) {
      __resetPrivateVisibilityCacheForTests();
      const remote = ((await operationsByName.list_pages.handler(ctx(engine, true), { limit: 100 })) as Array<{ slug: string }>).map(r => r.slug);
      for (const slug of hidden) expect(remote).not.toContain(slug);
      for (const slug of visible) expect(remote).toContain(slug);
      const local = ((await operationsByName.list_pages.handler(ctx(engine, false), { limit: 100 })) as Array<{ slug: string }>).map(r => r.slug);
      for (const slug of [...hidden, ...visible]) expect(local).toContain(slug);
    }
  });

  test('remote get_page refuses unstamped atoms and concepts; local reads them', async () => {
    for (const engine of engines) {
      __resetPrivateVisibilityCacheForTests();
      for (const slug of hidden) {
        await expect(operationsByName.get_page.handler(ctx(engine, true), { slug })).rejects.toThrow(/Page not found/);
        expect(((await operationsByName.get_page.handler(ctx(engine, false), { slug })) as { slug: string }).slug).toBe(slug);
      }
      for (const slug of visible) expect(((await operationsByName.get_page.handler(ctx(engine, true), { slug })) as { slug: string }).slug).toBe(slug);
    }
  });

  test('remote search omits unstamped atoms and concepts; local finds them', async () => {
    for (const engine of engines) {
      __resetPrivateVisibilityCacheForTests();
      const slugs = async (remote: boolean) => ((await operationsByName.search.handler(ctx(engine, remote), { query: 'quokka', limit: 50 })) as
        Array<{ slug: string }>).map(r => r.slug);
      const remote = await slugs(true);
      for (const slug of hidden) expect(remote).not.toContain(slug);
      for (const slug of visible) expect(remote).toContain(slug);
      const local = await slugs(false);
      for (const slug of hidden) expect(local).toContain(slug);
    }
  });

  test('remote publication rechecks treat unstamped derived pages as private', async () => {
    for (const engine of engines) {
      const authority = { remote: true, sourceId: 'default', excludePrivate: true } as unknown as WriteAuthority;
      for (const slug of hidden) await expect(authorizePageVisibility(engine, authority, slug)).rejects.toMatchObject({ code: 'page_not_found' });
      for (const slug of visible) await authorizePageVisibility(engine, authority, slug);
    }
  });

  test('legacy-private origins and inputs hide explicitly world-visible derived pages without a repair', async () => {
    for (const engine of engines) {
      for (const [slug, type, frontmatter] of [
        ['atoms/legacy-origin', 'atom', { source_slug: 'notes/legacy-conflict', visibility: 'world' }],
        ['concepts/legacy-origin', 'concept', { synthesized_by: 'test', visibility: 'world' }],
        ['concepts/legacy-input', 'concept', { synthesized_by: 'test', visibility: 'world' }],
      ] as const) {
        await importFromContent(engine, slug, serializeMarkdown(frontmatter, 'quokka derived body', '', { type, title: slug, tags: [] }),
          { noEmbed: true, forceRechunk: true });
      }
      await engine.addLink('concepts/legacy-origin', 'atoms/legacy-origin', '', 'synthesized_from', 'concept-provenance');
      await engine.addLink('concepts/legacy-input', 'notes/legacy-conflict', '', 'synthesized_from', 'concept-provenance');
      const derived = ['atoms/legacy-origin', 'concepts/legacy-origin', 'concepts/legacy-input'];
      __resetPrivateVisibilityCacheForTests();
      const remote = (await engine.searchKeyword('quokka', { limit: 50, excludePrivate: true })).map(r => r.slug);
      for (const slug of derived) {
        expect(remote).not.toContain(slug);
        await expect(operationsByName.get_page.handler(ctx(engine, true), { slug })).rejects.toThrow(/Page not found/);
        expect(((await operationsByName.get_page.handler(ctx(engine, false), { slug })) as { slug: string }).slug).toBe(slug);
        expect((await engine.getPage(slug))!.frontmatter.visibility).toBe('world');
      }
    }
  });
});
