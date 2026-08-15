/**
 * Relational benchmark corpus (v0.43).
 *
 * A small entity graph whose relational answers are LEXICALLY UNRECOVERABLE:
 * every page body is generic and NEVER names the entity it relates to. Only
 * the typed edge connects them, so keyword + vector retrieval cannot surface
 * the answer — isolating the contribution of the typed-edge recall arm.
 *
 * Canonical source for BOTH the seed loader and the question set, so the
 * corpus and the gold answers can't drift. `relational.jsonl` is generated
 * from RELATIONAL_QUESTIONS (a drift test pins them equal).
 */

import type { BrainEngine } from '../../../../src/core/engine.ts';
import type { ChunkInput } from '../../../../src/core/types.ts';
import type { NamedThingQuestion } from '../../../../src/eval/retrieval-quality/harness.ts';

// edge maps: target entity → entities related to it via that edge type.
// invested_in / led_round point INTO the company (people/funds → company).
const INVESTMENTS: Record<string, string[]> = {
  'companies/widget-co': ['people/alice-example', 'people/bob-example', 'funds/fund-a'],
  'companies/acme-co': ['people/carol-example', 'people/alice-example', 'funds/fund-b'],
  'companies/novapay': ['people/bob-example', 'funds/fund-a'],
  'companies/mindbridge': ['people/dave-example', 'people/carol-example'],
  'companies/helio': ['people/erin-example', 'funds/fund-b'],
  'companies/quanta': ['people/frank-example', 'people/alice-example'],
  'companies/zenith': ['people/grace-example', 'people/heidi-example'],
  'companies/orbital': ['people/ivan-example', 'people/alice-example'],
};
const EMPLOYMENT: Record<string, string[]> = {
  'companies/widget-co': ['people/erin-example', 'people/grace-example'],
  'companies/acme-co': ['people/dave-example', 'people/frank-example'],
  'companies/novapay': ['people/grace-example'],
  'companies/helio': ['people/heidi-example'],
  'companies/zenith': ['people/ivan-example'],
};
const FOUNDED: Record<string, string[]> = {
  'companies/mindbridge': ['people/carol-example'],
  'companies/quanta': ['people/frank-example'],
  'companies/widget-co': ['people/ivan-example'],
  'companies/orbital': ['people/grace-example'],
};
const ADVISES: Record<string, string[]> = {
  'companies/novapay': ['people/frank-example'],
  'companies/helio': ['people/alice-example'],
};

// Generic, cross-mention-free bodies keyed by slug prefix.
function bodyFor(slug: string): string {
  if (slug.startsWith('companies/')) return 'A privately held company operating in its sector. Founded some years ago; details are sparse in this note.';
  if (slug.startsWith('funds/')) return 'An early-stage venture fund. Writes first checks; portfolio is not enumerated here.';
  return 'An individual in the network. Background and current focus are not described in this note.';
}

