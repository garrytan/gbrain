import { OperationError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import { PHYSICAL_ROOT_MARKER } from './root-metadata.ts';

const DOCS = 'docs/guides/write-refusals.md#owner_marker_missing';

/**
 * #8368: the verified self-transfer that re-creates the ownership marker for the same root on this host: prepare, then
 * accept. `root` and `epoch` are filled when the caller holds the binding; otherwise they are inputs from writer status.
 */
export function ownerMarkerRestoreFix(sourceId: string, binding?: { root: string; epoch: string }): Action {
  const intent = (phase: string) => ['--admin-intent', `writer_transfer_${phase}`, '--expected-state', '<admin_state>'];
  const adminState = { name: 'admin_state', how: `admin_state from gbrain sources writer status --source ${sourceId} --json on the owner host (read it again before the accept)` };
  const prepare = ['gbrain', 'sources', 'writer', 'transfer', 'prepare', sourceId, '--self-transfer'];
  return { argv: [...prepare, ...intent('prepare')], preview_argv: [...prepare, '--dry-run'], inputs: [adminState], consent: [], actor: 'host_admin', requires_exclusive: false, docs: DOCS,
    why: `Source ${sourceId}'s checkout lost its ownership marker (${PHYSICAL_ROOT_MARKER}) while the reservation beside it still names this owner. The self-transfer verifies ownership and re-creates the marker for this same root on this host; never create or copy the marker by hand.`,
    verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] },
    then: { argv: ['gbrain', 'sources', 'writer', 'transfer', 'accept', sourceId, '--path', binding?.root ?? '<root>', '--expected-epoch', binding?.epoch ?? '<owner_epoch>',
      '--manifest', '<manifest digest printed by prepare>', '--self-transfer', ...intent('accept')],
    inputs: [adminState, ...(binding ? [] : [{ name: 'root', how: 'the binding root writer status prints' }, { name: 'owner_epoch', how: 'the owner_epoch prepare printed' }])],
    consent: [], actor: 'host_admin', requires_exclusive: false,
    why: 'Accepts the self-transfer: ownership stays on this host, the marker is written again and writes to the source resume. A sync that stopped blocked_by_failures on a refused file is finished by running the same sync again.',
    verify: { argv: ['gbrain', 'sources', 'writer', 'failures', sourceId, '--json'] } } };
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
