/**
 * Wave 15 P2.4 (#6333, [UC2] SHADOW ONLY): re-extracting an edited page
 * inserts reworded copies of one claim (pairwise cosine 0.86–0.93, under the
 * calibrated dedup threshold, and on an uncalibrated embedding model no
 * cosine dedup fires at all). The deterministic "same page, cosine ≥ 0.85,
 * no diverging guard token" rule is NOT allowed to drop anything this wave:
 * the backstop only counts `would_dedup_same_page` so the predicate's
 * false-drop rate is measured on fixtures before any behaviour ships.
 *
 * Positive fixture: four rewordings of one claim → counted 3, four rows kept.
 * Negative fixtures (Lisbon→Porto, approved→rejected, email→phone): the
 * second claim is a correction, both rows are kept, and the counter pins the
 * measured false positive (the guard tokens cannot tell them apart), which
 * is exactly why the drop path does not ship.
 *
 * Zero model calls: the chat and embedding transports are stubs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';

let engine: PGLiteEngine;
const DIMS = 1536;
const ENTITY = 'people/alice-example';
const LONG_BODY = 'this is a real meeting note longer than 80 chars '.repeat(3);

/**
 * Unit vectors: sqrt(0.9) on a dim private to the page plus sqrt(0.1) on a
 * dim private to the fact, so two facts of one page sit at cosine exactly
 * 0.9 and facts of different pages are orthogonal (the candidate query is
 * entity-wide and the rule inspects the nearest row, as in production where
 * a page's own rewording is the closest fact about the entity).
 */
let nextDim = 0;
const pageDim = new Map<string, number>();
function vectorFor(slug: string): number[] {
  if (!pageDim.has(slug)) pageDim.set(slug, nextDim++);
  const v = new Array<number>(DIMS).fill(0);
  v[pageDim.get(slug)!] = Math.sqrt(0.9);
  v[nextDim++] = Math.sqrt(0.1);
  return v;
}

function stubExtraction(fact: string, vector: number[]): void {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ facts: [{ fact, kind: 'fact', entity: ENTITY, confidence: 1.0, notability: 'high' }] }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub',
    providerId: 'test',
  }));
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => vector) })) as never);
}

async function extractOnce(slug: string, fact: string, vector: number[] = vectorFor(slug)) {
  stubExtraction(fact, vector);
  const ctx: FactsBackstopCtx = { engine, sourceId: 'default', sessionId: `sync:${slug}`, source: 'sync:import', mode: 'inline' };
  const r = await runFactsBackstop({ slug, type: 'meeting', compiled_truth: LONG_BODY, frontmatter: {} }, ctx);
  expect(r.mode).toBe('inline');
  if (r.mode !== 'inline') throw new Error('unreachable');
  return r;
}

async function activeRows(slug: string): Promise<Array<{ id: number; fact: string }>> {
  return engine.executeRaw<{ id: number; fact: string }>(
    `SELECT id, fact FROM facts WHERE source_id = 'default' AND source_session = $1 AND expired_at IS NULL ORDER BY id`, [`sync:${slug}`],
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage(ENTITY, { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example is a person.', timeline: '', frontmatter: {} });
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
});

afterAll(async () => { resetGateway(); await engine.disconnect(); });

afterEach(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  __resetFactsQueueForTests();
});

describe('#6333 shadow: same-page rewording counter, never a drop', () => {
  test('four rewordings of one claim on one page: counted 3 times, four rows kept, nothing expired', async () => {
    const slug = 'meetings/reworded-example';
    const rewordings = [
      'Alice Example leads the platform team at the example company',
      'Alice Example is the lead of the example company platform team',
      'At the example company, Alice Example heads the platform team',
      'The example company platform team is led by Alice Example',
    ];
    let counted = 0;
    for (const [i, fact] of rewordings.entries()) {
      const r = await extractOnce(slug, fact);
      expect(r.inserted).toBe(1);
      expect(r.duplicate).toBe(0);
      counted += r.would_dedup_same_page ?? 0;
      expect(r.would_dedup_same_page ?? 0).toBe(i === 0 ? 0 : 1);
    }
    expect(counted).toBe(3);
    const rows = await activeRows(slug);
    expect(rows.map((r) => r.fact)).toEqual(rewordings);
    const expired = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE source_session = $1 AND expired_at IS NOT NULL`, [`sync:${slug}`]);
    expect(Number(expired[0].n)).toBe(0);
  });

  test('a rewording from a different page is never counted (provenance must match exactly)', async () => {
    const a = 'meetings/provenance-a-example';
    const b = 'meetings/provenance-b-example';
    await extractOnce(a, 'Alice Example moved the weekly sync to Tuesday mornings');
    const r = await extractOnce(b, 'Alice Example shifted the weekly sync to Tuesday mornings');
    expect(r.inserted).toBe(1);
    expect(r.would_dedup_same_page ?? 0).toBe(0);
  });

  test('a pair under the 0.85 floor is never counted', async () => {
    const slug = 'meetings/far-apart-example';
    await extractOnce(slug, 'Alice Example prefers written updates over meetings');
    // sqrt(0.5) on the page dim → cosine 0.67 against the page's first fact.
    const far = new Array<number>(DIMS).fill(0);
    far[pageDim.get(slug)!] = Math.sqrt(0.5); far[nextDim++] = Math.sqrt(0.5);
    const r = await extractOnce(slug, 'Alice Example likes async written updates more than meetings', far);
    expect(r.inserted).toBe(1);
    expect(r.would_dedup_same_page ?? 0).toBe(0);
  });

  // Measured false positives: `claimsDiverge` guards negation, numbers,
  // dates and amounts only, so each correction below is counted as a
  // would-be duplicate. The rows are still inserted (no drop path); the
  // pinned counts are the published false-drop rate (3/3) that keeps the
  // automatic drop out of this wave.
  const negatives: Array<[string, string, string]> = [
    ['lisbon-porto', 'Alice Example lives in Lisbon', 'Alice Example lives in Porto'],
    ['approved-rejected', 'Alice Example approved the example vendor contract', 'Alice Example rejected the example vendor contract'],
    ['email-phone', 'Alice Example prefers to be reached by email', 'Alice Example prefers to be reached by phone'],
  ];
  for (const [name, before, after] of negatives) {
    test(`negative ${name}: the correction is inserted, never dropped; the counter pins the measured false positive`, async () => {
      const slug = `meetings/negative-${name}-example`;
      await extractOnce(slug, before);
      const r = await extractOnce(slug, after);
      expect(r.inserted).toBe(1);
      expect(r.duplicate).toBe(0);
      expect(r.fact_ids).toHaveLength(1);
      const rows = await activeRows(slug);
      expect(rows.map((x) => x.fact)).toEqual([before, after]);
      expect(r.would_dedup_same_page ?? 0).toBe(1);
    });
  }
});
