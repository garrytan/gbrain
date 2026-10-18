/**
 * Segmented page storage (Wave B, spec 8.2 links, PR 2 full-pass mode): link
 * extraction over a segmented page's body, one block at a time
 * (segment-blocks.ts), with the result extractPageLinks gives for the joined
 * body: O(page) work, O(segment) memory, not yet incremental.
 *
 * Each block is extracted in a window (`bodyWindows`) and only references
 * starting in the block are kept, at their page offsets. The candidates are
 * merged in extractPageLinks' order (pass, then offset) with its
 * first-occurrence dedup, then the frontmatter's. The page-role priors read
 * the role phrases a first pass over the blocks found (rolePriorPhrases), and
 * one pack-regex budget serves the page.
 *
 * Exact for every rule that stays inside a window; a construct the segmenter
 * does not keep inside a segment (an HTML comment or a mid-line ``` run
 * crossing a cut, an attendees section longer than a window) is read within
 * its window.
 */
import type { BrainEngine } from '../engine.ts';
import {
  candidateKey, dedupeCandidates, extractBodyLinks, frontmatterLinks, rolePriorPhrases, stripCodeBlocks,
  type BodyLinkCandidate, type ExtractPageLinksOptions, type PageLinksResult, type SlugResolver,
} from '../link-extraction.ts';
import { datedLines, narrativeRefs } from '../link-temporal-evidence.ts';
import { rangedRelationLines } from '../link-effective.ts';
import type { TemporalBody } from '../link-temporal-apply.ts';
import { PageRegexBudget } from '../schema-pack/redos-guard.ts';
import type { PageType } from '../types.ts';
import { bodyBlocks, detachedValue, segmentedPassWork, type BodyBlock, type BodyBlockOptions } from './segment-blocks.ts';

