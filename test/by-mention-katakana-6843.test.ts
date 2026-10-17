/**
 * Protects short Katakana aliases from becoming edges inside unrelated words.
 * Regression: character-level CJK maximal munch accepts デン in インシデント.
 * Existing Hangul and general CJK suites do not cover Katakana word spans.
 * Uses the public matcher and real mention publication; no new production seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { findMentionedEntities, tokenizeTitle, type Gazetteer } from '../src/core/by-mention.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMentionPass } from '../src/core/mentions/pass.ts';
import { explainMention } from '../src/commands/extract-mentions-explain.ts';
import { mentionLinks, page } from './helpers/mention-brain.ts';

const opts = { fromSlug: 'notes/example', fromSourceId: 'default' };
function aliasGazetteer(name: string): Gazetteer {
  const tokens = tokenizeTitle(name);
  return new Map([[tokens[0]!, [{
    slug: 'entities/example-cafe', source_id: 'default', title: 'Example Cafe',
    origin: 'frontmatter', matchText: name, tokens,
  }]]]);
}

describe('short Katakana alias boundaries (#6843)', () => {
  test('does not match a two-character alias inside an unrelated word', () => {
    expect(findMentionedEntities('インシデント対応の手順を確認する。', aliasGazetteer('デン'), opts)).toEqual([]);
  });

  test.each(['デンに行った', '「デン」', '喫茶デン', 'デン・カフェ', '😀デンで会う', 'DENデン'])
  ('keeps script and punctuation boundaries: %s', body => {
    expect(findMentionedEntities(body, aliasGazetteer('デン'), opts)).toHaveLength(1);
  });

  test.each(['インシデント', 'デンタル', 'カデン', 'デンー', 'ーデン', 'デンァ', 'ァデン', 'デン\u3099', '\u{1b164}デン', 'デン\u{1b164}'])
  ('rejects adjacent Katakana, small kana and sound/voicing marks: %s', body => {
    expect(findMentionedEntities(body, aliasGazetteer('デン'), opts)).toEqual([]);
  });

  test('protects three-character aliases too, without joining separated tokens', () => {
    const g = aliasGazetteer('ライト');
    expect(findMentionedEntities('ハイライトを読む', g, opts)).toEqual([]);
    expect(findMentionedEntities('ライトに聞く', g, opts)).toHaveLength(1);
    for (const body of ['デ・ン', 'デ ン', 'デ😀ン', 'デ\nン']) {
      expect(findMentionedEntities(body, aliasGazetteer('デン'), opts)).toEqual([]);
    }
  });

  test('retains longer and mixed-script aliases', () => {
    for (const name of ['カフェデン', 'カフェDEN', '喫茶デン', '艾例丝', 'ひかり']) {
      expect(findMentionedEntities(`「${name}」に行った`, aliasGazetteer(name), opts)).toHaveLength(1);
    }
    // No compatibility folding or new halfwidth-name policy.
    expect(findMentionedEntities('ﾃﾞﾝに行く', aliasGazetteer('デン'), opts)).toEqual([]);
  });

  test('rejecting an early substring leaves the original offset of a later real mention', () => {
    const body = '😀インシデント対応。その後「デン」に行った';
    const found = findMentionedEntities(body, aliasGazetteer('デン'), opts);
    expect(found).toHaveLength(1);
    expect(found[0]!.offset).toBe(body.indexOf('デン」に'));
    expect(found[0]!.name).toBe('Example Cafe');
  });

  test('canonical voicing normalization preserves original body offsets', () => {
    const body = '😀「ガク」に聞いた'.normalize('NFD');
    const found = findMentionedEntities(body, aliasGazetteer('ガク'), opts);
    expect(found).toHaveLength(1);
    expect(found[0]!.offset).toBe(body.indexOf('カ'));
    expect(findMentionedEntities('ガクに聞いた', aliasGazetteer('ガク'.normalize('NFD')), opts)).toHaveLength(1);
    expect(findMentionedEntities('カガクを学ぶ'.normalize('NFD'), aliasGazetteer('ガク'), opts)).toEqual([]);
  });

  test('preserves ignore, code, self-link and source guards', () => {
    const g = aliasGazetteer('デン');
    expect(findMentionedEntities('デンに行く', g, { ...opts, ignoreNames: ['デン'] })).toEqual([]);
    expect(findMentionedEntities('`デン`', g, opts)).toEqual([]);
    expect(findMentionedEntities('デンに行く', g, { ...opts, fromSlug: 'entities/example-cafe' })).toEqual([]);
    expect(findMentionedEntities('デンに行く', g, { ...opts, fromSourceId: 'other' })).toEqual([]);
    expect(findMentionedEntities('デンに行く', g, { ...opts, fromSourceId: 'other', allowCrossSource: true })).toHaveLength(1);
  });
});

describe('Katakana mention publication', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('schema_pack', 'gbrain-base-v2');
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('the real pass and explain agree, preserving other edge producers on an edited origin', async () => {
    await page(engine, 'entities/example-cafe', 'entity', 'Example Cafe', 'A synthetic cafe.', {
      frontmatter: { aliases: ['デン'] },
    });
    // putPage is storage-only; seed the frontmatter index as the importer does.
    await engine.executeRaw("INSERT INTO page_aliases (source_id, slug, alias_norm) VALUES ('default', 'entities/example-cafe', 'デン')");
    await page(engine, 'notes/incident', 'note', 'Incident response', 'インシデント対応の手順を確認する。');
    await page(engine, 'notes/visit', 'note', 'Visit', '「デン」に行った');
    await page(engine, 'notes/ignored', 'note', 'Ignored', 'デンに行った', { frontmatter: { mention_ignore: ['デン'] } });
    await page(engine, 'notes/unsupported', 'note', 'Unsupported setting', 'デンに行った', { frontmatter: { mention_exclude: ['デン'] } });
    expect((await runMentionPass(engine)).state).toBe('complete');
    expect(await mentionLinks(engine)).toEqual([
      'notes/unsupported -> entities/example-cafe', 'notes/visit -> entities/example-cafe',
    ]);
    expect(await explainMention(engine, 'デン', { page: 'notes/incident' })).toMatchObject({
      reason: 'not_a_known_name', page: { linked: false },
    });
    expect(await explainMention(engine, 'デン', { page: 'notes/visit' })).toMatchObject({ reason: null, page: { linked: true } });
    expect(await explainMention(engine, 'デン', { page: 'notes/ignored' })).toMatchObject({ reason: 'ignored_by_page' });

    // A changed origin is reconciled through the existing conditional pass.
    // Neither manual/Markdown edges nor typed NER assertions belong to it.
    await engine.addLinksBatch([
      { from_slug: 'notes/visit', to_slug: 'entities/example-cafe', link_type: 'related', link_source: 'manual' },
      { from_slug: 'notes/visit', to_slug: 'entities/example-cafe', link_type: 'references', link_source: 'markdown' },
      { from_slug: 'notes/visit', to_slug: 'entities/example-cafe', link_type: 'works_at', link_source: 'mentions', link_kind: 'typed_ner' },
    ]);
    await page(engine, 'notes/visit', 'note', 'Visit', 'インシデント対応');
    const updated = await runMentionPass(engine);
    expect(updated).toMatchObject({ state: 'complete', removed: 1 });
    expect(await mentionLinks(engine)).toEqual([
      'notes/unsupported -> entities/example-cafe', 'notes/visit -> entities/example-cafe (typed_ner)',
    ]);
    expect((await engine.getLinks('notes/visit', { sourceId: 'default' })).map(l => l.link_source).sort()).toEqual(['manual', 'markdown', 'mentions']);
    await engine.setConfig('mentions.exclude_slugs', 'entities/example-cafe');
    await runMentionPass(engine);
    expect(await mentionLinks(engine)).toEqual(['notes/visit -> entities/example-cafe (typed_ner)']);
  }, 120_000);
});
