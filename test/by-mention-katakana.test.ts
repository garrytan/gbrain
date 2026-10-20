/**
 * Protects Katakana names from matching inside a longer Katakana word (#6843):
 * character-level CJK maximal munch accepted デン in インシデント and stored a
 * false mention edge. Existing Hangul and Han suites cover other scripts only.
 * Uses the public matcher and the real mention pass; no production seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { findMentionedEntities, hashGazetteer, tokenizeTitle, type Gazetteer, type GazetteerEntry } from '../src/core/by-mention.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMentionPass } from '../src/core/mentions/pass.ts';
import { mentionBrain, mentionLinks, page } from './helpers/mention-brain.ts';

const opts = { fromSlug: 'notes/example', fromSourceId: 'default' };

function entryFor(name: string, sourceId = 'default', slug = 'entities/acme-example'): GazetteerEntry {
  return { slug, source_id: sourceId, title: 'Acme Example', origin: 'frontmatter', matchText: name, tokens: tokenizeTitle(name) };
}

function gazetteerOf(...entries: GazetteerEntry[]): Gazetteer {
  return new Map([[entries[0]!.tokens[0]!, entries]]);
}

const found = (body: string, name = 'デン') => findMentionedEntities(body, gazetteerOf(entryFor(name)), opts);

describe('Katakana mention boundaries (#6843)', () => {
  test.each(['インシデント対応の手順を確認する。', 'デンタル', 'カデン', 'デンー', 'ーデン', 'デンァ', 'ァデン',
    'デン\u3099', 'デン\u309a', '\u{1b164}デン', 'デン\u{1b164}', 'ｶデン', 'デ ン'])
  ('rejects a name inside a longer Katakana run: %s', body => {
    expect(found(body)).toEqual([]);
  });

  test.each(['デンに行った', '「デン」', '喫茶デン', 'デン・カフェ', '😀デンで会う', 'DENデン', 'デン。'])
  ('keeps Hiragana, Han, Latin, punctuation and ・ as boundaries: %s', body => {
    expect(found(body)).toHaveLength(1);
  });

  test('applies to every pure-Katakana name, with no length cap', () => {
    expect(found('ハイライトを読む', 'ライト')).toEqual([]);
    expect(found('ライトに聞く', 'ライト')).toHaveLength(1);
    expect(found('スーパーマーケットへ', 'マーケット')).toEqual([]);
    expect(found('「マーケット」へ', 'マーケット')).toHaveLength(1);
  });

  test('mixed-script and non-Katakana names keep character matching', () => {
    expect(found('カフェデンに行った', '喫茶デン')).toEqual([]);
    expect(found('老舗喫茶デンタルに行った', '喫茶デン')).toHaveLength(1);
    expect(found('我读了艾例丝的书', '艾例丝')).toHaveLength(1);
  });

  test('a rejected substring leaves the original offset of a later real mention', () => {
    const body = '😀インシデント対応。その後「デン」に行った';
    const hits = found(body);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.offset).toBe(body.indexOf('デン」'));
  });

  test('own-source sibling selection applies the same boundary', () => {
    const foreign = entryFor('デン', 'other', 'entities/acme-example');
    const own = entryFor('デン', 'default', 'entities/widget-co');
    const g = gazetteerOf(foreign, own);
    const cross = { ...opts, allowCrossSource: true };
    expect(findMentionedEntities('インシデント', g, cross)).toEqual([]);
    expect(findMentionedEntities('「デン」', g, cross).map(m => m.slug)).toEqual(['entities/widget-co']);
  });

  test('the resume fingerprint changes with the matcher semantics', () => {
    const entry = entryFor('デン');
    const prior = createHash('sha256').update('html-comments-masked-v4\n').update(
      `${entry.source_id}\0${entry.slug}\0${entry.title}\0${entry.tokens.join(' ')}\0${entry.matchText}`,
    ).digest('hex').slice(0, 8);
    expect(hashGazetteer(gazetteerOf(entry))).not.toBe(prior);
  });
});

describe('Katakana mention publication (#6843)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('the mention pass stores no edge for a word-internal alias', async () => {
    await page(engine, 'entities/acme-example', 'entity', 'Acme Example', 'A synthetic entity.', { frontmatter: { aliases: ['デン'] } });
    await engine.executeRaw("INSERT INTO page_aliases (source_id, slug, alias_norm) VALUES ('default', 'entities/acme-example', 'デン')");
    await page(engine, 'notes/incident', 'note', 'Incident response', 'インシデント対応の手順を確認する。');
    await page(engine, 'notes/visit', 'note', 'Visit', '「デン」に行った');
    expect((await runMentionPass(engine)).state).toBe('complete');
    expect(await mentionLinks(engine)).toEqual(['notes/visit -> entities/acme-example']);
  }, 120_000);
});
