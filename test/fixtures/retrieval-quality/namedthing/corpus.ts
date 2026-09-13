/**
 * NamedThingBench seed corpus (T6) — the canonical in-memory brain that the
 * committed fixture (test/fixtures/retrieval-quality/namedthing.jsonl) is
 * written against. Placeholder names only (CLAUDE.md privacy rule).
 *
 * ONE source for two consumers, so a paid receipt and the CI gate describe the
 * SAME brain:
 *   - the hermetic gate (test/eval-retrieval-quality.test.ts): embed transport
 *     stubbed to throw, chunks land WITHOUT vectors → keyword + title + alias path;
 *   - the reranker A/B (scripts/r1-namedthing-rerank-ab.ts): `embed` supplied,
 *     every chunk stored with its real vector → the full hybrid pipeline.
 *
 * Sibling of relational/corpus.ts (same directory family, same "canonical
 * source for the seed loader" contract). Pages, chunk boundaries, aliases and
 * the `token_count: 10` stamp are exactly what the gate has always seeded —
 * change them only together with the fixture and its gate expectations.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../../../src/core/engine.ts';
import type { ChunkInput } from '../../../../src/core/types.ts';
import { parseQuestionsJsonl, type NamedThingQuestion } from '../../../../src/eval/retrieval-quality/harness.ts';

export interface NamedThingPage {
  slug: string;
  title: string;
  type: 'note' | 'person';
  /** One `content_chunks` row per entry (chunk_source compiled_truth); the page's compiled_truth is the entries joined by '\n'. */
  chunks: readonly string[];
  /** Declared aliases; `setPageAliases` receives them lower-cased (alias-synonym family). */
  aliases?: readonly string[];
}

export const NAMEDTHING_CORPUS: readonly NamedThingPage[] = [
  {
    slug: 'projects/example-amphitheater',
    title: 'The Example Hall — Indoor Greek Amphitheater for Adversarial Debate',
    type: 'note',
    chunks: [
      'Indoor greek amphitheater for adversarial debate in the city.',
      'Ceiling treatment acoustics for the amphitheater dome and seating.',
    ],
    aliases: ['Hall of Light'],
  },
  {
    slug: 'projects/example-civic-platform',
    title: 'Example Civic Feedback Platform',
    type: 'note',
    chunks: ['A civic feedback platform for the city to gather resident input.'],
    aliases: ['the widget tracker'],
  },
  {
    slug: 'people/alice-example',
    title: 'Alice Example',
    type: 'person',
    chunks: ['Alice works on the civic feedback platform and gathers resident input.'],
  },
];

/** The committed 12-query fixture this corpus answers. */
export const NAMEDTHING_FIXTURE_PATH = join(import.meta.dir, '..', 'namedthing.jsonl');

export function loadNamedThingQuestions(path: string = NAMEDTHING_FIXTURE_PATH): NamedThingQuestion[] {
  return parseQuestionsJsonl(readFileSync(path, 'utf8'));
}

/** Document-side batch embedder (the gateway's `embed`, or a deterministic stub). */
export type EmbedTexts = (texts: string[]) => Promise<Float32Array[]>;

export interface SeedNamedThingOpts {
  /** Source the pages land in. Default 'default' (what the gate and `hybridSearch(..., { sourceId: 'default' })` use). */
  sourceId?: string;
  /**
   * When supplied, every chunk text is embedded in ONE batch and stored with
   * its vector. Absent → chunks land without vectors (the hermetic path).
   */
  embed?: EmbedTexts;
}

export interface SeedNamedThingResult {
  pages: number;
  chunks: number;
  /** Chunks stored with a vector (0 on the hermetic path). */
  embedded: number;
  /** Characters sent to the embedder (spend accounting); 0 when not embedded. */
  embedded_chars: number;
}

/**
 * Seed the corpus into a fresh brain exactly the way the hermetic gate does:
 * `putPage` (compiled_truth = chunks joined), `upsertChunks` (one row per
 * chunk, `token_count: 10`), `setPageAliases` (lower-cased) when declared.
 */
export async function seedNamedThingCorpus(engine: BrainEngine, opts: SeedNamedThingOpts = {}): Promise<SeedNamedThingResult> {
  const sourceId = opts.sourceId ?? 'default';
  const allTexts = NAMEDTHING_CORPUS.flatMap(p => [...p.chunks]);
  let vectors: Float32Array[] | null = null;
  if (opts.embed) {
    vectors = await opts.embed(allTexts);
    if (vectors.length !== allTexts.length) {
      throw new Error(`seedNamedThingCorpus: embedder returned ${vectors.length} vector(s) for ${allTexts.length} chunk(s)`);
    }
  }
  let cursor = 0;
  let chunks = 0;
  for (const page of NAMEDTHING_CORPUS) {
    await engine.putPage(
      page.slug,
      { type: page.type, title: page.title, compiled_truth: page.chunks.join('\n') },
      { sourceId },
    );
    const ci: ChunkInput[] = page.chunks.map((text, i) => {
      const row: ChunkInput = { chunk_index: i, chunk_text: text, chunk_source: 'compiled_truth', token_count: 10 };
      if (vectors) row.embedding = vectors[cursor + i];
      return row;
    });
    cursor += page.chunks.length;
    chunks += ci.length;
    await engine.upsertChunks(page.slug, ci, { sourceId });
    if (page.aliases && page.aliases.length) {
      await engine.setPageAliases(page.slug, sourceId, page.aliases.map(a => a.toLowerCase()));
    }
  }
  return {
    pages: NAMEDTHING_CORPUS.length,
    chunks,
    embedded: vectors ? vectors.length : 0,
    embedded_chars: vectors ? allTexts.reduce((s, t) => s + t.length, 0) : 0,
  };
}
