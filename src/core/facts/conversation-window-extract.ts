/**
 * One conversation window through the extractor (extract-conversation-facts, #6267 windows): the model call (or the
 * injected extractor), save-time entity resolution and subject inference, and the fact rows the page publishes. Shared
 * by the command's whole-page pass and the segmented page's per-occurrence pass (conversation-incremental.ts), with the
 * page outcome rows both publish and the parser-input version token they bind to.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine, NewFact } from '../engine.ts';
import type { Page } from '../types.ts';
import { observationDateFrom, resolveObservationDate, type ObservationDate } from '../ai/date-grounding.ts';
import { BudgetExhausted } from '../budget/budget-tracker.ts';
import { deriveDateContext } from '../conversation-parser/parse.ts';
import { resolveExtractedEntitiesForSave, type SaveTimeResolutionCounts } from '../entities/resolve-on-save.ts';
import { NON_EXTRACTABLE_AUDIT_SOURCE, TERMINAL_AUDIT_SOURCE, stampExtractorVersion } from './audit-sources.ts';
import { CONVERSATION_ENTITY_HINTS_CAP } from './conversation-entity-hints.ts';
import { CONVERSATION_FACTS_SOURCE_PREFIX, type ConversationFactRow } from './conversation-publication.ts';
import { inferConversationSubjects } from './conversation-subject-infer.ts';
import type { ConversationSegment } from './conversation-types.ts';
import { extractFactsFromTurnWithOutcome, type ExtractInput, type ExtractedFact } from './extract.ts';
import { tightenToPage, type FactVisibility } from './visibility.ts';

/** What one window's extraction needs from the run. */
export interface ConversationWindowRun {
  engine: BrainEngine;
  sourceId: string;
  factVisibility: FactVisibility;
  signal: AbortSignal | undefined;
  /** Injected per-segment extractor (BrainBench decision 15); undefined runs the production fail-hard extractor. */
  extractor?: (input: ExtractInput) => Promise<ExtractedFact[]>;
}

/**
 * A conversation fact's valid_from: a validated event date the extractor
 * stated (date-grounding variant) wins; else the segment start, except the
 * epoch fallback (no trustworthy date → the insert's now() default).
 */
function segmentValidFrom(extracted: Date | undefined, startIso: string | undefined): { valid_from?: Date } {
  if (extracted) return { valid_from: extracted };
  return startIso && !startIso.startsWith('1970-') ? { valid_from: new Date(startIso) } : {};
}

/**
 * Observation date of a conversation segment (date-grounding.ts): the
 * segment's own timestamp when it came from the transcript itself or the
 * page's frontmatter date — never the synthetic epoch fallback, and never a
 * timestamp the parser derived from effective_date (which may be an event
 * date). Otherwise the page's observation date, or null (unknown).
 */
export function segmentObservationDate(page: Pick<Page, 'slug' | 'frontmatter' | 'effective_date'>, startIso: string | undefined): ObservationDate | null {
  const day = startIso?.slice(0, 10);
  const context = deriveDateContext({ page: page as Page });
  const explicit = !!day && !day.startsWith('1970-')
    && (context.source === 'explicit' || context.source === 'frontmatter_date' || day !== context.fallbackDate);
  return explicit ? observationDateFrom(startIso) : resolveObservationDate({ slug: page.slug, frontmatter: page.frontmatter });
}

/**
 * Extract one rendered window. The production path is fail-hard with a reason: a failed window aborts the page rather
 * than dropping facts, and BudgetExhausted is rethrown unwrapped (#3669) so the run halts with a budget receipt.
 * Rows are numbered from `rowNum`; publication renumbers them under the page lock.
 */