function titleFor(slug: string): string {
  const tail = slug.split('/')[1];
  return tail.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Every distinct slug in the graph. */
function allSlugs(): string[] {
  const set = new Set<string>();
  for (const map of [INVESTMENTS, EMPLOYMENT, FOUNDED, ADVISES]) {
    for (const [company, members] of Object.entries(map)) {
      set.add(company);
      for (const m of members) set.add(m);
    }
  }
  return [...set].sort();
}

function pageType(slug: string): 'company' | 'person' {
  // funds + people render as person-ish entity pages; companies as company.
  return slug.startsWith('companies/') ? 'company' : 'person';
}

// Deterministic per-slug basis embedding so pages are properly indexed
// (chunked) like a real brain. The query has no embedding in CI (no API key),
// so vector search can't connect entities anyway — but the pages must carry a
// chunk to be searchable at all. Body text stays generic + cross-mention-free.
// `dim` MUST match the schema's embedding column, which tracks the configured
// gateway default (1280 ZE / 1536 OpenAI) and can shift with shard order —
// so callers probe the real width via probeEmbeddingDim rather than hardcode.
function basisEmbedding(slug: string, dim: number): Float32Array {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  const e = new Float32Array(dim);
  e[h % dim] = 1.0;
  return e;
}

/**
 * Probe the actual `content_chunks.embedding` column width. pgvector stores
 * the dimension in `atttypmod` directly. Tests must size fixtures to this, not
 * a hardcoded 1536 — the column tracks the gateway default and a prior test in
 * the same shard can leave it at 1280 (ZE). Mirrors pglite-engine.test.ts.
 */
export async function probeEmbeddingDim(engine: BrainEngine): Promise<number> {
  const db = (engine as unknown as { db: { query: (sql: string) => Promise<{ rows: Array<{ atttypmod: number }> }> } }).db;
  const r = await db.query(
    `SELECT atttypmod FROM pg_attribute
       WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`,
  );
  return r.rows[0].atttypmod;
}

/** Seed the corpus into a fresh brain. Bodies never name related entities. */
export async function seedRelationalCorpus(engine: BrainEngine): Promise<void> {
  const dim = await probeEmbeddingDim(engine);
  for (const slug of allSlugs()) {
    const body = bodyFor(slug);
    await engine.putPage(slug, {
      type: pageType(slug),
      title: titleFor(slug),
      compiled_truth: body,
      timeline: '',
    });
    await engine.upsertChunks(slug, [{
      chunk_index: 0,
      chunk_text: body,
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(slug, dim),
      token_count: body.split(/\s+/).length,
    }] satisfies ChunkInput[]);
  }
  const addAll = async (map: Record<string, string[]>, linkType: string) => {
    for (const [company, members] of Object.entries(map)) {
      for (const m of members) {
        // edge points member → company (member invested_in / works_at / founded / advises company)
        await engine.addLink(m, company, '', linkType, 'manual');
      }
    }
  };
  await addAll(INVESTMENTS, 'invested_in');
  await addAll(EMPLOYMENT, 'works_at');
  await addAll(FOUNDED, 'founded');
  await addAll(ADVISES, 'advises');
}

function bareName(slug: string): string {
  return slug.split('/')[1];
}

/** Generate the gold question set from the same maps used to seed. */
export function buildRelationalQuestions(): NamedThingQuestion[] {
  const qs: NamedThingQuestion[] = [];

  for (const [company, investors] of Object.entries(INVESTMENTS)) {
    qs.push({
      family: 'graph-relationship', kind: 'who_rel', seed: company, linkTypes: ['invested_in', 'led_round'],
      query: `who invested in ${bareName(company)}`, relevant: investors,
    });
  }
  for (const [company, employees] of Object.entries(EMPLOYMENT)) {
    qs.push({
      family: 'graph-relationship', kind: 'who_rel', seed: company, linkTypes: ['works_at'],
      query: `who works at ${bareName(company)}`, relevant: employees,
    });
  }
  for (const [company, founders] of Object.entries(FOUNDED)) {
    qs.push({
      family: 'graph-relationship', kind: 'who_rel', seed: company, linkTypes: ['founded'],
      query: `who founded ${bareName(company)}`, relevant: founders,
    });
  }
  for (const [company, advisors] of Object.entries(ADVISES)) {
    qs.push({
      family: 'graph-relationship', kind: 'who_rel', seed: company, linkTypes: ['advises'],
      query: `who advises ${bareName(company)}`, relevant: advisors,
    });
  }

  // connects: company pairs that share at least one related entity (any edge).
  const relatedTo = (company: string): Set<string> => {
    const s = new Set<string>();
    for (const map of [INVESTMENTS, EMPLOYMENT, FOUNDED, ADVISES]) for (const m of map[company] ?? []) s.add(m);
    return s;
  };
  const companies = Object.keys(INVESTMENTS);
  for (let i = 0; i < companies.length; i++) {
    for (let j = i + 1; j < companies.length; j++) {
      const a = companies[i], b = companies[j];
      const shared = [...relatedTo(a)].filter(x => relatedTo(b).has(x));
      if (shared.length === 0) continue;
      qs.push({
        family: 'graph-relationship', kind: 'connects', seed: `${a} ↔ ${b}`, linkTypes: undefined,
        query: `what connects ${bareName(a)} and ${bareName(b)}`, relevant: shared.sort(),
      });
    }
  }

  return qs;
}

export const RELATIONAL_QUESTIONS: NamedThingQuestion[] = buildRelationalQuestions();