/** Context a window carries after its block (an excerpt reaches 120 chars past a link) and, at least, before it. */
const CONTEXT_CHARS = 4096;
const HEADING = /^(#{1,6})[ \t]/;

export interface SegmentedLinkPage { id: number; slug: string; source_id: string; type: PageType; frontmatter: Record<string, unknown> }

/** A block in its window: `text[start, end)` is the block, at page offset `start + offset`. */
export interface BodyWindow { text: string; start: number; end: number; offset: number; block: BodyBlock }

/** Track the headings still open after `text`, by level (a heading closes every deeper one). */
function openHeadings(text: string, open: string[]): void {
  const masked = stripCodeBlocks(text);
  let at = 0;
  for (const line of masked.split('\n')) {
    const m = HEADING.exec(line);
    if (m) {
      open.length = m[1]!.length;
      open[m[1]!.length - 1] = text.slice(at, at + line.length);
    }
    at += line.length + 1;
  }
}

/**
 * Each block of a segmented body in a window: whole preceding blocks of at least CONTEXT_CHARS before it (a window
 * starts where parsers start fresh), the next CONTEXT_CHARS after it and, ahead of all, the headings still open
 * there, so section-scoped rules (role-prior suppression, machine sections, attendance sections) see the block's
 * section. A window that does not start the body opens with a blank line, so it never starts with frontmatter.
 */
export async function* bodyWindows(engine: BrainEngine, page: { id: number; slug: string; source_id?: string },
  opts: BodyBlockOptions = {}): AsyncIterable<BodyWindow> {
  const ahead: BodyBlock[] = [];
  const before: BodyBlock[] = [];
  const headings: string[] = [];
  let beforeChars = 0;
  const windowOf = (own: BodyBlock): BodyWindow => {
    const lead = before[0]?.at ?? own.at;
    const head = (lead === 0 ? '' : `\n${headings.filter(Boolean).map(h => `${h}\n`).join('')}`) + before.map(b => b.text).join('');
    let after = '';
    for (const b of ahead) {
      if (after.length >= CONTEXT_CHARS) break;
      after += b.text.slice(0, CONTEXT_CHARS - after.length);
    }
    segmentedPassWork.windows += head.length + own.text.length + after.length;
    return { text: head + own.text + after, start: head.length, end: head.length + own.text.length, offset: own.at - head.length, block: own };
  };
  const done = (own: BodyBlock) => {
    before.push(own);
    beforeChars += own.text.length;
    while (before.length > 1 && beforeChars - before[0]!.text.length >= CONTEXT_CHARS) {
      const gone = before.shift()!;
      beforeChars -= gone.text.length;
      openHeadings(gone.text, headings);
    }
  };
  for await (const block of bodyBlocks(engine, page, opts)) {
    ahead.push(block);
    while (ahead.length > 1 && ahead.slice(1).reduce((n, b) => n + b.text.length, 0) >= CONTEXT_CHARS) {
      const own = ahead.shift()!;
      yield windowOf(own);
      done(own);
    }
  }
  while (ahead.length) {
    const own = ahead.shift()!;
    yield windowOf(own);
    done(own);
  }
}

/** The page-role phrases of a segmented body (rolePriorPhrases over every block), as ExtractPageLinksOptions.roleText. */
export async function segmentedRoleText(engine: BrainEngine, page: { id: number; slug: string; source_id?: string },
  opts: BodyBlockOptions = {}): Promise<string> {
  const found: Array<string | null> = [null, null, null];
  for await (const block of bodyBlocks(engine, page, opts)) {
    rolePriorPhrases(block.text).forEach((phrase, i) => { found[i] ??= phrase; });
    if (found.every(Boolean)) break;
  }
  return found.filter(Boolean).join('\n');
}

/**
 * extractPageLinks(slug, `${compiled_truth}\n${timeline}`, ...) of a segmented page, streamed; `regions` narrows the
 * body (the remote mention effect reads the compiled truth only). With `temporal`, also collects the body's temporal
 * inputs (dated lines, narrative references, ranged relation lines) for publication. `onBlock` sees each block once,
 * in order, so a caller can parse the same read for something else.
 */
export async function extractSegmentedPageLinks(engine: BrainEngine, page: SegmentedLinkPage, resolver: SlugResolver,
  opts: ExtractPageLinksOptions & BodyBlockOptions & { temporal?: boolean; onBlock?: (block: BodyBlock) => void } = {}): Promise<PageLinksResult & { temporalBody?: TemporalBody }> {
  const roleText = opts.roleText ?? await segmentedRoleText(engine, page, opts);
  const regexBudget = opts.regexBudget ?? new PageRegexBudget();
  const kept = new Map<string, BodyLinkCandidate & { seq: number }>();
  const temporalBody: TemporalBody = { lines: [], narrative: [], ranged: [] };
  let seq = 0;
  let attendanceComplete = true;
  for await (const w of bodyWindows(engine, page, opts)) {
    const body = await extractBodyLinks(page.slug, w.text, page.type, resolver,
      { ...opts, roleText, regexBudget, window: { start: w.start, end: w.end, offset: w.offset } });
    attendanceComplete &&= body.attendanceComplete;
    opts.onBlock?.(w.block);
    for (const link of body.links) {
      const key = candidateKey(link.candidate);
      const prior = kept.get(key);
      if (!prior || link.pass < prior.pass || (link.pass === prior.pass && link.index < prior.index)) kept.set(key, { ...detachedValue(link), seq: seq++ });
    }
    if (!opts.temporal) continue;
    temporalBody.lines.push(...detachedValue(datedLines(w.block.text)));
    if (w.block.region === 'truth') temporalBody.narrative.push(...detachedValue(narrativeRefs(w.block.text)));
    for (const line of rangedRelationLines(w.text)) if (line.start >= w.start && line.start < w.end) temporalBody.ranged.push(detachedValue({ ...line, start: line.start + w.offset }));
  }
  const fm = await frontmatterLinks(page.slug, page.frontmatter, page.type, resolver, opts);
  const body = [...kept.values()].sort((a, b) => a.pass - b.pass || a.index - b.index || a.seq - b.seq).map(link => link.candidate);
  return { candidates: dedupeCandidates([...body, ...fm.candidates]), unresolved: fm.unresolved,
    attendanceComplete: attendanceComplete && fm.attendanceComplete, ...(opts.temporal ? { temporalBody } : {}) };
}
