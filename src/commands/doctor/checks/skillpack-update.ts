/**
 * Skillpack update journals (`gbrain skillpack reference --update-untouched`):
 *   - skillpack_update_incomplete (warn): a journal a crash left `pending`,
 *     with the restore command. A pending journal whose workspace writer lock
 *     is fresh belongs to a run still going and is not reported.
 *   - skillpack_backups (ok): how many update backups are kept.
 * Filesystem only (~/.gbrain/skillpack-backups), so it runs with or without
 * an engine and on brains with no git repository. Emits nothing when there
 * are no backups.
 */
import { statSync } from 'fs';

import { workspaceLockPath } from '../../../core/skillpack/file-lock.ts';
import { JOURNAL_KEEP_DAYS, JOURNAL_KEEP_LAST, listJournals, type Journal } from '../../../core/skillpack/update-journal.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';

const LIVE_LOCK_MS = 10 * 60 * 1000;

function runIsLive(skillsRoot: string): boolean {
  try {
    return Date.now() - statSync(workspaceLockPath(skillsRoot)).mtimeMs < LIVE_LOCK_MS;
  } catch {
    return false;
  }
}

/** `backups` overrides ~/.gbrain/skillpack-backups (tests). */
export async function runSkillpackUpdateChecks(_ctx?: DoctorContext, backups?: string): Promise<Check[]> {
  const checks: Check[] = [];
  let journals: Journal[];
  try {
    journals = listJournals(backups);
  } catch (err) {
    checks.push({ name: 'skillpack_update_incomplete', status: 'warn', message: `Skillpack update backups could not be read: ${(err as Error).message}. Health is unknown.` });
    return checks;
  }
  if (journals.length === 0) return checks;
  const pending = journals.filter(j => j.status === 'pending' && !runIsLive(j.skills_root));
  if (pending.length) {
    checks.push({
      name: 'skillpack_update_incomplete',
      status: 'warn',
      message: `${pending.length} skillpack update(s) did not finish (a crash left the journal pending): `
        + pending.map(j => `${j.id} (${j.skills_root}; mid-apply: ${j.skills.filter(s => s.status === 'applying').map(s => s.slug).join(', ') || 'none'})`).join('; ')
        + `. New updates of that skills root refuse until it is restored: gbrain skillpack restore ${pending[0]!.id}.`,
      fix: agentFix(['gbrain', 'skillpack', 'restore', '--list', '--json'],
        'Lists the pending journal and the files each skill touched; changes nothing. The restore itself refuses files changed since the update.', 'skillpack_update_incomplete'),
      details: { pending: pending.map(j => ({ id: j.id, skills_root: j.skills_root, restore: `gbrain skillpack restore ${j.id}` })) },
    });
  }
  checks.push({
    name: 'skillpack_backups',
    status: 'ok',
    message: `${journals.length} skillpack update backup(s) kept (oldest ${journals[journals.length - 1]!.id}); each is kept ${JOURNAL_KEEP_DAYS} days or while among the newest ${JOURNAL_KEEP_LAST}. List them with gbrain skillpack restore --list.`,
  });
  return checks;
}

export const skillpackUpdateEntry: DoctorEntry = {
  name: 'skillpack_update_incomplete',
  emits: ['skillpack_update_incomplete', 'skillpack_backups'],
  run: runSkillpackUpdateChecks,
};
