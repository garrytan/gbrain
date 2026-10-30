/**
 * GBRA-60 (git-canonical memory, G6): a managed dream synthesis child verifies and stamps each page before it writes
 * it, so a strict source commits each output once, holding its verified body. The quote-verify repair and provenance
 * stamp are the ones postprocessing applies (synthesize-postprocess.ts): `verifyDreamPage` plus the S8 grounding pass
 * against the transcript, then `dream_generated`, the cycle dates, `raw_source` and `seat` on a page that is dream output.
 * Postprocessing then finds nothing to change and skips its publish; it stays the backstop for a child that could not
 * verify (a job queued by an older build, or a transcript this worker cannot read with the hash the cycle discovered).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { DreamOutputSpec } from '../minions/types.ts';
import { parseMarkdown, serializeMarkdown } from '../markdown.ts';
import { withoutOffPeriodTurns } from '../context/capture-consent.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { CONVERSATION_PAGE_URI_PREFIX } from './transcript-discovery.ts';
import { emptyQuoteVerifyStats, groundSource, verifyDreamPage, type QuoteVerifyStats, type VerifiablePage } from './synthesize-verify.ts';
import { attributionChecksEnabled } from './attribution-checks.ts';
import { resolveGroundingDecide, type GroundingStats } from './grounding-decide.ts';

const GROUNDING_COUNTS = ['pages', 'units', 'pass', 'quarantine', 'insufficient_context', 'margin_hold', 'kept_on_error', 'input_tokens', 'cost_usd'] as const;
/** The S8 grounding counts one child page added: the phase reports them in its own grounding stats. */
export type GroundingCounts = Partial<Record<typeof GROUNDING_COUNTS[number], number>>;

/** What a child's ledger row records about the page it wrote: the transcript it verified against, and that page's stats. */
export interface ChildVerification { transcript_hash: string; quote_verify: boolean; stats: QuoteVerifyStats; grounding?: GroundingCounts }

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The transcript the cycle discovered at `spec.raw_source`, read the way discovery read it (a conversation page's body,
 * or the corpus file with or without its off-period turns), or null when no reading has the discovered hash.
 */
async function readTranscript(engine: BrainEngine, spec: DreamOutputSpec): Promise<string | null> {
  const candidates: Array<string | null> = [];
  if (spec.raw_source.startsWith(CONVERSATION_PAGE_URI_PREFIX)) {
    const rest = spec.raw_source.slice(CONVERSATION_PAGE_URI_PREFIX.length);
    const cut = rest.indexOf('/');
    const page = (await engine.readPageSnapshot(rest.slice(cut + 1), { sourceId: rest.slice(0, cut) }))?.page;
    candidates.push(page && !isSegmentedPage(page) ? page.compiled_truth : null);
  } else if (spec.raw_source.startsWith('/')) {
    try {
      const raw = readFileSync(spec.raw_source, 'utf8');
      candidates.push(raw, spec.raw_source.endsWith('.txt') ? withoutOffPeriodTurns(spec.raw_source, raw) : null);
    } catch { /* unreadable on this worker: postprocessing verifies */ }
  }
  return candidates.find((content): content is string => content !== null && sha256(content) === spec.transcript_hash) ?? null;
}

/**
 * The verified, stamped markdown for each planned page, with what the child's ledger row records; null when the
 * transcript cannot be read with the discovered hash, or a page it would replace is segmented (the pages are written as
 * planned and postprocessing verifies them).
 */
export async function verifyChildPages(engine: BrainEngine, spec: DreamOutputSpec, sourceId: string,
  pages: Array<{ slug: string; content: string }>): Promise<Array<{ content: string; verification: ChildVerification }> | null> {
  const transcript = await readTranscript(engine, spec);
  if (transcript === null) return null;
  const source = groundSource(spec.raw_source, transcript);
  const supersession = spec.quote_verify ? await attributionChecksEnabled(engine) : false;
  const grounding = spec.quote_verify ? await resolveGroundingDecide(engine) : undefined;
  const out: Array<{ content: string; verification: ChildVerification }> = [];
  for (const { slug, content } of pages) {
    const stats = emptyQuoteVerifyStats();
    const before = grounding ? { ...grounding.stats } : undefined;
    const parsed = parseMarkdown(content, slug);
    const existing = (await engine.readPageSnapshot(slug, { sourceId }))?.page ?? null;
    if (existing && isSegmentedPage(existing)) return null;
    let page: VerifiablePage = { compiled_truth: parsed.compiled_truth, timeline: parsed.timeline ?? '', frontmatter: { ...parsed.frontmatter } };
    if (!existing || existing.frontmatter?.dream_generated === true) {
      const firstDate = page.frontmatter.dream_created_cycle_date || page.frontmatter.dream_cycle_date || spec.cycle_date;
      page.frontmatter = { ...page.frontmatter, dream_generated: true, dream_cycle_date: firstDate, dream_created_cycle_date: firstDate,
        raw_source: spec.raw_source, ...(spec.seat ? { seat: spec.seat } : {}) };
    }
    if (spec.quote_verify) {
      if (existing && existing.compiled_truth.trim() === page.compiled_truth.trim() && (existing.timeline ?? '').trim() === page.timeline.trim()) stats.skipped_unchanged++;
      else {
        const prior = existing ? { compiled_truth: existing.compiled_truth, timeline: existing.timeline ?? '', frontmatter: existing.frontmatter ?? {} } : null;
        if (prior) stats.preexisting_diffed++;
        const mechanical = verifyDreamPage(page, [source], { prior, checkedAt: spec.cycle_date, supersession }, stats);
        const verified = grounding ? await grounding.apply(mechanical, [source], `page:${sourceId}:${slug}`, spec.cycle_date) : mechanical;
        if (verified.changed) stats.pages_repaired++;
        page = { compiled_truth: verified.compiled_truth, timeline: verified.timeline, frontmatter: verified.frontmatter };
      }
    }
    out.push({ content: serializeMarkdown(page.frontmatter, page.compiled_truth, page.timeline, { type: parsed.type, title: parsed.title, tags: parsed.tags }),
      verification: { transcript_hash: spec.transcript_hash, quote_verify: spec.quote_verify, stats,
        ...(grounding && before ? { grounding: Object.fromEntries(GROUNDING_COUNTS.map(key => [key, grounding.stats[key] - before[key]])) } : {}) } });
  }
  return out;
}

/** Adds one child page's S8 grounding counts into the phase's grounding stats. */
export function addGroundingCounts(into: GroundingStats, from: GroundingCounts): void {
  for (const key of GROUNDING_COUNTS) {
    const value = from[key];
    if (typeof value === 'number' && Number.isFinite(value)) into[key] += value;
  }
}

/** Adds one child page's verify stats into the phase's. */
export function addVerifyStats(into: QuoteVerifyStats, from: Partial<QuoteVerifyStats>): void {
  for (const key of Object.keys(into) as Array<keyof QuoteVerifyStats>) {
    const value = from[key];
    if (typeof value === 'number' && Number.isFinite(value)) into[key] += value;
  }
}
