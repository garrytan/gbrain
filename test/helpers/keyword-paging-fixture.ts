/**
 * Cat 40 Hard F2 fixture: a keyword corpus both engines can seed, plus a
 * keyword-mode walk through the real `search` op (cursor encoding included).
 * Shared by test/search-keyword-paging.test.ts (PGLite) and
 * test/e2e/search-keyword-paging-parity.test.ts (PGLite + Postgres).
 *
 * Corpus (term "quasar"): one dominant page whose body repeats the term in
 * DOMINANT_CHUNKS chunks, MANY_PAGES short notes, MIXED_TYPES pages of type
 * `meeting`, plus an OR-only pair (each page holds one of two words, never
 * both). All names are placeholders.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { operations } from '../../src/core/operations.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';

export const TERM = 'quasar';
export const DOMINANT_SLUG = 'ledgers/widget-co-ledger';
export const DOMINANT_CHUNKS = 300;
export const MANY_PAGES = 23;
export const MIXED_TYPES = 4;

export async function seedPage(engine: BrainEngine, slug: string, body: string, opts: { type?: string; title?: string; frontmatter?: Record<string, unknown> } = {}): Promise<void> {
  await importFromContent(engine, slug, serializeMarkdown(opts.frontmatter ?? {}, body, '', { type: opts.type ?? 'note', title: opts.title ?? slug, tags: [] }),
    { noEmbed: true, forceRechunk: true });
}

/** Seeds the corpus; returns every slug that matches TERM. */
export async function seedKeywordCorpus(engine: BrainEngine): Promise<string[]> {
  const slugs: string[] = [];
  await seedPage(engine, DOMINANT_SLUG, `The ${TERM} ledger for widget-co. Every entry below cites the ${TERM} invoice.`);
  // Hundreds of matching chunks on one page: copies of its first chunk (the chunk trigger indexes each row).
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, modality)
     SELECT cc.page_id, cc.chunk_index + g, cc.chunk_text || ' entry ' || g, cc.chunk_source, cc.modality
     FROM content_chunks cc JOIN pages p ON p.id = cc.page_id, generate_series(1, ${DOMINANT_CHUNKS - 1}) g
     WHERE p.slug = $1 AND cc.chunk_index = 0`, [DOMINANT_SLUG]);
  slugs.push(DOMINANT_SLUG);
  for (let i = 0; i < MANY_PAGES; i++) {
    const slug = `notes/acme-example-${String(i).padStart(2, '0')}`;
    await seedPage(engine, slug, `Note ${i} for acme-example mentions the ${TERM} rollout once.`);
    slugs.push(slug);
  }
  for (let i = 0; i < MIXED_TYPES; i++) {
    const slug = `meetings/alice-example-${i}`;
    await seedPage(engine, slug, `Meeting ${i} with alice-example about the ${TERM} budget.`, { type: 'meeting' });
    slugs.push(slug);
  }
  await seedPage(engine, 'notes/or-only-a', 'The zephyrine report is filed.');
  await seedPage(engine, 'notes/or-only-b', 'The obsidianite report is filed.');
  return slugs;
}

export interface Captured { rows: Array<Record<string, unknown>>; retrieval: Record<string, unknown> }

export function searchCtx(engine: BrainEngine, remote: boolean): OperationContext & { captured: Record<string, unknown> } {
  const captured: Record<string, unknown> = {};
  return {
    engine: engine as never, config: {} as never, logger: console as never, dryRun: false, remote, sourceId: 'default',
    ...(remote ? { transport: 'http' } : {}),
    emitResponseMeta: (key: string, value: unknown) => { captured[key] = value; },
    emitNotice: () => {},
    captured,
  } as unknown as OperationContext & { captured: Record<string, unknown> };
}

const searchOp = operations.find(o => o.name === 'search')!;

export async function callSearch(engine: BrainEngine, params: Record<string, unknown>, remote = true): Promise<Captured> {
  const ctx = searchCtx(engine, remote);
  const rows = await searchOp.handler(ctx, params) as Array<Record<string, unknown>>;
  return { rows, retrieval: (ctx.captured.retrieval ?? {}) as Record<string, unknown> };
}

/** Follows `next` until it is absent (or `maxPages`); returns every page and its slugs in order. */
export async function walkKeyword(engine: BrainEngine, first: Record<string, unknown>, remote = true, maxPages = 50,
  between?: (page: number) => Promise<void>): Promise<{ pages: Captured[]; slugs: string[] }> {
  const pages: Captured[] = [];
  let args: Record<string, unknown> | undefined = { ...first, match: 'keyword' };
  while (args && pages.length < maxPages) {
    const page = await callSearch(engine, args, remote);
    pages.push(page);
    if (between) await between(pages.length);
    args = page.retrieval.next as Record<string, unknown> | undefined;
  }
  return { pages, slugs: pages.flatMap(p => p.rows.map(r => String(r.slug))) };
}
