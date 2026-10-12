/**
 * #6454: older imports stored the parser's four reserved keys (`type`,
 * `title`, `tags`, `slug`) inside `pages.frontmatter`. A file can never carry
 * them into the parsed frontmatter object, so for those rows the canonical
 * file and the database copy never digest-matched and every coordinated
 * write was refused `source_changed` (~80k pages on the reported brain).
 *
 * Fix: `comparableFrontmatter` strips the four top-level keys on both sides
 * of the drift comparison (publication, reconcile, repair), and the render
 * strips them before the slug stamp so a stale stored `type`/`title` never
 * overrides the page columns in the published file ([R40]: that half is a
 * rendering change for legacy rows, pinned here on its own).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { Page } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { comparableFrontmatter, parseMarkdown, serializeMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const logger = { info() {}, warn() {}, error() {} };

const page = (overrides: Partial<Page>): Page => ({
  id: 1, slug: 'people/alice-example', type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example\n\nBody.', timeline: '',
  frontmatter: {}, source_id: 'default', created_at: new Date(0), updated_at: new Date(0), ...overrides,
} as Page);

describe('comparableFrontmatter (#6454)', () => {
  test('strips only the four top-level reserved keys and leaves nested user keys alone', () => {
    const stored = { type: 'person', title: 'Old Title', tags: ['stale'], slug: 'people/other', yc_user_id: 1,
      nested: { type: 'kept', title: 'kept', tags: ['kept'], slug: 'kept' }, trust_tier: 'agent_written' };
    expect(comparableFrontmatter(stored)).toEqual({ yc_user_id: 1, nested: { type: 'kept', title: 'kept', tags: ['kept'], slug: 'kept' }, trust_tier: 'agent_written' });
    expect(stored.type).toBe('person');
    expect(comparableFrontmatter(null)).toEqual({});
    expect(comparableFrontmatter(undefined)).toEqual({});
  });

  test('the parser never produces a reserved key, so a clean frontmatter compares equal to itself', () => {
    const parsed = parseMarkdown('---\ntype: person\ntitle: Alice\ntags: [a]\nslug: people/alice\nyc_user_id: 1\n---\n# Alice\n', 'people/alice.md');
    expect(parsed.frontmatter).toEqual({ yc_user_id: 1 });
    expect(comparableFrontmatter(parsed.frontmatter)).toEqual(parsed.frontmatter);
  });
});

describe('serializePageToMarkdown renders the columns, never a stale stored reserved key ([R40])', () => {
  test('a legacy row whose stored type/title disagree with the columns renders the columns', () => {
    const rendered = serializePageToMarkdown(page({ type: 'note', title: 'Column Title', frontmatter: { type: 'person', title: 'Stored Title', yc_user_id: 1 } }), []);
    const parsed = parseMarkdown(rendered, 'people/alice-example.md');
    expect(parsed.type).toBe('note');
    expect(parsed.title).toBe('Column Title');
    expect(parsed.frontmatter).toEqual({ yc_user_id: 1 });
    expect(rendered).not.toContain('Stored Title');
    expect(rendered).not.toContain('type: person');
  });

  test('stored tags with an empty tag list no longer render; a non-empty tag list renders only the column tags', () => {
    const empty = serializePageToMarkdown(page({ frontmatter: { tags: ['stale'] } }), []);
    expect(parseMarkdown(empty, 'people/alice-example.md').tags).toEqual([]);
    expect(empty).not.toContain('stale');
    const tagged = serializePageToMarkdown(page({ frontmatter: { tags: ['stale'] } }), ['live']);
    expect(parseMarkdown(tagged, 'people/alice-example.md').tags).toEqual(['live']);
    expect(tagged).not.toContain('stale');
  });

  test('a clean page renders byte-identically to the primitive serializer (digest-neutral), nested keys included', () => {
    const frontmatter = { yc_user_id: 1, nested: { type: 'kept', title: 'kept' }, validate: false };
    const clean = page({ frontmatter });
    expect(serializePageToMarkdown(clean, ['x'])).toBe(serializeMarkdown(frontmatter, clean.compiled_truth, '', { type: 'person', title: 'Alice Example', tags: ['x'] }));
  });

  test('the #5966 slug stamp rules survive the strip: a doubled hyphen is stamped, a stored slug naming another page is replaced by the page slug', () => {
    const doubled = serializePageToMarkdown(page({ slug: 'people/a--b', frontmatter: { slug: 'people/elsewhere' } }), []);
    expect(doubled).toMatch(/^slug: people\/a--b$/m);
    const plain = serializePageToMarkdown(page({ frontmatter: { slug: 'people/elsewhere' } }), []);
    expect(plain).toMatch(/^slug: people\/alice-example$/m);
    expect(plain).not.toContain('people/elsewhere');
    expect(parseMarkdown(plain, 'people/alice-example.md').slug).toBe('people/alice-example');
    expect(serializePageToMarkdown(page({ frontmatter: {} }), [])).not.toMatch(/^slug:/m);
  });
});

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-6454-db-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});

/** The reporter's rows: the parser-stripped keys stored in `pages.frontmatter` by an older import (guard lifted for the seed). */
export async function seedStaleReservedKeys(engine: BrainEngine, sourceId: string, slug: string, keys: Record<string, unknown>): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    await engine.executeRaw('UPDATE pages SET frontmatter = frontmatter || $3::text::jsonb WHERE source_id=$1 AND slug=$2', [sourceId, slug, JSON.stringify(keys)]);
  } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}

