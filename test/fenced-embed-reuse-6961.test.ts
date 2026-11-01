/**
 * #6961: a write to a page with a facts or takes fence re-embeds only the chunks whose text changed. Before, the
 * A13 reuse gate turned off for any fenced page, so a one-row fact append re-embedded every chunk of the entity page.
 * A fenced page reuses only vectors whose recorded embedding input equals the one this import would embed; a legacy
 * vector with no recorded input is re-embedded there, since nothing proves it was computed from the sanitized text.
 *
 * PGLite always, Postgres when DATABASE_URL is set; the embedding transport is stubbed ($0).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { testBackends } from './helpers/test-backends.ts';

const DIMS = 1536;
let embedded: string[] = [];
let counter = 0;

function gateway() {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    embedded.push(...values);
    return { embeddings: values.map(() => { const v = new Array(DIMS).fill(0); v[counter++ % DIMS] = 1; return v; }), usage: { tokens: values.length } };
  }) as never);
}

const paragraph = (word: string) => Array.from({ length: 400 }, (_, i) => `${word}${i}`).join(' ') + '.';
const FENCE = (rows: string[]) => ['## Facts', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  ...rows.map((claim, i) => `| ${i + 1} | ${claim} | fact | 1.0 | world | medium | 2017-01-01 |  | chat |  |`), '<!--- gbrain:facts:end -->', ''].join('\n');
const PERSON = (facts: string[]) => `---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\n${
  ['alpha', 'bravo', 'charlie', 'delta'].map(w => `## Section ${w}\n\n${paragraph(w)}`).join('\n\n')}\n\n${FENCE(facts)}`;
const FACTS = ['Alice Example works at Acme Example', 'Alice Example lives in Springfield'];
const APPENDED = 'Alice Example joined the board of Fund A';

for (const backend of testBackends()) describe(`#6961 fenced page vector reuse (${backend})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  const chunkCount = async (slug: string) => (await engine.getChunks(slug, { includeUnsealed: true })).length;

  beforeAll(async () => { resetGateway(); gateway(); ({ engine, close } = await isolatedSharedSkillsEngine(backend === 'postgres' ? process.env.DATABASE_URL : undefined)); }, 120_000);
  afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close(); }, 60_000);
  beforeEach(() => { embedded = []; gateway(); });

  // Value: protects=a one-row fact append on a fenced entity page embeds only the chunk the row changed (#6961: about
  //   13-15M embedding tokens a day on one reference brain); fails_when=the reuse gate is off for fenced pages and every
  //   chunk is re-embedded; why_new=the only fenced-page reuse test pinned the full re-embed; seam=embed transport stub
  test('a one-row fact append re-embeds only the changed fence chunk', async () => {
    const slug = 'people/alice-example';
    await importFromContent(engine, slug, PERSON(FACTS));
    const total = await chunkCount(slug);
    expect(total).toBeGreaterThanOrEqual(4);
    embedded = [];
    await importFromContent(engine, slug, PERSON([...FACTS, APPENDED]));
    expect(embedded.length).toBeGreaterThan(0);
    expect(embedded.length).toBeLessThan(total);
    expect(embedded.some(text => text.includes(APPENDED))).toBe(true);
    for (const text of embedded) expect(text).not.toMatch(/alpha0 |bravo0 |charlie0 /);
    expect((await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true })).every(chunk => chunk.embedding)).toBe(true);
  }, 120_000);

  // Value: protects=a fenced page never reuses a vector whose input is unproven (no recorded embedding input), so no
  //   reused vector can carry text the sanitized chunk lacks; fails_when=the legacy raw-text branch (tier none, no stored mode)
  //   admits it on a fenced page; why_new=fenced pages reused nothing before #6961; seam=embedding_input_hash and the page mode cleared in SQL (a pre-provenance page)
  test('a legacy vector with no recorded input is re-embedded on a fenced page', async () => {
    const slug = 'people/alice-example-legacy';
    await engine.setConfig('search.contextual_retrieval', 'none');
    try {
      await importFromContent(engine, slug, PERSON(FACTS));
      const total = await chunkCount(slug);
      await engine.executeRaw(`UPDATE content_chunks SET embedding_input_hash = NULL WHERE page_id = (SELECT id FROM pages WHERE slug = $1)`, [slug]);
      await engine.executeRaw(`UPDATE pages SET contextual_retrieval_mode = NULL WHERE slug = $1`, [slug]);
      embedded = [];
      await importFromContent(engine, slug, PERSON([...FACTS, APPENDED]));
      expect(embedded.length).toBe(total);
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'search.contextual_retrieval'`);
    }
  }, 120_000);
});
