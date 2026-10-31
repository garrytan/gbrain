/**
 * extraction_input_truncated (large pages A7): pages whose last extraction
 * read only part of its input, from the durable `input_truncated` receipts in
 * `page_extraction_state` (src/core/extraction-watermark.ts). Facts read the
 * first 8,000 characters when no watermark matched (or the newest 8,000 of a
 * long append); atoms read the first `cycle.extract_atoms.max_input_chars`;
 * conversation facts skip an input over the size cap. Appends after a
 * watermark are read incrementally, so the receipt marks text that was never
 * read. Warn when a receipt has a remedy (the atoms cap, an oversized
 * conversation input); facts-only receipts are reported as info. Reads the
 * database only.
 *
 * PR 4 (Wave B incremental derivation, transcripts): a segmented page's paid
 * derivations keep their receipt per occurrence on page_segment_derivations
 * (`unread_windows`: the run stopped before every window was read, at the
 * per-page spend cap or a window limit; the next run resumes there; `failed_windows`:
 * a conversation window whose extraction failed run after run was skipped, and its
 * sample names the window). Both tables
 * are read; a page counts once per pipeline and receipt kind. A derivation receipt
 * without a `kind` (the synopsis pass's tier fallback or refused reservation), or of
 * kind `unpriced_model` (doctor derivation_unpriced_model), is not an input-truncation
 * receipt and is not counted. A receipt whose reason is `purge_sweep_pending` (synopsis
 * or fact extraction made no paid call because a fact purge's sweep covers the
 * page) counts under that kind, whatever its own: its remedy is finishing the sweep
 * (doctor derivation_purge_sweeps), not a higher spend cap.
 *
 * conversation_detection_ambiguous (PR 4, Wave B incremental derivation, transcripts): segmented conversation pages
 * held because no format is detected over them yet some format parses messages (a `detection_ambiguous` receipt
 * with each format's count): nothing was extracted or collected there until the operator chooses the format with
 * gbrain extract-conversation-facts --slug <slug> --grammar <format|none> (preview with --dry-run). Such a page's
 * receipts are listed there, not here, so a stale window receipt never offers a spend cap for it; an operator choice
 * (`grammar_chosen`) is not a truncation and is not listed.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { EXTRACT_MAX_INPUT_CHARS_KEY } from '../../../core/cycle/extract-atoms-input.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../../core/page-spend.ts';

interface ReceiptGroup { pipeline: string; kind: string; pages: number; samples: string[] }

const REMEDY: Record<string, string> = {
  facts_backstop: 'later appends are extracted from the appended text; for a conversation page, gbrain extract-conversation-facts --slug <slug> reads every window of the body',
  extract_atoms: `raise the cap so the next cycle reads more of each page: gbrain config set ${EXTRACT_MAX_INPUT_CHARS_KEY} <n>`,
  conversation_facts: 'the parser input (page body or raw_transcript sidecar) is over the conversation body cap and was not read; trim the sidecar under the cap or remove raw_transcript from the page frontmatter, then gbrain extract-conversation-facts --slug <slug>',
};

const UNREAD_WINDOWS = 'unread_windows';
const UNREAD_REMEDY = `the run stopped before every window of the page was read (the receipt's reason: the per-page spend cap, a window limit or a skipped window); the next run resumes where it stopped, and when the cap stopped it: gbrain config set ${PAGE_DERIVATION_CAP_KEY} <usd>`;
const FAILED_WINDOWS = 'failed_windows';
const FAILED_REMEDY = 'a conversation window failed to extract in run after run and is skipped, so the older windows still get extracted (the sample names the window, its receipt the last error); fix the cause, then gbrain extract-conversation-facts --slug <slug> --force tries it again';
const PURGE_SWEEP = 'purge_sweep_pending';
const PURGE_SWEEP_REMEDY = 'a fact purge\'s sweep of stored derivation results covers the page, so the run made no paid call there; gbrain doctor --only derivation_purge_sweeps names the purge, gbrain forget --purge --status --request-id <request_id> --continue finishes its sweep, and the next run resumes where it stopped';
const NO_MESSAGES = 'no_messages';
const NO_MESSAGES_REMEDY = 'the page reads as a transcript format over its whole text, yet no message parsed under that format (a conversation parser fault), so the last run changed nothing and kept its facts; rerunning repeats this, so report it with gbrain doctor --json and the page\'s format (a page that is not a transcript settles as non-extractable instead)';
const AMBIGUOUS = 'detection_ambiguous';
const CHOSEN = 'grammar_chosen';
const remedy = (g: ReceiptGroup): string | null => g.kind === PURGE_SWEEP ? PURGE_SWEEP_REMEDY : g.kind === UNREAD_WINDOWS ? UNREAD_REMEDY : g.kind === FAILED_WINDOWS ? FAILED_REMEDY
  : g.kind === NO_MESSAGES ? NO_MESSAGES_REMEDY : REMEDY[g.pipeline] ?? null;

const describe = (g: ReceiptGroup): string =>
  `${g.pipeline}/${g.kind}: ${g.pages} page(s) (e.g. ${g.samples.join(', ')}); ${remedy(g) ?? 'see the receipt in page_extraction_state'}`;

async function runExtractionInputTruncatedCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const held = await connectedEngine(ctx).executeRaw<{ page: string; grammars: Record<string, number> | string | null; total: number }>(
      `SELECT p.source_id || ':' || p.slug AS page, s.input_truncated->'grammars' AS grammars, count(*) OVER ()::int AS total
         FROM page_extraction_state s JOIN pages p ON p.id = s.page_id AND p.deleted_at IS NULL
        WHERE s.pipeline = 'conversation_facts' AND s.input_truncated->>'kind' = '${AMBIGUOUS}'
        ORDER BY s.updated_at DESC LIMIT 20`);
    const pages = held.map(r => ({ page: r.page, grammars: (typeof r.grammars === 'string' ? JSON.parse(r.grammars) : r.grammars ?? {}) as Record<string, number> }));
    if (!pages.length) {
      checks.push({ name: 'conversation_detection_ambiguous', status: 'ok', message: 'No conversation page is held for an undetected format.', details: { pages: 0, samples: [] } });
    } else {
      const total = Number(held[0]!.total);
      const sample = pages.slice(0, 3).map(p => `${p.page} (${Object.entries(p.grammars).map(([id, n]) => `${id}: ${n}`).join(', ')})`).join('; ');
      checks.push({ name: 'conversation_detection_ambiguous', status: 'warn',
        message: `${total} conversation page(s) are held: no format is detected over the whole page, yet these formats parse messages in it, so nothing was extracted or removed there (messages per format: ${sample}). `
          + 'Preview the format the page holds with gbrain extract-conversation-facts --source-id <source> --slug <slug> --grammar <format> --dry-run (--grammar none for a page that is not a transcript: its conversation facts are removed), then run it without --dry-run.',
        details: { pages: total, samples: pages },
        fix: agentFix(['gbrain', 'extract-conversation-facts', '--source-id', '<SOURCE>', '--slug', '<SLUG>', '--grammar', '<FORMAT>', '--dry-run'],
          "Shows what a run under the chosen format would extract and which conversation facts its settled run would remove; it changes nothing. Running it without --dry-run applies the choice, which is the user's call.",
          'conversation_detection_ambiguous', { ask_user: true, inputs: [
            { name: 'SOURCE', how: 'the source id before the colon of a page in details.samples' },
            { name: 'SLUG', how: 'the slug after the colon of that page' },
            { name: 'FORMAT', how: "one of that page's formats in details.samples, or none when the page is not a transcript, chosen with the user" }] }) });
    }
  } catch (error) {
    checks.push(checkError('conversation_detection_ambiguous', 'read the held conversation pages', error, { details: { health: 'unknown' } }));
  }
  try {
    const rows = await connectedEngine(ctx).executeRaw<{ pipeline: string; kind: string; pages: number; samples: string[] }>(
      `WITH receipts AS (
         SELECT s.page_id, s.pipeline, COALESCE(s.input_truncated->>'kind', 'unknown') AS kind, s.updated_at, NULL::text AS detail
           FROM page_extraction_state s WHERE s.input_truncated IS NOT NULL AND COALESCE(s.input_truncated->>'kind', '') NOT IN ('${AMBIGUOUS}', '${CHOSEN}')
         UNION ALL
         SELECT d.page_id, d.pipeline, CASE WHEN d.receipt->>'reason' = '${PURGE_SWEEP}' THEN '${PURGE_SWEEP}' ELSE COALESCE(d.receipt->>'kind', 'unknown') END AS kind,
                max(d.updated_at) AS updated_at,
                min(CASE WHEN d.receipt->>'kind' = '${FAILED_WINDOWS}' THEN ' window ' || (d.receipt->'windows'->0->>'ordinal') || ' of occurrence ' || d.occurrence_id END) AS detail
           FROM page_segment_derivations d
          WHERE ((d.receipt->>'kind' IS NOT NULL AND d.receipt->>'kind' <> 'unpriced_model') OR d.receipt->>'reason' = '${PURGE_SWEEP}')
            AND NOT EXISTS (SELECT 1 FROM page_extraction_state h WHERE h.page_id = d.page_id AND h.pipeline = d.pipeline AND h.input_truncated->>'kind' = '${AMBIGUOUS}')
          GROUP BY 1, 2, 3)
       SELECT r.pipeline, r.kind, count(DISTINCT r.page_id)::int AS pages,
              (array_agg(p.source_id || ':' || p.slug || COALESCE(r.detail, '') ORDER BY r.updated_at DESC))[1:3] AS samples
         FROM receipts r JOIN pages p ON p.id = r.page_id AND p.deleted_at IS NULL
        GROUP BY 1, 2 ORDER BY 1, 2`);
    const groups: ReceiptGroup[] = rows.map(r => ({ pipeline: r.pipeline, kind: r.kind, pages: Number(r.pages), samples: r.samples ?? [] }));
    const details = { groups: groups.map(g => ({ ...g, remedy: remedy(g) })) };
    if (!groups.length) {
      checks.push({ name: 'extraction_input_truncated', status: 'ok', message: 'Every page extraction read all of its input (no head-only, tail-window or size-skip receipts).', details });
      return checks;
    }
    const summary = `Page extractions that read only part of their input: ${groups.map(describe).join('. ')}.`;
    const actionable = groups.filter(g => g.pipeline !== 'facts_backstop' || g.kind === UNREAD_WINDOWS || g.kind === PURGE_SWEEP);
    if (!actionable.length) {
      checks.push({ name: 'extraction_input_truncated', status: 'ok', severity: 'info', readiness_state: 'degraded', message: summary, details });
      return checks;
    }
    const atoms = actionable.find(g => g.pipeline === 'extract_atoms');
    const capped = actionable.some(g => g.kind === UNREAD_WINDOWS);
    const sweeping = actionable.some(g => g.kind === PURGE_SWEEP);
    checks.push({ name: 'extraction_input_truncated', status: 'warn', message: summary, details,
      ...(atoms
        ? { fix: agentFix(['gbrain', 'config', 'set', EXTRACT_MAX_INPUT_CHARS_KEY, '<n>'],
          'A higher cap lets the next extract_atoms cycle read more of each cut page; it raises model spend, so the value is the user\'s call.', 'extraction_input_truncated',
          { ask_user: true, consent: ['paid'], inputs: [{ name: 'n', how: 'a character count above the cut pages\' sizes, chosen with the user' }] }) }
        : capped
          ? { fix: agentFix(['gbrain', 'config', 'set', PAGE_DERIVATION_CAP_KEY, '<USD>'],
            'A higher per-page cap lets the next run read the windows the cap stopped; it raises model spend, so the value is the user\'s call.', 'extraction_input_truncated',
            { ask_user: true, consent: ['paid'], inputs: [{ name: 'USD', how: 'a per-page dollar cap chosen with the user' }] }) }
          : sweeping
            ? { fix: agentFix(['gbrain', 'doctor', '--only', 'derivation_purge_sweeps', '--json'],
              'Names each unfinished fact purge sweep and the command that continues it; paid extraction resumes on the pages once the sweep ends. It changes nothing.', 'extraction_input_truncated') }
            : { fix_unavailable_reason: 'operator_judgement' as const }) });
  } catch (error) {
    checks.push(checkError('extraction_input_truncated', 'read the extraction receipts', error, { details: { health: 'unknown' } }));
  }
  return checks;
}

export const extractionInputTruncatedEntry: DoctorEntry = { name: 'extraction_input_truncated', emits: ['conversation_detection_ambiguous', 'extraction_input_truncated'], run: runExtractionInputTruncatedCheck };
