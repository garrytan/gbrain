/**
 * #6696 B5 `ghost_pages`: live pages whose canonical file is missing on the
 * source's owner host (`liveFileDrift` reason `canonical_file_missing`, one
 * classifier in `src/core/ghost-pages.ts`). Every coordinated write to such a
 * page refuses and no sync can import its file, so the finding names the
 * read-only `gbrain repair ghost-pages --source <id>` preview; a person
 * decides between restoring the file and removing the page.
 *
 * Bounded: an existence pre-filter (a stat of each page's recorded canonical
 * path) before the full check of at most `GHOST_CHECK_LIMIT` candidates per
 * source, with bounded samples and `inspected` / `truncated` / `exact` details.
 * Off the owner host or on a brain with no bound source it is `ok` + info
 * (`not_applicable`), never a warning; an unreadable or ambiguous checkout is
 * the unknown convention (`warn`, `details.health: 'unknown'`).
 * `undeclared_db_only_pages` stays a separate audit. #6910: ghosts on files of
 * an adopted shared skillpack are counted apart (`details.skill_paths`, code
 * `ghost_skill_pack_member`, with their restore commands), never as knowledge
 * ghosts awaiting `gbrain repair ghost-pages`, which leaves them alone; on
 * their own they leave the check `ok` with the restore step.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { readGhostPages } from '../../../core/ghost-pages.ts';
import { SKILL_PACK_MEMBER_CODE, skillPathDetail } from '../../../core/repair/ghost-pages.ts';

const DOCS = 'docs/guides/repair.md#ghost-pages';

async function runGhostPages(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const summary = await readGhostPages(connectedEngine(ctx), {});
    const details = { count: summary.count, by_source: summary.by_source, samples: summary.samples, inspected: summary.inspected,
      truncated: summary.truncated, exact: summary.exact, docs: DOCS,
      ...(summary.skill_paths ? { skill_paths: { ...skillPathDetail(undefined, summary.skill_path_samples, summary.skill_paths), samples: summary.skill_path_samples } } : {}) };
    const skillNote = summary.skill_paths
      ? ` ${summary.skill_paths} more are files of the shared skillpack missing from the checkout (${SKILL_PACK_MEMBER_CODE}: ${summary.skill_path_samples.map(page => `${page.source_id}:${page.slug}`).join(', ')}); the repair leaves them alone: restore each file on the owner host (git -C <source root> checkout -- <path>, or republish the skill with put_skill).`
      : '';
    const ghostSources = summary.by_source.filter(entry => entry.count > 0);
    const unknown = summary.by_source.filter(entry => entry.status === 'unknown');
    if (ghostSources.length) {
      const first = ghostSources[0]!.source_id;
      checks.push({ name: 'ghost_pages', status: 'warn', details: { ...details, ...(unknown.length ? { health: 'unknown' } : {}) },
        message: `${summary.count}${summary.exact ? '' : '+'} live page(s) have no canonical file on the owner host (ghost pages), so every write to them refuses and no sync can import them `
          + `(${ghostSources.map(entry => `${entry.source_id}: ${entry.count}`).join('; ')}; e.g. ${summary.samples.map(page => `${page.source_id}:${page.slug} (${page.path})`).join(', ')}).`
          + `${unknown.length ? ` ${unknown.map(entry => entry.source_id).join(', ')} could not be checked (${unknown[0]!.reason}).` : ''}`
          + ` Preview the removal with gbrain repair ghost-pages --source ${first}; to keep a page instead, restore its file at the recorded path and sync.${skillNote}`,
        fix: agentFix(['gbrain', 'repair', 'ghost-pages', '--source', first, '--json'],
          'Read-only preview: lists each ghost page with its recorded canonical path and revision, and prints the apply command with its hash. Apply only after the user agrees (it soft-deletes; restore the file and sync to keep a page).',
          'ghost_pages', { docs: DOCS }) });
      return checks;
    }
    if (unknown.length) {
      const source = unknown[0]!.source_id;
      checks.push({ name: 'ghost_pages', status: 'warn', details: { ...details, health: 'unknown' },
        message: `Ghost pages of ${unknown.map(entry => `${entry.source_id} (${entry.reason})`).join(', ')} could not be checked: the canonical checkout is missing or could not be read reliably, so no count is reported.`,
        fix: agentFix(['gbrain', 'sources', 'writer', 'status', '--source', source, '--json'],
          'Read-only: shows the source\'s canonical root and owner host so the checkout can be inspected.', 'ghost_pages', { docs: DOCS }) });
      return checks;
    }
    if (summary.reason === 'not_owner_host' || summary.reason === 'not_applicable') {
      checks.push({ name: 'ghost_pages', status: 'ok', severity: 'info', readiness_state: 'not_applicable', details: { ...details, reason: summary.reason },
        message: summary.reason === 'not_owner_host'
          ? 'Not applicable on this host: ghost pages are checked on each source\'s canonical owner host (run doctor there).'
          : 'Not applicable: no source has a canonical checkout, so no page owns a file that could be missing.' });
      return checks;
    }
    checks.push({ name: 'ghost_pages', status: 'ok', details,
      message: `No live page is missing its canonical file (${summary.inspected} page(s) inspected${summary.truncated ? '; bounded, more not checked' : ''}).${skillNote}` });
  } catch (error) {
    checks.push(checkError('ghost_pages', 'check live pages for a missing canonical file', error, { details: { count: 'unknown', health: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const ghostPagesEntry: DoctorEntry = { name: 'ghost_pages', emits: ['ghost_pages'], run: runGhostPages };
