/**
 * GBRA-133 PR 1: the fixes of the classic (unmanaged) sync rename holds. gitHoldFix (persistence/sync-holds.ts)
 * dispatches these codes here; the holds are written by src/commands/sync/holds.ts and renames.ts.
 *
 *   rename_identity_unreadable (S-51)  the database refused to compare a renamed file's title or id, so the pair
 *                                      waits and the old page stays whole;
 *   rename_reconcile_failed (S-67)     a rename fell back to an add and removing the old page threw unexpectedly,
 *                                      so the old page was kept and may be a duplicate.
 */
import type { Action } from './agent-output.ts';

export const CLASSIC_RENAME_HOLD_CODES = ['rename_identity_unreadable', 'rename_reconcile_failed'] as const;
export type ClassicRenameHoldCode = typeof CLASSIC_RENAME_HOLD_CODES[number];

export function classicRenameHoldFix(record: { source_id: string; path: string; code: string; slug?: string | null }): Action {
  const source = record.source_id;
  const verify = { argv: ['gbrain', 'sources', 'status', source, '--json'] };
  const sync: Action = { argv: ['gbrain', 'sync', '--source', source, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false, verify,
    why: `Re-screens ${record.path} after the file is fixed; the rest of the source keeps syncing either way.` };
  if (record.code === 'rename_reconcile_failed') {
    return { argv: ['gbrain', 'sync', '--source', source, '--full', '--no-pull'], consent: [], actor: 'user', requires_exclusive: false,
      docs: 'docs/guides/write-refusals.md#rename_reconcile_failed',
      user_message: `${record.path} was imported as the new name of a renamed file, but removing the page of the old name failed unexpectedly, so sync kept that page (it may now duplicate ${record.slug ?? 'the new page'}) and the rest of source ${source} kept syncing. `
        + `A full sync of the source (gbrain sync --source ${source} --full --no-pull) re-reads every file and removes pages whose file is gone after checking each one; it can take a while on a large source. `
        + 'Or find the old page with gbrain sources status and remove it with gbrain delete (recoverable for 72 h).',
      why: 'Whether to remove a page is the user\'s call; the hold records only the failure\'s class and code, never its message.',
      verify };
  }
  return { argv: verify.argv, consent: [], actor: 'user', requires_exclusive: false, docs: 'docs/guides/write-refusals.md#rename_identity_unreadable',
    user_message: `${record.path} replaces a file removed in the same sync, but the database refused to compare its title or frontmatter id, so sync could not tell whether it is the same page. `
      + `It held ${record.path} and kept the old page (same id, links, facts and timeline); the rest of source ${source} keeps syncing. `
      + `Remove the characters the database cannot store (a NUL byte or a broken Unicode character) from the file's title and id, commit, then run gbrain sync --source ${source} --no-pull: the next sync decides again whether it is the old page.`,
    why: 'Which page a file is cannot be decided without comparing its identity, and sync never guesses; the hold is decided again when the file changes or on gbrain sources retry-held.',
    then: sync, verify };
}