test('a page whose stored frontmatter carries stale type/title commits an unchanged-body write; real drift still refuses', async () => {
  for (const engine of engines) await staleKeysCase(engine);
}, 240_000);

async function staleKeysCase(engine: BrainEngine): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-6454-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  const sourceId = `s6454-${randomUUID().slice(0, 8)}`;
  const slug = 'people/example-person';
  const content = '---\ntype: person\ntitle: Example Person\ntags: [founder]\n---\n# Example Person\n\nAn observation.\n';
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
      const put = (params: Record<string, unknown>) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), ...params } })
        .then(receipt => receipt as { state: string }, (error: { code?: string }) => ({ state: 'refused', code: error.code }));
      expect((await put({ content })).state).toBe('committed');
      const file = join(root, 'people', 'example-person.md');
      const published = readFileSync(file, 'utf8');
      const revision = async () => (await engine.readPageSnapshot(slug, { sourceId }))!.revision;

      // The reporter's rows: stored `type`/`title` the file can never carry (and that disagree with nothing yet).
      await seedStaleReservedKeys(engine, sourceId, slug, { type: 'person', title: 'Example Person' });
      // Before the fix: source_changed / file_database_drift although the file is exactly the last publication.
      expect(await put({ content, expected_revision: await revision() })).toMatchObject({ state: 'committed' });
      const [row] = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>('SELECT frontmatter FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      expect(Object.keys(row.frontmatter)).not.toContain('type');
      expect(Object.keys(row.frontmatter)).not.toContain('title');

      // Stale keys that disagree with the columns: still not drift, and the published file renders the columns ([R40]).
      await seedStaleReservedKeys(engine, sourceId, slug, { type: 'note', title: 'A Title The Columns Never Had', tags: ['stale-tag'], slug: 'people/elsewhere' });
      const edited = content.replace('An observation.', 'An observation, edited through put_page.');
      expect(await put({ content: edited, expected_revision: await revision() })).toMatchObject({ state: 'committed' });
      const rendered = readFileSync(file, 'utf8');
      expect(rendered).toContain('type: person');
      expect(rendered).toContain('title: Example Person');
      expect(rendered).not.toContain('A Title The Columns Never Had');
      expect(rendered).not.toContain('stale-tag');
      expect(rendered).not.toMatch(/^slug:/m);
      expect(parseMarkdown(rendered, 'people/example-person.md').tags).toEqual(['founder']);

      // Real drift must still refuse, with the file and the row left as they are (the fix widens nothing).
      const [before] = await engine.executeRaw<{ frontmatter: Record<string, unknown>; compiled_truth: string; title: string }>(
        'SELECT frontmatter, compiled_truth, title FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      for (const drift of [
        rendered.replace('An observation, edited through put_page.', 'An observation edited by hand in the file.'),
        rendered.replace('title: Example Person', 'title: Renamed In The File'),
        rendered.replace('tags:\n  - founder', 'tags:\n  - founder\n  - hand-added'),
      ]) {
        expect(drift).not.toBe(rendered);
        writeFileSync(file, drift);
        expect(await put({ content: edited, expected_revision: await revision() })).toMatchObject({ state: 'refused', code: 'source_changed' });
        expect(readFileSync(file, 'utf8')).toBe(drift);
        const [after] = await engine.executeRaw<typeof before>('SELECT frontmatter, compiled_truth, title FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
        expect(after).toEqual(before);
      }
      writeFileSync(file, rendered);
      expect(await put({ content: edited, expected_revision: await revision() })).toMatchObject({ state: 'committed' });
      expect(published).not.toBe(rendered);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(dir, { recursive: true, force: true });
  }
}
