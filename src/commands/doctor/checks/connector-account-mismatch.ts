/**
 * connector_account_mismatch doctor check (#6803): connector sources whose
 * last sync refused with `connector_account_changed` because the credential
 * resolves to a different account than the source is pinned to. Autopilot
 * skips them (unavailable-path) instead of retrying every interval, so this
 * check is where the operator learns a source has stopped importing. The fix
 * is the operator's: restore the credential for the pinned account and sync
 * by hand, or archive the source after adding one for the new account.
 * Account identities stay out of the message; the sync refusal names them locally.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { connectorAccountMismatches } from '../../../core/persistence/connector-account-mismatch.ts';

const DOCS = 'docs/guides/write-refusals.md#connector-account-changed';

export async function connectorAccountMismatchCheck(engine: BrainEngine): Promise<Check> {
  try {
    const found = [...(await connectorAccountMismatches(engine))].sort(([a], [b]) => a.localeCompare(b));
    if (found.length === 0) return { name: 'connector_account_mismatch', status: 'ok', message: 'No connector source is waiting for its account to be repinned.' };
    const [first] = found[0]!;
    const listed = found.map(([id, m]) => `${id} (${m.detail === 'account_unresolved' ? 'credential resolves to no account' : 'credential resolves to a different account'} since ${m.at})`).join(', ');
    return {
      name: 'connector_account_mismatch',
      status: 'warn',
      message: `${found.length} connector source(s) stopped importing because their credential no longer resolves to the pinned account: ${listed}. `
        + 'Autopilot skips them until they are repinned, so nothing is retried in the background. '
        + `Restore the credential for the pinned account, then run gbrain sync --source <id> (the sync prints the pinned and resolved accounts). `
        + 'For a deliberate account change, add a new source for the new account and archive this one with gbrain sources archive <id>; its pages stay. '
        + `Changing the source's connector config also lets autopilot try it once more. See ${DOCS}.`,
      details: { code: 'connector_account_changed', sources: found.map(([id, m]) => ({ source_id: id, detail: m.detail, since: m.at })), docs: DOCS },
      fix: {
        argv: ['gbrain', 'sync', '--source', first],
        consent: ['credentials'],
        actor: 'user',
        why: `The credential for ${first} must first be restored to the account the source is pinned to; this sync then checks the account and clears the skip, or refuses again naming both accounts.`,
        user_message: `Your connector source ${first} stopped importing: its credential now belongs to a different account than the one it was set up with. `
          + `Restore that account's credential and run the sync, or tell me to set up a new source for the new account and archive this one.`,
        verify: doctorVerify('connector_account_mismatch'),
        docs: DOCS,
        requires_exclusive: false,
      },
    };
  } catch (error) {
    return { name: 'connector_account_mismatch', status: 'warn', message: `Connector account state could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown' }, fix_unavailable_reason: 'check_errored' };
  }
}

async function runConnectorAccountMismatch(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({ ...(await connectorAccountMismatchCheck(connectedEngine(ctx))), name: 'connector_account_mismatch' });
  return checks;
}

export const connectorAccountMismatchEntry: DoctorEntry = {
  name: 'connector_account_mismatch',
  emits: ['connector_account_mismatch'],
  run: runConnectorAccountMismatch,
};
