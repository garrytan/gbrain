import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { slugifySegment } from '../src/core/sync.ts';
import { enrichEntity, slugifyEntity } from '../src/core/enrichment-service.ts';
import { slugify } from '../src/core/entities/resolve.ts';
import { normalizeBasename } from '../src/core/link-extraction.ts';
import { normalizeAlias } from '../src/core/search/alias-normalize.ts';

/**
 * Pins ADR-0001 (docs/adr/0001-cyrillic-slugs-keep-i-kratkoye-and-yo.md).
 *
 * The rule is one sentence — Cyrillic и-kratkoye and yo survive slugification,
 * every other U+0300..U+036F mark folds — but it is enforced in four separate
 * grammars, and nothing else in the suite asserts it. Before these tests the
 * rule could be reverted, or one of the four could drift back, with a green
 * run: the existing Cyrillic fixtures ("Список задач", "Иван Петров") contain
 * neither letter.
 */

/** Every grammar that turns free text into a slug-shaped key. */
const GRAMMARS: [string, (s: string) => string][] = [
  ['sync.slugifySegment', slugifySegment],
  ['enrichment.slugifyEntity', (s) => slugifyEntity(s, 'person').replace(/^people\//, '')],
  ['resolve.slugify', slugify],
  ['link.normalizeBasename', normalizeBasename],
];

describe('ADR-0001: Cyrillic slugs keep и-kratkoye and yo', () => {
  for (const [name, fn] of GRAMMARS) {
    test(`${name} keeps и-kratkoye`, () => {
      expect(fn('Российская')).toBe('российская');
      expect(fn('Андрей')).toBe('андрей');
      expect(fn('Київ')).toBe('київ');
    });

    test(`${name} keeps yo`, () => {
      expect(fn('Ёлка')).toBe('ёлка');
      expect(fn('Пётр')).toBe('пётр');
    });

    test(`${name} still folds Latin accents`, () => {
      expect(fn('José')).toBe('jose');
      expect(fn('Café')).toBe('cafe');
    });

    test(`${name} folds a Cyrillic acute — it is a stress mark, not a letter`, () => {
      // The carve-out is exactly U+0306 and U+0308. A dictionary stress accent
      // is a true accent and must NOT fork a second slug for the same word.
      expect(fn('моло\u0301ко')).toBe(fn('молоко'));
    });
  }

  test('a page slug and its basename index key agree on Cyrillic', () => {
    // The regression guard. normalizeBasename is slugifySegment's twin (#4985):
    // when only one of them keeps the marks, every [[wikilink]] to a name
    // containing и-kratkoye or yo stops resolving, silently.
    for (const name of ['Андрей', 'российской', 'Київ', 'Пётр', 'Ёлка', 'Алексей']) {
      expect(normalizeBasename(name)).toBe(slugifySegment(name));
    }
  });

  test('resolve.slugify yields a usable key for non-Latin names', () => {
    // Was ASCII-only: every Cyrillic name resolved to '' and collided there.
    expect(slugify('Иван Петров')).toBe('иван-петров');
    expect(slugify('Тестовая Компания')).not.toBe('');
  });

  test('the two spellings of one name slug APART', () => {
    // Deliberate per ADR-0001: the slug reports what was written. Merging them
    // is the alias layer's job, asserted below.
    expect(slugifySegment('Пётр Иванов')).not.toBe(slugifySegment('Петр Иванов'));
  });
});

describe('ADR-0001 consequence: the alias layer merges yo and ye', () => {
  test('yo and ye spellings share one alias key', () => {
    expect(normalizeAlias('Пётр Иванов')).toBe(normalizeAlias('Петр Иванов'));
    expect(normalizeAlias('ПЁТР ИВАНОВ')).toBe(normalizeAlias('Петр Иванов'));
  });

  test('и-kratkoye is NOT merged into и', () => {
    // Only yo/ye are interchangeable in Russian orthography. Folding
    // и-kratkoye too would collapse genuinely different names.
    expect(normalizeAlias('Андрей')).not.toBe(normalizeAlias('Андреи'));
    expect(normalizeAlias('Дмитрий')).toBe('дмитрий');
  });
});

// ---------------------------------------------------------------------------
// The consequence the ADR is FOR: two spellings land on one Entity.
// The grammar assertions above are static; this is the branching path in
// enrichEntity that actually merges them, and it only exists end-to-end —
// the stub must project its alias, and the next mention must read it back.
// ---------------------------------------------------------------------------

describe('ADR-0001 consequence: enrichEntity merges the two spellings', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    for (const t of ['content_chunks', 'links', 'tags', 'timeline_entries', 'page_aliases', 'page_versions', 'ingest_log', 'pages']) {
      await (engine as unknown as { db: { exec(q: string): Promise<unknown> } }).db.exec(`DELETE FROM ${t}`);
    }
  });

  const mention = (entityName: string, entityType: 'person' | 'company') => ({
    entityName,
    entityType,
    context: `встретился с ${entityName}`,
    sourceSlug: 'meetings/2026-04-03',
  });

  test('a second mention spelled with ye appends to the yo stub', async () => {
    const first = await enrichEntity(engine, mention('Пётр Иванов', 'person'), { trusted: true });
    expect(first.action).toBe('created');
    expect(first.slug).toBe('people/пётр-иванов');

    const second = await enrichEntity(engine, mention('Петр Иванов', 'person'), { trusted: true });
    expect(second.action).toBe('updated');
    expect(second.slug).toBe('people/пётр-иванов');

    // The twin the alias layer exists to prevent.
    expect(await engine.getPage('people/петр-иванов')).toBeNull();
  });

  test('the alias probe cannot pull an entity onto a page outside its namespace', async () => {
    // A note that merely CLAIMS the name as an alias is not an Entity page.
    // Without a namespace gate the company mention below would append its
    // timeline + backlink to this project note instead of minting
    // companies/атлас — page_aliases is brain-wide and unaware of type.
    await importFromContent(
      engine,
      'projects/атлас',
      '---\ntype: project\ntitle: Атлас\naliases:\n  - Атлас\n---\n\nПроект Атлас.\n',
      { noEmbed: true },
    );

    const result = await enrichEntity(engine, mention('Атлас', 'company'), { trusted: true });

    expect(result.slug).toBe('companies/атлас');
    expect(result.action).toBe('created');
    expect(await engine.getPage('companies/атлас')).not.toBeNull();
  });

  test('a quarantined stub does not publish its name into the brain-wide alias index', async () => {
    // page_aliases steers exact-lookup, hybrid search and resolveEntityRef for
    // the WHOLE brain. Untrusted extractor output must not reach it before
    // review — same fail-closed posture as the authoritative-write gate.
    const stub = await enrichEntity(engine, mention('Пётр Иванов', 'person'), { trusted: false });
    expect(stub.action).toBe('created');

    const aliases = await engine.resolveAliases([normalizeAlias('Пётр Иванов')], { sourceId: 'default' });
    expect(aliases.get(normalizeAlias('Пётр Иванов')) ?? []).toHaveLength(0);
  });

  test('a trusted stub DOES publish its name, which is what merges the pair', async () => {
    await enrichEntity(engine, mention('Пётр Иванов', 'person'), { trusted: true });

    const hits = (await engine.resolveAliases([normalizeAlias('Петр Иванов')], { sourceId: 'default' })).get(
      normalizeAlias('Петр Иванов'),
    ) ?? [];
    expect(hits.map((h) => h.slug)).toContain('people/пётр-иванов');
  });
});
