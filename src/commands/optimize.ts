import type { BrainEngine, LinkBatchInput, TimelineBatchInput } from '../core/engine.ts';
import type { ChunkInput, PageType } from '../core/types.ts';
import { chunkText } from '../core/chunkers/recursive.ts';
import { extractPageLinks, makeResolver, parseTimelineEntries } from '../core/link-extraction.ts';

const DEFAULT_MAX_WORDS = 300;
const DEFAULT_OVERLAP_WORDS = 50;
const DEFAULT_MAX_CHARS = 300;
const BATCH_SIZE = 100;

interface OptimizeOpts {
  dryRun: boolean;
  jsonMode: boolean;
  maxWords: number;
  overlapWords: number;
  maxChars: number;
  typeFilter?: PageType;
  skipExtract: boolean;
}

interface OptimizeResult {
  pages_processed: number;
  pages_rechunked: number;
  chunks_created: number;
  links_created: number;
  timeline_entries_created: number;
}

export async function runOptimize(engine: BrainEngine, args: string[]) {
  const opts = parseArgs(args);
  try {
    const result = await runOptimizeCore(engine, opts);
    if (opts.jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log([
        '',
        `Optimized ${result.pages_processed} pages`,
        `  rechunked pages: ${result.pages_rechunked}`,
        `  chunks created: ${result.chunks_created}`,
        `  links created: ${result.links_created}`,
        `  timeline entries created: ${result.timeline_entries_created}`,
        opts.dryRun ? 'Dry run only: no changes written.' : 'Done.',
      ].join('\n'));
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

export async function runOptimizeCore(engine: BrainEngine, opts: OptimizeOpts): Promise<OptimizeResult> {
  const result: OptimizeResult = {
    pages_processed: 0,
    pages_rechunked: 0,
    chunks_created: 0,
    links_created: 0,
    timeline_entries_created: 0,
  };

  const slugs = Array.from(await engine.getAllSlugs());
  const existingSlugs = new Set(slugs);
  const pageTypes = new Map<string, PageType>();
  for (const slug of slugs) {
    const page = await engine.getPage(slug);
    if (page) pageTypes.set(slug, page.type);
  }
  const resolver = makeResolver(engine, { mode: 'batch' });
  const linkBatch: LinkBatchInput[] = [];
  const timelineBatch: TimelineBatchInput[] = [];

  const flushLinks = async () => {
    if (linkBatch.length === 0) return;
    result.links_created += await engine.addLinksBatch(linkBatch.splice(0));
  };
  const flushTimeline = async () => {
    if (timelineBatch.length === 0) return;
    result.timeline_entries_created += await engine.addTimelineEntriesBatch(timelineBatch.splice(0));
  };

  const dryRunLinks = new Set<string>();
  const dryRunTimeline = new Set<string>();

  for (const slug of slugs) {
    const page = await engine.getPage(slug);
    if (!page) continue;
    if (opts.typeFilter && page.type !== opts.typeFilter) continue;
    result.pages_processed++;

    const chunks = await engine.getChunks(slug);
    const shouldRechunk = chunks.length === 0
      || chunks.some(c => !c.embedded_at)
      || chunks.some(c => wordCount(c.chunk_text) > Math.ceil(opts.maxWords * 1.5))
      || chunks.some(c => c.chunk_text.length > opts.maxChars);

    if (shouldRechunk) {
      const nextChunks = buildChunks(page.compiled_truth, page.timeline, opts.maxWords, opts.overlapWords, opts.maxChars);
      result.pages_rechunked++;
      result.chunks_created += nextChunks.length;
      if (!opts.dryRun) {
        await engine.upsertChunks(slug, nextChunks);
      }
    }

    if (opts.skipExtract) continue;

    const fullContent = `${page.compiled_truth}\n${page.timeline}`;
    const extracted = await extractPageLinks(slug, fullContent, page.frontmatter, page.type, resolver);
    const linkedEntities = new Set<string>();
    for (const link of await engine.getLinks(slug)) {
      if (isTimelineEntity(pageTypes.get(link.to_slug))) linkedEntities.add(link.to_slug);
    }
    for (const link of await engine.getBacklinks(slug)) {
      if (isTimelineEntity(pageTypes.get(link.from_slug))) linkedEntities.add(link.from_slug);
    }
    for (const candidate of extracted.candidates) {
      const fromSlug = candidate.fromSlug ?? slug;
      if (!existingSlugs.has(fromSlug) || !existingSlugs.has(candidate.targetSlug)) continue;
      if (fromSlug === slug && isTimelineEntity(pageTypes.get(candidate.targetSlug))) {
        linkedEntities.add(candidate.targetSlug);
      }
      const input: LinkBatchInput = {
        from_slug: fromSlug,
        to_slug: candidate.targetSlug,
        link_type: candidate.linkType,
        context: candidate.context,
        link_source: candidate.linkSource,
        origin_slug: candidate.originSlug,
        origin_field: candidate.originField,
      };
      if (opts.dryRun) {
        const key = `${input.from_slug}::${input.to_slug}::${input.link_type}::${input.link_source ?? 'markdown'}`;
        if (!dryRunLinks.has(key)) {
          dryRunLinks.add(key);
          result.links_created++;
        }
      } else {
        linkBatch.push(input);
        if (linkBatch.length >= BATCH_SIZE) await flushLinks();
      }
    }

    for (const entry of parseTimelineEntries(fullContent)) {
      const pageInput: TimelineBatchInput = {
        slug,
        date: entry.date,
        summary: entry.summary,
        detail: entry.detail || '',
      };
      const propagatedInputs: TimelineBatchInput[] = [...linkedEntities].map(entitySlug => ({
        slug: entitySlug,
        date: entry.date,
        source: slug,
        summary: entry.summary,
        detail: entry.detail || `From ${slug}`,
      }));
      const inputs = [pageInput, ...propagatedInputs];
      if (opts.dryRun) {
        for (const input of inputs) {
          const key = `${input.slug}::${input.date}::${input.summary}`;
          if (!dryRunTimeline.has(key)) {
            dryRunTimeline.add(key);
            result.timeline_entries_created++;
          }
        }
      } else {
        timelineBatch.push(...inputs);
        if (timelineBatch.length >= BATCH_SIZE) await flushTimeline();
      }
    }

    for (const entry of await engine.getTimeline(slug)) {
      if (linkedEntities.size === 0) continue;
      const inputs: TimelineBatchInput[] = [...linkedEntities].map(entitySlug => ({
        slug: entitySlug,
        date: formatDate(entry.date),
        source: slug,
        summary: entry.summary,
        detail: entry.detail || `From ${slug}`,
      }));
      if (opts.dryRun) {
        for (const input of inputs) {
          const key = `${input.slug}::${input.date}::${input.summary}`;
          if (!dryRunTimeline.has(key)) {
            dryRunTimeline.add(key);
            result.timeline_entries_created++;
          }
        }
      } else {
        timelineBatch.push(...inputs);
        if (timelineBatch.length >= BATCH_SIZE) await flushTimeline();
      }
    }
  }

  if (!opts.dryRun) {
    await flushLinks();
    await flushTimeline();
  }

  return result;
}

function buildChunks(compiledTruth: string, timeline: string, maxWords: number, overlapWords: number, maxChars: number): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  if (compiledTruth.trim()) {
    for (const c of chunkText(compiledTruth, { chunkSize: maxWords, chunkOverlap: overlapWords })) {
      pushBoundedChunks(chunks, c.text, 'compiled_truth', maxChars);
    }
  }
  if (timeline.trim()) {
    for (const c of chunkText(timeline, { chunkSize: maxWords, chunkOverlap: overlapWords })) {
      pushBoundedChunks(chunks, c.text, 'timeline', maxChars);
    }
  }
  return chunks;
}

function pushBoundedChunks(chunks: ChunkInput[], text: string, source: 'compiled_truth' | 'timeline', maxChars: number) {
  for (const part of splitByChars(text, maxChars)) {
    chunks.push({
      chunk_index: chunks.length,
      chunk_text: part,
      chunk_source: source,
      token_count: wordCount(part),
    });
  }
}

function isTimelineEntity(type: PageType | undefined): boolean {
  return type === 'person' || type === 'company';
}

function formatDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function splitByChars(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return [trimmed];

  const parts: string[] = [];
  let remaining = trimmed;
  while (remaining.length > maxChars) {
    let cut = Math.max(
      remaining.lastIndexOf('\n\n', maxChars),
      remaining.lastIndexOf('\n', maxChars),
      remaining.lastIndexOf('. ', maxChars),
      remaining.lastIndexOf(' ', maxChars),
    );
    if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
    const head = remaining.slice(0, cut).trim();
    if (head) parts.push(head);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function parseArgs(args: string[]): OptimizeOpts {
  const maxWords = numberFlag(args, '--max-words', DEFAULT_MAX_WORDS);
  const overlapWords = numberFlag(args, '--overlap-words', Math.min(DEFAULT_OVERLAP_WORDS, Math.floor(maxWords / 6)));
  const maxChars = numberFlag(args, '--max-chars', DEFAULT_MAX_CHARS);
  if (maxWords < 50) throw new Error('--max-words must be >= 50.');
  if (overlapWords < 0 || overlapWords >= maxWords) throw new Error('--overlap-words must be >= 0 and lower than --max-words.');
  if (maxChars < 200) throw new Error('--max-chars must be >= 200.');

  const typeIdx = args.indexOf('--type');
  const typeFilter = typeIdx >= 0 && typeIdx + 1 < args.length ? args[typeIdx + 1] as PageType : undefined;
  return {
    dryRun: args.includes('--dry-run'),
    jsonMode: args.includes('--json'),
    maxWords,
    overlapWords,
    maxChars,
    typeFilter,
    skipExtract: args.includes('--no-extract'),
  };
}

function numberFlag(args: string[], name: string, fallback: number): number {
  const idx = args.indexOf(name);
  if (idx < 0) return fallback;
  const raw = args[idx + 1];
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${name}: ${raw}`);
  return Math.floor(value);
}

function wordCount(text: string): number {
  return (text.match(/\S+/g) || []).length;
}