export async function extractConversationWindow(run: ConversationWindowRun, page: Page, seg: ConversationSegment, text: string, rowNum: number,
  entityHints: ExtractInput['entityHints']): Promise<{ extracted: number; rows: ConversationFactRow[]; resolution: SaveTimeResolutionCounts }> {
  const sessionId = `${CONVERSATION_FACTS_SOURCE_PREFIX}:${page.slug}`;
  let extracted: ExtractedFact[];
  const input: ExtractInput = { turnText: text, sessionId, source: CONVERSATION_FACTS_SOURCE_PREFIX, engine: run.engine, abortSignal: run.signal,
    entityHints, entityHintsCap: CONVERSATION_ENTITY_HINTS_CAP };
  if (run.extractor) {
    extracted = await run.extractor(input);
  } else {
    const extraction = await extractFactsFromTurnWithOutcome({ ...input, observationDate: segmentObservationDate(page, seg.startIso) });
    if (!extraction.ok) {
      if (extraction.error instanceof BudgetExhausted) throw extraction.error;
      const detail = extraction.error instanceof Error ? `: ${extraction.error.message}` : '';
      throw Object.assign(new Error(`segment ${seg.startIso}..${seg.endIso} extraction failed (${extraction.reason})${detail}`,
        extraction.error === undefined ? undefined : { cause: extraction.error }), { extractionReason: extraction.reason });
    }
    extracted = extraction.facts;
  }
  // This bulk path bypasses writeSingleFact and writes through insertFacts: every extractor-provided entity goes
  // through the shipped resolver (alias_exact / prefix / fuzzy / slugify) while source scope is known.
  const resolution = await resolveExtractedEntitiesForSave(run.engine, run.sourceId, extracted, (raw, message) => {
    process.stderr.write(`[extract-conversation-facts] ${page.slug} segment ${seg.startIso}..${seg.endIso} `
      + `entity resolution failed for ${JSON.stringify(raw)}: ${message}; preserving fact without an entity target\n`);
  });
  if (extracted.length === 0) return { extracted: 0, rows: [], resolution };
  const visibility = tightenToPage(run.factVisibility, page);
  const rows = await inferConversationSubjects(run.engine, run.sourceId, visibility, extracted.map((fact, i) => ({ // #6764
    ...fact, visibility,
    row_num: rowNum + i,
    source_markdown_slug: page.slug,
    source: CONVERSATION_FACTS_SOURCE_PREFIX,
    source_session: sessionId,
    ...segmentValidFrom(fact.valid_from, seg.startIso),
    context: fact.context ?? `from ${page.slug} segment ${seg.startIso}..${seg.endIso}`,
  })));
  return { extracted: extracted.length, rows, resolution };
}

/**
 * The parser-input version token of a page read from its own body. content_hash covers title, type, compiled_truth,
 * timeline, and frontmatter; unlike JavaScript Date, it cannot collapse distinct PostgreSQL updates within one
 * millisecond. effective_date is parser input too.
 */
export function regularPageVersionToken(page: Page): string {
  const hash = page.content_hash ?? createHash('sha256')
    .update(JSON.stringify({
      title: page.title,
      type: page.type,
      compiled_truth: page.compiled_truth,
      timeline: page.timeline || '',
      frontmatter: page.frontmatter || {},
    }))
    .digest('hex');
  const effectiveDate = page.effective_date
    ? new Date(page.effective_date).toISOString().slice(0, 10)
    : 'none';
  return `page-${hash}-${effectiveDate}`;
}

export function outcomeSession(source: string, slug: string, versionToken: string): string {
  return `${source}:${slug}:${versionToken}`;
}

type OutcomeRow = NewFact & { row_num: number; source_markdown_slug: string };

/** The page outcome of a complete extraction, bound to the parser-input version it read. */
export function terminalAuditFact(slug: string, rowNum: number, versionToken: string): OutcomeRow {
  return {
    fact: 'EXTRACTION_COMPLETE',
    kind: 'fact',
    entity_slug: null,
    source: TERMINAL_AUDIT_SOURCE,
    source_session: outcomeSession(TERMINAL_AUDIT_SOURCE, slug, versionToken),
    confidence: 1.0,
    notability: 'low',
    context: stampExtractorVersion(null),
    row_num: rowNum,
    source_markdown_slug: slug,
  };
}

/** The durable not-extractable outcome: stops repeated scans of a page version with nothing to extract. */
export function nonExtractableAuditFact(slug: string, rowNum: number, versionToken: string, reason: string): OutcomeRow {
  return {
    fact: 'EXTRACTION_NOT_APPLICABLE',
    kind: 'fact',
    entity_slug: null,
    source: NON_EXTRACTABLE_AUDIT_SOURCE,
    source_session: outcomeSession(NON_EXTRACTABLE_AUDIT_SOURCE, slug, versionToken),
    confidence: 1.0,
    notability: 'low',
    context: stampExtractorVersion(`scanned, not extractable: ${reason}`),
    row_num: rowNum,
    source_markdown_slug: slug,
  };
}
