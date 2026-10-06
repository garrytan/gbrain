/**
 * #5829 remainder: `mentions.exclude_slugs` keeps a page out of the mention
 * gazetteer entirely, title and aliases. Hangul word boundaries (#5960, and
 * the name-suffix rule of v0.60.69.0) stop word-internal matches like 인하 in
 * "인하여"; what they cannot fix is a name that is also a standalone common
 * word, like a person page titled 우리 against 우리는 ("we"). The exclude list
 * is the operator's escape hatch, and the mention pass removes links already
 * written to the excluded page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildGazetteer, findMentionedEntities, type DroppedName } from '../src/core/by-mention.ts';
import { explainMention } from '../src/commands/extract-mentions-explain.ts';
import { mentionBrain, mentionLinks, page, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetMentionBrain(engine);
  await engine.unsetConfig('mentions.exclude_slugs');
});

const opts = { fromSlug: 'notes/n1', fromSourceId: 'default' };

describe('mentions.exclude_slugs (#5829)', () => {
  test('an excluded page contributes neither its title nor its aliases; other pages still link', async () => {
    await page(engine, 'people/inha', 'person', '인하', 'A person.');
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await engine.executeRaw("INSERT INTO page_aliases (source_id, slug, alias_norm) VALUES ('default', 'people/inha', '인하씨')");
    const body = '사정으로 인하여 취소되었습니다. 인하씨와 Acme Example.';

    const before = findMentionedEntities(body, await buildGazetteer(engine), opts).map(m => m.slug);
    expect(before).toContain('people/inha');

    await engine.setConfig('mentions.exclude_slugs', '["people/inha"]');
    const dropped: DroppedName[] = [];
    const after = findMentionedEntities(body, await buildGazetteer(engine, { dropped }), opts).map(m => m.slug);
    expect(after).toEqual(['companies/acme']);
    expect(dropped.filter(d => d.slug === 'people/inha').map(d => [d.origin, d.reason]).sort()).toEqual([
      ['frontmatter', 'excluded_slug'],
      ['title', 'excluded_slug'],
    ]);
  });

  test('the mention pass removes links already written to a page once it is excluded', async () => {
    await page(engine, 'people/uri', 'person', '우리', 'A person.');
    await page(engine, 'notes/n1', 'note', 'n1', '우리는 내일 다시 만납니다.');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['notes/n1 -> people/uri']);
    await engine.setConfig('mentions.exclude_slugs', 'people/uri');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual([]);
  });

  test('explain names the setting', async () => {
    await page(engine, 'people/inha', 'person', '인하', 'A person.');
    await engine.setConfig('mentions.exclude_slugs', 'people/inha');
    const r = await explainMention(engine, '인하');
    expect(r.reason).toBe('excluded_by_config');
    expect(r.message).toContain('mentions.exclude_slugs');
  });
});
