import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchOpts } from '../../src/core/types.ts';
import { installFixtureChunks } from './page-projection.ts';

const vector = new Float32Array(1536);
vector[0] = 1;
const dates = [
  ['start', '2026-03-01T00:00:00Z'],
  ['before-precise', '2026-03-01T12:00:00.123455Z'],
  ['precise', '2026-03-01T12:00:00.123456Z'],
  ['after-precise', '2026-03-01T12:00:00.123457Z'],
  ['last-millisecond', '2026-03-01T23:59:59.999000Z'],
  ['last-microsecond', '2026-03-01T23:59:59.999999Z'],
  ['next-day', '2026-03-02T00:00:00Z'],
];

export async function seedSearchQueryContract(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('query-dates', 'query-dates'), ('query-order', 'query-order')`);
  for (const [name, timestamp] of dates) {
    const slug = `notes/${name}`;
    await engine.putPage(slug, { type: 'note', title: 'precisiontoken 東京', compiled_truth: 'precisiontoken 東京' }, { sourceId: 'query-dates' });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'precisiontoken 東京', embedding: vector }], { sourceId: 'query-dates' });
    await engine.executeRaw(`UPDATE pages SET effective_date = $1::text::timestamptz WHERE source_id = 'query-dates' AND slug = $2`, [timestamp, slug]);
  }
  for (let i = 0; i < 40; i++) {
    const slug = `notes/order-${String(i).padStart(2, '0')}`;
    await engine.putPage(slug, { type: 'note', title: 'ordertoken 東京', compiled_truth: 'ordertoken 東京 앨범 example 기획' }, { sourceId: 'query-order' });
    await installFixtureChunks(engine, slug, [0, 1].map(chunk_index => ({ chunk_index, chunk_source: 'compiled_truth', chunk_text: 'ordertoken 東京 앨범 example 기획' })), { sourceId: 'query-order' });
  }
  await engine.executeRaw(`UPDATE content_chunks SET chunk_text = chunk_text WHERE id % 2 = 0`);
}

export async function verifySearchDateBounds(engine: BrainEngine): Promise<void> {
  const arms = [
    (opts: SearchOpts) => engine.searchKeyword('precisiontoken', opts),
    (opts: SearchOpts) => engine.searchKeywordChunks('precisiontoken', opts),
    (opts: SearchOpts) => engine.searchKeyword('東京', opts),
    (opts: SearchOpts) => engine.searchKeywordChunks('東京', opts),
    (opts: SearchOpts) => engine.searchTitles('precisiontoken', opts),
    (opts: SearchOpts) => engine.searchVector(vector, opts),
  ];
  for (const arm of arms) {
    const find = async (bounds: SearchOpts) => (await arm({ limit: 100, sourceId: 'query-dates', ...bounds })).map(r => r.slug).sort();
    expect(await find({ afterDate: '2026-03-01', afterDateInclusive: true, beforeDate: '2026-03-02' }))
      .toEqual(dates.slice(0, -1).map(([name]) => `notes/${name}`).sort());
    expect(await find({ afterDate: '2026-03-01T12:00:00.123456Z', afterDateInclusive: true, beforeDate: '2026-03-01T12:00:00.123456Z', beforeDateInclusive: true }))
      .toEqual(['notes/precise']);
    expect(await find({ afterDate: '2026-03-01T04:00:00.123456-08:00', afterDateInclusive: true, beforeDate: '2026-03-01T13:00:00.123456+01:00', beforeDateInclusive: true }))
      .toEqual(['notes/precise']);
    expect(await find({ afterDate: '2026-03-01T12:00:00.123456Z', beforeDate: '2026-03-01T12:00:00.123458Z' }))
      .toEqual(['notes/after-precise']);
    expect(await find({ afterDate: '2026-03-01T12:00:00.123454Z', beforeDate: '2026-03-01T12:00:00.123456Z' }))
      .toEqual(['notes/before-precise']);
  }
}

export async function verifyKeywordTieOrder(engine: BrainEngine): Promise<void> {
  for (const query of ['ordertoken', '東京']) {
    const opts = { limit: 10, sourceId: 'query-order' };
    const expected = Array.from({ length: 10 }, (_, i) => `notes/order-${String(i).padStart(2, '0')}`);
    for (let run = 0; run < 3; run++) {
      const pages = await engine.searchKeyword(query, opts);
      expect(pages.map(r => r.slug)).toEqual(expected);
      const first = await engine.searchKeywordChunks(query, opts);
      const next = await engine.searchKeywordChunks(query, { ...opts, offset: 10 });
      const chunks = [...first, ...next];
      expect(chunks.map(r => r.chunk_id)).toEqual([...chunks].sort((a, b) => a.page_id - b.page_id || a.chunk_id - b.chunk_id).map(r => r.chunk_id));
      expect(new Set(chunks.map(r => r.chunk_id)).size).toBe(20);
      expect(chunks.map(r => r.slug)).toEqual(expected.flatMap(slug => [slug, slug]));
    }
  }
}

export async function verifyMixedCjkCase(engine: BrainEngine): Promise<void> {
  for (const search of [engine.searchKeyword.bind(engine), engine.searchKeywordChunks.bind(engine)]) {
    const hits = await search('앨범 ExAmPlE 기획', { limit: 10, sourceId: 'query-order' });
    expect(hits).toHaveLength(10);
    expect(hits.every(hit => hit.chunk_text.includes('example'))).toBe(true);
    expect(await search('앨범 MissingExample 기획', { sourceId: 'query-order' })).toEqual([]);
  }
}
