import { OperationError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import { PHYSICAL_ROOT_MARKER } from './root-metadata.ts';

const DOCS = 'docs/guides/write-refusals.md#owner_marker_missing';
const RESERVATION_DOCS = 'docs/guides/write-refusals.md#ownership_reservation_missing';

/**
 * The verified self-transfer for the same root on this host (prepare, then accept), which re-creates whichever ownership
 * record went missing. `root` and `epoch` are filled when the caller holds the binding; otherwise they are inputs from
 * writer status.
 */
function selfTransferRestoreFix(sourceId: string, binding: { root: string; epoch: string } | undefined, record: string, why: string, docs: string): Action {
  const intent = (phase: string) => ['--admin-intent', `writer_transfer_${phase}`, '--expected-state', '<admin_state>'];
  const adminState = { name: 'admin_state', how: `admin_state from gbrain sources writer status --source ${sourceId} --json on the owner host (read it again before the accept)` };
  const prepare = ['gbrain', 'sources', 'writer', 'transfer', 'prepare', sourceId, '--self-transfer'];
  return { argv: [...prepare, ...intent('prepare')], preview_argv: [...prepare, '--dry-run'], inputs: [adminState], consent: [], actor: 'host_admin', requires_exclusive: false, docs, why,
    verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] },
    then: { argv: ['gbrain', 'sources', 'writer', 'transfer', 'accept', sourceId, '--path', binding?.root ?? '<root>', '--expected-epoch', binding?.epoch ?? '<owner_epoch>',
      '--manifest', '<manifest digest printed by prepare>', '--self-transfer', ...intent('accept')],
    inputs: [adminState, ...(binding ? [] : [{ name: 'root', how: 'the binding root writer status prints' }, { name: 'owner_epoch', how: 'the owner_epoch prepare printed' }])],
    consent: [], actor: 'host_admin', requires_exclusive: false,
    why: `Accepts the self-transfer: ownership stays on this host, the ${record} is written again and writes to the source resume. A sync that stopped blocked_by_failures on a refused file is finished by running the same sync again.`,
    verify: { argv: ['gbrain', 'sources', 'writer', 'failures', sourceId, '--json'] } } };
}

/** #8368: the verified self-transfer that re-creates the ownership marker for the same root on this host. */
export function ownerMarkerRestoreFix(sourceId: string, binding?: { root: string; epoch: string }): Action {
  return selfTransferRestoreFix(sourceId, binding, 'marker',
    `Source ${sourceId}'s checkout lost its ownership marker (${PHYSICAL_ROOT_MARKER}) while the reservation beside it still names this owner. The self-transfer verifies ownership and re-creates the marker for this same root on this host; never create or copy the marker by hand.`, DOCS);
}

/**
 * #8368: the ownership marker inside the checkout is gone while the outside-root reservation still names this owner (a
 * cleanup or restore that dropped dotfiles). A retry never brings it back, so a write refused with it ends terminally;
 * only the self-transfer in `fix` restores it. lockWorktree fills the source and root.
 */
export function ownerMarkerMissingError(sourceId?: string, binding?: { root: string; epoch: string }): OperationError {
  const error = new OperationError('owner_marker_missing',
    `The ownership marker ${PHYSICAL_ROOT_MARKER} is missing from the checkout root, while the reservation beside the checkout still names this owner.`,
    `On the brain host, read gbrain sources writer status${sourceId ? ` --source ${sourceId}` : ''} --json and note admin_state, then run the verified self-transfer `
      + `(gbrain sources writer transfer prepare ${sourceId ?? '<source>'} --self-transfer, then transfer accept with the manifest it prints) to re-create the marker. Never create or copy the marker by hand.`, DOCS);
  error.fix = ownerMarkerRestoreFix(sourceId ?? '<source>', binding);
  return error;
}

