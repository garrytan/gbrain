import { describe, test, expect } from 'bun:test';
import { RipgrepBm25Adapter } from './ripgrep-bm25.ts';
import type { Page, Query } from '../types.ts';

function mkPage(slug: string, title: string, compiled_truth: string, timeline = ''): Page {
  return {
    slug,
    type: 'person',
    title,
    compiled_truth,
    timeline,
  };
}

const CORPUS: Page[] = [
  mkPage('people/alice-chen', 'Alice Chen',
    'Alice Chen is a senior engineer at Stripe. She founded a payments startup in 2022.'),
  mkPage('people/bob-kim', 'Bob Kim',
    'Bob Kim is a product manager at Acme Corp. He previously worked at Google.'),
  mkPage('people/carol-park', 'Carol Park',
    'Carol Park is a VC partner at Accel. She invests in early-stage fintech companies.'),
  mkPage('companies/stripe', 'Stripe',
    'Stripe is a payments infrastructure company founded by the Collison brothers. Alice Chen is a senior engineer on the platform team.'),
  mkPage('companies/accel', 'Accel',
    'Accel is a venture capital firm. Carol Park is a partner focused on fintech.'),
];

function mkQuery(id: string, text: string, relevant: string[]): Query {
  return {
    id,
    tier: 'easy',
    text,
    expected_output_type: 'cited-source-pages',
    gold: { relevant },
  };
}

