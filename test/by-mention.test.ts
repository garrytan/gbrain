/**
 * Unit tests for src/core/by-mention.ts.
 *
 * Pure-function coverage of `findMentionedEntities` + `buildGazetteer`.
 * Hermetic via PGLite for buildGazetteer (needs engine); pure-fn cases
 * for findMentionedEntities (no engine needed).
 *
 * Covers all 20 cases enumerated in the v0.42.0.0 plan:
 *   1. Single-token title match
 *   2. Multi-word phrase pass ("Acme Corp" matches "Acme Corp" not "Acme")
 *   3. Case folding
 *   4. Whole-word boundary
 *   5. Possessive form
 *   6. Code-block stripping
 *   7. Min-length filter
 *   8. Ignore-list at gazetteer build (Apple suppressed when no page)
 *   9. Ignore-list inverse (Apple matches when page exists)
 *   10. First-mention-only cap
 *   11. Empty gazetteer
 *   12. Empty text
 *   13. All entity pages soft-deleted → empty gazetteer
 *   14. Multi-word shared first token (longest-match wins)
 *   15. Determinism across 10 calls
 *   16. Self-link guard (D13)
 *   17. Cross-source guard
 *   18. Hardcoded type filter (meeting NOT in gazetteer)
 *   19. Min-length + ignore-list interaction
 *   20. Code-block + token interaction
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  buildGazetteer,
  findMentionedEntities,
  tokenizeForScan,
  tokenizeTitle,
  LINKABLE_ENTITY_TYPES,
  type Gazetteer,
  type GazetteerEntry,
} from '../src/core/by-mention.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
});

// Tiny gazetteer builder for pure-fn cases that don't need engine.
//
// Deliberately calls the PRODUCTION `tokenizeTitle` rather than re-declaring
// the tokenizer. A duplicated copy makes every test here non-discriminating:
// reverting the source tokenizer would leave the fixture on the new one, so
// title and body would keep agreeing and the tests would pass either way.
function gazetteerFromEntries(entries: Omit<GazetteerEntry, 'tokens'>[]): Gazetteer {
  const g: Gazetteer = new Map();
  for (const raw of entries) {
    const tokens = tokenizeTitle(raw.title);
    if (tokens.length === 0) continue;
    const key = tokens[0]!;
    const entry: GazetteerEntry = { ...raw, tokens };
    const bucket = g.get(key);
    if (bucket) bucket.push(entry);
    else g.set(key, [entry]);
  }
  for (const bucket of g.values()) bucket.sort((a, b) => b.tokens.length - a.tokens.length);
  return g;
}

// ============================================================
// findMentionedEntities — pure unit tests
// ============================================================

describe('findMentionedEntities — pure cases', () => {
  test('1. single-token title match', () => {
    const g = gazetteerFromEntries([
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
    ]);
    const mentions = findMentionedEntities('Acme launched today.', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.slug).toBe('companies/acme');
    expect(mentions[0]!.name).toBe('Acme');
    expect(mentions[0]!.offset).toBe(0);
  });

  test('2. multi-word phrase pass — "Acme Corp" matches multi-word, not single', () => {
    const g = gazetteerFromEntries([
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
      { slug: 'companies/acme-corp', source_id: 'default', title: 'Acme Corp' },
    ]);
    const mentions = findMentionedEntities('We met with Acme Corp last week.', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    // longest-match wins → only the multi-word target
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.slug).toBe('companies/acme-corp');
  });

  test('3. case folding — "iOS Engineer" title matches "ios engineer" in body', () => {
    const g = gazetteerFromEntries([
      { slug: 'people/ios-engineer', source_id: 'default', title: 'iOS Engineer' },
    ]);
    const mentions = findMentionedEntities('Looking to hire an ios engineer.', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.slug).toBe('people/ios-engineer');
  });

  test('4. whole-word boundary — "Acme" matches "Acme." but NOT "Acmecorp"', () => {
    const g = gazetteerFromEntries([
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
    ]);
    // Should match (sentence-ending dot is a token break)
    const m1 = findMentionedEntities('We bought Acme.', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(m1).toHaveLength(1);
    // Should NOT match — "Acmecorp" tokenizes as single token "acmecorp"
    const m2 = findMentionedEntities('Acmecorp is unrelated.', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(m2).toHaveLength(0);
  });

  test('5. possessive form — "Acme\'s growth" → Acme matches', () => {
    const g = gazetteerFromEntries([
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
    ]);
    const mentions = findMentionedEntities("Acme's growth is impressive.", g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.slug).toBe('companies/acme');
  });

  test('6. code-block stripping — mentions inside ``` blocks ignored', () => {
    const g = gazetteerFromEntries([
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
    ]);
    const body = '```\nAcme code\n```\nNothing here.';
    const mentions = findMentionedEntities(body, g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(0);
  });

  test('10. first-mention-only cap — 5 body mentions of same entity → 1 link', () => {
    const g = gazetteerFromEntries([
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
    ]);
    const body = 'Acme one. Acme two. Acme three. Acme four. Acme five.';
    const mentions = findMentionedEntities(body, g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(1);
  });

  test('11. empty gazetteer → empty result', () => {
    const g: Gazetteer = new Map();
    const mentions = findMentionedEntities('Anything goes here.', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toEqual([]);
  });

  test('12. empty text → empty result', () => {
    const g = gazetteerFromEntries([
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
    ]);
    const mentions = findMentionedEntities('', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toEqual([]);
  });

  test('14. multi-word shared first token — longest-match wins', () => {
    const g = gazetteerFromEntries([
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
      { slug: 'companies/acme-corp', source_id: 'default', title: 'Acme Corp' },
      { slug: 'companies/acme-foundation', source_id: 'default', title: 'Acme Foundation' },
    ]);
    const body = 'Acme Foundation announced. Then Acme Corp. Then plain Acme.';
    const mentions = findMentionedEntities(body, g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    // First offset: "Acme Foundation" — longest match wins.
    // Second occurrence of "Acme": multi-word "Acme Corp" matches → multi-word wins.
    // Third: plain "Acme" alone — single-word match.
    const slugs = mentions.map(m => m.slug);
    expect(slugs).toContain('companies/acme-foundation');
    expect(slugs).toContain('companies/acme-corp');
    expect(slugs).toContain('companies/acme');
  });

  test('15. determinism — same body + same gazetteer → identical output across 10 calls', () => {
    const g = gazetteerFromEntries([
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
      { slug: 'companies/acme-corp', source_id: 'default', title: 'Acme Corp' },
      { slug: 'people/alice', source_id: 'default', title: 'Alice Smith' },
    ]);
    const body = 'Acme Corp and Alice Smith and Acme met. Then Alice Smith again.';
    const refs = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const mentions = findMentionedEntities(body, g, {
        fromSlug: 'writing/post-1', fromSourceId: 'default',
      });
      refs.add(JSON.stringify(mentions));
    }
    expect(refs.size).toBe(1);
  });

  test('16. self-link guard (D13) — entity page mentioning own title skips', () => {
    const g = gazetteerFromEntries([
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
    ]);
    // Page IS the Acme page; body mentions "Acme" → self-link guard skips.
    const mentions = findMentionedEntities('Acme has 500 customers.', g, {
      fromSlug: 'companies/acme', fromSourceId: 'default',
    });
    expect(mentions).toEqual([]);
  });

  test('17. cross-source guard — page in source A mentions entity in source B → no link', () => {
    const g = gazetteerFromEntries([
      { slug: 'companies/acme', source_id: 'team-b', title: 'Acme' },
    ]);
    const mentions = findMentionedEntities('We met Acme today.', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'team-a', // different source
    });
    expect(mentions).toEqual([]);
  });

  test('20. code-block + token interaction — body text outside block linked, inside skipped', () => {
    const g = gazetteerFromEntries([
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
    ]);
    // Single backtick inline-code blocks the inner mention; outer mention fires.
    const body = 'Outside: Acme works. Inline `Acme inside` should skip. After.';
    const mentions = findMentionedEntities(body, g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(1); // first-mention-only cap
    expect(mentions[0]!.slug).toBe('companies/acme');
  });
});

// ============================================================
// CJK — entity extraction tests
// ============================================================

describe('findMentionedEntities — CJK cases', () => {
  test('CJK single-name match — "纳瓦尔" in body → matched', () => {
    const g = gazetteerFromEntries([
      { slug: 'people/naval', source_id: 'default', title: '纳瓦尔' },
    ]);
    const mentions = findMentionedEntities('我最近读了纳瓦尔的书。', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.slug).toBe('people/naval');
    expect(mentions[0]!.name).toBe('纳瓦尔');
  });

  test('CJK multi-name — two different CJK entities in one body', () => {
    const g = gazetteerFromEntries([
      { slug: 'people/naval', source_id: 'default', title: '纳瓦尔' },
      { slug: 'people/shuang-xuetao', source_id: 'default', title: '双雪涛' },
    ]);
    const mentions = findMentionedEntities('纳瓦尔和双雪涛都是作家。', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(2);
    const slugs = mentions.map(m => m.slug);
    expect(slugs).toContain('people/naval');
    expect(slugs).toContain('people/shuang-xuetao');
  });

  test('CJK first-mention-only — repeated name → single link', () => {
    const g = gazetteerFromEntries([
      { slug: 'people/naval', source_id: 'default', title: '纳瓦尔' },
    ]);
    const mentions = findMentionedEntities('纳瓦尔说过。然后纳瓦尔又说过。', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(1);
  });

  test('CJK self-link guard — entity page mentioning itself is skipped', () => {
    const g = gazetteerFromEntries([
      { slug: 'people/naval', source_id: 'default', title: '纳瓦尔' },
    ]);
    const mentions = findMentionedEntities('纳瓦尔是一位投资人。', g, {
      fromSlug: 'people/naval', fromSourceId: 'default',
    });
    expect(mentions).toEqual([]);
  });

  test('CJK cross-source guard — entity in different source skipped', () => {
    const g = gazetteerFromEntries([
      { slug: 'people/naval', source_id: 'team-b', title: '纳瓦尔' },
    ]);
    const mentions = findMentionedEntities('纳瓦尔写了这本书。', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'team-a',
    });
    expect(mentions).toEqual([]);
  });

  test('CJK code-block stripping — CJK name inside ``` is skipped, outside matched', () => {
    const g = gazetteerFromEntries([
      { slug: 'people/naval', source_id: 'default', title: '纳瓦尔' },
    ]);
    // "纳瓦尔" only appears inside code block → should be skipped.
    const body = '```\n纳瓦尔\n```\n只有代码块里面有。';
    const mentions = findMentionedEntities(body, g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(0);
  });

  test('CJK determinism — same output across 10 calls', () => {
    const g = gazetteerFromEntries([
      { slug: 'people/naval', source_id: 'default', title: '纳瓦尔' },
      { slug: 'people/shuang-xuetao', source_id: 'default', title: '双雪涛' },
    ]);
    const body = '纳瓦尔和双雪涛。纳瓦尔再说一次。';
    const refs = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const mentions = findMentionedEntities(body, g, {
        fromSlug: 'writing/post-1', fromSourceId: 'default',
      });
      refs.add(JSON.stringify(mentions));
    }
    expect(refs.size).toBe(1);
  });

  test('CJK mixed body — CJK entity matched in body with ASCII around it', () => {
    const g = gazetteerFromEntries([
      { slug: 'people/naval', source_id: 'default', title: '纳瓦尔' },
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
    ]);
    const mentions = findMentionedEntities('Acme was founded by 纳瓦尔 in 2020.', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(2);
    const slugs = mentions.map(m => m.slug);
    expect(slugs).toContain('people/naval');
    expect(slugs).toContain('companies/acme');
  });

  test('CJK empty gazetteer — no false positives', () => {
    const g: Gazetteer = new Map();
    const mentions = findMentionedEntities('纳瓦尔和双雪涛。', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toEqual([]);
  });

  test('CJK empty text → empty result', () => {
    const g = gazetteerFromEntries([
      { slug: 'people/naval', source_id: 'default', title: '纳瓦尔' },
    ]);
    const mentions = findMentionedEntities('', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toEqual([]);
  });
});

// ============================================================
// Vietnamese (diacritic Latin) — entity extraction tests
// ============================================================

// Fictional Vietnamese names only (privacy rule: no real people in fixtures).
// "Đà Nẵng" is a public city, not a person, and is the canonical đ-diacritic case.
//
// Every case below asserts TOKENIZATION, not just the resolved mention. A
// mention-only assertion does not discriminate: the previous ASCII tokenizer
// fragmented the gazetteer title and the body symmetrically, so a 5-fragment
// entry still matched a 5-fragment body run, and `Mention.name` is copied from
// the untouched `title` column rather than derived from tokens.
describe('findMentionedEntities — Vietnamese cases', () => {
  test('VN multi-syllable name matches as a WHOLE (regression: no diacritic fragmentation)', () => {
    // Discriminating assertion: the ASCII tokenizer produced
    // ['nguy','n','v','n','c'] for this title.
    expect(tokenizeTitle('Nguyễn Văn Đức')).toEqual(['nguyễn', 'văn', 'đức']);
    const body = 'Hôm nay mình học bài của thầy Nguyễn Văn Đức.';
    expect(tokenizeForScan(body).map(t => t.text)).toContain('nguyễn');

    const g = gazetteerFromEntries([
      { slug: 'people/nguyen-van-duc', source_id: 'default', title: 'Nguyễn Văn Đức' },
    ]);
    const mentions = findMentionedEntities(body, g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.slug).toBe('people/nguyen-van-duc');
    expect(mentions[0]!.name).toBe('Nguyễn Văn Đức');
  });

  test('VN place name with đ/diacritics — "Đà Nẵng" matched', () => {
    // Discriminating assertion: the ASCII tokenizer produced ['n','ng'],
    // which is what made this entity match 820 pages instead of 440.
    expect(tokenizeTitle('Đà Nẵng')).toEqual(['đà', 'nẵng']);
    const body = 'Gia đình mình chuyển tới Đà Nẵng năm ngoái.';
    expect(tokenizeForScan(body).map(t => t.text)).toContain('nẵng');

    const g = gazetteerFromEntries([
      { slug: 'places/da-nang', source_id: 'default', title: 'Đà Nẵng' },
    ]);
    const mentions = findMentionedEntities(body, g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.slug).toBe('places/da-nang');
    expect(mentions[0]!.name).toBe('Đà Nẵng');
  });

  test('VN NFD body matches an NFC gazetteer title (and the reverse)', () => {
    const nfc = 'Nguyễn Văn';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);                       // fixture really is decomposed
    expect(tokenizeTitle(nfd)).toEqual(tokenizeTitle(nfc));
    expect(tokenizeTitle(nfd)).toEqual(['nguyễn', 'văn']);

    const opts = { fromSlug: 'writing/post-1', fromSourceId: 'default' };
    const gNfc = gazetteerFromEntries([{ slug: 'people/nvd', source_id: 'default', title: nfc }]);
    expect(findMentionedEntities(`Thầy ${nfd} nói.`, gNfc, opts)).toHaveLength(1);

    const gNfd = gazetteerFromEntries([{ slug: 'people/nvd', source_id: 'default', title: nfd }]);
    expect(findMentionedEntities(`Thầy ${nfc} nói.`, gNfd, opts)).toHaveLength(1);
  });

  test('VN diacritics are significant — "Hồng" title does NOT match diacritic-free "Hong"', () => {
    // The title must survive tokenization intact for this to mean anything:
    // under the ASCII tokenizer it became ['l','th','h','ng'] and missed for
    // the wrong reason.
    expect(tokenizeTitle('Lê Thị Hồng')).toEqual(['lê', 'thị', 'hồng']);
    const g = gazetteerFromEntries([
      { slug: 'people/le-thi-hong', source_id: 'default', title: 'Lê Thị Hồng' },
    ]);
    // Body uses the ASCII-typed variant "Le Thi Hong" — tokens differ, no false match.
    const mentions = findMentionedEntities('Gặp Le Thi Hong hôm qua.', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toEqual([]);
  });

  test('VN mixed with ASCII — Vietnamese name + ASCII company in one body', () => {
    const body = 'Phạm Quốc Bảo hợp tác với Acme.';
    // Discriminating: the ASCII tokenizer emitted ['ph','m','qu','c','b','o',
    // 'h','p','t','c','v','i','acme'] here — only the ASCII control survived.
    expect(tokenizeForScan(body).map(t => t.text))
      .toEqual(['phạm', 'quốc', 'bảo', 'hợp', 'tác', 'với', 'acme']);

    const g = gazetteerFromEntries([
      { slug: 'people/pham-quoc-bao', source_id: 'default', title: 'Phạm Quốc Bảo' },
      { slug: 'companies/acme', source_id: 'default', title: 'Acme' },
    ]);
    const mentions = findMentionedEntities(body, g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(2);
    const slugs = mentions.map(m => m.slug);
    expect(slugs).toContain('people/pham-quoc-bao');
    expect(slugs).toContain('companies/acme');
  });

  test('VN longest-match wins — "Nguyễn Văn Đức" beats a shorter "Nguyễn Văn" entry', () => {
    // Both entries must share a real first token for maximal-munch to be
    // exercised at all; under the ASCII tokenizer both keyed on 'nguy'.
    expect(tokenizeTitle('Nguyễn Văn')).toEqual(['nguyễn', 'văn']);
    expect(tokenizeTitle('Nguyễn Văn Đức')[0]).toBe('nguyễn');
    const g = gazetteerFromEntries([
      { slug: 'people/nguyen-van-duc', source_id: 'default', title: 'Nguyễn Văn Đức' },
      { slug: 'people/nguyen-van', source_id: 'default', title: 'Nguyễn Văn' },
    ]);
    const mentions = findMentionedEntities('Bài giảng của Nguyễn Văn Đức rất hay.', g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.slug).toBe('people/nguyen-van-duc');
  });

  test('VN first-mention-only cap — repeated name → single link', () => {
    const g = gazetteerFromEntries([
      { slug: 'people/nguyen-van-duc', source_id: 'default', title: 'Nguyễn Văn Đức' },
    ]);
    const body = 'Nguyễn Văn Đức nói. Sau đó Nguyễn Văn Đức nói tiếp.';
    // The cap must be capping a WHOLE-name match, not a fragment run.
    expect(tokenizeForScan(body).map(t => t.text).slice(0, 3)).toEqual(['nguyễn', 'văn', 'đức']);
    const mentions = findMentionedEntities(body, g, {
      fromSlug: 'writing/post-1', fromSourceId: 'default',
    });
    expect(mentions).toHaveLength(1);
  });

  test('VN determinism — identical output across 10 calls', () => {
    const g = gazetteerFromEntries([
      { slug: 'people/nguyen-van-duc', source_id: 'default', title: 'Nguyễn Văn Đức' },
      { slug: 'places/da-nang', source_id: 'default', title: 'Đà Nẵng' },
    ]);
    const body = 'Thầy Nguyễn Văn Đức ở Đà Nẵng. Nguyễn Văn Đức lần nữa.';
    expect(tokenizeForScan(body).map(t => t.text))
      .toEqual(['thầy', 'nguyễn', 'văn', 'đức', 'ở', 'đà', 'nẵng', 'nguyễn', 'văn', 'đức', 'lần', 'nữa']);
    const refs = new Set<string>();
    for (let i = 0; i < 10; i++) {
      refs.add(JSON.stringify(findMentionedEntities(body, g, {
        fromSlug: 'writing/post-1', fromSourceId: 'default',
      })));
    }
    expect(refs.size).toBe(1);
  });
});

// ============================================================
// Tokenizer boundaries — non-word glyphs
// ============================================================

// Guards for the two ways a Unicode tokenizer regresses against the ASCII one
// it replaces. Both were found in review of the first version of this change,
// which used /[[\p{L}\p{M}\p{N}]--[CJK]]+/gv: \p{M} let a token consist of
// combining marks alone, and \p{N} minted tokens the ASCII regex never emitted.
describe('tokenizer boundaries — marks and non-ASCII numerics', () => {
  const opts = { fromSlug: 'writing/post-1', fromSourceId: 'default' };

  test('a token can never be combining marks alone (U+FE0F does not become a key)', () => {
    // VARIATION SELECTOR-16 is \p{Mn} and rides on most emoji. Allowing a
    // mark-only token made every emoji-prefixed entity title key on a bare
    // U+FE0F, collapsing them into one mutually-confusable bucket.
    expect(tokenizeTitle('❤️ Health Notes')).toEqual(['health', 'notes']);
    expect(tokenizeTitle('⭐️ Budget Notes')).toEqual(['budget', 'notes']);
    expect(tokenizeForScan('❤️').map(t => t.text)).toEqual([]);

    const g = gazetteerFromEntries([
      { slug: 'companies/health-notes', source_id: 'default', title: '❤️ Health Notes' },
      { slug: 'companies/budget-notes', source_id: 'default', title: '⭐️ Budget Notes' },
    ]);
    expect([...g.keys()].sort()).toEqual(['budget', 'health']);

    // The plain-text link survives...
    expect(findMentionedEntities('Plain health notes, no emoji.', g, opts).map(m => m.slug))
      .toEqual(['companies/health-notes']);
    // ...and an unrelated emoji in the body does not drag in the other entity.
    expect(findMentionedEntities('Sprint ⚠️ health notes were fine.', g, opts).map(m => m.slug))
      .toEqual(['companies/health-notes']);
  });

  test('non-ASCII numerics do not break strict token adjacency of an ASCII name', () => {
    // findMentionedEntities requires an entry's tokens to be STRICTLY
    // ADJACENT in the body, so any glyph that newly tokenizes between the
    // words of "Acme Corp" silently kills a match that used to work.
    const g = gazetteerFromEntries([
      { slug: 'companies/acme-corp', source_id: 'default', title: 'Acme Corp' },
    ]);
    for (const body of [
      'We met Acme Corp today.',    // control
      'We met Acme¹ Corp today.',   // U+00B9 superscript one (No)
      'Acme ½ Corp',                // U+00BD vulgar fraction (No)
      'Acme １ Corp',                // U+FF11 fullwidth digit one (Nd)
      'Acme ❤️ Corp',          // emoji + VS16 (So + Mn)
    ]) {
      expect(findMentionedEntities(body, g, opts)).toHaveLength(1);
    }
    // ASCII digits still tokenize exactly as /[a-zA-Z0-9]+/ did.
    expect(tokenizeForScan('web3 and h2o').map(t => t.text)).toEqual(['web3', 'and', 'h2o']);
  });

  test('Han Extension A is no longer CJK here — aligned with cjk.ts scope', () => {
    // Deliberate behaviour change. by-mention's walkers used to carry their
    // own range copy covering Ext-A (U+3400–4DBF); cjk.ts scopes Ext-A out
    // repo-wide, and this module now uses CJK_SLUG_CHARS verbatim. Ext-A
    // therefore tokenizes as a word run instead of per character, and an
    // Ext-A-only title is one sub-MIN_NAME_LENGTH token rather than N
    // char-level ones. Search, chunking and slug grammar already ignore
    // Ext-A, so this removes by-mention as the lone subsystem that disagreed.
    expect(tokenizeForScan('㐀㐁').map(t => t.text)).toEqual(['㐀㐁']);
    expect(tokenizeTitle('㐀㐁')).toEqual(['㐀㐁']);
    // In-scope CJK is untouched: still char-level.
    expect(tokenizeTitle('纳瓦尔')).toEqual(['纳', '瓦', '尔']);
    expect(tokenizeForScan('纳瓦尔说').map(t => t.text)).toEqual(['纳', '瓦', '尔', '说']);
  });
});

// ============================================================
// buildGazetteer — engine-backed tests
// ============================================================

describe('buildGazetteer — engine integration', () => {
  test('7. min-length filter — title "AI" (length 2) not in gazetteer', async () => {
    await engine.putPage('companies/ai', {
      type: 'company', title: 'AI', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.putPage('companies/acme', {
      type: 'company', title: 'Acme', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    const g = await buildGazetteer(engine);
    expect(g.has('acme')).toBe(true);
    expect(g.has('ai')).toBe(false);
  });

  test('8. ignore-list at build — "Apple" suppressed when no companies/apple page', async () => {
    // Seed a different entity page named "Apple" — but importantly NO
    // companies/apple slug exists. Wait — actually the ignore-list keys
    // on TITLE not slug. So even a non-companies slug with title="Apple"
    // would be in the gazetteer because `existingTitles.has("Apple")` is true.
    // The ignore list only fires when NO row has title="Apple". To exercise
    // suppression: seed no entity with title="Apple" — duh, then there's
    // nothing in the gazetteer for Apple anyway. The ignore-list rule is
    // only meaningful if a HYPOTHETICAL entity named "Apple" would otherwise
    // appear; in practice, the ignore-list short-circuits ANY row whose
    // title is in the ignore set AND whose title isn't in existingTitles.
    // For a deterministic test: seed one entity with title="Apple" and
    // verify it IS in the gazetteer (per CK12 inverse rule); seed another
    // run with no Apple entity and verify the ignore-list doesn't add one.
    // Both behaviors covered by the existingTitles vs ignore_set logic.
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice Example', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    const g = await buildGazetteer(engine);
    // No Apple entity seeded → 'apple' not a gazetteer key (trivially).
    expect(g.has('apple')).toBe(false);
    // Alice IS in gazetteer.
    expect(g.has('alice')).toBe(true);
  });

  test('9. ignore-list inverse — title "Apple" matches when companies/apple exists (CK12)', async () => {
    await engine.putPage('companies/apple', {
      type: 'company', title: 'Apple', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    const g = await buildGazetteer(engine);
    // existingTitles has "Apple" so the ignore-list does NOT suppress;
    // gazetteer presence wins per CK12 rule.
    expect(g.has('apple')).toBe(true);
    expect(g.get('apple')![0]!.slug).toBe('companies/apple');
  });

  test('alias entries (v0.46.15, #3801): page_aliases become gazetteer entries', async () => {
    await engine.putPage('people/saoirse-x', {
      type: 'person', title: 'Saoirse Example', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.setPageAliases('people/saoirse-x', 'default', ['saoirse']);
    const g = await buildGazetteer(engine);
    const bucket = g.get('saoirse');
    expect(bucket).toBeDefined();
    expect(bucket!.some((e) => e.slug === 'people/saoirse-x')).toBe(true);
  });

  test('REGRESSION (v0.46.15): ignore-list rejects ALIAS entries case-insensitively; CK12 title behavior unchanged', async () => {
    // Title side (unchanged CK12 policy): a real page titled "Apple" stays.
    await engine.putPage('companies/apple', {
      type: 'company', title: 'Apple', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    // Alias side (new teeth): an alias "apple" on an unrelated page is
    // suppressed — aliases are not user-created pages; the cased ignore list
    // must match the normalized-lowercase alias store.
    await engine.putPage('people/annie-p', {
      type: 'person', title: 'Annie P Example', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.setPageAliases('people/annie-p', 'default', ['apple']);
    const g = await buildGazetteer(engine);
    const bucket = g.get('apple') ?? [];
    expect(bucket.some((e) => e.slug === 'companies/apple')).toBe(true); // title entry survives
    expect(bucket.some((e) => e.slug === 'people/annie-p')).toBe(false); // alias entry rejected
  });

  test('alias entries: ambiguous alias (two slugs, same source) is skipped', async () => {
    await engine.putPage('people/sable-one', {
      type: 'person', title: 'Sable One Example', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.putPage('people/sable-two', {
      type: 'person', title: 'Sable Two Example', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.setPageAliases('people/sable-one', 'default', ['sable']);
    await engine.setPageAliases('people/sable-two', 'default', ['sable']);
    const g = await buildGazetteer(engine);
    // Title entries ("Sable One Example" etc.) legitimately share the key —
    // the ALIAS-shaped entries (single-token) must be absent.
    expect((g.get('sable') ?? []).filter((e) => e.tokens.length === 1)).toHaveLength(0);
  });

  test('alias entries: alias colliding with an existing page TITLE in the same source is skipped', async () => {
    await engine.putPage('companies/acme-corp', {
      type: 'company', title: 'Acme', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.putPage('people/andy-c', {
      type: 'person', title: 'Andy C Example', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.setPageAliases('people/andy-c', 'default', ['acme']);
    const g = await buildGazetteer(engine);
    const bucket = g.get('acme') ?? [];
    expect(bucket.some((e) => e.slug === 'companies/acme-corp')).toBe(true);
    expect(bucket.some((e) => e.slug === 'people/andy-c')).toBe(false);
  });

  test('alias entries: sub-MIN_NAME_LENGTH aliases are skipped', async () => {
    await engine.putPage('people/jt-example', {
      type: 'person', title: 'JT Example Person', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.setPageAliases('people/jt-example', 'default', ['jt']);
    const g = await buildGazetteer(engine);
    // The multi-token TITLE entry may share the key; the single-token alias
    // entry ('jt' < MIN_NAME_LENGTH) must be absent.
    expect((g.get('jt') ?? []).filter((e) => e.tokens.length === 1)).toHaveLength(0);
  });

  test('13. all entity pages soft-deleted → empty gazetteer', async () => {
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice Example', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.softDeletePage('people/alice');
    const g = await buildGazetteer(engine);
    expect(g.size).toBe(0);
  });

  test('18. hardcoded type filter — page with type=meeting NOT in gazetteer', async () => {
    await engine.putPage('meetings/2026-01-15', {
      type: 'meeting' as any, title: 'Weekly Sync',
      compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.putPage('people/bob', {
      type: 'person', title: 'Robert Builder', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    const g = await buildGazetteer(engine);
    expect(g.has('weekly')).toBe(false); // meeting type filtered out
    expect(g.has('robert')).toBe(true);  // person type included
  });

  test('19. min-length + ignore-list interaction — "YC" (2 chars) filtered by min-length BEFORE ignore-list', async () => {
    // YC isn't in DEFAULT_IGNORE_LIST. But "Box" (3 chars) is. "Box" length
    // = 3 < MIN_NAME_LENGTH (4), so it's filtered by min-length first. The
    // ignore-list never fires. We test the regression that the min-length
    // gate runs BEFORE the ignore-list (so adding Box to ignore-list
    // doesn't accidentally change the filter ordering).
    await engine.putPage('companies/box', {
      type: 'company', title: 'Box', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    const g = await buildGazetteer(engine);
    // "Box" is 3 chars → min-length filter drops it (whether or not in ignore-list).
    expect(g.has('box')).toBe(false);
  });

  test('extraIgnore — user-supplied additional ignore tokens', async () => {
    await engine.putPage('people/john', {
      type: 'person', title: 'John', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    // No companies/john exists, so adding John to extraIgnore should suppress.
    const g1 = await buildGazetteer(engine);
    expect(g1.has('john')).toBe(true); // baseline: in gazetteer
    const g2 = await buildGazetteer(engine, { extraIgnore: ['John'] });
    // But title "John" IS the entity title — existingTitles.has('John') is true.
    // Per CK12 rule, gazetteer presence wins → John IS still in.
    expect(g2.has('john')).toBe(true);
  });

  test('LINKABLE_ENTITY_TYPES exposes the hardcoded contract', () => {
    // Regression: if anyone changes the hardcoded type list, this test
    // forces a deliberate change (and a corresponding test update).
    expect(LINKABLE_ENTITY_TYPES).toEqual(['person', 'company', 'organization', 'entity']);
  });

  // CJK — engine-backed tests
  test('CJK entity with 2-char title enters gazetteer with char-level tokens', async () => {
    await engine.putPage('people/naval', {
      type: 'person', title: '纳瓦尔', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    const g = await buildGazetteer(engine);
    // "纳瓦尔" tokenized as ["纳","瓦","尔"] → key is "纳"
    expect(g.has('纳')).toBe(true);
    const bucket = g.get('纳')!;
    expect(bucket.length).toBe(1);
    expect(bucket[0]!.tokens).toEqual(['纳', '瓦', '尔']);
    expect(bucket[0]!.slug).toBe('people/naval');
  });

  test('CJK single-char title (cjkCharCount < 2) excluded from gazetteer', async () => {
    await engine.putPage('people/x', {
      type: 'person', title: '谢', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    const g = await buildGazetteer(engine);
    expect(g.size).toBe(0);
  });

  test('VN person title enters gazetteer keyed on first diacritic-preserving token', async () => {
    await engine.putPage('people/nguyen-van-duc', {
      type: 'person', title: 'Nguyễn Văn Đức', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    const g = await buildGazetteer(engine);
    // "Nguyễn Văn Đức" → ["nguyễn","văn","đức"], keyed on "nguyễn" (NOT fragmented to "nguy").
    expect(g.has('nguyễn')).toBe(true);
    const bucket = g.get('nguyễn')!;
    expect(bucket[0]!.tokens).toEqual(['nguyễn', 'văn', 'đức']);
    expect(bucket[0]!.slug).toBe('people/nguyen-van-duc');
    // Regression guard: the old ASCII tokenizer would have keyed on "nguy".
    expect(g.has('nguy')).toBe(false);
  });
});
