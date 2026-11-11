/**
 * privacy_label_ignored doctor check (GST-2462): live pages with no `visibility` whose `access` or
 * `confidentiality` value gbrain does not read as private (search/ignored-privacy-labels.ts), counted by key and value.
 * Those pages read like unlabelled pages to remote callers and are not kept out of git by the label. A value whose
 * plain meaning is private (PLAINLY_PRIVATE_RE) warns; any other value is information. Nothing is rewritten: the fix
 * is the read-only listing of the top warned value's pages (`gbrain list --where <key>=<value> --json`).
 *
 * Bounded for large brains: the scan goes through the GIN index on pages.frontmatter (the label keys' `?` prefilter),
 * stops after SCAN_CAP matching pages (the counts are then a lower bound), returns at most VALUE_ROWS values, and runs
 * under a STATEMENT_MS statement timeout; an overrun reports the health as unknown.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';
import { displayLabelValue, ignoredPrivacyLabelSql, PLAINLY_PRIVATE_RE, PRIVACY_LABEL_KEYS, privacyLabelKeySql, SCAN_CAP } from '../../../core/search/ignored-privacy-labels.ts';
import { edgeTrimSql } from '../../../core/edge-whitespace.ts';

export const VALUE_ROWS = 50;
export const STATEMENT_MS = 15_000;
const MESSAGE_VALUES = 10;
/** `gbrain list --where` takes a string value of at most this many characters, and a comma splits it into a list. */
const WHERE_VALUE_CHARS = 256;

interface LabelRow { key: string; raw: string; is_string: boolean; pages: number; scanned: number; groups: number }

export async function privacyLabelIgnoredCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const name = 'privacy_label_ignored';
  try {
    const values = PRIVACY_LABEL_KEYS.map(key => `('${key}', p.frontmatter->>'${key}', jsonb_typeof(p.frontmatter->'${key}') = 'string')`).join(', ');
    const rows = await engine.executeRaw<LabelRow>(
      `WITH hits AS (SELECT p.frontmatter FROM pages p
          WHERE p.deleted_at IS NULL ${sourceIds ? 'AND p.source_id = ANY($1::text[])' : ''}
            AND ${privacyLabelKeySql('p')} AND ${ignoredPrivacyLabelSql('p')}
          LIMIT ${SCAN_CAP + 1})
       SELECT l.key, l.raw, l.is_string, count(*)::int AS pages, (SELECT count(*)::int FROM hits) AS scanned, (count(*) OVER ())::int AS groups
       FROM hits p CROSS JOIN LATERAL (VALUES ${values}) AS l(key, raw, is_string)
       WHERE NULLIF(${edgeTrimSql('l.raw')}, '') IS NOT NULL
       GROUP BY l.key, l.raw, l.is_string
       ORDER BY pages DESC, l.key, l.raw
       LIMIT ${VALUE_ROWS}`, sourceIds ? [sourceIds] : [], { timeoutMs: STATEMENT_MS });
    const scanned = Math.min(rows[0]?.scanned ?? 0, SCAN_CAP);
    const capped = (rows[0]?.scanned ?? 0) > SCAN_CAP;
    const labels = rows.map(r => ({ key: r.key, value: r.raw.trim(), pages: r.pages, plainly_private: PLAINLY_PRIVATE_RE.test(r.raw),
      ...(r.is_string && r.raw.length <= WHERE_VALUE_CHARS && !r.raw.includes(',') ? { listable: r.raw } : {}) }));
    const details = { pages: scanned, values: labels.map(({ listable: _l, ...rest }) => rest), value_count: rows[0]?.groups ?? 0,
      values_truncated: (rows[0]?.groups ?? 0) > rows.length, count: capped ? 'lower_bound' : 'exact', truncated: capped, scan_cap: SCAN_CAP };
    if (!labels.length) {
      return { name, status: 'ok', details, message: 'No page relies on an access or confidentiality value gbrain does not recognize.' };
    }
    const warned = labels.filter(l => l.plainly_private);
    const shown = labels.slice(0, MESSAGE_VALUES).map(l => `${l.key}: ${displayLabelValue(l.value)} (${l.pages})`).join(', ');
    const more = details.value_count > MESSAGE_VALUES ? ` and ${details.value_count - MESSAGE_VALUES} more value(s)` : '';
    const message = `${scanned}${capped ? '+' : ''} page(s) carry an access or confidentiality value gbrain does not recognize and no visibility: ${shown}${more}. `
      + 'gbrain ignores these values, so remote callers read these pages like unlabelled ones and the label does not keep them out of git. '
      + 'To keep a page private, add visibility: private to its frontmatter (gbrain rewrites no label itself).';
    if (!warned.length) {
      return { name, status: 'ok', severity: 'info', readiness_state: 'ok', details, message: `${message} None of these values reads as private, so this is information.` };
    }
    const target = warned.find(l => l.listable !== undefined);
    const listing = target ? agentFix(['gbrain', 'list', '--where', `${target.key}=${target.listable}`, '--json'],
      `Lists the pages labelled ${target.key}: ${displayLabelValue(target.value)} (read-only); for each page that should stay private, ask the user before adding visibility: private.`, name) : undefined;
    return { name, status: 'warn', details, message: `${message} ${warned.length} of these value(s) read as private in plain words (${warned.slice(0, MESSAGE_VALUES).map(l => `${l.key}: ${displayLabelValue(l.value)}`).join(', ')}).`,
      ...(listing ? { fix: listing } : { fix_unavailable_reason: 'operator_judgement' as const }) };
  } catch (error) {
    const timedOut = (error as { code?: string } | null)?.code === '57014';
    return { name, status: 'warn', fix_unavailable_reason: 'check_errored',
      message: timedOut ? `Ignored privacy labels could not be counted within ${STATEMENT_MS} ms. Health is unknown.`
        : `Ignored privacy labels could not be counted: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown', truncated: true, health: 'unknown' } };
  }
}
