/**
 * conversation_format_coverage check — peeled verbatim from src/commands/doctor.ts
 * (3d.3 v0.41.13.0) so it is unit-testable against PGLite, following the
 * computeExtractAtomsBacklogCheck pattern. doctor.ts re-exports it under the
 * facade rule.
 *
 * Scans the most recent conversation-type pages (50 per concrete type, granular aliases included),
 * runs parseConversation in dry mode, reports per-pattern hit counts +
 * unmatched count. Warn at >10% unmatched with paste-ready hint pointing at
 * `gbrain conversation-parser scan <slug>`.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { ALLOWED_TYPES, isConversationFactsEligiblePage, pageTypesForAllowed, requireParseableConversationFlag } from '../../../core/facts/conversation-types.ts';
import type { Check } from '../../doctor.ts';
import { checkError } from '../check-fix.ts';

/** Newest pages read per conversation type. */
const TYPE_SAMPLE = 50;

export async function computeConversationFormatCoverageCheck(
  engine: BrainEngine,
): Promise<Check> {
  const name = 'conversation_format_coverage';
  try {
    const { ConversationBodyTooLargeError, readConversationBodyForParsing } = await import('../../../core/conversation-parser/body.ts');
    const { parseConversation } = await import('../../../core/conversation-parser/parse.ts');
    // Single source of truth for the conversation-facts type allowlist (#4135),
    // expanded to the granular collector types the extractor reads (#8469).
    const allowedTypes = pageTypesForAllowed(ALLOWED_TYPES);
    // PageFilters supports singular `type` only; iterate the concrete types
    // and cap at TYPE_SAMPLE each.
    const sample: import('../../../core/types.ts').Page[] = [];
    // #5330: sample only pages the extractor would claim.
    const strict = await requireParseableConversationFlag(engine);
    let capped = false;
    for (const t of allowedTypes) {
      const slice = await engine.listPages({ limit: TYPE_SAMPLE, type: t as import('../../../core/types.ts').PageType });
      if (slice.length >= TYPE_SAMPLE) capped = true;
      sample.push(...slice.filter(page => isConversationFactsEligiblePage(page, allowedTypes, strict)));
    }
    if (sample.length === 0) {
      return {
        name,
        status: 'ok',
        message: 'No conversation-type pages — coverage check not applicable',
      };
    }
    const { isTranscriptClaiming } = await import('../../../core/conversation-parser/transcript-signals.ts');
    const hitsByPattern: Record<string, number> = {};
    let unmatched = 0;
    let summaryOnly = 0;
    let oversized = 0;
    for (const page of sample) {
      // An oversized raw_transcript sidecar is never read; extraction_input_truncated reports it.
      const body = await readConversationBodyForParsing(engine, page).catch((error: unknown) => {
        if (error instanceof ConversationBodyTooLargeError) return null;
        throw error;
      });
      if (body === null) { oversized++; continue; }
      const result = parseConversation(body, { page, noPolish: true, noFallback: true });
      // #4193: a no_match on a page that never claimed a transcript
      // (summary-only meeting/slack page) is not parser debt. Report it
      // separately and keep it out of the coverage denominator. Matched
      // pages and transcript-claiming misses keep today's behavior.
      if (result.phase === 'no_match' && !isTranscriptClaiming(page, body)) {
        hitsByPattern['_summary_only'] = (hitsByPattern['_summary_only'] ?? 0) + 1;
        summaryOnly++;
        continue;
      }
      const id = result.matched_pattern_id ?? '_no_match';
      hitsByPattern[id] = (hitsByPattern[id] ?? 0) + 1;
      if (result.phase === 'no_match') unmatched++;
    }
    const candidates = sample.length - summaryOnly - oversized;
    // #7145: a sample is named as one, in the text and in details.
    const sampleNote = capped ? ` (a sample of up to ${TYPE_SAMPLE} pages per conversation type)` : '';
    const details = { sampled: sample.length, exact: !capped, ...(capped ? { bound: 'sample', limit: TYPE_SAMPLE } : {}) };
    const unmatchedPct = candidates > 0 ? (unmatched / candidates) * 100 : 0;
    const breakdown = Object.entries(hitsByPattern)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    if (unmatchedPct > 10) {
      return {
        name,
        status: 'warn',
        message:
          `${unmatched}/${candidates} transcript-bearing conversation pages${sampleNote} (${unmatchedPct.toFixed(1)}%) match NO built-in pattern. ` +
          `Breakdown: ${breakdown}. ` +
          `Investigate: gbrain conversation-parser scan <slug>`,
        details,
      };
    }
    return {
      name,
      status: 'ok',
      message: `${sample.length} pages${sampleNote}: ${breakdown}`,
      details,
    };
  } catch (err) {
    return checkError(name, 'check conversation format coverage', err);
  }
}
