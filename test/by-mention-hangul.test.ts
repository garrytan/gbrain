import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildGazetteer, findMentionedEntities, hashGazetteer, tokenizeTitle } from '../src/core/by-mention.ts';
import type { Gazetteer } from '../src/core/by-mention.ts';

let engine: PGLiteEngine;
let gazetteer: Gazetteer;
const opts = { fromSlug: 'notes/example', fromSourceId: 'default' };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, title] of [
    ['people/jiwon', '지원'],
    ['companies/jangin', '장인'],
    ['people/inha', '인하'],
    ['companies/example-card', '예시카드'],
    ['companies/spaced', '예시 카드'],
    ['companies/longer', '지원 회사'],
    ['companies/alias', 'Example Company'],
    ['people/alice-example', '艾例丝'],
  ]) {
    await engine.putPage(slug!, {
      type: 'company', title: title!, compiled_truth: '', timeline: '', frontmatter: {},
    });
  }
  await engine.executeRaw(
    "INSERT INTO page_aliases (source_id, slug, alias_norm) VALUES ('default', 'companies/alias', '아내')",
  );
  gazetteer = await buildGazetteer(engine);
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

function mentions(body: string): string[] {
  return findMentionedEntities(body, gazetteer, opts).map(m => m.slug);
}

describe('Hangul mention boundaries', () => {
  test.each(['재지원 안내', '로그인하기', '국가 성장 인프라로', '찾아내는 방법'])
  ('rejects word-internal title/alias and cross-space matches: %s', body => {
    expect(mentions(body)).toEqual([]);
  });

  test.each(['지 원', '지,원', '지\n원', '지😀원'])
  ('does not join separated syllables into a contiguous name: %s', body => {
    expect(mentions(body)).toEqual([]);
  });

  test.each(['지원이 왔다', '지원은 왔다', '지원에게 물었다', '지원의 문서', '지원과 만났다'])
  ('keeps attached Korean particles: %s', body => {
    expect(mentions(body)).toEqual(['people/jiwon']);
  });

  test.each(['지원씨는 왔다', '지원님께 드렸다', '지원에게서 받았다', '지원이었다', '지원아 가자', '지원 대표가 말했다', '지원대표가 말했다'])
  ('keeps attached honorifics, titles and copula forms: %s', body => {
    expect(mentions(body)).toEqual(['people/jiwon']);
  });

  test.each(['지원하는 방법', '지원금 신청', '지원군을 보냈다', '장인정신', '인하여 늦었다'])
  ('rejects a name that only starts a longer word: %s', body => {
    expect(mentions(body)).toEqual([]);
  });

  test('matches an alias using alias spelling, not its canonical Latin title', () => {
    const body = '😀 아내와 만났다';
    const found = findMentionedEntities(body, gazetteer, opts);
    expect(found).toHaveLength(1);
    expect(found[0]!.slug).toBe('companies/alias');
    expect(found[0]!.name).toBe('Example Company');
    expect(body.slice(found[0]!.offset, found[0]!.offset + 2)).toBe('아내');
  });

  test('preserves spaces explicitly present in a Hangul name', () => {
    expect(tokenizeTitle('예시 카드')).toEqual(['예', '시', '카', '드']);
    expect(mentions('예시\t카드에서 일한다')).toEqual(['companies/spaced']);
    expect(mentions('예시카드에서 일한다')).toEqual(['companies/example-card']);
    expect(mentions('예시,카드')).toEqual([]);
  });

  test('rejecting the longest candidate still allows a valid shorter name', () => {
    expect(mentions('지원,회사')).toEqual(['people/jiwon']);
    expect(mentions('지원 회사에서 일한다')).toEqual(['companies/longer']);
  });

  test('a rejected early occurrence does not hide a later real mention', () => {
    const body = '재지원 안내 다음에 지원이 왔다';
    const found = findMentionedEntities(body, gazetteer, opts);
    expect(found).toHaveLength(1);
    expect(found[0]!.offset).toBe(body.indexOf('지원이'));
  });

  test('same-token own-source preference cannot override a spacing mismatch', () => {
    const entry = gazetteer.get('예')!.find(e => e.slug === 'companies/spaced')!;
    const twin: Gazetteer = new Map([['예', [
      { ...entry, source_id: 'foreign' },
      { ...entry, source_id: 'default', matchText: '예시카드' },
    ]]]);
    expect(findMentionedEntities('예시 카드에서 일한다', twin, {
      ...opts, allowCrossSource: true,
    }).map(m => m.source_id)).toEqual(['foreign']);
    expect(findMentionedEntities('예시 카드에서 일한다', twin, opts)).toEqual([]);
  });

  test('resume identity includes spelling and invalidates the old matcher fingerprint', () => {
    const entry = gazetteer.get('예')!.find(e => e.slug === 'companies/spaced')!;
    const spaced: Gazetteer = new Map([['예', [entry]]]);
    const unspaced: Gazetteer = new Map([['예', [{ ...entry, matchText: '예시카드' }]]]);
    expect(hashGazetteer(spaced)).not.toBe(hashGazetteer(unspaced));
    const legacy = createHash('sha256').update(
      `${entry.source_id}\0${entry.slug}\0${entry.title}\0${entry.tokens.join(' ')}`,
    ).digest('hex').slice(0, 8);
    expect(hashGazetteer(spaced)).not.toBe(legacy);
    expect(hashGazetteer(spaced)).toBe(hashGazetteer(spaced));
  });

  test('preserves Han substring matching and self/cross-source/code guards', () => {
    expect(mentions('我读了艾例丝的书')).toEqual(['people/alice-example']);
    expect(mentions('```\n지원이 왔다\n```')).toEqual([]);
    expect(findMentionedEntities('지원이 왔다', gazetteer, {
      fromSlug: 'people/jiwon', fromSourceId: 'default',
    })).toEqual([]);
    expect(findMentionedEntities('지원이 왔다', gazetteer, {
      fromSlug: 'notes/example', fromSourceId: 'other',
    })).toEqual([]);
    expect(findMentionedEntities('지원이 왔다', gazetteer, {
      fromSlug: 'notes/example', fromSourceId: 'other', allowCrossSource: true,
    })).toHaveLength(1);
  });
});
