/**
 * Renames leave a slug alias, and links written against the old slug keep
 * resolving.
 *
 * updateSlug only rewrote pages.slug, so nothing recorded where a page went:
 * `[[people/alice-example]]` in a referrer stopped resolving after the page was
 * renamed, and any replace-semantics link pass (put_page, sync) then deleted
 * the inbound edge. updateSlug now records `slug_aliases(old -> new)` in the
 * same transaction (repointing aliases that named the old slug), and both the
 * DB resolver and file-sync extraction resolve through it.
 *
 * PGLite in-memory, no embeddings ($0).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { makeResolver } from '../src/core/link-extraction.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await runSources(engine, ['add', 'rl', '--no-federated']);
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

const aliases = (sourceId: string) => engine.executeRaw<{ alias_slug: string; canonical_slug: string }>(
  `SELECT alias_slug, canonical_slug FROM slug_aliases WHERE source_id = $1 ORDER BY alias_slug`, [sourceId]);

describe('updateSlug records an alias', () => {
  test('a rename writes old -> new and repoints earlier aliases', async () => {
    await importFromContent(engine, 'people/bob-example', `---\ntype: person\ntitle: Bob Example\n---\n\nBob.\n`, { noEmbed: true });
    expect(await engine.updateSlug('people/bob-example', 'people/bob-example-2')).toBe(1);
    expect(await engine.updateSlug('people/bob-example-2', 'people/bob-example-3')).toBe(1);
    expect(await aliases('default')).toEqual([
      { alias_slug: 'people/bob-example', canonical_slug: 'people/bob-example-3' },
      { alias_slug: 'people/bob-example-2', canonical_slug: 'people/bob-example-3' },
    ]);
    const r = makeResolver(engine, { mode: 'batch', sourceId: 'default' });
    expect(await r.resolve('people/bob-example')).toBe('people/bob-example-3');
    expect(await engine.resolveSlugWithAlias('people/bob-example', 'default')).toBe('people/bob-example-3');
  });

  test('renaming back onto an aliased slug drops the self-referencing alias', async () => {
    await importFromContent(engine, 'people/carol-example', `---\ntype: person\ntitle: Carol Example\n---\n\nCarol.\n`, { noEmbed: true });
    await engine.updateSlug('people/carol-example', 'people/carol-example-2');
    await engine.updateSlug('people/carol-example-2', 'people/carol-example');
    expect((await aliases('default')).filter(a => a.alias_slug.startsWith('people/carol'))).toEqual([
      { alias_slug: 'people/carol-example-2', canonical_slug: 'people/carol-example' },
    ]);
  });
});

describe('updateSlug carries slug-keyed bindings (#5431)', () => {
  test('facts and search aliases follow the renamed page; a purged page\'s leftovers yield', async () => {
    await importFromContent(engine, 'people/dana-example', `---\ntype: person\ntitle: Dana Example\naliases: [Dana E]\n---\n\nDana.\n`, { noEmbed: true });
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, source, row_num, source_markdown_slug) VALUES
      ('default', 'people/dana-example', 'Dana founded a company.', 'test', 1, 'people/dana-example'),
      ('default', 'people/dana-example', 'Dana mentioned elsewhere.', 'test', NULL, 'notes/other-example'),
      ('default', 'people/erin-example', 'Stale fence row of a purged page.', 'test', 1, 'people/dana-example-2')`);
    await engine.executeRaw(`INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES ('default', 'dana e', 'people/dana-example-2')
      ON CONFLICT DO NOTHING`);
    const before = await engine.executeRaw<{ alias_norm: string }>(`SELECT alias_norm FROM page_aliases WHERE source_id = 'default' AND slug = 'people/dana-example'`);
    expect(before.map(r => r.alias_norm)).toContain('dana e');

    expect(await engine.updateSlug('people/dana-example', 'people/dana-example-2')).toBe(1);

    const facts = await engine.executeRaw<{ entity_slug: string; source_markdown_slug: string; fact: string }>(
      `SELECT entity_slug, source_markdown_slug, fact FROM facts WHERE source_id = 'default' ORDER BY fact`);
    expect(facts).toEqual([
      { entity_slug: 'people/dana-example-2', source_markdown_slug: 'people/dana-example-2', fact: 'Dana founded a company.' },
      { entity_slug: 'people/dana-example-2', source_markdown_slug: 'notes/other-example', fact: 'Dana mentioned elsewhere.' },
    ]);
    const pageAliases = await engine.executeRaw<{ slug: string }>(
      `SELECT DISTINCT slug FROM page_aliases WHERE source_id = 'default' AND slug LIKE 'people/dana-example%'`);
    expect(pageAliases).toEqual([{ slug: 'people/dana-example-2' }]);
  });
});

describe('sync keeps inbound edges across a rename', () => {
  test('editing the referrer after a rename keeps its edge to the renamed page', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rename-alias-'));
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo });
    mkdirSync(join(repo, 'notes'));
    mkdirSync(join(repo, 'people'));
    writeFileSync(join(repo, 'notes/seed.md'), `---\ntype: note\ntitle: Seed\n---\n\nseed\n`);
    execSync('git add -A && git commit -qm seed', { cwd: repo });
    const sync = () => performSync(engine, { repoPath: repo, sourceId: 'rl', noPull: true, noEmbed: true });
    await sync();
    writeFileSync(join(repo, 'notes/a.md'), `---\ntype: note\ntitle: A\n---\n\nMet with [[people/alice-example]] about the widget.\n`);
    writeFileSync(join(repo, 'people/alice-example.md'), `---\ntype: person\ntitle: Alice Example\n---\n\nAlice is an engineer.\n`);
    execSync('git add -A && git commit -qm add', { cwd: repo });
    await sync();
    const edges = async () => (await engine.executeRaw<{ t: string }>(
      `SELECT t.slug t FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
        WHERE f.source_id = 'rl' AND f.slug = 'notes/a' ORDER BY 1`)).map(r => r.t);
    expect(await edges()).toEqual(['people/alice-example']);

    execSync('git mv people/alice-example.md people/alice-example-2.md && git commit -qm mv', { cwd: repo });
    await sync();
    expect(await aliases('rl')).toEqual([{ alias_slug: 'people/alice-example', canonical_slug: 'people/alice-example-2' }]);

    appendFileSync(join(repo, 'notes/a.md'), `\nFollow-up: shipped.\n`);
    execSync('git commit -qam edit', { cwd: repo });
    await sync();
    expect(await edges()).toEqual(['people/alice-example-2']);
  }, 60_000);
});
