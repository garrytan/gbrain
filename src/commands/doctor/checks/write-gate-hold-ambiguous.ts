/**
 * write_gate_hold_ambiguous: quarantine holds the v333 upgrade could not tie to one page. A hold normally remembers its
 * page's permanent id, so a rename cannot lift it; on upgrade each older hold was classified from the page that held its
 * slug and the rename history, and one that fits several pages (a page created after the hold now has the slug, the name
 * moved, or two pages qualify) was left unbound with its candidate pages recorded. Such a hold stays held for every
 * candidate, so nothing it quarantined is shown, but a person has to decide it: `gbrain trust review` lists it, and
 * `gbrain trust drop` removes it (a release is refused until it is bound). Read-only; this check changes nothing.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { isMissingSchemaObject } from '../../../core/utils.ts';
import { rethrowCapabilityRefusal } from '../../../core/engine-capability-refusal.ts';

const LIMIT = 50;

async function runWriteGateHoldAmbiguous(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const rows = await connectedEngine(ctx).executeRaw<{ id: string; source_id: string; slug: string; candidates: number; total: number }>(
      `SELECT id::text AS id, source_id, slug, cardinality(page_candidates) AS candidates, COUNT(*) OVER () AS total
         FROM write_gate_holds WHERE status = 'held' AND page_id IS NULL AND page_candidates IS NOT NULL ORDER BY id LIMIT ${LIMIT}`);
    const items = rows.map(r => ({ hold_ref: `h${r.id}`, source_id: r.source_id, slug: r.slug, candidate_pages: Number(r.candidates) }));
    const total = rows.length ? Number(rows[0]!.total) : 0;
    const details = { total, items };
    if (!total) {
      checks.push({ name: 'write_gate_hold_ambiguous', status: 'ok', details, message: 'Every held write is tied to one page, or waits for its page to be created.' });
      return checks;
    }
    checks.push({ name: 'write_gate_hold_ambiguous', status: 'warn', details,
      message: `${total} held write(s) could not be tied to one page when the brain was upgraded: ${items.slice(0, 5).map(i => `${i.hold_ref} (${i.source_id}/${i.slug}, ${i.candidate_pages} candidate page(s))`).join('; ')}${total > 5 ? `; and ${total - 5} more` : ''}. `
        + 'Each stays held for every candidate page, so nothing it quarantined is shown. Ask the user to review each one (gbrain trust review) and drop it (gbrain trust drop <ref>); a release is refused until the hold is tied to a page. Nothing was changed.',
      fix: agentFix(['gbrain', 'trust', 'review'], 'Lists the held writes for the owner to decide, read-only.', 'write_gate_hold_ambiguous') });
  } catch (error) {
    rethrowCapabilityRefusal(error);
    if (isMissingSchemaObject(error, 'table', 'write_gate_holds') || isMissingSchemaObject(error, 'column', ['page_id', 'page_candidates'])) {
      checks.push({ name: 'write_gate_hold_ambiguous', status: 'ok', details: { schema: 'pre_hold_page_id' }, message: 'This schema predates held writes following their page.' });
    } else {
      checks.push(checkError('write_gate_hold_ambiguous', 'list held writes that could not be tied to one page', error));
    }
  }
  return checks;
}

export const writeGateHoldAmbiguousEntry: DoctorEntry = { name: 'write_gate_hold_ambiguous', emits: ['write_gate_hold_ambiguous'], run: runWriteGateHoldAmbiguous };
