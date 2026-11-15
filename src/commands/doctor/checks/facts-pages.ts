/**
 * facts_undated_lines doctor check (GST-2731): a facts page (type: facts, such as me/facts or company/facts, the
 * starter pages gbrain setup --shape writes) holds one dated line per fact, so an agent quoting it can say when the
 * fact was true. This notes each facts page with list lines that carry no YYYY-MM-DD date, by page and line number,
 * never the line's text. Read-only; a warn whose fix reads the page and asks the user for the dates. It reads each
 * page's bounded prefix (the first 64 KiB, far more than a facts page holds); a page stored in segments is skipped
 * and counted.
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { agentFix, checkError, withSkippedSegmented } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { boundedBodyPrefixSql } from '../../../core/page-window/bounded-lead.ts';

const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const LIST_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

/** 1-based numbers of the list lines in a facts page body that carry no date. */
export function undatedFactLines(body: string): number[] {
  return body.split('\n').flatMap((line, i) => (LIST_LINE_RE.test(line) && !DATE_RE.test(line) ? [i + 1] : []));
}

export async function factsUndatedLines(engine: BrainEngine): Promise<Omit<Check, 'name'>> {
  try {
    const rows = await engine.executeRaw<{ slug: string; source_id: string; segmented: boolean; body: string | null }>(
      `SELECT p.slug, p.source_id, p.body_storage = 'segmented' AS segmented, ${boundedBodyPrefixSql('p')} AS body
         FROM pages p WHERE p.type = 'facts' AND p.deleted_at IS NULL ORDER BY p.source_id, p.slug`);
    const segmented = rows.filter(r => r.segmented).length;
    const pages = rows.flatMap(r => {
      const lines = r.segmented || r.body == null ? [] : undatedFactLines(r.body);
      return lines.length ? [{ source_id: r.source_id, slug: r.slug, lines }] : [];
    });
    if (!pages.length) {
      return withSkippedSegmented({ status: 'ok' as const, message: `Every fact line on ${rows.length} facts page(s) carries a date.` }, segmented);
    }
    const first = pages[0]!;
    const named = pages.slice(0, 5).map(p => `${p.source_id}:${p.slug} (line${p.lines.length > 1 ? 's' : ''} ${p.lines.slice(0, 10).join(', ')}${p.lines.length > 10 ? ', ...' : ''})`).join('; ');
    return withSkippedSegmented({
      status: 'warn' as const,
      message: `${pages.length} facts page(s) have fact lines with no date, so an agent cannot say when they were true: ${named}${pages.length > 5 ? '; ...' : ''}.`,
      details: { pages },
      fix: agentFix(['gbrain', 'get', first.slug, '--source', first.source_id],
        'Reads the page. Each undated line needs the date it became true, which only the user knows; add it as a new dated line rather than rewriting the old one.',
        'facts_undated_lines', { ask_user: true, user_message: `${first.slug} (source ${first.source_id}) has ${first.lines.length} fact line(s) with no date. When did each become true? I can add the dates.` }),
    }, segmented);
  } catch (error) {
    const { name: _name, ...rest } = checkError('facts_undated_lines', 'read the facts pages', error);
    return rest;
  }
}

async function runFactsPages(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({ name: 'facts_undated_lines', ...(await factsUndatedLines(connectedEngine(ctx))) });
  return checks;
}

export const factsPagesEntry: DoctorEntry = {
  name: 'facts_undated_lines',
  emits: ['facts_undated_lines'],
  run: runFactsPages,
};