/** #10260: the verified self-transfer that re-creates the reservation beside the checkout from the stamp that still identifies it. */
export function ownershipReservationRestoreFix(sourceId: string, binding?: { root: string; epoch: string }): Action {
  return selfTransferRestoreFix(sourceId, binding, 'reservation',
    `Source ${sourceId}'s checkout lost the ownership reservation beside it (.gbrain-owner-<hash>.json in its parent folder) while its own stamp (${PHYSICAL_ROOT_MARKER}) still names this owner and identifies this exact directory. `
      + 'The self-transfer (without --confirm-relocated-root) checks the stamp against this brain, the worktree this host owns and the live directory, takes the worktree lock, and re-creates the reservation for this same root; never move, copy or delete the stamp.', RESERVATION_DOCS);
}

export const OWNERSHIP_RESERVATION_MISSING_MESSAGE = `The ownership reservation beside the checkout is missing, while the checkout's stamp ${PHYSICAL_ROOT_MARKER} still names this owner and identifies this exact directory.`;

/**
 * #10260: the reservation beside the checkout is gone (a file-sync client or cleanup that removed it from the parent
 * folder) while the in-root stamp still names this worktree, its recorded root and this directory's device, inode and
 * birth time. Code `recovery_required` (detail `ownership_reservation_missing`); only the self-transfer in `fix`
 * re-creates the reservation. lockWorktree fills the source and root. `message` overrides the default for the
 * relocated-root self-transfer, which this state refuses.
 */
export function ownershipReservationMissingError(sourceId?: string, binding?: { root: string; epoch: string }, message = OWNERSHIP_RESERVATION_MISSING_MESSAGE): OperationError {
  const error = new OperationError('recovery_required', message,
    `On the brain host, read gbrain sources writer status${sourceId ? ` --source ${sourceId}` : ''} --json and note admin_state, then run the verified self-transfer without --confirm-relocated-root `
      + `(gbrain sources writer transfer prepare ${sourceId ?? '<source>'} --self-transfer, then transfer accept with the manifest it prints) to re-create the reservation. Never move, copy or delete the stamp to claim this path.`, RESERVATION_DOCS);
  error.detail = 'ownership_reservation_missing';
  error.fix = ownershipReservationRestoreFix(sourceId ?? '<source>', binding);
  return error;
}

/**
 * #10260: the self-transfer that would re-create a lost reservation found the checkout's Git repository gone too, on a
 * source that sync imported from Git (`lastCommit`). Whatever a file-sync client or cleanup left behind cannot be shown
 * to be this brain's checkout, so nothing is prepared until the person restores the folder.
 */
export function checkoutGitMissingError(sourceId: string, synced: { sourceId: string; folder: string; lastCommit: string }): OperationError {
  const { folder, lastCommit } = synced;
  const prepare = ['gbrain', 'sources', 'writer', 'transfer', 'prepare', sourceId, '--self-transfer', '--dry-run'];
  const error = new OperationError('recovery_required',
    'The checkout lost its ownership reservation and its Git history, so its identity cannot be verified and ownership was not re-established.',
    `The Git repository for source ${synced.sourceId}'s folder ${folder} is gone or no longer holds commit ${lastCommit}, the commit sync last imported from it. Nothing was changed. Restore that repository where it was, from the file-sync client's or a backup's copy, `
      + `so that git -C ${folder} cat-file -e ${lastCommit}^{commit} succeeds, then run gbrain sources writer transfer prepare ${sourceId} --self-transfer --dry-run again. Never move, copy or delete the ownership stamp.`,
    RESERVATION_DOCS);
  error.detail = 'checkout_git_missing';
  error.fix = { ask_user: true, consent: [], actor: 'user', requires_exclusive: false, docs: RESERVATION_DOCS,
    why: `The checkout's Git history is gone along with its ownership reservation; restoring it is the user's call.`,
    user_message: `The Git repository for source ${synced.sourceId} (${folder}) is gone or no longer holds that source's history, probably after a file-sync client or a cleanup. Please restore that repository where it was from the sync client's or a backup's copy. Then gbrain can re-establish ownership.`,
    verify: { argv: ['git', '-C', folder, 'cat-file', '-e', `${lastCommit}^{commit}`] },
    then: { argv: prepare, consent: [], actor: 'host_admin', requires_exclusive: false, why: 'Previews the self-transfer again once the repository is back; it changes nothing.' } };
  return error;
}
