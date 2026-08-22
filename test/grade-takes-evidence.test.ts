/**
 * #2811 — grade_takes evidence retrieval is REAL now.
 *
 * Pre-fix, defaultEvidenceRetriever returned the literal placeholder
 * '[evidence retrieval not yet wired — v0.36.1.0 ship-state]' and the whole
 * calibration loop graded takes against their own claim text — every verdict
 * was structurally 'unresolvable'.
 *
 * Post-fix: hybrid search on the take's claim (expansion off, source-scoped,
 * own page excluded) + the pure formatEvidenceBlock (effective_date vs
 * since_date annotation, ~500c/item clamp, 4k block cap, no-evidence +
 * fail-open fallbacks). PROMPT_VERSION moved off '-stub' so cached stub
 * verdicts are cleanly invalidated.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  formatEvidenceBlock,
  defaultEvidenceRetriever,
  GRADE_TAKES_PROMPT_VERSION,
  EVIDENCE_ITEM_CLAMP_CHARS,
  EVIDENCE_BLOCK_CAP_CHARS,
  type EvidenceHit,
} from '../src/core/cycle/grade-takes.ts';
import { __setEmbedTransportForTests, resetGateway, configureGateway } from '../src/core/ai/gateway.ts';
import type { Take, BrainEngine } from '../src/core/engine.ts';

function makeTake(overrides: Partial<Take> = {}): Take {
  return {
    id: 1,
    page_id: 1,
    page_slug: 'companies/acme-corp',
    claim: 'Acme Corp will double ARR by Q4 2024',
    kind: 'bet',
    holder: 'brain',
    weight: 0.7,
    since_date: '2024-01',
    ...overrides,
  } as unknown as Take;
}

// ─── formatEvidenceBlock (pure) ─────────────────────────────────────

describe('formatEvidenceBlock (#2811)', () => {
  test('zero hits → explicit no-evidence note steering to unresolvable', () => {
    const block = formatEvidenceBlock(makeTake(), []);
    expect(block).toContain('No evidence found');
    expect(block).toContain('2024-01');
    expect(block).toContain('unresolvable');
    expect(block).not.toContain('not yet wired');
  });

  test('items carry slug + date and are annotated before/after the claim', () => {
    const hits: EvidenceHit[] = [
      { slug: 'notes/after', title: 'After', chunk_text: 'Acme doubled ARR in November.', effective_date: '2024-11-20' },
      { slug: 'notes/before', title: 'Before', chunk_text: 'Acme planned aggressive growth.', effective_date: '2023-06-01' },
      { slug: 'notes/undated', title: 'Undated', chunk_text: 'Acme ships weekly.', effective_date: null },
    ];
    const block = formatEvidenceBlock(makeTake(), hits);
    expect(block).toContain('[notes/after • 2024-11-20]');
    expect(block).toContain('(dated after the claim)');
    expect(block).toContain('[notes/before • 2023-06-01]');
    expect(block).toContain('BEFORE the claim');
    expect(block).toContain('[notes/undated • undated]');
  });

  test('same-month hit (YYYY-MM since_date) counts as after, not before', () => {
    const hits: EvidenceHit[] = [
      { slug: 'notes/same-month', title: 's', chunk_text: 'Acme signed the deal.', effective_date: '2024-01-20' },
    ];
    const block = formatEvidenceBlock(makeTake({ since_date: '2024-01' } as Partial<Take>), hits);
    expect(block).toContain('(dated after the claim)');
  });

  test('items clamp at ~500 chars and the block caps at 4k', () => {
    const long = 'x'.repeat(2000);
    const hits: EvidenceHit[] = Array.from({ length: 20 }, (_, i) => ({
      slug: `notes/long-${i}`,
      title: `L${i}`,
      chunk_text: long,
      effective_date: '2024-06-01',
    }));
    const block = formatEvidenceBlock(makeTake(), hits);
    // No single item body exceeds the clamp.
    expect(block).not.toContain('x'.repeat(EVIDENCE_ITEM_CLAMP_CHARS + 1));
    expect(block.length).toBeLessThanOrEqual(EVIDENCE_BLOCK_CAP_CHARS + 40);
    expect(block).toContain('[evidence truncated]');
  });

  test('hits with only whitespace text fall back to the no-usable-evidence note', () => {
    const hits: EvidenceHit[] = [
      { slug: 'notes/blank', title: 'b', chunk_text: '   \n  ', effective_date: null },
    ];
    const block = formatEvidenceBlock(makeTake(), hits);
    expect(block).toContain('No usable evidence');
    expect(block).toContain('unresolvable');
  });
});

// ─── prompt version off the stub ────────────────────────────────────

describe('GRADE_TAKES_PROMPT_VERSION (#2811)', () => {
  test('moved off -stub so cached stub verdicts invalidate', () => {
    expect(GRADE_TAKES_PROMPT_VERSION).not.toContain('stub');
  });
});

// ─── defaultEvidenceRetriever over PGLite ───────────────────────────

describe('defaultEvidenceRetriever over PGLite (#2811)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    resetGateway();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    __setEmbedTransportForTests(
      (async ({ values }: { values: string[] }) => ({
        embeddings: values.map(() => Array.from({ length: 1536 }, () => 0.1)),
      })) as never,
    );
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    await engine.putPage('companies/acme-corp', {
      type: 'company',
      title: 'Acme Corp',
      compiled_truth: 'Acme Corp will double ARR by Q4 2024 — the take page itself.',
    });
    await engine.putPage('notes/acme-outcome', {
      type: 'note',
      title: 'Acme outcome update',
      compiled_truth: 'Acme Corp doubled ARR in November 2024, closing the year strong.',
    });
    // putPage does not chunk; sync/import does. Seed chunks the way a synced
    // brain carries them so the retriever has real chunk_text to format.
    await engine.upsertChunks('companies/acme-corp', [{
      chunk_index: 0,
      chunk_text: 'Acme Corp will double ARR by Q4 2024 — the take page itself.',
      chunk_source: 'compiled_truth',
      embedding: new Float32Array(1536).fill(0.1),
      token_count: 16,
    }]);
    await engine.upsertChunks('notes/acme-outcome', [{
      chunk_index: 0,
      chunk_text: 'Acme Corp doubled ARR in November 2024, closing the year strong.',
      chunk_source: 'compiled_truth',
      embedding: new Float32Array(1536).fill(0.1),
      token_count: 16,
    }]);
  });

  afterAll(async () => {
    __setEmbedTransportForTests(null);
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env },
    });
    await engine.disconnect();
  });

  test('retrieves real brain evidence and EXCLUDES the take\'s own page', async () => {
    const block = await defaultEvidenceRetriever(engine, makeTake(), { sourceId: 'default' });
    expect(block).toContain('notes/acme-outcome');
    expect(block).not.toContain('[companies/acme-corp');
    expect(block).not.toContain('not yet wired');
  }, 60000);

  test('source scope is honored: an empty source yields the no-evidence fallback', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('empty-src', 'Empty') ON CONFLICT (id) DO NOTHING`,
      [],
    );
    const block = await defaultEvidenceRetriever(engine, makeTake(), { sourceId: 'empty-src' });
    // The default source HAS matching evidence — none of it may leak into
    // an empty source's scope.
    expect(block).not.toContain('notes/acme-outcome');
    expect(block).toContain('unresolvable');
  }, 60000);

  test('fail-open: a broken engine degrades to a claim-only note instead of throwing', async () => {
    const broken = {
      executeRaw: async () => { throw new Error('db exploded'); },
      getConfig: async () => { throw new Error('db exploded'); },
    } as unknown as BrainEngine;
    const block = await defaultEvidenceRetriever(broken, makeTake(), { sourceId: 'default' });
    expect(block).toContain('[evidence retrieval failed');
    expect(block).toContain('Acme Corp will double ARR');
    expect(block).toContain('unresolvable');
  }, 60000);
});
