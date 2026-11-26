/**
 * `legacy_slug_spellings`: pages stored under an older spelling of their name (capitals, or a decomposed Unicode name).
 * They still open and take small edits, but a put by that spelling is refused and an import of their file is held until
 * the page moves to its normal slug. The finding counts them per source and names the read-only preview,
 * `gbrain repair slug-spelling --source <id>`; applying it needs the preview's hash and the owner's consent. On a managed
 * brain the repair is unavailable, so the finding says a person has to decide and names no command that would refuse.
 * With none left the check is ok; a scan that stopped at its candidate limit without finding one, or a role that row-level
 * security applies to on pages (its count can come back short), is a warning (unknown), never ok.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { slugSpellingPreviewArgv } from '../../../core/persistence/legacy-slug-put.ts';
import { managedPersistenceEnabled } from '../../../core/persistence/ownership.ts';
import { countSlugSpellings, SLUG_SPELLING_SCAN_LIMIT } from '../../../core/repair/slug-spelling.ts';
import { rowSecurityTables } from '../../../core/repair/slug-spelling-guards.ts';
import type { Action } from '../../../core/agent-output.ts';

const DOCS = 'docs/guides/repair.md#slug-spelling';

async function runLegacySlugSpellings(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    // A count read through row security can come back short (a USING (false) policy shows nothing), so it is unknown, never ok.
    if ((await rowSecurityTables(engine, ['pages'])).length) {
      checks.push({ name: 'legacy_slug_spellings', status: 'warn', details: { count: 'unknown', row_security: ['pages'], docs: DOCS },
        message: 'This database role reads pages through row-level security, so pages stored under an older spelling may be hidden from it and whether any remain is unknown. Run gbrain doctor as the table owner or a role with BYPASSRLS to count them.' });
      return checks;
    }
    const { by_source, truncated } = await countSlugSpellings(engine);
    const count = by_source.reduce((sum, entry) => sum + entry.count, 0);
    const details: Record<string, unknown> = { count, by_source, truncated, docs: DOCS };
    if (!count && !truncated) {
      checks.push({ name: 'legacy_slug_spellings', status: 'ok', details, message: 'No page is stored under an older spelling of its name.' });
      return checks;
    }
    if (!count) {
      // The scan stops after SLUG_SPELLING_SCAN_LIMIT candidates; pages past them were never read, so this is unknown, not ok.
      checks.push({ name: 'legacy_slug_spellings', status: 'warn', details: { ...details, count: 'unknown' },
        message: `The scan for pages stored under an older spelling stopped after ${SLUG_SPELLING_SCAN_LIMIT} candidate pages without finding one; pages past them were not checked, so whether any remain is unknown. Preview a source with gbrain repair slug-spelling --source <id> to check it fully.` });
      return checks;
    }
    const perSource = by_source.map(entry => `${entry.source_id}: ${entry.count}`).join(', ');
    const base = `${count} page(s) are stored under an older spelling of their name (capitals or decomposed Unicode) (${perSource}${truncated ? ', more may exist' : ''}); `
      + 'each still opens and takes small edits, but a put by that spelling is refused and an import of its file is held. ';
    if (await managedPersistenceEnabled(engine)) {
      const fix: Action = { consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify('legacy_slug_spellings'), docs: DOCS,
        why: 'Page tables on a managed brain change only through coordinated publications, so the repair that moves these pages is unavailable there.',
        user_message: `${count} page(s) are stored under an older spelling of their name. Moving them is not available on a managed brain, so a person has to decide how to rename them; until then each stays readable and editable by its stored spelling.` };
      checks.push({ name: 'legacy_slug_spellings', status: 'warn', details: { ...details, needs_human: true },
        message: `${base}Moving them is not available on a managed brain, so a person has to decide how to rename them.`, fix });
      return checks;
    }
    const first = by_source[0]!;
    const argv = slugSpellingPreviewArgv(first.source_id);
    checks.push({ name: 'legacy_slug_spellings', status: 'warn', details,
      message: `${base}Preview the move with ${by_source.slice(0, 5).map(entry => slugSpellingPreviewArgv(entry.source_id).join(' ')).join(' or ')}, and apply it with the command the preview prints after the owner agrees. Pages whose normal name is taken, or whose file must be renamed first, are listed for a person.`,
      fix: agentFix(argv, `Previews moving the ${first.count} page(s) of source ${first.source_id} stored under an older spelling to their normal slug; writes nothing.`, 'legacy_slug_spellings', { docs: DOCS }) });
  } catch (error) {
    checks.push(checkError('legacy_slug_spellings', 'count the pages stored under an older spelling', error, { details: { count: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const legacySlugSpellingsEntry: DoctorEntry = { name: 'legacy_slug_spellings', emits: ['legacy_slug_spellings'], run: runLegacySlugSpellings };
