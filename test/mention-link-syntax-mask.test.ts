import { describe, expect, test } from 'bun:test';
import { findMentionedEntities, tokenizeTitle, type Gazetteer, type GazetteerEntry } from '../src/core/by-mention.ts';

function gazetteer(entries: Omit<GazetteerEntry, 'tokens'>[]): Gazetteer {
  const g: Gazetteer = new Map();
  for (const raw of entries) {
    const tokens = tokenizeTitle(raw.title);
    const bucket = g.get(tokens[0]!);
    const entry: GazetteerEntry = { ...raw, tokens };
    if (bucket) bucket.push(entry);
    else g.set(tokens[0]!, [entry]);
  }
  return g;
}

describe('mention scan ignores link syntax', () => {
  const g = gazetteer([
    { slug: 'products/widget-co', source_id: 'default', title: 'Widget Co' },
    { slug: 'projects/acme-example', source_id: 'default', title: 'Acme Example' },
  ]);
  const opts = { fromSlug: 'notes/n1', fromSourceId: 'default' };

  test('slug targets, link destinations and URLs yield no mentions', () => {
    const bodies = ['[[notes/widget-co-launch]]', '[[projects/acme-example-kernels|Kernels]]',
      '[Kernels](projects/acme-example-kernels)', 'https://docs.example.com/widget-co/setup'];
    const got = bodies.map(b => findMentionedEntities(b, g, opts).map(m => m.slug));
    expect(got).toEqual([[], [], [], []]);
  });

  test('display text and plain prose still mention', () => {
    const body = '[Acme Example](projects/x) and [[notes/y|Widget Co]] and Widget Co.';
    expect(findMentionedEntities(body, g, opts).map(m => m.slug).sort())
      .toEqual(['products/widget-co', 'projects/acme-example']);
  });
});