describe('RipgrepBm25Adapter', () => {
  test('init returns opaque state without throwing', async () => {
    const adapter = new RipgrepBm25Adapter();
    const state = await adapter.init(CORPUS, { name: 'ripgrep-bm25' });
    expect(state).toBeDefined();
  });

  test('query for person name ranks their page first', async () => {
    const adapter = new RipgrepBm25Adapter();
    const state = await adapter.init(CORPUS, { name: 'ripgrep-bm25' });
    const results = await adapter.query(mkQuery('q1', 'Alice Chen', ['people/alice-chen']), state);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].page_id).toBe('people/alice-chen');
    expect(results[0].rank).toBe(1);
  });

  test('query returns ranked list with increasing ranks', async () => {
    const adapter = new RipgrepBm25Adapter();
    const state = await adapter.init(CORPUS, { name: 'ripgrep-bm25' });
    const results = await adapter.query(mkQuery('q1', 'payments company', ['companies/stripe']), state);
    expect(results.length).toBeGreaterThan(0);
    for (let i = 0; i < results.length; i++) {
      expect(results[i].rank).toBe(i + 1);
    }
  });

  test('scores are monotonically non-increasing by rank', async () => {
    const adapter = new RipgrepBm25Adapter();
    const state = await adapter.init(CORPUS, { name: 'ripgrep-bm25' });
    const results = await adapter.query(mkQuery('q1', 'engineer at Stripe', []), state);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  test('query with no matching tokens returns empty', async () => {
    const adapter = new RipgrepBm25Adapter();
    const state = await adapter.init(CORPUS, { name: 'ripgrep-bm25' });
    const results = await adapter.query(mkQuery('q1', 'xyzznonexistent quatloos', []), state);
    expect(results.length).toBe(0);
  });

  test('stopword-only query returns empty', async () => {
    const adapter = new RipgrepBm25Adapter();
    const state = await adapter.init(CORPUS, { name: 'ripgrep-bm25' });
    const results = await adapter.query(mkQuery('q1', 'the of and', []), state);
    expect(results.length).toBe(0);
  });

  test('tie-break is deterministic by page_id when scores are equal', async () => {
    // Two identical pages (except slug) should tie on score; tie-break
    // must be stable-deterministic to keep benchmark runs reproducible.
    const adapter = new RipgrepBm25Adapter();
    const pages: Page[] = [
      mkPage('people/b-twin', 'Twin Page', 'same content'),
      mkPage('people/a-twin', 'Twin Page', 'same content'),
    ];
    const state = await adapter.init(pages, { name: 'ripgrep-bm25' });
    const results = await adapter.query(mkQuery('q1', 'same content', []), state);
    expect(results.length).toBe(2);
    // a-twin should come first by lexicographic tie-break.
    expect(results[0].page_id).toBe('people/a-twin');
    expect(results[1].page_id).toBe('people/b-twin');
  });

  test('BM25 rewards term frequency but not linearly (k1 saturation)', async () => {
    const adapter = new RipgrepBm25Adapter();
    const pages: Page[] = [
      // Three mentions of "widget" in body.
      mkPage('p/three', 'Threefold', 'widget widget widget plus filler'),
      // Ten mentions — should NOT score 10/3x higher (k1 saturation).
      mkPage('p/ten', 'Tenfold',
        'widget widget widget widget widget widget widget widget widget widget plus filler'),
    ];
    const state = await adapter.init(pages, { name: 'ripgrep-bm25' });
    const results = await adapter.query(mkQuery('q1', 'widget', []), state);
    expect(results.length).toBe(2);
    // Tenfold should rank higher, but not by a 10/3 ratio.
    const tenScore = results.find(r => r.page_id === 'p/ten')!.score;
    const threeScore = results.find(r => r.page_id === 'p/three')!.score;
    expect(tenScore).toBeGreaterThan(threeScore);
    // Saturation check: 10x frequency should not produce 3x the score.
    expect(tenScore / threeScore).toBeLessThan(2.0);
  });

  test('doc-length normalization penalizes very long docs', async () => {
    // Same number of "widget" mentions, but very different doc lengths —
    // the shorter doc should rank higher (widget is a larger fraction of content).
    const adapter = new RipgrepBm25Adapter();
    const filler = 'alpha beta gamma delta epsilon zeta eta theta iota kappa '
      .repeat(50);
    const pages: Page[] = [
      mkPage('p/short', 'Short', 'widget widget'),
      mkPage('p/long', 'Long', `widget widget ${filler}`),
    ];
    const state = await adapter.init(pages, { name: 'ripgrep-bm25' });
    const results = await adapter.query(mkQuery('q1', 'widget', []), state);
    expect(results[0].page_id).toBe('p/short');
  });

  test('IDF: rare terms score higher than common terms', async () => {
    const adapter = new RipgrepBm25Adapter();
    const pages: Page[] = [
      mkPage('p/a', 'A', 'common rare'),
      mkPage('p/b', 'B', 'common filler'),
      mkPage('p/c', 'C', 'common filler filler'),
      mkPage('p/d', 'D', 'common filler filler filler'),
    ];
    const state = await adapter.init(pages, { name: 'ripgrep-bm25' });
    // "rare" appears in 1/4 docs; "common" in 4/4. A match on "rare"
    // should rank higher than a match on "common" alone.
    const rareResults = await adapter.query(mkQuery('q1', 'rare', []), state);
    const commonResults = await adapter.query(mkQuery('q2', 'common', []), state);
    // Every doc has "common", but only p/a has "rare".
    expect(rareResults[0].page_id).toBe('p/a');
    // The "rare" top score should be higher than the "common" top score
    // because rare has higher IDF.
    expect(rareResults[0].score).toBeGreaterThan(commonResults[0].score);
  });

  test('slug tokens are indexed (people/alice-chen -> alice matches)', async () => {
    // Queries mentioning the slug indirectly (via name) should find the page
    // even if the slug itself doesn't appear in content exactly.
    const adapter = new RipgrepBm25Adapter();
    const pages: Page[] = [
      mkPage('people/alice-chen', 'Alice', 'See people/alice-chen for bio.'),
    ];
    const state = await adapter.init(pages, { name: 'ripgrep-bm25' });
    const results = await adapter.query(mkQuery('q1', 'alice chen', []), state);
    expect(results.length).toBe(1);
    expect(results[0].page_id).toBe('people/alice-chen');
  });
});
