/**
 * PR #6688 salvage: a derived alias yields to another live page's exact
 * title only when the caller can read that page. A private (or other-source)
 * title the caller cannot see must not hide a readable alias.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importFromContent(engine, 'projects/title-alias-example',
    '---\ntitle: Title alias example\ntype: project\naliases: [titleprivacycode]\n---\n\n# Synthetic entity\n', { noEmbed: true });
  await engine.executeRaw("UPDATE page_aliases SET origin='declared' WHERE slug='projects/title-alias-example' AND alias_norm='titleprivacycode'");
  await importFromContent(engine, 'projects/exact-private-title-example',
    '---\ntitle: titleprivacycode\ntype: project\nvisibility: private\n---\n\n# Synthetic private title\n', { noEmbed: true });
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

describe('readAliases title competitor honors the read scope (#6688)', () => {
  test('a private exact title the caller cannot read does not hide a readable derived alias', async () => {
    expect((await engine.resolveAliases(['titleprivacycode'], { sourceId: 'default', excludePrivate: true })).get('titleprivacycode'))
      .toEqual([{ slug: 'projects/title-alias-example', source_id: 'default' }]);
  });

  test('a caller who can read the private title still sees the title win', async () => {
    expect((await engine.resolveAliases(['titleprivacycode'], { sourceId: 'default' })).has('titleprivacycode')).toBe(false);
  });

  test('a visible exact title still wins for a private-excluding caller', async () => {
    await importFromContent(engine, 'projects/exact-visible-title-example',
      '---\ntitle: titleprivacycode\ntype: project\n---\n\n# Synthetic visible title\n', { noEmbed: true });
    expect((await engine.resolveAliases(['titleprivacycode'], { sourceId: 'default', excludePrivate: true })).has('titleprivacycode')).toBe(false);
  });
});
